/**
 * 验证：走**生产同一条路径**（createLlmPort → 配置解析 → 真实 HTTP → 解析归一）
 * 调一次真实模型，确认换服务商真的只靠环境变量。
 *
 * 与 probe-llm-provider.mjs 的区别：那个直接构造适配器，这个用端口工厂
 * （worker / web 用的就是它），因此额外覆盖了「门控判定、provider 上报、
 * 额外请求头合并」这些装配环节。
 *
 * 用法：node scripts/verify-llm-port.mjs [model]
 * 密钥从 provider_config.json 读取（路径由环境变量 ZW_PROVIDER_CONFIG 覆盖，
 * 缺省是开发机上的位置），只打印前后各 4 位。
 */
import fs from 'node:fs';
import { createLlmPort } from '../src/lib/ports.ts';
import { llmReady } from '../src/lib/llm-availability.ts';
import { buildQuotedSummary, llmModelName } from '../src/lib/summary-content.ts';

const CONFIG =
  process.env.ZW_PROVIDER_CONFIG ?? 'C:/Users/35258/.zcode/v2/provider_config.json';
const BODY_URL = 'https://cn101.top/notices/00f8313ea7880fc0';
const MODEL = process.argv[2] ?? 'glm-5.3-flash';

const rule = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).config.providerConfigRules.providerRules.find(
  (item) => item.providerId === 'opencode-go-chat',
);
const key = rule.config.access.apiKey;

// 只改环境变量 —— 这就是「换服务商」的全部动作
process.env.LLM_PROVIDER = 'openai';
process.env.LLM_API_KEY = key;
process.env.LLM_API_BASE = 'https://opencode.ai/zen/go/v1';
process.env.LLM_MODEL = MODEL;
process.env.LLM_TIMEOUT_MS = '120000';
process.env.LLM_EXTRA_HEADERS = JSON.stringify({
  'x-opencode-session': 'zw-verify-5c1e7a02-9b44-4d18-8f60-2a7c3d9e4b51',
  'user-agent': 'opencode/0.1.0',
});

console.log(`门控 llmReady() = ${llmReady()}`);
const llm = createLlmPort();
console.log(`端口 provider=${llm.provider}  上报模型名=${llmModelName(llm)}`);

const html = await fetch(BODY_URL).then((response) => response.text());
const title = /<h1 class="detail-title">([^<]+)</.exec(html)?.[1] ?? '';
const body = (/<div class="body-text" data-testid="notice-body">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
console.log(`输入：${title.slice(0, 28)}… / 正文 ${body.length} 字`);

const started = Date.now();
const summary = await llm.summarize({ title, url: BODY_URL, bodyText: body });
console.log(`\n✅ 调用成功（${((Date.now() - started) / 1000).toFixed(1)}s）`);

const quoted = buildQuotedSummary(summary, summary.quotes);
console.log('这是什么:', quoted.what.text);
console.log('影响谁:', quoted.who.text);
console.log('截止日期:', quoted.deadline.text);
quoted.keyPoints.forEach((point, index) => console.log(`  条款${index + 1}:`, point.text));

const flat = body.replace(/\s+/g, '');
const items = [
  ['what', quoted.what.quote],
  ['who', quoted.who.quote],
  ...quoted.keyPoints.map((point, index) => [`keyPoint[${index}]`, point.quote]),
  ['deadline', quoted.deadline.quote],
  ['howToComment', quoted.howToComment.quote],
].filter(([, quote]) => typeof quote === 'string' && quote.length > 0);
const bad = items.filter(([, quote]) => !flat.includes(quote.replace(/\s+/g, '')));
console.log(`\n引用核对：${items.length - bad.length}/${items.length} 逐字命中原文`);
for (const [field, quote] of bad) console.log(`  ❌ ${field} 不在原文：${quote.slice(0, 60)}`);
