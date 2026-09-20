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

const VALID_CONTENT = JSON.stringify({
  what: '某征求意见稿公开征求意见',
  who: '社会公众',
  keyPoints: ['明确了适用范围', '规定了反馈渠道'],
  deadline: '2026-10-07',
  howToComment: '通过电子邮箱反馈',
  quotes: {
    what: '现向社会公开征求意见',
    who: '社会公众可通过以下途径反馈',
    keyPoints: ['本规定适用于运输机场', '一、电子邮箱：a@b.gov.cn'],
    deadline: '截止日期为：2026年10月7日',
    howToComment: '一、电子邮箱：a@b.gov.cn',
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
    assert.match(body.messages[0].content, /政府公示信息解读助手/);
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
    assert.equal(summary.keyPoints.length, 2);
    assert.equal(summary.quotes?.keyPoints.length, 2, '引用条数与关键条款对齐');
    assert.equal(summary.quotes?.deadline, '截止日期为：2026年10月7日');
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
      () => withContent('{"what":"只有一段"}').summarize({ title: 't', url: 'u', bodyText: 'b' }),
      /缺少非空数组字段 "keyPoints"/,
      '先校验 keyPoints，再逐字段读字符串',
    );
    await assert.rejects(
      () =>
        withContent('{"what":"a","keyPoints":["c"],"howToComment":"d"}').summarize({
          title: 't',
          url: 'u',
          bodyText: 'b',
        }),
      /缺少字符串字段 "who"/,
    );
    await assert.rejects(
      () => withContent('{"what":"a","who":"b","keyPoints":[],"howToComment":"c"}').summarize({
        title: 't',
        url: 'u',
        bodyText: 'b',
      }),
      /缺少非空数组字段 "keyPoints"/,
    );
  });

  it('deadline 不是 YYYY-MM-DD 时归一为 null（不猜日期）', () => {
    const summary = normalizeModelSummary({
      what: 'a',
      who: 'b',
      keyPoints: ['c'],
      deadline: '2026年10月7日',
      howToComment: 'd',
    });
    assert.equal(summary.deadline, null);
  });

  it('parseModelJson 截取最外层 JSON 主体（模型前后带解释文字）', () => {
    const parsed = parseModelJson('好的，这是摘要：{"what":"a","who":"b","keyPoints":["c"],"howToComment":"d"} 以上。');
    assert.equal(parsed.what, 'a');
  });
});
