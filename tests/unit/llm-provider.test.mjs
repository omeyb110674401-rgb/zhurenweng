import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OpenAiCompatibleLlm,
  extraHeaders,
  normalizeModelSummary,
  parseModelJson,
  resolveGlmConfig,
  resolveOpenAiLlmConfig,
} from '../../src/lib/adapters/openai-compatible-llm.ts';
import { buildQuotedSummary } from '../../src/lib/summary-content.ts';

/**
 * 单元：LLM 服务商配置与请求/响应处理（issue #25）。
 *
 * 背景：摘要适配器原先写死智谱 GLM（变量名 `GLM_*`、默认基址与模型、错误信息都带
 * GLM），而 PRD 第 49 条要求「调用已备案的国产大模型 API（默认 GLM 系列，**通过
 * 环境变量可切换服务商**）」。国内平台（智谱 / DeepSeek / 通义 / Kimi / 多数聚合）
 * 都提供 OpenAI 兼容的 chat/completions，差异只在「基址 + 密钥 + 模型名 + 少量请求头」，
 * 于是协议只实现一次，服务商由配置决定。
 *
 * 这里钉死三件事：
 * 1. 两个预设的配置解析口径（glm 只有 Key 必填；openai 三项都必填 —— 通用端点没有
 *    可以猜的默认基址/模型，缺一项就该在构造期报错，而不是发一个注定失败的请求）；
 * 2. 请求形状（端点拼接、Bearer 鉴权、额外请求头合并、模型名与两段消息）；
 * 3. 响应处理（合法 JSON → 归一化摘要；HTTP 错误 / 缺 content / 脏 JSON → 抛错，
 *    绝不把脏数据落库 —— 由摘要任务的重试与人工复核兜底）。
 *
 * 全程零网络：用假 fetch 断言请求，用固定响应断言解析。
 */

/** 参与导引形状的一份合法模型输出（issue #55：没有 keyPoints，多了谁能提 / 逾期 / 渠道） */
const VALID_CONTENT = JSON.stringify({
  what: '某征求意见稿公开征求意见',
  who: '运输机场运营人',
  whoCanSubmit: '社会各界均可提出意见',
  afterDeadline: '逾期视为无意见',
  deadline: '2026-10-07',
  howToComment: '通过电子邮箱或信函反馈',
  channels: [
    { kind: 'email', value: 'a@b.gov.cn' },
    { kind: 'online', value: 'www.b.gov.cn' },
  ],
  quotes: {
    what: '现向社会公开征求意见',
    who: '本规定适用于运输机场运营人',
    whoCanSubmit: '社会各界均可向本机关反馈意见',
    afterDeadline: '逾期不再受理',
    deadline: '截止日期为：2026年10月7日',
    howToComment: '一、电子邮箱：a@b.gov.cn',
    channels: ['一、电子邮箱：a@b.gov.cn', '二、登录本网站 www.b.gov.cn 留言'],
  },
});

/** 最小 Response 替身（适配器只用到 ok / status / text() / json()）。 */
function fakeResponse({ ok = true, status = 200, body = '', payload = null } = {}) {
  return {
    ok,
    status,
    text: async () => body,
    json: async () => payload,
  };
}

/** 记录请求的假 fetch。 */
function recordingFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  impl.calls = calls;
  return impl;
}

describe('LLM 配置解析：glm 预设与通用 OpenAI 兼容端点', () => {
  it('glm 预设：只有 Key 必填，基址与模型有默认值', () => {
    const config = resolveGlmConfig({ GLM_API_KEY: ' k ' });
    assert.equal(config.apiKey, 'k', '配置值一律 trim');
    assert.equal(config.apiBase, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(config.model, 'glm-4-flash');
    assert.equal(config.providerLabel, 'glm');
    assert.equal(config.timeoutMs, 60_000);
    assert.deepEqual(config.headers, {});
  });

  it('glm 预设：基址与模型可覆盖，缺 Key 时报出变量名', () => {
    const config = resolveGlmConfig({
      GLM_API_KEY: 'k',
      GLM_API_BASE: 'https://example.invalid/v4/',
      GLM_MODEL: 'glm-4.5-flash',
      GLM_TIMEOUT_MS: '5000',
    });
    assert.equal(config.apiBase, 'https://example.invalid/v4/');
    assert.equal(config.model, 'glm-4.5-flash');
    assert.equal(config.timeoutMs, 5000);
    assert.throws(() => resolveGlmConfig({}), /GLM_API_KEY 未配置/);
    assert.throws(() => resolveGlmConfig({ GLM_API_KEY: '   ' }), /GLM_API_KEY 未配置/, '空白串视为未配置');
  });

  it('通用端点：三项都必填，缺哪项就报哪项', () => {
    const full = { LLM_API_KEY: 'k', LLM_API_BASE: 'https://gw.example/v1', LLM_MODEL: 'flash-x' };
    assert.equal(resolveOpenAiLlmConfig(full).model, 'flash-x');
    assert.equal(resolveOpenAiLlmConfig(full).providerLabel, 'openai');
    assert.throws(() => resolveOpenAiLlmConfig({}), /LLM_API_KEY 未配置/);
    assert.throws(() => resolveOpenAiLlmConfig({ ...full, LLM_API_BASE: '' }), /LLM_API_BASE 未配置/);
    assert.throws(() => resolveOpenAiLlmConfig({ ...full, LLM_MODEL: ' ' }), /LLM_MODEL 未配置/);
  });

  it('超时必须是正数毫秒值（写错就在构造期报错）', () => {
    const base = { LLM_API_KEY: 'k', LLM_API_BASE: 'https://gw.example/v1', LLM_MODEL: 'm' };
    assert.equal(resolveOpenAiLlmConfig({ ...base, LLM_TIMEOUT_MS: '120000' }).timeoutMs, 120000);
    assert.throws(() => resolveOpenAiLlmConfig({ ...base, LLM_TIMEOUT_MS: '0' }), /超时/);
    assert.throws(() => resolveOpenAiLlmConfig({ ...base, LLM_TIMEOUT_MS: 'abc' }), /超时/);
    assert.equal(resolveOpenAiLlmConfig({ ...base, LLM_TIMEOUT_MS: '' }).timeoutMs, 60_000, '空白用默认');
  });

  it('额外请求头：JSON 对象（字符串值），非法即报错', () => {
    assert.deepEqual(extraHeaders(undefined), {});
    assert.deepEqual(extraHeaders('  '), {});
    assert.deepEqual(extraHeaders('{"x-session-id":"abc"}'), { 'x-session-id': 'abc' });
    assert.throws(() => extraHeaders('{oops'), /不是合法 JSON/);
    assert.throws(() => extraHeaders('["a"]'), /应为 JSON 对象/);
    assert.throws(() => extraHeaders('{"n":1}'), /必须是字符串值/);
  });
});

describe('LLM 请求形状（假 fetch，零网络）', () => {
  const config = {
    apiKey: 'secret-key',
    apiBase: 'https://gw.example/v1',
    model: 'flash-x',
    timeoutMs: 1000,
    headers: { 'x-session-id': 'session-1' },
    providerLabel: 'openai',
  };

  it('POST 到 <base>/chat/completions，带 Bearer 与额外请求头、模型名与两段消息', async () => {
    const fetchImpl = recordingFetch(fakeResponse({ payload: { choices: [{ message: { content: VALID_CONTENT } }] } }));
    const llm = new OpenAiCompatibleLlm({ ...config, fetchImpl });
    await llm.summarize({ title: '标题', url: 'https://example.gov.cn/a', bodyText: '正文内容' });

    assert.equal(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, 'https://gw.example/v1/chat/completions', '基址末尾斜杠不该产生双斜杠');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer secret-key');
    assert.equal(init.headers['x-session-id'], 'session-1', '额外请求头要合并进去');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'flash-x');
    assert.equal(body.messages.length, 2);
    assert.match(body.messages[0].content, /政府公示的「参与导引」助手/);
    // 提示词必须明写「不要编造条文」：抓取到的正文是公告壳，条款在附件里，
    // 这是本次摘要重构的立论，退回去就会重新产出看着像条款的元信息复述
    assert.match(body.messages[0].content, /不要编写、推测或概括任何「条款内容」/);
    assert.match(body.messages[0].content, /正文通常只是公告本身/);
    assert.match(body.messages[1].content, /标题：标题/);
    assert.match(body.messages[1].content, /正文内容/);
  });

  it('基址末尾多个斜杠也会归一（拼接结果只有一个 /）', async () => {
    const fetchImpl = recordingFetch(fakeResponse({ payload: { choices: [{ message: { content: VALID_CONTENT } }] } }));
    const llm = new OpenAiCompatibleLlm({ ...config, apiBase: 'https://gw.example/v1///', fetchImpl });
    await llm.summarize({ title: 't', url: 'https://example.gov.cn/a', bodyText: 'b' });
    assert.equal(fetchImpl.calls[0].url, 'https://gw.example/v1/chat/completions');
  });

  it('正文为空时仍可调用（提示词里说明「仅能基于标题判断」）', async () => {
    const fetchImpl = recordingFetch(fakeResponse({ payload: { choices: [{ message: { content: VALID_CONTENT } }] } }));
    const llm = new OpenAiCompatibleLlm({ ...config, fetchImpl });
    await llm.summarize({ title: '只有标题', url: 'https://example.gov.cn/a', bodyText: '' });
    assert.match(JSON.parse(fetchImpl.calls[0].init.body).messages[1].content, /仅能基于标题判断/);
  });

  it('provider 与 model 可被上报（notices.summary_model 用）', () => {
    const llm = new OpenAiCompatibleLlm({ ...config, fetchImpl: async () => fakeResponse() });
    assert.equal(llm.provider, 'openai');
    assert.equal(llm.model, 'flash-x');
  });
});

describe('LLM 响应处理：脏数据一律抛错，绝不落库', () => {
  const config = {
    apiKey: 'k',
    apiBase: 'https://gw.example/v1',
    model: 'm',
    timeoutMs: 1000,
    headers: {},
    providerLabel: 'openai',
  };
  const withContent = (content) =>
    new OpenAiCompatibleLlm({
      ...config,
      fetchImpl: recordingFetch(fakeResponse({ payload: { choices: [{ message: { content } }] } })),
    });

  it('合法响应 → 归一化摘要（含引用，供渲染态使用）', async () => {
    const summary = await withContent(VALID_CONTENT).summarize({
      title: 't',
      url: 'https://example.gov.cn/a',
      bodyText: 'b',
    });
    assert.equal(summary.deadline, '2026-10-07');
    assert.equal('keyPoints' in summary, false, '新输出不再产生 keyPoints（公告壳里没有条款可概括）');
    assert.equal(summary.whoCanSubmit, '社会各界均可提出意见');
    assert.equal(summary.afterDeadline, '逾期视为无意见');
    assert.deepEqual(
      summary.channels.map((channel) => channel.kind),
      ['email', 'online'],
    );
    assert.equal(summary.quotes?.channels?.length, 2, '引用与渠道条数一致');
    assert.equal(summary.quotes?.deadline, '截止日期为：2026年10月7日');
  });

  it('渠道：适配器一项都不删，未知 kind 归 other（删项会让引用与渠道错位）', async () => {
    const summary = await withContent(
      JSON.stringify({
        what: 'a',
        who: 'b',
        howToComment: 'c',
        channels: [
          { kind: 'email', value: ' a@b.gov.cn ' },
          { kind: '传真', value: '010-66010000' },
          { kind: 'bogus', value: '' },
        ],
        quotes: { channels: ['一、电子邮箱 a@b.gov.cn', '二、传真：010-66010000', '三、其他'] },
      }),
    ).summarize({ title: 't', url: 'u', bodyText: 'b' });
    assert.equal(summary.channels.length, 3, '三条原样保留（含空值那条）');
    assert.equal(summary.channels[0].value, 'a@b.gov.cn', '值 trim');
    assert.equal(summary.channels[1].kind, 'other', '不认识的 kind 归为 other，不猜');
    assert.equal(summary.channels[2].value, '');
    assert.equal(summary.quotes?.channels?.[2], '三、其他', '下标对齐未被破坏');
    const quoted = buildQuotedSummary(summary, summary.quotes);
    assert.equal(quoted.channels.length, 2, '空值那条在归一化为落库形状时才被丢弃');
    assert.equal(quoted.channels[1].quote, '二、传真：010-66010000', '丢弃后引用仍对得上');
  });

  it('markdown 围栏包裹的 JSON 也能解析', async () => {
    const summary = await withContent('```json\n' + VALID_CONTENT + '\n```').summarize({
      title: 't',
      url: 'https://example.gov.cn/a',
      bodyText: 'b',
    });
    assert.equal(summary.what.length > 0, true);
  });

  it('HTTP 错误 / 缺 content / 非 JSON / 缺字段 → 抛错', async () => {
    const httpError = new OpenAiCompatibleLlm({
      ...config,
      fetchImpl: recordingFetch(fakeResponse({ ok: false, status: 429, body: 'rate limited' })),
    });
    await assert.rejects(
      () => httpError.summarize({ title: 't', url: 'u', bodyText: 'b' }),
      /openai API HTTP 429/,
    );

    const noContent = new OpenAiCompatibleLlm({
      ...config,
      fetchImpl: recordingFetch(fakeResponse({ payload: { choices: [] } })),
    });
    await assert.rejects(
      () => noContent.summarize({ title: 't', url: 'u', bodyText: 'b' }),
      /缺少 choices\[0\]\.message\.content/,
    );

    await assert.rejects(
      () => withContent('这不是 JSON').summarize({ title: 't', url: 'u', bodyText: 'b' }),
      /未找到 JSON 对象/,
    );
    await assert.rejects(
      () => withContent('{"who":"只有一段"}').summarize({ title: 't', url: 'u', bodyText: 'b' }),
      /"what" 缺字段、"howToComment" 缺字段/,
      '不合格的两段一次报全（此前按顺序只报第一个，看不出后面还有几段坏）',
    );
    await assert.rejects(
      () =>
        withContent('{"what":"a","who":"b","howToComment":"   "}').summarize({
          title: 't',
          url: 'u',
          bodyText: 'b',
        }),
      /"howToComment" 空串/,
      '必填段只有空白字符也算没答上',
    );
    // 三种故障的处置不同，消息必须分得开：模型给成数组时不能说它「空」
    await assert.rejects(
      () =>
        withContent('{"what":["第一条","第二条"],"who":"b","howToComment":"c"}').summarize({
          title: 't',
          url: 'u',
          bodyText: 'b',
        }),
      /"what" 值不是字符串（array）/,
    );
    /*
     * 「影响谁」自 issue #56 第八节起是**可缺段**，理由是实测而不是推测：
     * 提示词要求原文写明受影响主体才写，而公告壳里没有这句话 —— 模型于是返回空串
     * （连引用也空），必填校验把整条打成失败，重刷第一轮 15/50 条就是这么掉的；
     * 侥幸通过的那些里 26/35 条填的是「有关单位和公众 / 社会公众」这类泛称，
     * 恰是提示词禁止的答案。空 = 诚实但作废、非空 = 违反要求，两头都不是要的东西。
     */
    for (const [label, json] of [
      ['空串', '{"what":"a","who":"","howToComment":"c"}'],
      ['只有空白', '{"what":"a","who":"   ","howToComment":"c"}'],
      ['缺字段', '{"what":"a","howToComment":"c"}'],
      ['值不是字符串', '{"what":"a","who":["企业","个人"],"howToComment":"c"}'],
    ]) {
      const summary = await withContent(json).summarize({ title: 't', url: 'u', bodyText: 'b' });
      assert.equal(summary.who, '', `影响谁${label}时整条仍应落库，该段留空`);
      assert.equal(summary.what, 'a');
      assert.equal(summary.howToComment, 'c');
    }
    // 原文可能确实没写的两段**不能**必填，否则只会逼模型编一句
    const sparse = await withContent('{"what":"a","who":"b","howToComment":"c"}').summarize({
      title: 't',
      url: 'u',
      bodyText: 'b',
    });
    assert.equal(sparse.whoCanSubmit, '', '谁能提缺省为空串');
    assert.equal(sparse.afterDeadline, '', '逾期会怎样缺省为空串');
    assert.deepEqual(sparse.channels, [], '渠道缺省为空数组');
  });

  it('deadline 不是 YYYY-MM-DD 时归一为 null（不猜日期）', () => {
    const summary = normalizeModelSummary({
      what: 'a',
      who: 'b',
      deadline: '2026年10月7日',
      howToComment: 'd',
      channels: [],
    });
    assert.equal(summary.deadline, null);
  });

  it('parseModelJson 截取最外层 JSON 主体（模型前后带解释文字）', () => {
    const parsed = parseModelJson('好的，这是摘要：{"what":"a","who":"b","keyPoints":["c"],"howToComment":"d"} 以上。');
    assert.equal(parsed.what, 'a');
  });
});
