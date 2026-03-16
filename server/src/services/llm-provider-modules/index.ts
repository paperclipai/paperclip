import { openrouterModule } from "./providers/openrouter.js";
import { anthropicModule } from "./providers/anthropic.js";
import { openaiModule } from "./providers/openai.js";
import { huggingfaceModule } from "./providers/huggingface.js";
import { ollamaModule } from "./providers/ollama.js";
import { customModule } from "./providers/custom.js";
import type { LlmProviderModule, LlmProviderType } from "./types.js";

const MODULES: Record<LlmProviderType, LlmProviderModule> = {
  openrouter: openrouterModule,
  anthropic: anthropicModule,
  openai: openaiModule,
  huggingface: huggingfaceModule,
  ollama: ollamaModule,
  custom: customModule,
};

export function getProviderModule(providerType: LlmProviderType): LlmProviderModule {
  const module = MODULES[providerType];
  if (!module) {
    throw new Error(`Unknown LLM provider: ${providerType}`);
  }
  return module;
}

export function listProviderModules(): LlmProviderModule[] {
  return Object.values(MODULES);
}

export { type LlmProviderModule, type LlmProviderType, type LlmValidationResult } from "./types.js";
