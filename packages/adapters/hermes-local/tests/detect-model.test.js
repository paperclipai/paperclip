
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelFromConfig,
  parseConfiguredModelsFromConfig,
  resolveProvider,
  inferProviderFromModel,
} from '../src/server/detect-model.js';

test('parseModelFromConfig reads default model block', () => {
  const config = `
model:
  default: "gpt-5.4"
  provider: copilot
  base_url: https://api.githubcopilot.com
  api_mode: chat_completions
`;
  assert.deepEqual(parseModelFromConfig(config), {
    model: 'gpt-5.4',
    provider: 'copilot',
    baseUrl: 'https://api.githubcopilot.com',
    apiMode: 'chat_completions',
    source: 'config',
  });
});

test('parseConfiguredModelsFromConfig finds default and auxiliary models', () => {
  const config = `
model:
  default: anthropic/claude-sonnet-4
  provider: anthropic

auxiliary:
  vision:
    model: openai/gpt-4o
    provider: openrouter

fallback_model:
  model: google/gemini-2.5-flash
  provider: openrouter
`;
  const models = parseConfiguredModelsFromConfig(config);
  assert.equal(models[0].model, 'anthropic/claude-sonnet-4');
  assert.ok(models.some((entry) => entry.model === 'openai/gpt-4o'));
  assert.ok(models.some((entry) => entry.model === 'google/gemini-2.5-flash'));
});

test('resolveProvider prefers explicit adapter config over detected config', () => {
  const result = resolveProvider({
    explicitProvider: 'openrouter',
    detectedProvider: 'anthropic',
    detectedModel: 'claude-sonnet-4',
    model: 'claude-sonnet-4',
  });
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.resolvedFrom, 'adapterConfig');
});

test('inferProviderFromModel uses prefix hints', () => {
  assert.equal(inferProviderFromModel('gpt-5.4'), 'copilot');
  assert.equal(inferProviderFromModel('glm-4.7'), 'zai');
  assert.equal(inferProviderFromModel('claude-sonnet-4'), 'anthropic');
});
