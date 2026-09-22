/**
 * 验证：走**生产同一条路径**（createLlmPort → 配置解析 → 真实 HTTP → 解析归一）
 * 调一次真实模型，确认换服务商真的只靠环境变量。
 *
 * 与 probe-llm-provider.mjs 的区别：那个直接构造适配器，这个用端口工厂
 * （worker / web 用的就是它），因此额外覆盖了「门控判定、provider 上报、
 * 额外请求头合并」这些装配环节。
 *
 * 两种模式：
 * - **容器内（生产验通用的就是这条）**：`LLM_API_KEY` 或 `GLM_API_KEY` 已在环境里时，
 *   一律**不碰环境变量**，直接按容器现状判定并调用一次 —— 验的是「线上真的能用吗」，
 *   而不是「我配的这一套能用吗」。
 * - **开发机**：环境里没有密钥时，从 provider_config.json 取 opencode-go 的密钥，
 *   按换服务商的口径注入（路径由 `ZW_PROVIDER_CONFIG` 覆盖，缺省是开发机上的位置）。
 *
 * 用法：node scripts/verify-llm-port.mjs [model]
 * 只打印密钥长度与前后各 4 位，绝不打印全值。
 */
import fs from 'node:fs';
import { createLlmPort } from '../src/lib/ports.ts';
import { llmReady, llmUnavailableReason } from '../src/lib/llm-availability.ts';
import { buildQuotedSummary, llmModelName } from '../src/lib/summary-content.ts';

const CONFIG =
  process.env.ZW_PROVIDER_CONFIG ?? 'C:/Users/35258/.zcode/v2/provider_config.json';
const BODY_URL =
  process.env.ZW_VERIFY_NOTICE_URL ?? 'https://cn101.top/notices/00f8313ea7880fc0';
const MODEL = process.argv[2];

if (process.env.LLM_API_KEY || process.env.GLM_API_KEY) {
  console.log('模式：沿用容器现有环境变量（不改写）');
} else {
  // 开发机：把「换服务商」这件事当作被测对象本身
  const rule = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).config.providerConfigRules.providerRules.find(
    (item) => item.providerId === 'opencode-go-chat',
  );
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_API_KEY = rule.config.access.apiKey;
  process.env.LLM_API_BASE = 'https://opencode.ai/zen/go/v1';
  process.env.LLM_MODEL = MODEL ?? 'glm-5.3-flash';
  process.env.LLM_TIMEOUT_MS = '120000';
  process.env.LLM_EXTRA_HEADERS = JSON.stringify({
    'x-opencode-session': 'zw-verify-5c1e7a02-9b44-4d18-8f60-2a7c3d9e4b51',
    'user-agent': 'opencode/0.1.0',
  });
  console.log('模式：开发机 provider_config.json 注入 opencode-go');
}

const key = (process.env.LLM_API_KEY ?? process.env.GLM_API_KEY ?? '').trim();
if (MODEL) process.env.LLM_MODEL = MODEL;
console.log(`密钥：${key.slice(0, 4)}…${key.slice(-4)}（长度 ${key.length}）`);
console.log(
  `门控 llmReady() = ${llmReady()}` +
    (llmReady() ? '' : `（原因：${llmUnavailableReason()}）`),
);
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
