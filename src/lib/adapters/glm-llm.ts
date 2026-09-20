import type { LlmPort } from '../ports.ts';
import { createGlmLlmFromEnv } from './openai-compatible-llm.ts';

/**
 * 智谱 GLM 预设（issue #25）—— PRD 的默认服务商，实现全在
 * adapters/openai-compatible-llm.ts（GLM 用的是 OpenAI 兼容端点，协议同一份）。
 *
 * 这个文件只负责「GLM 是什么」：环境变量名（`GLM_API_KEY` / `GLM_API_BASE` /
 * `GLM_MODEL` / `GLM_TIMEOUT_MS`）、默认基址 `https://open.bigmodel.cn/api/paas/v4`
 * 与默认模型 `glm-4-flash`，以及 provider 上报名 `glm`。
 *
 * 想换服务商不必改代码：`LLM_PROVIDER=openai` + `LLM_API_BASE` / `LLM_API_KEY` /
 * `LLM_MODEL`（任何 OpenAI 兼容端点，例如同类的 flash 档便宜模型）。
 */

export { GLM_DEFAULT_API_BASE, GLM_DEFAULT_MODEL, resolveGlmConfig } from './openai-compatible-llm.ts';

/** 构造智谱 GLM 端口（`LLM_PROVIDER=glm`）。 */
export function createGlmLlm(env: NodeJS.ProcessEnv = process.env): LlmPort {
  return createGlmLlmFromEnv(env);
}
