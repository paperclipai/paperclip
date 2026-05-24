// OpenAI-Compatible Adapter

// Implements the AdapterAdapter interface for OpenAI-compatible providers
// (Ollama, OpenRouter, OpenAI)

import type { AgentAdapter } from '@paperclipai/adapter-utils';

// Default configuration for local providers
const DEFAULT_CONFIG = {
  baseUrl: 'http://localhost:11434/v1',  // Ollama default
  model: 'llama3'
};

// List of supported model identifiers
const MODEL_LIST = [
  'llama3', 'mistral', 'phi-3', 'gpt-3.5-turbo', 'gpt-4'
];

// Adapter implementation
interface OpenAIFriendlyConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  proxyUrl?: string;
  temperature?: number;
  maxTokens?: number;
};

// Track supported providers
const PROVIDER_TYPE = 'openai_compatible';

// Public adapter interface
export const adapterType = PROVIDER_TYPE;

// Public adapter metadata
export const adapterMetadata = {
  label: 'OpenAI-Compatible API',
  description: 'Unified adapter for Ollama, OpenRouter, and OpenAI-compatible APIs';
  models: MODEL_LIST,
  defaultConfig: DEFAULT_CONFIG,
  requiredFields: ['baseUrl', 'model']
};

// Adapter implementation
export class OpenAICompatibleAdapter {
  constructor(private config: OpenAIFriendlyConfig) {
    if (!this.config.baseUrl) {
      throw new Error('baseUrl is required');
    }
    if (!this.config.model) {
      throw new Error('model is required');
    }
  }

  async invoke(context: any): Promise<any> {
    // Implement core request/response handling here
    throw new Error('Not implemented');
  }

  status(requestId: string): Promise<any> {
    // Implement status checking here
    throw new Error('Not implemented');
  }

  cancel(requestId: string): Promise<void> {
    // Implement cancellation here
    throw new Error('Not implemented');
  }
}