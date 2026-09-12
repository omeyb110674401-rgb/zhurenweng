import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * E2E（issue #12）：管理后台与健康告警。
 *
 * 测试装置：只复制 npc 源的 fixture 快照到临时目录 —— moj / govcn 两个源
 * 在 fixture 源站上 404，天然构造「部分源失败」的抓取局面：
 *   → 源健康看板展示 npc 健康（有最近成功时间）、moj/govcn 异常（有最近错误）；
 *   → 每个失败源触发告警邮件（stub 经 MAILER_OUTBOX_FILE 捕获），同日重复失败去重；
 *   → stub LLM 注入失败（LLM_STUB_FAILURES=always）→ failed_review 条目出现在
 *     复核队列 → 重置重试（stub 恢复）后摘要自动补齐；或人工编辑摘要直接保存 done；
 *   → 手动补录条目走与爬虫相同的入库 / 摘要 / 检索索引管线。
 *
 * 访问保护：ADMIN_TOKEN 经环境变量注入；未带 token 返回 401 引导页，登录后
 * 以会话 Cookie（或 ?token= 查询参数）访问。全程零外部依赖（ADR-0001）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue12-'));
const dbFile = path.join(workDir, 'app.db');
const outboxFile = path.join(workDir, 'outbox.jsonl');
const callsFile = path.join(workDir, 'llm-calls.jsonl');
const tempFixturesDir = path.join(workDir, 'fixtures');

const ADMIN_TOKEN = 'zw-e2e-admin-token';
const ALERT_EMAIL = 'ops@zhurenweng.example';

/** 手动补录条目（标题带唯一标记，供列表 / 检索断言） */
const MANUAL_TITLE = '城镇供水价格管理办法（试行）（人工补录验证版）征求意见';
const MANUAL_URL = 'https://www.example.gov/manual/e2e-issue12-entry';
const MANUAL_BODY = '人工补录验证正文：为规范城镇供水价格行为，现将办法（试行）全文公开征求意见。';

let app;
let fixtures;
let cookie;

function isoDatePlus(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 单轮运行真实 worker 子进程，extraEnv 仅注入本次运行。返回 { code, output }。 */
function runWorkerOnce(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1', ...extraEnv },
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

/** stub 邮件捕获文件 → 邮件对象数组（JSONL）。 */
function readOutbox() {
  if (!fs.existsSync(outboxFile)) return [];
  return fs
    .readFileSync(outboxFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** GET /admin（可选 query 与会话 Cookie），不自动跟随重定向。 */
function getAdmin(query = '', useCookie = true) {
  return fetch(`${app.url}/admin${query}`, {
    redirect: 'manual',
    headers: useCookie && cookie ? { cookie } : {},
  });
}

/** POST 表单到 /admin 下的端点，默认携带会话 Cookie。 */
function postAdmin(pathname, params, useCookie = true) {
  return fetch(`${app.url}${pathname}`, {
    method: 'POST',
    body: new URLSearchParams(params),
    redirect: 'manual',
    headers: useCookie && cookie ? { cookie } : {},
  });
}

/** 复核队列条目：[{ id, title }]（按页面展示顺序）。 */
function extractReviewItems(html) {
  return [...html.matchAll(/data-testid="review-item-link" href="\/notices\/([0-9a-f]+)"[^>]*>([^<]+)</g)].map(
    (match) => ({ id: match[1], title: match[2].trim() }),
  );
}

/** 断言 alert 邮件（按 任务 × 源 计数）。source 为 null 表示任务级告警。 */
function countAlerts(alerts, jobName, source) {
  return alerts.filter((mail) => {
    if (!mail.subject.includes(`任务失败告警：${jobName}（源：`)) return false;
    if (source === null) return mail.subject.includes('（源：—）');
    return mail.subject.includes(`（${source}）`);
  }).length;
}

before(async () => {
  // 只复制 npc 源 fixture：moj / govcn 缺失 → fixture 源站 404 → 抓取失败告警
  fs.cpSync(path.join(repoRoot, 'fixtures', 'npc'), path.join(tempFixturesDir, 'npc'), {
    recursive: true,
  });

  fixtures = createFixtureServer({ fixturesDir: tempFixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      LLM_STUB_CALLS_FILE: callsFile,
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: outboxFile,
      ADMIN_TOKEN,
      ALERT_EMAIL,
      SUMMARY_RETRY_DELAY_MS: '10',
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #12：管理后台与健康告警', () => {
  it('访问保护：未带 token 返回 401 引导页，登录成功后可访问；错误 token 恒为 401', async () => {
    // 未配置场景的前置自洽：已配置 ADMIN_TOKEN（见 before），先验证匿名访问
    let response = await getAdmin('', false);
    assert.equal(response.status, 401);
    let html = await response.text();
    assert.match(html, /data-testid="admin-login-form"/, '401 页展示登录表单');
    assert.match(html, /管理后台/, '401 页是引导页而非空白');

    // 错误 token：查询参数与登录表单两条路径都 401
    response = await getAdmin('?token=wrong-token', false);
    assert.equal(response.status, 401);
    response = await fetch(`${app.url}/admin/login`, {
      method: 'POST',
      body: new URLSearchParams({ token: 'wrong-token' }),
      redirect: 'manual',
    });
    assert.equal(response.status, 401);
    html = await response.text();
    assert.match(html, /data-testid="admin-login-error"/, '登录失败提示');

    // 正确登录：303 回 /admin + 下发会话 Cookie
    response = await fetch(`${app.url}/admin/login`, {
      method: 'POST',
      body: new URLSearchParams({ token: ADMIN_TOKEN }),
      redirect: 'manual',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin');
    const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('zw_admin_session='));
    assert.ok(setCookie, '登录成功下发会话 Cookie');
    assert.match(setCookie, /HttpOnly/, '会话 Cookie 为 HttpOnly');
    assert.match(setCookie, /SameSite=Lax/, '会话 Cookie 为 SameSite=Lax');
    cookie = setCookie.split(';')[0];

    // 会话 Cookie 与 ?token= 两条路径都能访问看板
    response = await getAdmin('');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-testid="admin-dashboard"/);

    response = await getAdmin(`?token=${encodeURIComponent(ADMIN_TOKEN)}`, false);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-testid="admin-dashboard"/);

    // 退出登录：清除 Cookie 后回到 401
    response = await postAdmin('/admin/logout', {});
    assert.equal(response.status, 303);
    const cleared = response.headers.getSetCookie().find((value) => value.startsWith('zw_admin_session='));
    assert.match(cleared ?? '', /Max-Age=0/, '退出下发即刻过期的 Cookie');
    cookie = undefined;
    response = await getAdmin('', false);
    assert.equal(response.status, 401);

    // 重新登录，供后续场景使用
    response = await fetch(`${app.url}/admin/login`, {
      method: 'POST',
      body: new URLSearchParams({ token: ADMIN_TOKEN }),
      redirect: 'manual',
    });
    cookie = response.headers.getSetCookie().find((value) => value.startsWith('zw_admin_session='))?.split(';')[0];
    assert.ok(cookie, '重新登录成功');
  });

  it('失败告警：抓取失败（moj/govcn 404）与摘要失败（stub 注入）各触发一封告警邮件', async () => {
    const first = await runWorkerOnce({ LLM_STUB_FAILURES: 'always' });
    assert.equal(first.code, 0, `worker 应正常退出，输出：${first.output}`);
    assert.match(first.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);
    assert.equal((first.output.match(/源 (moj|govcn) 抓取失败/g) ?? []).length, 2, '两个缺失 fixture 的源抓取失败');
    assert.match(first.output, /摘要任务完成：成功 0 条，转人工复核 2 条/);
    assert.match(first.output, /任务失败告警已发送/, '告警发送日志');

    const alerts = readOutbox();
    assert.equal(alerts.length, 3, `应为 3 封告警（crawl×moj、crawl×govcn、summarize×npc），实际 ${alerts.length}`);
    for (const mail of alerts) {
      assert.equal(mail.to, ALERT_EMAIL, '告警收件人是 ALERT_EMAIL');
      assert.match(mail.subject, /【主人翁】任务失败告警：/);
      assert.match(mail.text, /错误摘要：/, '告警正文含错误摘要');
    }
    assert.equal(countAlerts(alerts, 'crawl-notices', 'moj'), 1);
    assert.equal(countAlerts(alerts, 'crawl-notices', 'govcn'), 1);
    assert.equal(countAlerts(alerts, 'summarize-notices', 'npc'), 1);
    const crawlAlert = alerts.find((mail) => mail.subject.includes('crawl-notices（源：'));
    assert.match(crawlAlert.text, /HTTP 404/, '告警正文含失败原因');
  });

  it('源健康看板：展示各源最近成功时间与最近错误（fixture 抓取后）', async () => {
    const response = await getAdmin();
    assert.equal(response.status, 200);
    const html = await response.text();

    const npcRow = /data-testid="source-health-row" data-source-id="npc"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
    assert.ok(npcRow, '看板包含 npc 源行');
    assert.match(npcRow, /data-field="status">健康</, 'npc 抓取成功 → 健康');
    assert.match(
      npcRow,
      /data-field="last-success"><span class="mono">\d{4}-\d{2}-\d{2}T/,
      'npc 有最近成功抓取时间（ISO 8601）',
    );
    assert.match(npcRow, /data-field="enabled">启用</, 'npc 处于启用状态');

    const mojRow = /data-testid="source-health-row" data-source-id="moj"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
    assert.ok(mojRow, '看板包含 moj 源行');
    assert.match(mojRow, /data-field="status">异常</, 'moj 抓取失败 → 异常');
    const lastError = /data-field="last-error">([^<]+)</.exec(mojRow)?.[1] ?? '';
    assert.match(lastError, /HTTP 404/, 'moj 展示最近错误信息');
    assert.match(
      mojRow,
      /data-field="last-error-at"><span class="mono">\d{4}-\d{2}-\d{2}T/,
      'moj 有最近错误时间',
    );
  });

  it('复核队列：失败条目出现在队列 → 重置重试（stub 恢复）→ 摘要自动补齐', async () => {
    let html = await (await getAdmin()).text();
    const items = extractReviewItems(html);
    assert.equal(items.length, 2, '两个失败摘要条目进入复核队列');
    assert.ok(items.some((item) => item.title.includes('医疗保障法')), '队列含失败条目标题');
    assert.match(html, /data-testid="review-queue"/, '队列区块渲染');

    const target = items.find((item) => item.title.includes('医疗保障法'));
    const reset = await postAdmin('/admin/review', { noticeId: target.id, action: 'reset' });
    assert.equal(reset.status, 303);
    assert.equal(reset.headers.get('location'), '/admin?ok=review_reset');

    html = await (await getAdmin('?ok=review_reset')).text();
    assert.match(html, /已重置为待生成/, '重置成功横幅');
    assert.equal(extractReviewItems(html).length, 1, '重置后队列只剩另一条');

    // 重置后回到 pending：详情页显示普通「摘要生成中」占位，无待复核标注
    const detailPending = await (await fetch(`${app.url}/notices/${target.id}`)).text();
    assert.match(detailPending, /摘要生成中/);
    assert.ok(!detailPending.includes('待人工复核'), '重置后不再是待复核占位');

    // stub LLM 恢复正常 → 下一轮摘要任务自动补齐
    const retry = await runWorkerOnce();
    assert.equal(retry.code, 0, `worker 应正常退出，输出：${retry.output}`);
    assert.match(retry.output, /摘要任务完成：成功 1 条，转人工复核 0 条/);

    const detail = await (await fetch(`${app.url}/notices/${target.id}`)).text();
    assert.match(detail, /data-testid="ai-summary"/, '重置重试后摘要生成完成');
    assert.match(detail, /【stub】这是一份政府公示征求意见稿（固定测试摘要）。/);
    assert.ok(!detail.includes('摘要生成中'), '占位消失');

    html = await (await getAdmin()).text();
    assert.ok(!extractReviewItems(html).some((item) => item.id === target.id), '复核后条目离开队列');
  });

  it('复核队列：直接编辑摘要文本保存为 done，详情页立即展示人工摘要', async () => {
    const html = await (await getAdmin()).text();
    const items = extractReviewItems(html);
    assert.equal(items.length, 1, '剩余一条待复核条目');
    const target = items[0];

    const save = await postAdmin('/admin/review', {
      noticeId: target.id,
      action: 'save',
      what: '【人工】这是医疗保障法草案的征求意见公告。',
      who: '【人工】受草案影响的医疗保障参保人与定点医药机构。',
      keyPoints: '【人工】第一条 规范医疗保障关系\n【人工】第二条 健全多层次保障体系',
      deadline: isoDatePlus(20),
      howToComment: '【人工】请前往中国人大网征求意见页面提交意见。',
    });
    assert.equal(save.status, 303);
    assert.equal(save.headers.get('location'), '/admin?ok=review_saved');

    const after = await (await getAdmin('?ok=review_saved')).text();
    assert.match(after, /已保存人工摘要/, '保存成功横幅');
    assert.match(after, /data-testid="review-queue-empty"/, '队列清空');
    assert.ok(!after.includes('data-testid="review-queue-item"'), '无残留待复核条目');

    const detail = await (await fetch(`${app.url}/notices/${target.id}`)).text();
    assert.match(detail, /data-testid="ai-summary"/, '详情页渲染人工摘要');
    assert.match(detail, /【人工】这是医疗保障法草案的征求意见公告。/, '人工摘要内容（这是什么）');
    assert.match(detail, /【人工】第二条 健全多层次保障体系/, '人工摘要关键条款');
    assert.match(detail, /摘要模型：manual/, '人工摘要与自动摘要可区分');
    assert.ok(!detail.includes('摘要生成中'), '占位消失');
  });

  it('手动补录：条目出现在列表页并走完整管线（摘要 + 检索索引），URL 幂等去重', async () => {
    const deadline = isoDatePlus(30);
    const post = await postAdmin('/admin/notices', {
      title: MANUAL_TITLE,
      agency: '国家发展和改革委员会（人工补录）',
      url: MANUAL_URL,
      publishedAt: isoDatePlus(-3),
      deadlineAt: deadline,
      bodyText: MANUAL_BODY,
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.get('location'), '/admin?ok=notice_inserted');

    const html = await (await getAdmin('?ok=notice_inserted')).text();
    assert.match(html, /补录条目已入库/, '补录成功横幅');

    // 条目 id 与爬虫同规则（原文 URL 的 SHA-256 前缀），可直达详情页
    const id = createHash('sha256').update(MANUAL_URL).digest('hex').slice(0, 16);
    const detailResponse = await fetch(`${app.url}/notices/${id}`);
    assert.equal(detailResponse.status, 200, `详情页应存在（id=${id}）`);
    const detail = await detailResponse.text();
    assert.match(detail, new RegExp(MANUAL_TITLE), '详情页含补录标题');
    assert.match(detail, /摘要生成中/, '入库后摘要列为 pending（走同一摘要管线）');

    // 入库即同步检索索引：补录条目即刻可被检索命中（与爬虫相同的索引钩子）
    const searchHtml = await (await fetch(`${app.url}/search?q=${encodeURIComponent('人工补录验证版')}`)).text();
    assert.match(searchHtml, /data-testid="search-query-text"/);
    assert.ok(!searchHtml.includes('data-testid="search-empty-state"'), '检索应命中补录条目');
    assert.match(searchHtml, new RegExp(MANUAL_TITLE), '搜索结果展示补录条目');

    // 看板出现专用源「manual（人工补录）」，最近成功时间 = 本次补录时间
    const adminHtml = await (await getAdmin()).text();
    const manualRow = /data-testid="source-health-row" data-source-id="manual"[\s\S]*?<\/tr>/.exec(adminHtml)?.[0] ?? '';
    assert.ok(manualRow, '看板包含人工补录源行');
    assert.match(manualRow, /data-field="last-success">\d{4}-\d{2}-\d{2}T/);

    // 摘要任务下一轮自动补齐 AI 摘要（stub）
    const workerRun = await runWorkerOnce();
    assert.equal(workerRun.code, 0, `worker 应正常退出，输出：${workerRun.output}`);
    assert.match(workerRun.output, /摘要任务完成：成功 1 条，转人工复核 0 条/);
    const detailAfter = await (await fetch(`${app.url}/notices/${id}`)).text();
    assert.match(detailAfter, /data-testid="ai-summary"/, '补录条目自动获得 AI 摘要');
    assert.match(detailAfter, /【stub】/, '摘要来自摘要任务（stub 基准文案）');

    // 列表页展示补录条目（按截止日期排序，30 天后截止应在列表中）
    const listHtml = await (await fetch(`${app.url}/`)).text();
    assert.match(listHtml, new RegExp(MANUAL_TITLE), '补录条目出现在列表页');

    // 幂等：同一原文 URL 再次补录 → 更新而非重复入库
    const again = await postAdmin('/admin/notices', {
      title: `${MANUAL_TITLE}（更新）`,
      agency: '国家发展和改革委员会（人工补录）',
      url: MANUAL_URL,
      publishedAt: isoDatePlus(-3),
      deadlineAt: deadline,
      bodyText: MANUAL_BODY,
    });
    assert.equal(again.status, 303);
    assert.equal(again.headers.get('location'), '/admin?ok=notice_updated', '同 URL 幂等更新');

    // 表单校验：缺必填与非法 URL 各自被拦截
    const missing = await postAdmin('/admin/notices', { title: '', agency: '', url: '' });
    assert.equal(missing.headers.get('location'), '/admin?error=missing_fields');
    const badUrl = await postAdmin('/admin/notices', { title: 't', agency: 'a', url: 'ftp://example.gov/x' });
    assert.equal(badUrl.headers.get('location'), '/admin?error=invalid_url');
  });

  it('告警去重：同一天同一源同一任务重复失败不再发；任务级失败同样去重', async () => {
    const outboxBefore = readOutbox().length;
    assert.ok(outboxBefore >= 3, '前置：此前已有 3 封告警');

    // 重复失败一轮（moj/govcn 再 404；npc 无待摘要条目 → 无新摘要失败）
    const repeat = await runWorkerOnce({ LLM_STUB_FAILURES: 'always' });
    assert.equal(repeat.code, 0, `worker 应正常退出，输出：${repeat.output}`);
    assert.equal((repeat.output.match(/源 (moj|govcn) 抓取失败/g) ?? []).length, 2, '重复失败确实发生');
    assert.match(repeat.output, /告警去重：.+当日已发过，跳过/, '去重日志');
    assert.equal(readOutbox().length, outboxBefore, '同日同源同任务重复失败不再发邮件');

    // 任务级失败：SEARCH_PROVIDER 非法使 reindex-notices 整任务抛错 → 告警一封
    const jobLevel = await runWorkerOnce({ SEARCH_PROVIDER: 'bogus-provider' });
    assert.equal(jobLevel.code, 0, `worker 应正常退出，输出：${jobLevel.output}`);
    assert.match(jobLevel.output, /任务 reindex-notices 失败/, 'reindex 任务失败');
    assert.equal(readOutbox().length, outboxBefore + 1, '任务级失败告警发送一封');
    const alerts = readOutbox();
    assert.equal(countAlerts(alerts, 'reindex-notices', null), 1);
    assert.match(
      alerts[alerts.length - 1].text,
      /未知的 SEARCH_PROVIDER/,
      '任务级告警含错误摘要',
    );

    // 任务级失败再触发 → 同日去重
    await runWorkerOnce({ SEARCH_PROVIDER: 'bogus-provider' });
    assert.equal(readOutbox().length, outboxBefore + 1, '任务级同日重复失败不再发');
  });

  it('源管理：停用源后抓取任务跳过，启用状态在看板即时反映', async () => {
    const disable = await postAdmin('/admin/sources', { id: 'moj', action: 'disable' });
    assert.equal(disable.status, 303);
    assert.equal(disable.headers.get('location'), '/admin?ok=source_updated');

    let html = await (await getAdmin('?ok=source_updated')).text();
    const row = /data-testid="source-health-row" data-source-id="moj"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
    assert.match(row, /data-field="enabled">停用</, '看板展示停用状态');

    const outboxBefore = readOutbox().length;
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 moj 已停用，本轮跳过/, '停用源被抓取任务跳过');
    assert.ok(!run.output.includes('源 moj 抓取失败'), '停用源不产生失败');
    assert.equal(readOutbox().length, outboxBefore, '停用不触发新告警');

    // 恢复启用
    await postAdmin('/admin/sources', { id: 'moj', action: 'enable' });
    html = await (await getAdmin()).text();
    const restored = /data-testid="source-health-row" data-source-id="moj"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
    assert.match(restored, /data-field="enabled">启用</, '恢复启用');

    // 未经授权的写操作一律 401
    const denied = await postAdmin('/admin/sources', { id: 'moj', action: 'disable' }, false);
    assert.equal(denied.status, 401, '未授权 POST 返回 401');
    const deniedReview = await postAdmin(
      '/admin/review',
      { noticeId: 'x', action: 'reset' },
      false,
    );
    assert.equal(deniedReview.status, 401, '未授权复核 POST 返回 401');
  });
});
