import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * E2E（issue #27）：详情页的「结构化速读」与「意见提交方式」。
 *
 * 本场景锁定的核心性质是**没有大模型也不断供**：AI 摘要要配密钥、要花钱、要过备案，
 * 任何一项没就绪，页面此前会退化成一句「暂未启用」——读者拿不到任何东西。而征求意见
 * 公告里最有行动价值的信息（意见往哪儿提交）是原文用固定句式写死的，程序就能可靠
 * 摘出来。因此：
 *
 * - LLM 端口不可用时：页面仍要给出原文注明的邮箱 / 在线入口 / 通信地址，且逐条带
 *   原文上下文；速读卡要明确标注「非 AI 生成」（不能让读者误以为是模型输出）；
 * - 抽不到渠道的条目：整块不渲染，分步指引保留通用文案——**不编**一条「通常可通过
 *   电子邮件提出」凑数；
 * - 已有 AI 摘要时：速读卡让位（五段式已覆盖），但提交方式照常渲染——它是原文原句，
 *   比模型叙述更该待在行动位置。
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub 端口。
 * 正文取自交通运输部「意见征集」的真实快照（含「一、登录…二、电子邮箱：…三、通信地址：…」
 * 三段式）与工业和信息化部的无联系方式条目。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-sources');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-brief-'));
const dbFile = path.join(workDir, 'app.db');

/** 有联系方式的条目（交通运输部，正文含在线入口 / 邮箱 / 通信地址三段式）。 */
const MOT_TITLE = '关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知';
/**
 * 无标点连排的条目（工业和信息化部）：正文写作「联系方式：电话：…传真：…地址：…」，
 * 传真与地址之间连逗号都没有，是地址抽取最容易被吞尾的形态。
 */
const MIIT_TITLE = '公开征求对《中华人民共和国无线电频率划分规定（征求意见稿）》的意见';
/** 未知模板的条目（国家能源局）：正文取不到，用于验证「不编渠道、页面不崩」。 */
const UNKNOWN_TEMPLATE_TITLE =
  '国家能源局关于《电力辅助服务市场基本规则（征求意见稿）》公开征求意见的通知';

let app;
let fixtures;

/** 单轮运行真实 worker 子进程（继承 process.env，含 startAppServer 注入的 fixture 源站）。 */
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

/** React SSR 在「文本 + 表达式」混排处插入 <!-- --> 注释，文本断言前剥掉。 */
function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 取指定标题条目的详情页 HTML。 */
async function detailOf(title) {
  const list = await (await fetch(`${app.url}/`)).text();
  const blocks = list.split(/<li class="notice-item"/).slice(1);
  for (const block of blocks) {
    const anchor = /<a[^>]*notice-title-link[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(block);
    if (anchor && anchor[2].trim() === title) {
      const response = await fetch(`${app.url}${anchor[1]}`);
      assert.equal(response.status, 200);
      return stripSsrComments(await response.text());
    }
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

/** 解析出指定渠道类型的所有 <li> 块。 */
function channelBlocks(html, kind) {
  return html
    .split('<li class="channel-item"')
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('</li>')))
    .filter((block) => block.includes(`data-channel-kind="${kind}"`));
}

/** 取渠道块里的「值」本身（不含下方的原文上下文片段）。 */
function channelValue(block) {
  const match = /<span class="channel-value">([^<]*)<\/span>|<a class="channel-value"[^>]*>([^<]*)<\/a>/.exec(
    block,
  );
  assert.ok(match, `渠道块应含 channel-value，实际：${block}`);
  return (match[1] ?? match[2]).trim();
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  const fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'glm',
      GLM_API_KEY: '',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: path.join(workDir, 'outbox.jsonl'),
      FIXTURES_DIR: fixturesDir,
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
    },
  });

  // 抓取一轮入库（摘要任务因端口不可用而跳过，正是当前生产状态）。
  const run = await runWorkerOnce();
  assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #27：LLM 未配置时，详情页不再断供（提交方式来自原文）', () => {
  it('原文注明的三种渠道都渲染出来（在线入口 / 邮箱 / 通信地址）', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MOT_TITLE);

    assert.match(detail, /data-testid="submission-channels"/, '应渲染提交方式块');
    assert.equal(channelBlocks(detail, 'online').length, 1);
    assert.equal(channelBlocks(detail, 'email').length, 1);
    assert.equal(channelBlocks(detail, 'address').length, 1);
  });

  it('邮箱带 mailto、网址可点击、地址为纯文本', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MOT_TITLE);

    const email = channelBlocks(detail, 'email')[0];
    assert.match(email, /href="mailto:glfzqyj@mot\.gov\.cn"/);
    assert.match(email, /glfzqyj@mot\.gov\.cn/);

    const online = channelBlocks(detail, 'online')[0];
    assert.match(online, /href="https:\/\/www\.mot\.gov\.cn"/);
    assert.match(online, /target="_blank"/);

    const address = channelBlocks(detail, 'address')[0];
    assert.match(address, /北京市东城区建国门内大街11号/);
    assert.ok(!/<a[^>]*href/.test(address), '通信地址不是链接');
  });

  it('每条渠道都附原文上下文片段（读者可核对，本站不改写）', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MOT_TITLE);

    assert.match(
      detail,
      /原文：一、登录交通运输部政府网站（网址：https:\/\/www\.mot\.gov\.cn）/,
    );
    assert.match(detail, /原文：二、电子邮箱：glfzqyj@mot\.gov\.cn/);
    assert.match(detail, /原文：三、通信地址：北京市东城区建国门内大街11号/);
  });

  it('速读卡明确标注「非 AI 生成」，首段逐字摘自原文', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MOT_TITLE);

    assert.match(detail, /data-testid="notice-brief"/);
    assert.match(detail, /非 AI 生成/);
    assert.match(detail, /data-testid="brief-lead"/);
    assert.match(detail, /为深入贯彻落实党的二十届三中全会/);
  });

  it('速读卡给出文件名称与原文分条要点（逐字，不改写）', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MOT_TITLE);

    assert.match(detail, /data-testid="brief-document-name"/);
    assert.match(detail, /《中华人民共和国公路法（修正草案征求意见稿）》/);
    assert.match(detail, /data-testid="brief-key-items"/);
    assert.match(detail, /进入首页右侧的“互动”栏“意见征集”，提出意见建议。/);
  });

  it('分步指引按实际渠道收敛：不再泛泛说「通常可通过…」', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MOT_TITLE);

    assert.match(detail, /本公示已在原文中注明具体提交方式/);
    assert.ok(
      !detail.includes('通常可通过在线表单、电子邮件或信函提出'),
      '已抽到渠道时不应再给通用猜测文案',
    );
  });

  it('AI 摘要不可用的说明与速读卡并存，且指向上方速读（不是死胡同）', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MOT_TITLE);

    assert.match(detail, /data-testid="summary-unavailable"/);
    assert.ok(!detail.includes('summary-placeholder'), '不可用时不显示「生成中」');
    assert.match(detail, /由程序从官方原文逐字摘录、不依赖大模型/);
  });
});

describe('issue #27：无标点连排的渠道也能逐条抽出（工业和信息化部真实写法）', () => {
  it('「联系方式：电话：…传真：…地址：…」三段都抽到，电话传真可拨号', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MIIT_TITLE);

    assert.equal(channelBlocks(detail, 'phone').length, 1);
    assert.match(channelBlocks(detail, 'phone')[0], /href="tel:01068206251"/);
    assert.equal(channelBlocks(detail, 'fax').length, 1);
    assert.match(channelBlocks(detail, 'fax')[0], /href="tel:01068206220"/);
    assert.equal(channelBlocks(detail, 'address').length, 1);
  });

  it('地址在邮编括号处收尾，不把后面的「邮寄时请在信封上注明…」吞进地址', async () => {
    useUnavailableLlm();
    const detail = await detailOf(MIIT_TITLE);

    // 注意断言的是**地址值**本身：上下文片段里当然会出现「邮寄时请在信封上注明」
    // （那是原文原句，设计如此），被吞进地址值的只有邮编之后那半句。
    const address = channelValue(channelBlocks(detail, 'address')[0]);
    assert.equal(address, '北京市西城区西长安街13号 工业和信息化部无线电管理局（邮编：100804）');
    assert.ok(!address.includes('邮寄时请在信封上注明'), '邮编之后是收尾语，不属于地址');
  });
});

describe('issue #27：抽不到渠道时不编造', () => {
  it('正文未取到的条目（未知模板）：渠道块不渲染，指引保留通用文案', async () => {
    useUnavailableLlm();
    const detail = await detailOf(UNKNOWN_TEMPLATE_TITLE);

    assert.ok(!detail.includes('submission-channels'), '无渠道时不应渲染该块');
    assert.match(detail, /通常可通过在线表单、电子邮件或信函提出/);
    // 抽不到渠道也不该让页面崩：摘要区说明照常在
    assert.match(detail, /data-testid="summary-unavailable"/);
  });
});

describe('issue #46：统计页把「未参与统计的条数」说清楚', () => {
  it('公示期分布：差额按条数说出，且与「收录总数 − 四桶之和」一致', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/stats`)).text());
    const total = Number(/data-testid="stats-total-notices">(\d+)</.exec(html)[1]);
    // 非零桶的计数自 issue #47 起是钻取链接 —— 取数字前先剥标签
    const buckets = [
      ...html.matchAll(/data-bucket="[^"]+"[\s\S]{0,400}?period-count">([\s\S]*?)<\/span>/g),
    ].map((match) => Number(/(\d+)/.exec(match[1].replace(/<[^>]*>/g, ''))?.[1] ?? 0));
    assert.equal(buckets.length, 4, '应有四个分布桶');

    const sum = buckets.reduce((acc, n) => acc + n, 0);
    const excluded = total - sum;
    assert.ok(
      excluded > 0,
      `本 fixture 含未标注截止日期的条目，差额应大于 0（total=${total} sum=${sum}）`,
    );
    assert.match(
      html,
      new RegExp(`另有 ${excluded} 条未标注截止日期`),
      '页面必须把差额按条数说出来，否则读者无法判断 178 与 176 的差是规则排除还是漏统计',
    );
    assert.match(html, /四桶之和因此小于收录总数/);
  });
});

describe('issue #27：有 AI 摘要时的分工', () => {
  it('速读卡让位给五段式摘要，提交方式照常渲染', async () => {
    useAvailableLlm();
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);

    const detail = await detailOf(MOT_TITLE);
    assert.match(detail, /data-testid="summary-what"/, '应有五段式摘要');
    assert.match(detail, /data-testid="ai-disclaimer"/);
    assert.ok(!detail.includes('notice-brief'), '有摘要时速读卡不重复展示');
    assert.ok(!detail.includes('summary-unavailable'));
    assert.match(detail, /data-testid="submission-channels"/, '提交方式与摘要无关，仍在');
    assert.match(detail, /href="mailto:glfzqyj@mot\.gov\.cn"/);
  });
});

describe('issue #39：详情页结构化数据（JSON-LD）', () => {
  /**
   * 结构化数据最怕「机器读到的」与「读者看到的」不是一回事，所以这里的断言全部是
   * **从页面可见内容反查 JSON-LD**：字段值必须等于同一页上渲染出来的值，而不是等于
   * 测试里另写一遍的期望串。
   */
  /** 取出 JSON-LD 脚本块（解析失败即失败）。 */
  function jsonLdOf(html) {
    const match = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, '详情页应输出 JSON-LD 脚本块');
    return { raw: match[1], doc: JSON.parse(match[1]) };
  }

  /** 详情字段值（「发布机关 / 截止日期」等，按 dt 文本取相邻 dd）。 */
  function fieldOf(html, label) {
    const match = new RegExp(`<dt>${label}</dt>\\s*<dd>([^<]*)</dd>`).exec(html);
    assert.ok(match, `详情页应有「${label}」字段`);
    return match[1].trim();
  }

  it('JSON-LD 可解析，且每个字段都与页面上可见的内容一致', async () => {
    useUnavailableLlm();
    const html = await detailOf(MOT_TITLE);
    const { doc } = jsonLdOf(html);

    assert.equal(doc['@context'], 'https://schema.org');
    assert.equal(doc['@type'], 'Article', '本页是文档页，不是 Event / GovernmentService');
    assert.equal(doc.headline, MOT_TITLE, 'headline = 页面标题');
    assert.equal(doc.inLanguage, 'zh-CN');
    assert.equal(doc.publisher.name, '主人翁');
    assert.ok(doc.description.startsWith('征求意见中 · 截止 '), 'description = 页面 meta 摘要');

    assert.equal(doc.author.name, fieldOf(html, '发布机关'), 'author = 页面「发布机关」');
    assert.equal(doc.datePublished, fieldOf(html, '发布日期'));
    assert.equal(doc.expires, fieldOf(html, '截止日期'), 'expires = 页面「截止日期」');
    assert.deepEqual(
      doc.additionalProperty,
      [{ '@type': 'PropertyValue', name: '征求意见截止日期', value: fieldOf(html, '截止日期') }],
      '截止日期另用 additionalProperty 逐字给一份（消费方不必猜 expires 的含义）',
    );

    const badge = /data-testid="notice-status-badge"[^>]*>([^<]*)</.exec(html)?.[1];
    assert.equal(doc.creativeWorkStatus, badge, 'creativeWorkStatus = 页面状态徽标');

    const official = /data-testid="official-url"[^>]*>([^<]*)</.exec(html)?.[1];
    assert.equal(doc.isBasedOn, official, 'isBasedOn = 页面「官方原文」链接');

    assert.match(doc.url, /^https:\/\/zw\.test\/notices\/[0-9a-f]+$/);
    assert.ok(
      html.includes(`rel="canonical" href="${doc.url}"`),
      'JSON-LD 的 url 应与 canonical 同一取值',
    );
    assert.deepEqual(doc.about, [
      { '@type': 'Legislation', name: '《中华人民共和国公路法（修正草案征求意见稿）》' },
    ]);
  });

  it('脚本块里没有裸 `<`（标题 / 正文里的尖括号不会提前闭合脚本）', async () => {
    const { raw } = jsonLdOf(await detailOf(MOT_TITLE));
    assert.ok(!raw.includes('<'), '渲染出来的 JSON-LD 必须把 `<` 写成 \\u003c');
  });

  it('取不到的字段整个省略：无截止日期的条目没有 expires，但仍给出法规与发布日期', async () => {
    useUnavailableLlm();
    const html = await detailOf(UNKNOWN_TEMPLATE_TITLE);
    const { doc } = jsonLdOf(html);

    assert.equal(fieldOf(html, '截止日期'), '未标注', '该条目正文未取到，没有截止日期');
    assert.equal('expires' in doc, false, '取不到截止日期时整个属性省略（不写 null）');
    assert.equal('additionalProperty' in doc, false);
    // 同一份 JSON-LD 里，取到的字段照常输出
    assert.equal(doc.datePublished, fieldOf(html, '发布日期'));
    assert.deepEqual(doc.about, [
      { '@type': 'Legislation', name: '《电力辅助服务市场基本规则（征求意见稿）》' },
    ]);
  });
});
