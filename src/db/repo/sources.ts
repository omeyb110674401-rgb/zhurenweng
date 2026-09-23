import { asc, eq } from 'drizzle-orm';
import { getDb } from '../client.ts';
import { sources } from '../schema/sqlite.ts';
import type { SourceRecord } from '../types.ts';
import {
  SOURCE_UNHEALTHY_AFTER_CONSECUTIVE_FAILURES,
  isSourceUnhealthy,
} from '../../lib/source-health.ts';

/**
 * 抓取管线维护的源登记信息。
 *
 * 三个入口刻意分开（issue #58）：原先 `upsertSource` 一个函数两用 —— 轮初拿它「乐观置
 * 健康」，成功时再拿它记成功时间。于是抓取失败的源在这一轮开头就被写成 healthy=true，
 * 而 `recordSourceFailure` 在调用点带着 `.catch(() => {})`：那条写一旦失败被吞掉，
 * 源就整天假绿。登记行、记账成功、记账失败是三件事，各自只有一个入口。
 */
export interface SourceIdentity {
  id: string;
  name: string;
  adapterType: string;
}

/** 三个入口共用的行形状（读-改-写要用的列）。 */
const SOURCE_ROW_COLUMNS = {
  id: sources.id,
  consecutiveFailures: sources.consecutiveFailures,
  lastErrorMessage: sources.lastErrorMessage,
} as const;

type SourceRow = { id: string; consecutiveFailures: number; lastErrorMessage: string | null };

async function findSourceRow(db: Awaited<ReturnType<typeof getDb>>, id: string): Promise<SourceRow | undefined> {
  const rows = await db
    .select(SOURCE_ROW_COLUMNS)
    .from(sources)
    .where(eq(sources.id, id))
    .limit(1);
  return rows[0];
}

/**
 * 保证源行存在（`notices.source_id` 的外键前提）。**不碰健康、计数与错误列** ——
 * 「本轮先乐观标健康、失败再翻回来」就是假绿窗口的来源。
 */
export async function registerSource(input: SourceIdentity): Promise<void> {
  const db = await getDb();
  if (await findSourceRow(db, input.id)) return;
  await db.insert(sources).values({ ...input, healthy: 1, consecutiveFailures: 0 });
}

/** 本轮抓取成功：判健康、连续失败计数归零、清掉当前故障态的错误信息，并记成功时间。 */
export async function recordSourceSuccess(
  input: SourceIdentity & { now: string },
): Promise<void> {
  const db = await getDb();
  const patch = {
    name: input.name,
    adapterType: input.adapterType,
    healthy: 1,
    consecutiveFailures: 0,
    lastSuccessAt: input.now,
    lastErrorMessage: null,
    lastErrorAt: null,
  };
  if (await findSourceRow(db, input.id)) {
    await db.update(sources).set(patch).where(eq(sources.id, input.id));
    return;
  }
  await db.insert(sources).values({ id: input.id, ...patch });
}

/**
 * 本轮抓取失败：连续失败计数 +1，并按 `isSourceUnhealthy` 的门槛决定这一行是否判红。
 *
 * @param immediateUnhealthy 数据质量降级（issue #51 的「一轮内过半条目失败」）走这条：
 *   它不是抖动而是事件，必须当场判红，于是把计数钳到门槛而不是留在线上慢慢数。
 * @returns 新的计数、是否判红，以及**上一次的**错误原文 —— 后者用来把连续故障的来路
 *   写进这一封邮件：错误列现在成功即清，跨轮的历史只能这样带一句。
 */
export async function recordSourceFailure(
  input: SourceIdentity & { error: string; now: string; immediateUnhealthy?: boolean },
): Promise<{
  consecutiveFailures: number;
  unhealthy: boolean;
  previousErrorMessage: string | null;
}> {
  const db = await getDb();
  const existing = await findSourceRow(db, input.id);
  const counted = (existing?.consecutiveFailures ?? 0) + 1;
  const consecutiveFailures =
    input.immediateUnhealthy === true
      ? Math.max(counted, SOURCE_UNHEALTHY_AFTER_CONSECUTIVE_FAILURES)
      : counted;
  const unhealthy = isSourceUnhealthy(consecutiveFailures);

  const patch = {
    name: input.name,
    adapterType: input.adapterType,
    healthy: unhealthy ? 0 : 1,
    consecutiveFailures,
    lastErrorMessage: input.error,
    lastErrorAt: input.now,
  };
  if (existing) {
    await db.update(sources).set(patch).where(eq(sources.id, input.id));
  } else {
    await db.insert(sources).values({ id: input.id, ...patch });
  }
  return { consecutiveFailures, unhealthy, previousErrorMessage: existing?.lastErrorMessage ?? null };
}

/** 全量源列表（管理后台源健康看板用），按源 ID 排序保证展示稳定。 */
export async function listSources(): Promise<SourceRecord[]> {
  const db = await getDb();
  const rows = await db.select().from(sources).orderBy(asc(sources.id));
  return rows.map(toSourceRecord);
}

/** 按源 ID 取源记录；不存在返回 null（详情页展示来源名称用）。 */
export async function getSourceById(id: string): Promise<SourceRecord | null> {
  const db = await getDb();
  const rows = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  return rows.length > 0 ? toSourceRecord(rows[0]) : null;
}

/** 源启用 / 停用（issue #12 源管理：停用后抓取任务跳过该源）。源不存在返回 false。 */
export async function setSourceEnabled(id: string, enabled: boolean): Promise<boolean> {
  const db = await getDb();
  const existing = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.id, id))
    .limit(1);
  if (existing.length === 0) return false;
  await db.update(sources).set({ enabled: enabled ? 1 : 0 }).where(eq(sources.id, id));
  return true;
}

function toSourceRecord(row: typeof sources.$inferSelect): SourceRecord {
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    healthy: row.healthy === 1,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorMessage: row.lastErrorMessage,
    lastErrorAt: row.lastErrorAt,
    enabled: row.enabled === 1,
  };
}
