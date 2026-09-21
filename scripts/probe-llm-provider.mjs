/**
 * 探针：opencode-go（OpenAI 兼容）端点 + 候选模型能否产出站点要求的结构化摘要。
 *
 * 用站点**真实正文**与**真实提示词**打一次真实请求，检查：
 * 1. 端点/密钥/模型是否可用（含延迟与 token 用量）；
 * 2. 输出能否通过站点自己的 parseModelJson + normalizeModelSummary；
 * 3. 最硬的一条：quotes 是否**逐字**出现在原文里（PRD 要求引用可核对）。
 *
 * 密钥从 provider_config.json 读取（路径由环境变量 ZW_PROVIDER_CONFIG 覆盖，
 * 缺省是开发机上的位置），只打印长度与前后各 4 位，绝不打印全值。
 * 用法：node scripts/probe-llm-provider.mjs [model ...]
 */
import fs from 'node:fs';
import { parseModelJson, normalizeModelSummary } from '../src/lib/adapters/openai-compatible-llm.ts';
import { buildQuotedSummary } from '../src/lib/summary-content.ts';

const CONFIG =
  process.env.ZW_PROVIDER_CONFIG ?? 'C:/Users/35258/.zcode/v2/provider_config.json';
const BASE = 'https://opencode.ai/zen/go/v1';
const BODY_URL = 'https://cn101.top/notices/00f8313ea7880fc0';
/** 稳定的会话标识（opencode-go 的 x-opencode-session 语义：一段对话一个固定值）。 */
const SESSION_ID = 'zw-probe-2f7a41d9-0c3e-4a55-9d21-8b6c5e0f7a13';

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const rule = config.config.providerConfigRules.providerRules.find(
  (item) => item.providerId === 'opencode-go-chat',
);
const API_KEY = rule.config.access.apiKey;
console.log(`密钥：${API_KEY.slice(0, 4)}…${API_KEY.slice(-4)}（长度 ${API_KEY.length}）`);
console.log(`端点：${BASE}/chat/completions`);

const SYSTEM_PROMPT = [
  '你是政府公示信息解读助手。用户会给出一份政府公示/征求意见稿的标题与正文纯文本。',
  '请只输出一个 JSON 对象（不要输出任何解释、markdown 代码围栏或其他文字），字段如下：',
  '{"what":"这是什么：一句话概括这份公示是什么","who":"影响谁：受影响的公众/主体","keyPoints":["关键条款：2-5 条，每条概括一个关键条款"],"deadline":"截止日期：YYYY-MM-DD，原文未明确则为 null","howToComment":"如何提意见：指引用户到官方渠道提交意见","quotes":{"what":"what 对应的原文引用片段（逐字摘录原文，不超过100字）","who":"who 对应的原文引用片段","keyPoints":["每条关键条款对应的原文引用片段，顺序与 keyPoints 一致"],"deadline":"截止日期对应的原文引用片段","howToComment":"提意见方式对应的原文引用片段"}}',
  '要求：只依据给定原文，不编造；引用必须是原文的逐字连续片段；原文未提及的信息用空字符串或 null 表达，不得猜测。',
].join('\n');

// 真实正文：从线上详情页取
const html = await fetch(BODY_URL).then((response) => response.text());
const title = /<h1 class="detail-title">([^<]+)</.exec(html)?.[1] ?? '（未知标题）';
const bodyMatch = /<div class="body-text" data-testid="notice-body">([\s\S]*?)<\/div>/.exec(html);
const bodyText = (bodyMatch?.[1] ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();
console.log(`正文：${title.slice(0, 30)}… / ${bodyText.length} 字\n`);

function quoteCheck(summary, source) {
  const flat = source.replace(/\s+/g, '');
  const items = [
    ['what', summary.what?.quote],
    ['who', summary.who?.quote],
    ...(summary.keyPoints ?? []).map((point, index) => [`keyPoint[${index}]`, point.quote]),
    ['deadline', summary.deadline?.quote],
    ['howToComment', summary.howToComment?.quote],
  ].filter(([, quote]) => typeof quote === 'string' && quote.length > 0);
  const bad = items.filter(([, quote]) => !flat.includes(quote.replace(/\s+/g, '')));
  return { total: items.length, verbatim: items.length - bad.length, bad };
}

const models = process.argv.slice(2);
for (const model of models.length > 0 ? models : ['mimo-v2.5']) {
  console.log('='.repeat(70));
  console.log('模型:', model);
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
        // opencode-go 要求客户端带稳定会话头（用于路由与提示缓存），
        // 并建议使用典型编码 agent 的 user-agent（见 https://opencode.ai/docs/go/）
        'x-opencode-session': SESSION_ID,
        'user-agent': 'opencode/0.1.0',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `标题：${title}\n官方原文链接：${BODY_URL}\n正文纯文本：\n${bodyText}` },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    console.log('请求失败:', error.message);
    continue;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const payload = await response.json().catch(() => null);
  console.log(`HTTP ${response.status}  用时 ${elapsed}s`);
  if (response.status !== 200) {
    console.log('响应:', JSON.stringify(payload).slice(0, 400));
    continue;
  }
  console.log('用量:', JSON.stringify(payload.usage ?? {}));
  const content = payload.choices?.[0]?.message?.content ?? '';
  console.log('原始输出全文:', JSON.stringify(content.slice(0, 1400)));
  try {
    const parsed = normalizeModelSummary(parseModelJson(content));
    console.log('✅ 形状合法：keyPoints', parsed.keyPoints.length, '条，deadline', parsed.deadline);
    console.log('   what:', parsed.what.slice(0, 60));
    // 引用核对要用渲染态（buildQuotedSummary 把扁平摘要 + quotes 合成 {text, quote}）
    const check = quoteCheck(buildQuotedSummary(parsed, parsed.quotes), bodyText);
    console.log(`   引用核对：${check.verbatim}/${check.total} 逐字命中`);
    for (const [key, quote] of check.bad) console.log(`   ❌ ${key} 引用不在原文：${quote.slice(0, 50)}`);
  } catch (error) {
    console.log('❌ 形状不合法:', error.message);
  }
  console.log();
}
