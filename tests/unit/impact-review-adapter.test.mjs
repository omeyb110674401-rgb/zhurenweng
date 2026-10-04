import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  IMPACT_REVIEW_DEFAULT_TIMEOUT_MS,
  OpenAiCompatibleImpactReview,
  parseImpactReviewVerdicts,
  resolveImpactReviewConfig,
} from '../../src/lib/adapters/impact-review-llm.ts';
import {
  ImpactReviewConfigError,
  ImpactReviewShapeError,
  ImpactReviewTransportError,
  reviewFailureRaw,
  reviewOutcomeOfError,
} from '../../src/lib/impact-review.ts';
import {
  buildSummaryDiagnostics,
  describeDiagnostics,
  emptyDroppedCounts,
  emptyFieldCounts,
  parseSummaryDiagnostics,
  SUMMARY_DIAGNOSTICS_VERSION,
} from '../../src/lib/summary-diagnostics.ts';
import { impactReviewIndependence } from '../../src/lib/ports.ts';

/**
 * 单元：第二路审读端口接真实模型（issue #50）。
 *
 * 分两半，各有各的理由：
 * - **不发请求的那一半**（配置解析、输出解析、失败归类、独立性核对）用纯函数钉住 ——
 *   它们是"六种失败各写各的诊断"的全部判据；
 * - **真发请求的那一半**打到一个**本地** HTTP 服务上（零外部依赖，ADR-0001）：
 *   超时、HTTP 非 2xx、形状非法这三条路径只有真发一次请求才测得到，而它们的处置
 *   （配置 vs 网络 vs 提示词）完全不同 —— 这正是本 issue 的验收要区分的东西。
 */

const QUOTE_A = '收费公路在收费偿债期间的管理养护费用，在车辆通行费中列支。';
const QUOTE_B = '收费公路的收费期限，由省、自治区、直辖市人民政府规定。';
const ITEM_A = {
  quote: QUOTE_A,
  who: '高速公路通行车主',
  point: '通行费用支出',
  text: '期限届满后可能继续收费。',
  neighborhood: `第一条 ${QUOTE_A}`,
};
const ITEM_B = {
  quote: QUOTE_B,
  who: '高速公路通行车主',
  point: '收费期限',
  text: '期限的确定权在省级政府。',
  neighborhood: `第二条 ${QUOTE_B}`,
};

describe('issue #50：审读侧配置（独立的环境变量族）', () => {
  it('三项必填：缺一就抛配置错，且错误里点名是哪个变量', () => {
    for (const [missing, env] of [
      [
        'IMPACT_REVIEW_API_BASE',
        { IMPACT_REVIEW_API_KEY: 'k', IMPACT_REVIEW_MODEL: 'm' },
      ],
      [
        'IMPACT_REVIEW_API_KEY',
        { IMPACT_REVIEW_API_BASE: 'https://api.example.cn/v1', IMPACT_REVIEW_MODEL: 'm' },
      ],
      [
        'IMPACT_REVIEW_MODEL',
        { IMPACT_REVIEW_API_BASE: 'https://api.example.cn/v1', IMPACT_REVIEW_API_KEY: 'k' },
      ],
    ]) {
      assert.throws(
        () => resolveImpactReviewConfig(env),
        (error) => error instanceof ImpactReviewConfigError && error.message.includes(missing),
        `缺 ${missing} 时必须当场抛配置错`,
      );
    }
  });

  it('端点不是合法 URL ⇒ 也是配置错（构造期就发现，不等到调用）', () => {
    assert.throws(
      () =>
        resolveImpactReviewConfig({
          IMPACT_REVIEW_API_BASE: '不是网址',
          IMPACT_REVIEW_API_KEY: 'k',
          IMPACT_REVIEW_MODEL: 'm',
        }),
      (error) => error instanceof ImpactReviewConfigError && /不是合法 URL/.test(error.message),
    );
  });

  it('三项齐全 ⇒ 解析出 trim 过的端点与缺省超时；超时非法当场抛', () => {
    const config = resolveImpactReviewConfig({
      IMPACT_REVIEW_API_BASE: '  https://api.example.cn/v1/  ',
      IMPACT_REVIEW_API_KEY: '  secret  ',
      IMPACT_REVIEW_MODEL: '  glm-4.5  ',
    });
    assert.equal(config.apiBase, 'https://api.example.cn/v1', '尾斜杠要去掉（拼路径时不然会双斜杠）');
    assert.equal(config.apiKey, 'secret');
    assert.equal(config.model, 'glm-4.5');
    assert.equal(config.timeoutMs, IMPACT_REVIEW_DEFAULT_TIMEOUT_MS);
    assert.throws(
      () =>
        resolveImpactReviewConfig({
          IMPACT_REVIEW_API_BASE: 'https://api.example.cn/v1',
          IMPACT_REVIEW_API_KEY: 'k',
          IMPACT_REVIEW_MODEL: 'm',
          IMPACT_REVIEW_TIMEOUT_MS: '0',
        }),
      (error) => error instanceof ImpactReviewConfigError,
    );
  });

  it('**不读生成侧的任何变量**：只给 LLM_* 时照样是"审读侧没配"', () => {
    assert.throws(
      () =>
        resolveImpactReviewConfig({
          LLM_API_BASE: 'https://relay.example.com/v1',
          LLM_API_KEY: 'generation-key',
          LLM_MODEL: 'mimo',
        }),
      (error) => error instanceof ImpactReviewConfigError,
      '生成侧的 LLM_* 不许顶替审读侧 —— 否则库里那条记录说不清是谁判的',
    );
  });
});

describe('issue #50：独立性核对（同端点 / 同 key 一律打回）', () => {
  it('stub 是测试端口：没有端点，独立性问题在这一档不成立', () => {
    const verdict = impactReviewIndependence({ IMPACT_REVIEW_PROVIDER: 'stub' });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reviewHost, null);
  });

  it('缺 base ⇒ 不成立，且理由写明"生成侧不许顶替"', () => {
    const verdict = impactReviewIndependence({
      IMPACT_REVIEW_PROVIDER: 'openai-compatible',
      LLM_API_BASE: 'https://relay.example.com/v1',
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /IMPACT_REVIEW_API_BASE/);
    assert.match(verdict.reason ?? '', /不许顶替/);
  });

  it('与生成侧**同一个端点** ⇒ 不成立（同一个厂商，"独立模型"只剩口号）', () => {
    const verdict = impactReviewIndependence({
      IMPACT_REVIEW_PROVIDER: 'openai-compatible',
      IMPACT_REVIEW_API_BASE: 'https://relay.example.com/v1',
      IMPACT_REVIEW_API_KEY: 'review-key',
      LLM_API_BASE: 'https://relay.example.com/v1',
      LLM_API_KEY: 'generation-key',
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /同一个端点/);
  });

  it('与生成侧**共用同一把 key** ⇒ 不成立（换了域名也可能是同一个账号）', () => {
    const verdict = impactReviewIndependence({
      IMPACT_REVIEW_PROVIDER: 'openai-compatible',
      IMPACT_REVIEW_API_BASE: 'https://api.bigmodel.cn/api/paas/v4',
      IMPACT_REVIEW_API_KEY: 'same-key',
      LLM_API_BASE: 'https://relay.example.com/v1',
      LLM_API_KEY: 'same-key',
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /同一把 Key/);
  });

  it('端点与 key 都不同 ⇒ 成立，并把两侧主机名报出来供人核对"境内直连"', () => {
    const verdict = impactReviewIndependence({
      IMPACT_REVIEW_PROVIDER: 'openai-compatible',
      IMPACT_REVIEW_API_BASE: 'https://open.bigmodel.cn/api/paas/v4',
      IMPACT_REVIEW_API_KEY: 'review-key',
      LLM_API_BASE: 'https://relay.example.com/v1',
      LLM_API_KEY: 'generation-key',
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, null);
    assert.equal(verdict.reviewHost, 'open.bigmodel.cn', '"境内直连"代码核不了，只能把主机名交给人核');
    assert.equal(verdict.generationHost, 'relay.example.com');
  });
});

describe('issue #50：审读输出的解析（形状判据）', () => {
  it('正常数组 ⇒ 三态各自解析出来，「已改」带文本', () => {
    const verdicts = parseImpactReviewVerdicts(
      JSON.stringify([
        { quote: QUOTE_A, text: ITEM_A.text, status: 'passed' },
        { quote: QUOTE_B, text: ITEM_B.text, status: 'revised', revisedText: '改过的正文' },
        { quote: QUOTE_A, text: '另一条推断', status: 'rejected' },
      ]),
    );
    assert.equal(verdicts.length, 3);
    assert.equal(verdicts[1].revisedText, '改过的正文');
    assert.equal(verdicts[2].revisedText, null);
  });

  it('容忍 markdown 围栏与前后解释文字（只截最外层数组）', () => {
    const body = `好，我逐条判完了：\n\`\`\`json\n[{"quote":"${QUOTE_A}","text":"${ITEM_A.text}","status":"passed"}]\n\`\`\`\n以上。`;
    assert.equal(parseImpactReviewVerdicts(body).length, 1);
  });

  it('没有数组 / 不是合法 JSON ⇒ 抛形状错（诊断里要能看见它说了什么）', () => {
    for (const content of ['我判完了', '{not json}', '']) {
      assert.throws(
        () => parseImpactReviewVerdicts(content),
        (error) => error instanceof ImpactReviewShapeError && reviewFailureRaw(error) === content,
        `「${content.slice(0, 12)}」应当抛形状错并带上原始输出`,
      );
    }
  });

  it('**状态认不出 ⇒ 整份作废**（宁可这一轮没有记录，也不要一句读错的合规结论）', () => {
    assert.throws(
      () =>
        parseImpactReviewVerdicts(
          JSON.stringify([
            { quote: QUOTE_A, text: ITEM_A.text, status: 'passed' },
            { quote: QUOTE_B, text: ITEM_B.text, status: 'ok' },
          ]),
        ),
      (error) => error instanceof ImpactReviewShapeError && /状态认不出/.test(error.message),
    );
  });

  it('元素缺回显（没有 quote / text）⇒ 丢掉那一条，其余照收', () => {
    const verdicts = parseImpactReviewVerdicts(
      JSON.stringify([
        { quote: QUOTE_A, text: ITEM_A.text, status: 'passed' },
        { quote: '', text: ITEM_B.text, status: 'passed' },
        { quote: QUOTE_B, text: '', status: 'passed' },
        '不是对象',
      ]),
    );
    assert.equal(verdicts.length, 1, '没有逐字回显就无法配对，留着只会变成挂不上的结论');
    assert.equal(verdicts[0].quote, QUOTE_A);
  });

  it('空数组是**合法**的（模型一条都没判）—— 不是形状错', () => {
    assert.deepEqual(parseImpactReviewVerdicts('[]'), []);
  });
});

describe('issue #50：失败归类（六种失败各写各的诊断）', () => {
  it('配置错 / 形状错 / 超时 / 其它 ⇒ 四种 outcome', () => {
    assert.equal(reviewOutcomeOfError(new ImpactReviewConfigError('x')), 'port-error');
    assert.equal(reviewOutcomeOfError(new ImpactReviewShapeError('x', 'raw')), 'invalid-shape');
    assert.equal(
      reviewOutcomeOfError(new ImpactReviewTransportError('x', 'timeout')),
      'timeout',
    );
    assert.equal(reviewOutcomeOfError(new ImpactReviewTransportError('x', 'http')), 'request-failed');
    assert.equal(reviewOutcomeOfError(new ImpactReviewTransportError('x', 'network')), 'request-failed');
    // 平台抛的超时（不是我们的类）
    const abort = new Error('The operation was aborted');
    abort.name = 'TimeoutError';
    assert.equal(reviewOutcomeOfError(abort), 'timeout');
    // 认不出的一律算"调用失败"，不编一个"未知"档
    assert.equal(reviewOutcomeOfError(new Error('???')), 'request-failed');
  });

  it('形状错与 HTTP 错各自带着原始输出（诊断要用它）', () => {
    assert.equal(reviewFailureRaw(new ImpactReviewShapeError('x', '模型原文')), '模型原文');
    assert.equal(
      reviewFailureRaw(new ImpactReviewTransportError('x', 'http', { raw: '{"error":"boom"}' })),
      '{"error":"boom"}',
    );
    assert.equal(reviewFailureRaw(new Error('没带原文')), '');
  });
});

/** 本地假端点：把请求体收下来，按脚本回话。 */
function startServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({ url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
        closeAll: () => server.closeAllConnections(),
      });
    });
  });
}

function adapterFor(base, extra = {}) {
  return new OpenAiCompatibleImpactReview({
    apiKey: 'review-secret',
    apiBase: base,
    model: 'glm-4.5',
    timeoutMs: extra.timeoutMs ?? 5_000,
    headers: {},
    providerLabel: 'openai-compatible',
    ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
  });
}

describe('issue #50：真发一次请求（打到本地假端点）', () => {
  let server;

  before(async () => {
    server = await startServer((req, res, body) => {
      const parsed = JSON.parse(body);
      if (parsed.model === 'boom') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"上游炸了"}');
        return;
      }
      if (parsed.model === 'hang') return; // 不回话：测超时
      const items = /逐字引用：([^\n]+)/g;
      const ids = [...parsed.messages[1].content.matchAll(items)].map((match) => match[1]);
      const verdicts = ids.map((quote, index) => ({
        quote,
        text: parsed.messages[1].content.split('推断正文：')[index + 1].split('\n')[0],
        status: index === 0 ? 'passed' : 'rejected',
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdicts) } }] }),
      );
    });
  });

  after(async () => {
    server.closeAll();
    await server.close();
  });

  it('请求体带上了判读四件 + 原文邻域，且**密钥只在请求头里**', async () => {
    const adapter = adapterFor(server.base);
    const verdicts = await adapter.review({
      noticeId: 'n1',
      title: '关于某规定的征求意见通知',
      items: [ITEM_A, ITEM_B],
    });
    assert.equal(verdicts.length, 2);
    assert.equal(verdicts[0].status, 'passed');
    assert.equal(verdicts[1].status, 'rejected');

    const sent = server.requests.at(-1);
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer review-secret');
    assert.ok(!sent.body.includes('review-secret'), '密钥不许出现在请求体里');
    assert.match(sent.body, /逐字引用/);
    assert.match(sent.body, /原文邻域|前后各 200 字/, '邻域必须真的送出去（没有它 A1/A2/A6 判不了）');
    assert.ok(sent.body.includes(QUOTE_A), '邻域里要带着引用本身');
    assert.match(sent.body, /"temperature":0/, '审读要稳定：温度固定 0');
  });

  it('HTTP 非 2xx ⇒ 传输错（kind=http），带上响应体供人定位', async () => {
    const boom = new OpenAiCompatibleImpactReview({
      apiKey: 'k',
      apiBase: server.base,
      model: 'boom',
      timeoutMs: 5_000,
      headers: {},
      providerLabel: 'openai-compatible',
    });
    await assert.rejects(
      () => boom.review({ noticeId: 'n3', title: 't', items: [ITEM_A] }),
      (error) =>
        error instanceof ImpactReviewTransportError &&
        error.kind === 'http' &&
        error.raw.includes('上游炸了') &&
        reviewOutcomeOfError(error) === 'request-failed',
    );
  });

  it('端点不回话 ⇒ 超时（kind=timeout），且诊断归类为 timeout 而不是"调用失败"', async () => {
    const hang = new OpenAiCompatibleImpactReview({
      apiKey: 'k',
      apiBase: server.base,
      model: 'hang',
      timeoutMs: 150,
      headers: {},
      providerLabel: 'openai-compatible',
    });
    await assert.rejects(
      () => hang.review({ noticeId: 'n4', title: 't', items: [ITEM_A] }),
      (error) =>
        error instanceof ImpactReviewTransportError &&
        error.kind === 'timeout' &&
        reviewOutcomeOfError(error) === 'timeout',
    );
  });

  it('响应不是合法形状 ⇒ 形状错，且原始输出随错带出来', async () => {
    const fake = new OpenAiCompatibleImpactReview({
      apiKey: 'k',
      apiBase: 'https://api.example.cn/v1',
      model: 'm',
      timeoutMs: 1_000,
      headers: {},
      providerLabel: 'openai-compatible',
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '我判完了，没有 JSON' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await assert.rejects(
      () => fake.review({ noticeId: 'n5', title: 't', items: [ITEM_A] }),
      (error) =>
        error instanceof ImpactReviewShapeError &&
        reviewFailureRaw(error) === '我判完了，没有 JSON' &&
        reviewOutcomeOfError(error) === 'invalid-shape',
    );
  });
});

describe('issue #50：审读结果进诊断（六种失败在库里分得开）', () => {
  const base = {
    model: 'mimo-v2.5',
    provider: 'openai',
    attempts: 1,
    kept: emptyFieldCounts(),
    quoteNotFound: 0,
  };

  it('跑成了 ⇒ 诊断里 `review.status = ok`，带上送审/采信条数，且能往返读回', () => {
    const diagnostics = buildSummaryDiagnostics(undefined, {
      ...base,
      review: {
        status: 'ok',
        model: 'glm-4.5',
        requested: 3,
        accepted: 2,
        rejected: 1,
        error: null,
        elapsedMs: 1234,
      },
    });
    assert.equal(diagnostics.v, SUMMARY_DIAGNOSTICS_VERSION);
    const back = parseSummaryDiagnostics(JSON.parse(JSON.stringify(diagnostics)));
    assert.deepEqual(back?.review, diagnostics.review);
    assert.match(describeDiagnostics(diagnostics), /审读通过（送审 3 条 \/ 采信 2 条/);
  });

  it('没跑成 ⇒ 六种原因各自落一格，且 `describeDiagnostics` 说得出来', () => {
    for (const status of [
      'not-configured',
      'not-independent',
      'port-error',
      'timeout',
      'request-failed',
      'invalid-shape',
    ]) {
      const diagnostics = buildSummaryDiagnostics(undefined, {
        ...base,
        review: {
          status,
          model: null,
          requested: 2,
          accepted: 0,
          rejected: 0,
          error: `原因-${status}`,
          elapsedMs: null,
        },
      });
      const back = parseSummaryDiagnostics(JSON.parse(JSON.stringify(diagnostics)));
      assert.equal(back?.review?.status, status, `${status} 要能读回来`);
      const line = describeDiagnostics(diagnostics);
      assert.match(line, /审读/, `${status} 必须在诊断那一行里出现`);
      assert.match(line, new RegExp(`原因-${status}`), '失败原因要跟着印出来');
    }
  });

  it('认不出的 status ⇒ 整格丢掉（半份比没有更坏），其余诊断照常', () => {
    const broken = {
      ...buildSummaryDiagnostics(undefined, base),
      review: { status: '莫名其妙', requested: 1, accepted: 1, rejected: 0 },
    };
    const back = parseSummaryDiagnostics(broken);
    assert.ok(back, '整份诊断不该因为这一格坏掉');
    assert.equal(back.review, undefined);
    assert.equal(back.model, 'mimo-v2.5');
  });

  it('没有 review 那一格（v3 之前的行、或摘要调用早于审读就失败）⇒ 不编一格出来', () => {
    const back = parseSummaryDiagnostics({
      v: 3,
      model: 'm',
      provider: 'p',
      elapsedMs: null,
      attempts: 1,
      instrumented: false,
      finishReason: null,
      usage: null,
      rawChars: 0,
      raw: '',
      rawTruncated: false,
      emitted: emptyFieldCounts(),
      normalized: emptyFieldCounts(),
      kept: emptyFieldCounts(),
      dropped: emptyDroppedCounts(),
    });
    assert.equal(back?.review, undefined);
    assert.doesNotMatch(describeDiagnostics(back), /审读/);
  });
});
