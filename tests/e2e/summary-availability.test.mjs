import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeItems } from './helpers/html.mjs';

/**
 * E2E（issue #22）：AI 摘要区的可用性门控。
 *
 * 背景：生产上线时 `LLM_PROVIDER=glm` 但 `GLM_API_KEY` 未配置 —— 摘要任务每轮
 * 构造端口即失败，库里的摘要状态永远停在 pending，详情页因此**永远显示
 * 「摘要生成中」**。那是不诚实的界面状态：承诺一件不会发生的事。门控
 * （src/lib/llm-availability.ts）与 /subscribe 的 mailerReady 同一套路数：
 *
 *   - 本文件：glm 但缺 GLM_API_KEY（= 当前生产状态）→ 摘要区显示「暂未启用」说明，
 *     不显示「生成中」；**已有摘要照常渲染**（绝不隐藏库内内容）；worker 整轮跳过
 *     摘要任务并说明原因（不再每轮记一条「任务失败」）；
 *   - 端口可用（或 LLM_PROVIDER=stub，见 npc-pipeline / summary-pipeline 场景）
 *     → 「生成中」占位与五段式摘要照常；**已截止条目走 #58 新增的「未生成摘要」分支**
 *     （它们被摘要任务的入队条件排除，说「生成中」就是承诺一件不会发生的事）。
 *
 * 两阶段用同一个库：先用 stub 跑一轮（生成摘要），再把端口切成「glm 缺 key」，
 * 断言两种条目（已有摘要 / 未生成摘要）在不可用状态下的表现。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub 端口。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-summary-gate-'));
const dbFile = path.join(workDir, 'app.db');

/** npc fixture 里未截止的两条会被 stub 生成摘要；已截止那条保持 pending。 */
const OPEN_TITLE = '企业破产法（修订草案二次审议稿）征求意见';
const CLOSED_TITLE = '检察公益诉讼法（草案二次审议稿）征求意见';

let app;
let fixtures;

/** 单轮运行 worker 子进程（继承 process.env，含当前 LLM 端口配置）。 */
function runWorkerOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** 从列表页取指定标题条目的详情链接。 */
function hrefOf(html, title) {
  const blocks = noticeItems(html);
  for (const block of blocks) {
    const anchor = /<a[^>]*notice-title-link[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(block);
    if (anchor && anchor[2].trim() === title) return anchor[1];
  }
  throw new Error(`列表页应含条目「${title}」`);
}

/** 切到「glm 端口但缺 API Key」= 当前生产状态。 */
function useUnavailableLlm() {
  process.env.LLM_PROVIDER = 'glm';
  process.env.GLM_API_KEY = '';
}

/** 切回可用端口（stub）。 */
function useAvailableLlm() {
  process.env.LLM_PROVIDER = 'stub';
  delete process.env.GLM_API_KEY;
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: path.join(workDir, 'outbox.jsonl'),
      FIXTURES_DIR: fixturesDir,
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
    },
  });

  // 阶段一：端口可用，跑一轮让未截止条目拿到摘要。
  // 断言不写死条数 —— 本场景用共享 fixtures 根目录（npc / moj / mee 三源），
  // 真正需要的前提只有两条：未截止条目拿到摘要、已截止条目保持无摘要。
  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
  assert.match(run.output, /摘要任务完成：成功 \d+ 条，转人工复核 0 条/);
  assert.ok(!/条目 .* 摘要失败/.test(run.output), 'stub 端口不应有失败条目');
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #22：LLM 端口未配置时的摘要区门控', () => {
  it('端口可用 + 已截止：显示「未生成摘要」，不再谎称「生成中」（issue #58）', async () => {
    useAvailableLlm();
    const list = await (await fetch(`${app.url}/`)).text();
    const detail = await (await fetch(`${app.url}${hrefOf(list, CLOSED_TITLE)}`)).text();

    assert.match(detail, /data-testid="summary-not-generated"/, '已截止且不入库的条目应有专属说明块');
    assert.match(detail, /未生成摘要/);
    assert.ok(
      !detail.includes('摘要生成中'),
      '进行时状态不可信的场景正是这一类：入队条件永不放行',
    );
    assert.ok(!detail.includes('summary-placeholder'), '不复用占位块（它会带回「生成中」）');
    assert.ok(!detail.includes('summary-unavailable'), '端口可用时不该说「暂未启用」');
  });

  it('端口不可用优先于「已截止不生成」：仍显示「暂未启用」说明', async () => {
    useUnavailableLlm();
    const list = await (await fetch(`${app.url}/`)).text();
    const detail = await (await fetch(`${app.url}${hrefOf(list, CLOSED_TITLE)}`)).text();

    assert.match(detail, /data-testid="summary-unavailable"/, '应显示不可用说明块');
    assert.match(detail, /AI 解读尚未启用|暂未启用/, '说明应讲清原因');
    assert.ok(!detail.includes('summary-placeholder'), '不应再显示「生成中」占位（它不会兑现）');
    assert.ok(
      !/本站正在为本条公示生成结构化 AI 摘要/.test(detail),
      '不应出现「正在生成」的进行时文案',
    );
    // 优先级本身也要钉住：这条条目同时满足「端口不可用」与「已截止」，界面只该说前者
    // （端口没配时讨论「这条会不会入队」没有意义）—— 见 summaryDisplayState 的顺序。
    assert.ok(!detail.includes('summary-not-generated'), '不可用一档优先于未生成一档');
  });

  it('端口不可用：已有摘要的条目照常渲染五段式摘要（绝不隐藏库内内容）', async () => {
    useUnavailableLlm();
    const list = await (await fetch(`${app.url}/`)).text();
    const detail = await (await fetch(`${app.url}${hrefOf(list, OPEN_TITLE)}`)).text();

    assert.match(detail, /data-testid="summary-what"/, '已有摘要应照常渲染');
    assert.match(detail, /data-testid="ai-disclaimer"/, 'AI 标注仍在（合规硬性要求）');
    assert.ok(!detail.includes('summary-unavailable'), '有摘要时不应显示不可用说明');
    assert.ok(!detail.includes('summary-placeholder'));
  });

  it('端口不可用：worker 整轮跳过摘要任务并说明原因，不记为任务失败', async () => {
    useUnavailableLlm();
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /LLM 端口未配置[^\n]*本轮跳过摘要任务/);
    assert.ok(
      !/任务 summarize-notices 失败/.test(run.output),
      '配置缺失不应表现为任务失败（会每轮一条失败日志 + 每天一封告警）',
    );
  });

  it('配置补齐后自动恢复：无需改代码，说明块退回各自的真实状态', async () => {
    useAvailableLlm();
    const list = await (await fetch(`${app.url}/`)).text();
    const detail = await (await fetch(`${app.url}${hrefOf(list, CLOSED_TITLE)}`)).text();

    assert.ok(!detail.includes('summary-unavailable'), '端口恢复后「暂未启用」说明应消失');
    // #58 之后恢复到的不是「生成中」，而是这条自己的真实状态：已截止 → 不会再生成
    assert.match(detail, /data-testid="summary-not-generated"/);
    assert.ok(!detail.includes('摘要生成中'), '门控恢复不等于给已截止条目重新承诺进行时');
  });
});
