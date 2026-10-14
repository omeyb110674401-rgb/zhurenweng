/**
 * 「供给中断」判据（issue #84）。
 *
 * 为什么这条判据值得单测钉住：它是熔断的**唯一开关**。判宽了（把内容族失败也算进来）
 * 会让一条脏数据把整轮熔断，剩下的条目全被推去人工复核；判窄了（漏掉真实的中转站
 * 措辞）熔断就永不触发，退回"额度打满后每条白跑 4 次"的老样子 —— 而**两种错误在
 * 日志里都长得像正常运行**。所以这里逐个钉住两族的代表样本。
 *
 * 样本取自生产实况（2026-10-13 那批失败日志）与适配器真实的抛错形状
 * （`openai API HTTP <status>：<body>`，见 openai-compatible-llm.ts）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isLlmSupplyBroken } from '../../worker/jobs/summarize-notices.ts';

/** 生产实况那一句（逐字抄自 2026-10-13 worker 日志）。 */
const PROD_429 =
  'openai API HTTP 429：{"type":"error","error":{"type":"GoUsageLimitError",' +
  '"message":"Go usage limit exceeded"},"metadata":{"workspace":"wrk_01M008DC05SW67YKDT90SW7ESC",' +
  '"limitName":"monthly"}}';

test('供给中断：HTTP 429 与额度打满（生产实况那一句）', () => {
  assert.equal(isLlmSupplyBroken(new Error(PROD_429)), true);
});

test('供给中断：认证与授权失效（401/402/403）也算 —— 重试同样不会好转', () => {
  assert.equal(isLlmSupplyBroken(new Error('openai API HTTP 401：invalid api key')), true);
  assert.equal(isLlmSupplyBroken(new Error('openai API HTTP 403：forbidden')), true);
  assert.equal(isLlmSupplyBroken(new Error('openai API HTTP 402：payment required')), true);
});

test('供给中断：不同服务商的额度措辞都要认', () => {
  const samples = [
    'insufficient_quota: You exceeded your current quota',
    'rate limit reached for gpt-4',
    'RateLimitError: too many requests',
    'usage_limit_exceeded',
    '账号已欠费，请及时充值',
    '接口调用额度已用尽',
  ];
  for (const sample of samples) {
    assert.equal(isLlmSupplyBroken(new Error(sample)), true, `应判为供给中断：${sample}`);
  }
});

test('内容族失败**不得**判为供给中断（否则一条脏数据熔断整轮）', () => {
  const samples = [
    '【stub】注入的 LLM 调用失败（第 1 次，LLM_STUB_FAILURES=always）',
    '模型输出中未找到 JSON 对象：这是一段散文',
    '模型输出不是合法 JSON：Unexpected token < in JSON',
    '摘要输出的必填段不合格：what、howToComment',
    '摘要输出不是 JSON 对象',
    'LLM 超时（300000ms）',
    '取条文失败：连接被拒绝',
  ];
  for (const sample of samples) {
    assert.equal(isLlmSupplyBroken(new Error(sample)), false, `不该判为供给中断：${sample}`);
  }
});

test('非 Error 抛出物不炸：判据对任意抛出物都要能回答', () => {
  // `throw 'string'` 与 Promise rejection 非 Error 都真实存在（errors.ts 的注释钉着这件事）
  assert.equal(isLlmSupplyBroken('openai API HTTP 429：quota'), true);
  assert.equal(isLlmSupplyBroken('随便一段话'), false);
  assert.equal(isLlmSupplyBroken(null), false);
  assert.equal(isLlmSupplyBroken(undefined), false);
});
