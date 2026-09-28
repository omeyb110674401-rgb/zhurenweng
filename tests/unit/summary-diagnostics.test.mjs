import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OpenAiCompatibleLlm,
  normalizeModelSummary,
} from '../../src/lib/adapters/openai-compatible-llm.ts';
import { buildQuotedSummary, buildQuotedSummaryWithTally } from '../../src/lib/summary-content.ts';
import { emptyFeedReport } from '../../src/lib/attachment-feed.ts';
import {
  RAW_OUTPUT_KEEP_CHARS,
  SUMMARY_DIAGNOSTICS_VERSION,
  buildSummaryDiagnostics,
  capRawOutput,
  describeDiagnostics,
  diagnosticsOfError,
  emptyFieldCounts,
  parseSummaryDiagnostics,
} from '../../src/lib/summary-diagnostics.ts';

/**
 * 单元：摘要调用的诊断（issue #86 第 0 刀）—— 「模型吐了什么、我们丢了什么、丢在哪一关」。
 *
 * 这一组测试的存在理由不是"新加了一个字段要覆盖"，而是：删掉的「改动点」连续两轮零产出，
 * 而事后**没有任何人能回答**它是"模型返回了空数组"还是"引用反查不过被丢掉"（#79 的教训）。
 * 所以这里钉的是**可区分性**本身：
 * 1. 两个丢弃阶段（归一化 / 反查）分开计数，且计数发生在丢弃那一行旁边（同一份实现，
 *    另写一遍就是让诊断与实际漂移）；
 * 2. `emitted - normalized === emptyOrInvalid + overLimit` 与 `normalized - kept === quoteNotFound`
 *    这两条等式成立 —— 诊断若对不上账，就是在说谎；
 * 3. 端口没上报时必须说"没人看过"（`instrumented: false`），**不许**把"没人看过"
 *    渲染成"模型什么都没说"（同 #82 那次「键在不在 vs 值是多少」的误报）。
 *
 * 全程零网络：假 fetch + 固定响应。
 */

const CONFIG = {
  apiKey: 'secret-key',
  apiBase: 'https://gw.example/v1',
  model: 'flash-x',
  timeoutMs: 1000,
  headers: {},
  providerLabel: 'openai',
};

function fakeResponse({ ok = true, status = 200, body = '', payload = null } = {}) {
  return { ok, status, text: async () => body, json: async () => payload };
}

/** 一条至少 8 字的、真的在 DRAFT 里的引用（反查有 8 字下限，短引用一律不算数）。 */
const DRAFT_QUOTE = '运输机场运营人应当取得许可';
const DRAFT = {
  name: '运输机场运营许可规定（征求意见稿）.docx',
  url: 'https://www.gov.cn/draft.docx',
  text: `第一条 为了规范运输机场运营许可，制定本规定。第二条 ${DRAFT_QUOTE}。`,
};
const EXPLANATION_QUOTE = '本标准为修订标准主要修改内容如下';
const EXPLANATION = {
  name: '编制说明.docx',
  url: 'https://www.gov.cn/explanation.docx',
  text: `一、项目概况 ${EXPLANATION_QUOTE}，其余为编辑性修改。`,
  role: 'explanation',
};
/** 一定反查不到的引用（够长、也够像真的） */
const ABSENT_QUOTE = '这句话根本不在任何一份附件正文里';

function summaryWith(parts) {
  return {
    what: '这是什么',
    who: '',
    whoCanSubmit: '',
    afterDeadline: '',
    deadline: null,
    howToComment: '如何提意见',
    channels: [],
    ...parts,
  };
}

describe('issue #86：反查阶段丢了几条要数得出来', () => {
  it('引用反查得到出处 ⇒ 计数 0，条目照常落库', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ keyPoints: ['要点一'] }),
      { keyPoints: [DRAFT_QUOTE] },
      [DRAFT],
    );
    assert.equal(tally.quoteNotFound, 0);
    assert.equal(summary.keyPoints.length, 1);
    assert.equal(summary.keyPoints[0].source, DRAFT.name, '出处仍由程序反查得出');
  });

  it('引用在本轮喂进去的正文里找不到 ⇒ 计数 +1，且那一条不落库', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ keyPoints: ['要点一', '要点二'] }),
      { keyPoints: [DRAFT_QUOTE, ABSENT_QUOTE] },
      [DRAFT],
    );
    assert.equal(tally.quoteNotFound, 1, '丢了一条，就要说丢了一条');
    assert.equal(summary.keyPoints.length, 1, '反查不到的那条不落库（既有规矩不变）');
  });

  it('空文本的条目不算"反查失败"（那是归一化阶段的账，两笔分开记）', () => {
    const { tally } = buildQuotedSummaryWithTally(
      summaryWith({ keyPoints: ['', '要点二'] }),
      { keyPoints: [null, ABSENT_QUOTE] },
      [DRAFT],
    );
    assert.equal(tally.quoteNotFound, 1, '只有"反查失败"那一条算，空文本那条不算');
  });

  it('段落隔离与计数同时成立：说明里的话落进条文要点，算反查失败', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ keyPoints: ['拿说明冒充条文'] }),
      { keyPoints: [EXPLANATION_QUOTE] },
      [DRAFT, EXPLANATION],
    );
    assert.equal(tally.quoteNotFound, 1, '说明里的引用在条文侧找不到 —— 隔离生效，且这件事看得见');
    assert.equal(summary.keyPoints.length, 0);
  });

  it('说明要点反查失败也计入同一个计数器', () => {
    const { summary, tally } = buildQuotedSummaryWithTally(
      summaryWith({ explanationPoints: [{ heading: '一、项目概况', text: '说了什么', quote: ABSENT_QUOTE }] }),
      undefined,
      [DRAFT, EXPLANATION],
    );
    assert.equal(tally.quoteNotFound, 1);
    assert.equal(summary.explanationPoints.length, 0);
  });

  it('buildQuotedSummary 与带计数的版本是同一份实现（返回值不多不少）', () => {
    const args = [
      summaryWith({ keyPoints: ['要点一'] }),
      { keyPoints: [DRAFT_QUOTE] },
      [DRAFT],
      null,
    ];
    const plain = buildQuotedSummary(...args);
    const { summary } = buildQuotedSummaryWithTally(...args);
    assert.deepEqual(plain, summary, '两个出口必须给出同一个形状，否则"同一份实现"是空话');
  });
});

describe('issue #86：归一化阶段的上限与空值分开记', () => {
  const nine = (prefix) => Array.from({ length: 9 }, (_, index) => `${prefix}${index + 1}`);

  it('条文要点超过上限 ⇒ 超上限计数 = 多出来的条数', () => {
    const tally = { emptyOrInvalid: 0, overLimit: 0 };
    const summary = normalizeModelSummary(
      summaryWith({ what: '这是什么', howToComment: '如何提意见', keyPoints: nine('要点') }),
      tally,
    );
    assert.equal(summary.keyPoints.length, 6, '上限仍是 6（本次不动产品行为）');
    assert.equal(tally.overLimit, 3, '9 条里被上限挡掉 3 条');
    assert.equal(tally.emptyOrInvalid, 0);
  });

  it('空条目与类型不对 ⇒ 计入空值那一类，而不是上限', () => {
    const tally = { emptyOrInvalid: 0, overLimit: 0 };
    const summary = normalizeModelSummary(
      summaryWith({ what: '这是什么', howToComment: '如何提意见', keyPoints: ['', '  ', '有效要点'] }),
      tally,
    );
    assert.equal(summary.keyPoints.length, 1);
    assert.equal(tally.emptyOrInvalid, 2);
    assert.equal(tally.overLimit, 0);
  });

  it('说明要点超过上限同样分开记', () => {
    const tally = { emptyOrInvalid: 0, overLimit: 0 };
    const points = Array.from({ length: 26 }, (_, index) => ({
      heading: `第${index + 1}节`,
      text: '说了什么',
      quote: '引用',
    }));
    const summary = normalizeModelSummary(
      summaryWith({ what: '这是什么', howToComment: '如何提意见', explanationPoints: points }),
      tally,
    );
    assert.equal(summary.explanationPoints.length, 24);
    assert.equal(tally.overLimit, 2);
  });

  it('不传计数对象时行为一字不变（老调用方零改动）', () => {
    const summary = normalizeModelSummary(
      summaryWith({ what: '这是什么', howToComment: '如何提意见', keyPoints: nine('要点') }),
    );
    assert.equal(summary.keyPoints.length, 6);
  });
});

describe('issue #86：适配器上报一次调用的诊断', () => {
  const validPayload = {
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify(
            summaryWith({
              what: '这是什么',
              howToComment: '如何提意见',
              keyPoints: ['要点一'],
              quotes: { keyPoints: [DRAFT_QUOTE] },
            }),
          ),
        },
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
  };

  it('成功时带上结束原因、token、耗时、原始输出，并声明"有人看过"', async () => {
    const llm = new OpenAiCompatibleLlm({ ...CONFIG, fetchImpl: async () => fakeResponse({ payload: validPayload }) });
    const summary = await llm.summarize({ title: '标题', url: 'https://x.gov.cn/a', bodyText: '正文' });
    const d = summary.diagnostics;
    assert.ok(d, '适配器必须给出诊断');
    assert.equal(d.v, SUMMARY_DIAGNOSTICS_VERSION);
    assert.equal(d.model, 'flash-x');
    assert.equal(d.instrumented, true, '"有人看过"这件事必须是真的');
    assert.equal(d.finishReason, 'stop');
    assert.deepEqual(d.usage, { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 });
    assert.equal(typeof d.elapsedMs, 'number');
    assert.equal(d.rawChars, validPayload.choices[0].message.content.length);
    assert.match(d.raw, /"what":"这是什么"/, '原始输出要留着 —— 计数回答不了"模型写的是什么"');
    assert.equal(d.rawTruncated, false);
    assert.equal(d.emitted.keyPoints, 1);
    assert.equal(d.normalized.keyPoints, 1);
    assert.equal(d.dropped.quoteNotFound, 0, '反查发生在适配器之外，这里只能是 0');
  });

  it('模型多吐的点被上限挡掉时，计数出现在诊断里', async () => {
    const content = JSON.stringify(
      summaryWith({
        what: '这是什么',
        howToComment: '如何提意见',
        keyPoints: Array.from({ length: 9 }, (_, index) => `要点${index + 1}`),
      }),
    );
    const llm = new OpenAiCompatibleLlm({
      ...CONFIG,
      fetchImpl: async () => fakeResponse({ payload: { choices: [{ message: { content } }] } }),
    });
    const summary = await llm.summarize({ title: '标题', url: 'https://x.gov.cn/a', bodyText: '正文' });
    const d = summary.diagnostics;
    assert.equal(d.emitted.keyPoints, 9);
    assert.equal(d.normalized.keyPoints, 6);
    assert.equal(d.dropped.overLimit, 3);
  });

  it('HTTP 非 2xx ⇒ 抛的错里带着诊断（响应体就是原始输出）', async () => {
    const llm = new OpenAiCompatibleLlm({
      ...CONFIG,
      fetchImpl: async () => fakeResponse({ ok: false, status: 503, body: 'upstream busy' }),
    });
    let caught = null;
    try {
      await llm.summarize({ title: '标题', url: 'https://x.gov.cn/a', bodyText: '正文' });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, '必须抛错');
    const d = diagnosticsOfError(caught);
    assert.ok(d, '失败路径也要能拿到诊断 —— 那正是最需要原始输出的场合');
    assert.equal(d.instrumented, true);
    assert.equal(d.finishReason, null);
    assert.equal(d.raw, 'upstream busy');
    assert.equal(typeof d.elapsedMs, 'number');
  });

  it('响应缺 content ⇒ 抛错，raw 为空但 instrumented 仍为 true（与"没人看过"不是一回事）', async () => {
    const llm = new OpenAiCompatibleLlm({
      ...CONFIG,
      fetchImpl: async () => fakeResponse({ payload: { choices: [{ message: {} }] } }),
    });
    let caught = null;
    try {
      await llm.summarize({ title: '标题', url: 'https://x.gov.cn/a', bodyText: '正文' });
    } catch (error) {
      caught = error;
    }
    const d = diagnosticsOfError(caught);
    assert.ok(d);
    assert.equal(d.raw, '', '确实什么都没收到');
    assert.equal(d.rawChars, 0);
    assert.equal(d.instrumented, true, '但"我们看过了"仍然成立 —— 这两个事实必须分得开');
  });

  it('模型输出不是合法 JSON ⇒ 诊断里留着那段原始输出（#79 当年缺的就是这份证据）', async () => {
    const llm = new OpenAiCompatibleLlm({
      ...CONFIG,
      fetchImpl: async () =>
        fakeResponse({ payload: { choices: [{ message: { content: '我认为这份文件的要点是：没有 JSON' } }] } }),
    });
    let caught = null;
    try {
      await llm.summarize({ title: '标题', url: 'https://x.gov.cn/a', bodyText: '正文' });
    } catch (error) {
      caught = error;
    }
    const d = diagnosticsOfError(caught);
    assert.ok(d);
    assert.equal(d.raw, '我认为这份文件的要点是：没有 JSON');
  });

  it('请求根本没发出去 ⇒ 普通错误、不带诊断（不编一份"什么都没说"）', async () => {
    const llm = new OpenAiCompatibleLlm({
      ...CONFIG,
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    let caught = null;
    try {
      await llm.summarize({ title: '标题', url: 'https://x.gov.cn/a', bodyText: '正文' });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    assert.equal(diagnosticsOfError(caught), null, '没有响应就没有诊断可写');
    assert.match(String(caught.message), /ECONNREFUSED/);
  });
});

describe('issue #86：worker 侧合成诊断时不编造', () => {
  const overrides = {
    model: 'stub',
    provider: 'stub',
    attempts: 1,
    kept: { keyPoints: 2, explanationPoints: 0, channels: 1, impacts: 0, changes: 0 },
    quoteNotFound: 3,
  };

  it('端口未上报 ⇒ 说清"没人看过"，但落库条数与丢弃数照样写', () => {
    const d = buildSummaryDiagnostics(undefined, overrides);
    assert.equal(d.instrumented, false);
    assert.equal(d.elapsedMs, null, '不把"没测"写成 0 毫秒');
    assert.equal(d.finishReason, null);
    assert.equal(d.raw, '');
    assert.equal(d.rawChars, 0);
    assert.equal(d.model, 'stub');
    assert.deepEqual(d.kept, overrides.kept);
    assert.equal(d.dropped.quoteNotFound, 3);
    assert.match(describeDiagnostics(d), /端口未上报响应细节/);
  });

  it('端口上报了 ⇒ 响应细节照留，只覆盖 worker 才知道的那几个字段', () => {
    const reported = {
      v: SUMMARY_DIAGNOSTICS_VERSION,
      model: 'flash-x',
      provider: 'openai',
      elapsedMs: 1234,
      attempts: 1,
      instrumented: true,
      finishReason: 'length',
      usage: null,
      rawChars: 10,
      raw: '{"what":1}',
      rawTruncated: false,
      emitted: { keyPoints: 5, explanationPoints: 0, channels: 0 },
      normalized: { keyPoints: 5, explanationPoints: 0, channels: 0 },
      kept: emptyFieldCounts(),
      dropped: { emptyOrInvalid: 0, overLimit: 0, quoteNotFound: 0 },
    };
    const d = buildSummaryDiagnostics(reported, { ...overrides, attempts: 3, model: 'flash-x', provider: 'openai' });
    assert.equal(d.elapsedMs, 1234, '端口测的耗时是真的，不能被覆盖成 0');
    assert.equal(d.finishReason, 'length');
    assert.equal(d.raw, '{"what":1}');
    assert.equal(d.emitted.keyPoints, 5);
    assert.equal(d.attempts, 3, '试了几次只有 worker 知道');
    assert.deepEqual(d.kept, overrides.kept, '落库条数也只有 worker 知道');
    assert.equal(d.dropped.quoteNotFound, 3);
  });
});

describe('issue #86：读侧容错、截断与一句话摘要', () => {
  it('垃圾值 / 缺版本号 ⇒ null（绝不抛错）', () => {
    for (const value of [null, undefined, 42, 'x', [], {}, { v: '1' }]) {
      assert.equal(parseSummaryDiagnostics(value), null, `不该把 ${JSON.stringify(value)} 当成诊断`);
    }
  });

  it('缺字段的旧行 ⇒ 给默认值，仍然解析得出来', () => {
    const d = parseSummaryDiagnostics({ v: 1, model: 'flash-x' });
    assert.ok(d);
    assert.equal(d.model, 'flash-x');
    assert.equal(d.instrumented, false);
    assert.equal(d.elapsedMs, null);
    assert.deepEqual(d.kept, { keyPoints: 0, explanationPoints: 0, channels: 0, impacts: 0, changes: 0 });
    assert.deepEqual(d.dropped, { emptyOrInvalid: 0, overLimit: 0, quoteNotFound: 0 });
  });

  it('落库再读回等价（round-trip）', () => {
    const d = buildSummaryDiagnostics(undefined, {
      model: 'flash-x',
      provider: 'openai',
      attempts: 2,
      kept: { keyPoints: 1, explanationPoints: 2, channels: 3, impacts: 1, changes: 2 },
      quoteNotFound: 4,
    });
    assert.deepEqual(parseSummaryDiagnostics(JSON.parse(JSON.stringify(d))), d);
  });

  it('超长原始输出会截断，但"原本多长"如实记着', () => {
    const long = 'x'.repeat(RAW_OUTPUT_KEEP_CHARS + 500);
    const capped = capRawOutput(long);
    assert.equal(capped.rawTruncated, true);
    assert.equal(capped.raw.length, RAW_OUTPUT_KEEP_CHARS);
    const short = capRawOutput('短');
    assert.equal(short.rawTruncated, false);
    assert.equal(short.raw, '短');
  });

  it('一句话摘要把三类丢弃拆开说（不合并成"丢了几条"）', () => {
    const d = buildSummaryDiagnostics(undefined, {
      model: 'flash-x',
      provider: 'openai',
      attempts: 1,
      kept: { keyPoints: 1, explanationPoints: 0, channels: 0, impacts: 0, changes: 0 },
      quoteNotFound: 2,
    });
    const line = describeDiagnostics({
      ...d,
      instrumented: true,
      emitted: { keyPoints: 4, explanationPoints: 0, channels: 0, impacts: 0, changes: 0 },
    });
    assert.match(line, /条文要点 1\/4/);
    assert.match(line, /反查不到出处 2/);
  });

  it('端口没上报时不写分母（`3/0` 会被读成"模型吐了 0 条"）', () => {
    const d = buildSummaryDiagnostics(undefined, {
      model: 'stub',
      provider: 'stub',
      attempts: 1,
      kept: { keyPoints: 3, explanationPoints: 2, channels: 0, impacts: 0, changes: 0 },
      quoteNotFound: 0,
    });
    const line = describeDiagnostics(d);
    assert.doesNotMatch(line, /\/\d/, '分母未知（没人上报）就不许出现分母');
    assert.match(line, /落库条文要点 3 条/);
    assert.match(line, /端口未上报响应细节/);
  });
});

describe('issue #86 第 3 刀：喂入清单（"我们给它看了什么"）', () => {
  const kept = { keyPoints: 1, explanationPoints: 1, channels: 0, impacts: 0, changes: 0 };
  const feed = {
    tier: 'deep',
    budget: { perSource: 16_000, total: 24_000, minShare: 4_000 },
    usedCjk: 7_913,
    sources: [
      {
        name: '《水质 …》编制说明.docx',
        role: 'explanation',
        origin: 'attachment',
        fullCjk: 12_400,
        fedCjk: 2_753,
        chars: 8_000,
        allowance: 8_000,
        truncated: true,
      },
      {
        name: '水质 ….docx',
        role: 'other',
        origin: 'attachment',
        fullCjk: 2_972,
        fedCjk: 2_972,
        chars: 7_973,
        allowance: 8_000,
        truncated: false,
      },
    ],
    starved: [{ name: '海水 汞的测定.docx', fullCjk: 2_188 }],
  };

  it('落库再读回等价（含每一份的配额、是不是被截过）', () => {
    const d = buildSummaryDiagnostics(undefined, {
      model: 'flash-x',
      provider: 'openai',
      attempts: 1,
      kept,
      quoteNotFound: 0,
      feed,
    });
    const back = parseSummaryDiagnostics(JSON.parse(JSON.stringify(d)));
    assert.deepEqual(back.feed, feed);
    assert.equal(back.v, SUMMARY_DIAGNOSTICS_VERSION);
  });

  it('worker 没给喂入清单 ⇒ 不许编一份空的（"没记"与"喂了 0 份"处置相反）', () => {
    const d = buildSummaryDiagnostics(undefined, {
      model: 'stub',
      provider: 'stub',
      attempts: 1,
      kept,
      quoteNotFound: 0,
    });
    assert.equal('feed' in d, false);
    // 空清单是另一回事：它是一份**真的**喂入结果（0 份），必须与"没记"区分得开
    const empty = buildSummaryDiagnostics(undefined, {
      model: 'stub',
      provider: 'stub',
      attempts: 1,
      kept,
      quoteNotFound: 0,
      feed: emptyFeedReport('standard'),
    });
    assert.equal(empty.feed.sources.length, 0);
    assert.equal(empty.feed.tier, 'standard');
  });

  it('1 版的行（没有这个键）照常解析，读侧当"没记"而不是"喂了 0 份"', () => {
    const v1 = {
      v: 1,
      model: 'flash-x',
      provider: 'openai',
      elapsedMs: 100,
      attempts: 1,
      instrumented: true,
      finishReason: 'stop',
      usage: null,
      rawChars: 2,
      raw: '{}',
      rawTruncated: false,
      emitted: kept,
      normalized: kept,
      kept,
      dropped: { emptyOrInvalid: 0, overLimit: 0, quoteNotFound: 0 },
    };
    const parsed = parseSummaryDiagnostics(v1);
    assert.ok(parsed, '旧版行必须解析得出来');
    assert.equal('feed' in parsed, false);
  });

  it('形状认不出来的喂入清单整个丢掉（半份清单比没有清单更坏）', () => {
    for (const bad of [
      { tier: 'unknown-tier', sources: [], starved: [] },
      'deep',
      [],
      { sources: [], starved: [] },
    ]) {
      const parsed = parseSummaryDiagnostics({
        v: SUMMARY_DIAGNOSTICS_VERSION,
        model: 'x',
        provider: 'y',
        kept,
        dropped: { emptyOrInvalid: 0, overLimit: 0, quoteNotFound: 0 },
        feed: bad,
      });
      assert.equal('feed' in parsed, false, `${JSON.stringify(bad)} 不该被读成一份喂入清单`);
    }
  });

  it('一句话摘要里说得出档位、被截的份数与"一个字没喂进去"的份数', () => {
    const d = buildSummaryDiagnostics(undefined, {
      model: 'flash-x',
      provider: 'openai',
      attempts: 1,
      kept,
      quoteNotFound: 0,
      feed,
    });
    const line = describeDiagnostics(d);
    assert.match(line, /重档喂入 2 份 \/ 7913 汉字/);
    assert.match(line, /其中 1 份被截/);
    assert.match(line, /1 份一个字没喂进去/);
  });

  it('标准档也要说得出档位（否则读的人分不清这条走了哪一档）', () => {
    const line = describeDiagnostics(
      buildSummaryDiagnostics(undefined, {
        model: 'stub',
        provider: 'stub',
        attempts: 1,
        kept,
        quoteNotFound: 0,
        feed: emptyFeedReport('standard'),
      }),
    );
    assert.match(line, /标准档喂入 0 份/);
    assert.doesNotMatch(line, /被截|一个字没喂/);
  });
});
