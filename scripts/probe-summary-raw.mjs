/**
 * 探针：把**生产同一条路径**发出的模型响应原样抓下来，逐字段看形状。
 *
 * 为什么要它：worker 日志里那句 `摘要输出缺少非空字符串字段 "who"` 是
 * `normalizeModelSummary` 的 `requiredText` 抛的，而它把三种完全不同的故障
 * 合并成同一条消息 —— 字段缺失 / 值不是字符串（模型给了数组或对象）/ 值是空串。
 * 三者对应的处置根本不同（改提示词、改校验、还是接受模型的答案），只看日志就会
 * 把「校验器先撞上哪个字段」误读成「只有这个字段有问题」：必填三段的检查顺序是
 * what → who → howToComment，前一个一抛，后面的状况永远不会出现在日志里。
 *
 * 用法（容器内跑，环境里已有密钥才验得到线上现状）：
 *   docker compose exec -T -e ZW_PROBE_URLS="http://web:3000/notices/<id> http://web:3000/notices/<id>" worker node scripts/probe-summary-raw.mjs
 */
import { createLlmPort } from '../src/lib/ports.ts';

const URLS = (process.env.ZW_PROBE_URLS ?? '')
  .split(/\s+/)
  .map((item) => item.trim())
  .filter((item) => item.length > 0);
if (URLS.length === 0) {
  console.error('用法：ZW_PROBE_URLS="详情页URL …" node scripts/probe-summary-raw.mjs');
  process.exit(1);
}

/**
 * 记录适配器收到的原始响应体。适配器在**构造时**就把 `fetch` 绑成实现，
 * 所以必须在 createLlmPort() 之前替换全局 fetch。
 */
const realFetch = globalThis.fetch;
let captured = null;
globalThis.fetch = async (url, init) => {
  const response = await realFetch(url, init);
  if (String(url).includes('/chat/completions')) captured = await response.clone().text();
  return response;
};

/** 与 verify-llm-port.mjs 同一口径：正文取站内详情页，不另找来源。 */
async function readNotice(url) {
  const html = await realFetch(url).then((response) => response.text());
  const title = /<h1 class="detail-title">([^<]+)</.exec(html)?.[1] ?? '';
  const body = (
    /<div class="body-text" data-testid="notice-body">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
  )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, body };
}

/** 一个字段的实际形状 —— 空串、缺键、非字符串是三回事，必须分开看。 */
function shapeOf(record, key) {
  if (!Object.hasOwn(record, key)) return '缺键';
  const value = record[key];
  if (typeof value === 'string') return value.trim() === '' ? '空串' : `非空串(${value.trim().length})`;
  if (value === null) return 'null';
  return `非字符串(${Array.isArray(value) ? 'array' : typeof value})`;
}

const FIELDS = ['what', 'who', 'whoCanSubmit', 'afterDeadline', 'deadline', 'howToComment'];

// 先探一次端口：本地环境没配密钥时 createLlmPort() 默认给 stub，它会「秒返回成功」
// 且根本不发请求 —— 探针在 stub 上跑出来的一切都没有意义，必须当场说清（实测踩过）
const probe = createLlmPort();
if (probe.provider === 'stub') {
  console.error(
    '当前端口是 stub（LLM_PROVIDER=stub 或没配密钥），探针要验的是真实响应。' +
      '请在容器里跑：docker compose exec -T -e ZW_PROBE_URLS="…" worker node scripts/probe-summary-raw.mjs',
  );
  process.exit(1);
}
console.log(`端口 provider=${probe.provider} 模型=${probe.model ?? '（未上报）'}`);

for (const url of URLS) {
  const id = url.split('/').pop();
  const { title, body } = await readNotice(url);
  captured = null;
  const llm = createLlmPort();
  const started = Date.now();
  let outcome = '成功';
  try {
    await llm.summarize({ title, url, bodyText: body });
  } catch (error) {
    outcome = `抛错：${error instanceof Error ? error.message : String(error)}`;
  }

  console.log(`\n=== ${id}  正文 ${body.length} 字  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`标题：${title.slice(0, 40)}`);
  console.log(`结果：${outcome}`);

  if (captured === null) {
    console.log('（没抓到响应体：请求没发出或没走 fetch）');
    continue;
  }
  let envelope;
  try {
    envelope = JSON.parse(captured);
  } catch {
    console.log(`响应不是 JSON：${captured.slice(0, 200)}`);
    continue;
  }
  const choice = envelope?.choices?.[0];
  const content = choice?.message?.content;
  console.log(
    `finish_reason=${choice?.finish_reason}  usage=${JSON.stringify(envelope?.usage ?? null)}`,
  );
  if (typeof content !== 'string') {
    console.log(`content 不是字符串：${JSON.stringify(choice?.message).slice(0, 200)}`);
    continue;
  }
  let record;
  try {
    record = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  } catch {
    console.log(`content 里的 JSON 解析不了，前 200 字：${content.slice(0, 200)}`);
    continue;
  }
  for (const field of FIELDS) {
    const value = record[field];
    const shown = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
    console.log(`  ${field.padEnd(13)} ${shapeOf(record, field).padEnd(22)} ${shown ?? ''}`);
  }
  const who = record.who;
  if (typeof who === 'string' && who.trim() === '') {
    console.log(`  → who 的引用：${JSON.stringify(record.quotes?.who ?? null)}`);
  }
}
