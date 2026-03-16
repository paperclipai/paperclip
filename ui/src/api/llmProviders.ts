import { api } from "./client";

export interface LlmProviderDescriptor {
  providerType: string;
  label: string;
  description: string;
  defaultBaseUrl?: string;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
}

export interface LlmModelEntry {
  id: string;
  name: string;
  contextWindow?: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
}

/**
 * LLM Providers descriptor - describes which providers are available and their requirements
 */
export const llmProvidersDescriptors: LlmProviderDescriptor[] = [
  {
    providerType: "anthropic",
    label: "Anthropic (Claude)",
    description: "Use Claude models - most capable, recommended",
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  {
    providerType: "openai",
    label: "OpenAI (GPT)",
    description: "Use GPT-4, GPT-3.5 models",
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  {
    providerType: "openrouter",
    label: "OpenRouter",
    description: "Access 100+ models through a unified API",
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  {
    providerType: "ollama",
    label: "Ollama (Local)",
    description: "Run models locally on your machine",
    defaultBaseUrl: "http://localhost:11434",
    requiresApiKey: false,
    requiresBaseUrl: true,
  },
  {
    providerType: "huggingface",
    label: "HuggingFace",
    description: "Access HuggingFace models via API",
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  {
    providerType: "custom",
    label: "Custom",
    description: "Custom LLM endpoint",
    requiresApiKey: false,
    requiresBaseUrl: true,
  },
];
