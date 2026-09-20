/**
 * AI 摘要可用性（issue #22）：摘要区的展示形态由 LLM 端口配置决定。
 *
 * 背景：生产上线时 `LLM_PROVIDER=glm` 但 `GLM_API_KEY` 未配置（compose 传的是
 * `${GLM_API_KEY:-}`）——摘要任务每轮构造端口即失败，库里的摘要状态永远停在
 * `pending`，详情页因此**永远显示「摘要生成中」**。那是个不诚实的界面状态：
 * 它承诺一件不会发生的事（PRD 要求 AI 内容显著标注、可核对，前提是它真的存在）。
 *
 * 判定口径与 adapters/glm-llm.ts 的构造校验保持一致：glm 端口缺 API Key 即不可用。
 * 与 `mailerReady`（issue #17 订阅入口门控）同一套路数：
 * - 可用：摘要区照常 —— 已有摘要渲染五段式；未生成显示「生成中」占位；
 * - 不可用：摘要区显示**说明块**（AI 解读尚未启用，请直接阅读官方原文），
 *   不再显示「生成中」；**已有摘要照常渲染**（绝不隐藏库里已有的内容）。
 *
 * 配置补齐后无需改代码：`GLM_API_KEY` 一填，占位与说明块自动回到正常形态。
 */

/** AI 摘要端口是否可用（true = 可以对外展示「生成中」这类进行时状态）。 */
export function llmReady(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = env.LLM_PROVIDER ?? 'stub';
  if (provider === 'stub') return true;
  if (provider !== 'glm') return false;
  return isSet(env.GLM_API_KEY);
}

function isSet(value: string | undefined): boolean {
  return (value ?? '').trim() !== '';
}
