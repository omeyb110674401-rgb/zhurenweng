import { resolveGlmConfig, resolveOpenAiLlmConfig } from './adapters/openai-compatible-llm.ts';

/**
 * AI 摘要可用性（issue #22）：摘要区的展示形态由 LLM 端口配置决定。
 *
 * 背景：生产上线时 `LLM_PROVIDER=glm` 但 `GLM_API_KEY` 未配置（compose 传的是
 * `${GLM_API_KEY:-}`）——摘要任务每轮构造端口即失败，库里的摘要状态永远停在
 * `pending`，详情页因此**永远显示「摘要生成中」**。那是个不诚实的界面状态：
 * 它承诺一件不会发生的事（PRD 要求 AI 内容显著标注、可核对，前提是它真的存在）。
 *
 * 与 `mailerReady`（issue #17 订阅入口门控）同一套路数：
 * - 可用：摘要区照常 —— 已有摘要渲染五段式；未生成显示「生成中」占位；
 * - 不可用：摘要区显示**说明块**（AI 解读尚未启用，请直接阅读官方原文），
 *   不再显示「生成中」；**已有摘要照常渲染**（绝不隐藏库里已有的内容）。
 *
 * 判定口径**不再手写镜像**（issue #23/#25 的教训）：这里直接调用端口构造所用的
 * 同一套配置解析函数，于是「门控说可用 ⟺ 端口能构造」由结构保证 —— 两处各写一份
 * trim / 必填规则，迟早分家成「界面在撒谎」或「功能被无谓隐藏」。
 * 配置补齐后无需改代码：变量一填，占位与说明块自动回到正常形态。
 */

/** AI 摘要端口是否可用（true = 可以对外展示「生成中」这类进行时状态）。 */
export function llmReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return llmUnavailableReason(env) === null;
}

/**
 * 端口不可用的原因（可读文案，用于 worker 日志与排障）；可用时返回 null。
 * 与 `llmReady` 同一实现的两个视图，日志里说的和界面判的必然一致。
 */
export function llmUnavailableReason(env: NodeJS.ProcessEnv = process.env): string | null {
  const provider = env.LLM_PROVIDER ?? 'stub';
  try {
    switch (provider) {
      case 'stub':
        return null;
      case 'glm':
        resolveGlmConfig(env);
        return null;
      case 'openai':
        resolveOpenAiLlmConfig(env);
        return null;
      default:
        // 未知 provider：端口构造会抛错，门控必须同样判为不可用
        return `未知的 LLM_PROVIDER "${provider}"（可选：stub | glm | openai）`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
