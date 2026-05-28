import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const type = "openai";
export const label = "OpenRouter";
export const supportsInstructionsBundle = true;
export const instructionsPathKey = "instructionsFilePath";
export const requiresMaterializedRuntimeSkills = true;
export const supportsLocalAgentJwt = true;

export const models = [
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (via OpenRouter)" },
  { id: "anthropic/claude-haiku-4", label: "Claude Haiku 4 (via OpenRouter)" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini (via OpenRouter)" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat (via OpenRouter)" },
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (via OpenRouter)" },
  { id: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B (via OpenRouter)" },
];

export const agentConfigurationDoc = `# openai adapter

Routes Paperclip agent heartbeats to any OpenAI Chat Completions-compatible
endpoint. Default baseUrl is OpenRouter; works equally well with
api.openai.com or any other OpenAI-compatible gateway.

Required config:
- baseUrl  - e.g. https://openrouter.ai/api/v1
- model    - provider/model slug (e.g. anthropic/claude-sonnet-4)

Required env input:
- OPENROUTER_API_KEY (or OPENAI_API_KEY for whichever endpoint you point at)

Use when: you want a single adapter that lets you swap the underlying
LLM by changing one string. Don't use when: you need a coding-tool-aware
runtime (use claude_local / codex_local / opencode_local instead).
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    label,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    supportsInstructionsBundle,
    instructionsPathKey,
    requiresMaterializedRuntimeSkills,
    supportsLocalAgentJwt,
  } as any;
}
