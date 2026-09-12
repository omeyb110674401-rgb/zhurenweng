import type { SearchDocument, SearchHit, SearchPort } from '../ports.ts';

/**
 * SearchPort 生产适配器：Meilisearch（issue #8，PRD 技术栈决策）。
 *
 * 用原生 fetch 直连 Meilisearch REST API（不引入额外依赖）。仅在
 * SEARCH_PROVIDER=meilisearch 时由 createSearchPort() 启用；开发与测试
 * 默认 local 实现，本机（开发 / CI）没有 Meilisearch，本适配器不做集成
 * 验证 —— 生产部署（docker-compose 编排 meilisearch 服务）时联调，属
 * ADR-0001 已知风险。
 *
 * 环境变量：
 * - MEILI_HOST（或 MEILI_URL，与 docker-compose 命名兼容）：服务地址，必填；
 * - MEILI_API_KEY（或 MEILI_MASTER_KEY）：API 密钥，无鉴权实例可缺省；
 * - MEILI_INDEX_UID：索引 uid，默认 notices；
 * - MEILI_TASK_TIMEOUT_MS：异步索引任务的等待上限，默认 10000。
 *
 * 错误处理：网络失败 / 非 2xx / 任务失败（索引、设置写入）都以异常抛出，
 * 由调用方（管线钩子 / 重建任务）决定降级策略；search 失败直接上抛，
 * 结果页展示错误态而非静默空结果。
 */

const DEFAULT_INDEX_UID = 'notices';
const DEFAULT_TASK_TIMEOUT_MS = 10_000;
const TASK_POLL_INTERVAL_MS = 50;

/** Meilisearch 异步任务状态（REST API /tasks/{uid}） */
type MeiliTaskStatus = 'enqueued' | 'processing' | 'succeeded' | 'failed' | 'canceled';

export interface MeilisearchConfig {
  /** 服务地址（不含尾斜杠），如 http://meilisearch:7700 */
  host: string;
  /** API 密钥（Master / Search key）；无鉴权实例为 undefined */
  apiKey?: string;
  /** 索引 uid */
  indexUid: string;
  /** 异步任务等待上限（毫秒） */
  taskTimeoutMs: number;
}

export class MeilisearchSearch implements SearchPort {
  readonly provider = 'meilisearch';

  private readonly host: string;
  private readonly apiKey: string | undefined;
  private readonly indexUid: string;
  private readonly taskTimeoutMs: number;
  /** 首次使用时确保索引与可搜索属性就绪（幂等，只执行一次） */
  private ensurePromise: Promise<void> | undefined;

  constructor(config: MeilisearchConfig) {
    this.host = config.host;
    this.apiKey = config.apiKey;
    this.indexUid = config.indexUid;
    this.taskTimeoutMs = config.taskTimeoutMs;
  }

  async index(documents: SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.ensure();
    // primaryKey=id：以条目 id 为主键，重复写入即更新（幂等 upsert）
    await this.requestWithTask(`/indexes/${this.indexUid}/documents?primaryKey=id`, {
      method: 'POST',
      body: JSON.stringify(documents),
    });
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensure();
    await this.requestWithTask(`/indexes/${this.indexUid}/documents/delete-batch`, {
      method: 'POST',
      body: JSON.stringify(ids),
    });
  }

  async search(query: string, limit?: number): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const response = await this.request(`/indexes/${this.indexUid}/search`, {
      method: 'POST',
      body: JSON.stringify({ q: trimmed, limit: limit ?? 20 }),
    });
    const payload = (await response.json()) as { hits?: unknown };
    if (!Array.isArray(payload.hits)) return [];
    return payload.hits
      .map((hit): SearchHit | null => {
        if (typeof hit !== 'object' || hit === null) return null;
        const record = hit as Record<string, unknown>;
        if (typeof record.id !== 'string') return null;
        return { id: record.id, title: typeof record.title === 'string' ? record.title : '' };
      })
      .filter((hit): hit is SearchHit => hit !== null);
  }

  /** 确保索引存在且可搜索属性顺序正确（title > summary > body）；结果幂等缓存。 */
  private ensure(): Promise<void> {
    this.ensurePromise ??= this.doEnsure();
    return this.ensurePromise;
  }

  private async doEnsure(): Promise<void> {
    // 已存在时 Meilisearch 返回 409，视为就绪
    await this.request('/indexes', {
      method: 'POST',
      body: JSON.stringify({ uid: this.indexUid, primaryKey: 'id' }),
    }).catch((error: unknown) => {
      if (!isMeiliStatusError(error, 409)) throw error;
    });
    await this.requestWithTask(`/indexes/${this.indexUid}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ searchableAttributes: ['title', 'summary', 'body'] }),
    });
  }

  /** 发起请求并等待对应的异步任务完成（索引 / 设置写入为异步语义）。 */
  private async requestWithTask(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(path, init);
    const payload = (await response.json()) as { taskUid?: unknown };
    if (typeof payload.taskUid !== 'number') {
      throw new Error(`Meilisearch 响应缺少 taskUid（${path}）`);
    }
    return this.waitForTask(payload.taskUid);
  }

  /** 轮询异步任务直到成功；失败 / 取消抛出带错误详情的异常。 */
  private async waitForTask(taskUid: number): Promise<unknown> {
    const deadline = Date.now() + this.taskTimeoutMs;
    for (;;) {
      const response = await this.request(`/tasks/${taskUid}`, { method: 'GET' });
      const task = (await response.json()) as { status?: unknown; error?: unknown };
      const status = task.status as MeiliTaskStatus | undefined;
      if (status === 'succeeded') return task;
      if (status === 'failed' || status === 'canceled') {
        throw new Error(`Meilisearch 任务 ${taskUid} ${status}：${JSON.stringify(task.error ?? null)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`Meilisearch 任务 ${taskUid} 等待超时（${this.taskTimeoutMs}ms）`);
      }
      await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MS));
    }
  }

  /** 统一请求封装：鉴权头、JSON 头、超时、非 2xx 抛错（带状态码与响应体）。 */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey !== undefined && this.apiKey !== '') {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.host}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.taskTimeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Meilisearch 请求失败（${this.host}${path}）：${reason}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new MeiliStatusError(`Meilisearch HTTP ${response.status}（${path}）：${body}`, response.status);
    }
    return response;
  }
}

/** 携带 HTTP 状态码的错误（ensure() 需要识别 409 = 索引已存在） */
export class MeiliStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function isMeiliStatusError(error: unknown, status: number): boolean {
  return error instanceof MeiliStatusError && error.status === status;
}

/** 从环境变量构建 Meilisearch 适配器（compose 用 MEILI_URL / MEILI_MASTER_KEY 命名）。 */
export function createMeilisearchSearchFromEnv(): MeilisearchSearch {
  const host = (process.env.MEILI_HOST ?? process.env.MEILI_URL ?? '').replace(/\/+$/, '');
  if (host === '') {
    throw new Error('SEARCH_PROVIDER=meilisearch 需要 MEILI_HOST（或 MEILI_URL）环境变量');
  }
  const apiKey = process.env.MEILI_API_KEY ?? process.env.MEILI_MASTER_KEY ?? undefined;
  const indexUid = process.env.MEILI_INDEX_UID || DEFAULT_INDEX_UID;
  const taskTimeoutMs = Number(process.env.MEILI_TASK_TIMEOUT_MS ?? DEFAULT_TASK_TIMEOUT_MS);
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0) {
    throw new Error(`MEILI_TASK_TIMEOUT_MS 必须为正数，实际：${process.env.MEILI_TASK_TIMEOUT_MS}`);
  }
  return new MeilisearchSearch({ host, apiKey, indexUid, taskTimeoutMs });
}
