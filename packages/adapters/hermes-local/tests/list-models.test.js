
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatConfiguredModels,
  listHermesModels,
  resetHermesModelsCacheForTests,
} from '../src/server/list-models.js';

test.afterEach(() => {
  resetHermesModelsCacheForTests();
});

test('formatConfiguredModels deduplicates by model id and annotates labels', () => {
  const models = formatConfiguredModels([
    { model: 'gpt-5.4', provider: 'copilot', sourcePath: 'model.default', isDefault: true },
    { model: 'gpt-5.4', provider: 'copilot', sourcePath: 'auxiliary.vision.model', isDefault: false },
    { model: 'openai/gpt-4o', provider: 'openrouter', sourcePath: 'auxiliary.vision.model', isDefault: false },
  ]);
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'gpt-5.4');
  assert.match(models[0].label, /default/);
  assert.match(models[1].label, /auxiliary\.vision\.model/);
});

test('listHermesModels caches per config path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-hermes-model-cache-'));
  const firstHome = path.join(root, 'copilot');
  const secondHome = path.join(root, 'litellm');
  await fs.mkdir(firstHome, { recursive: true });
  await fs.mkdir(secondHome, { recursive: true });
  const firstConfig = path.join(firstHome, 'config.yaml');
  const secondConfig = path.join(secondHome, 'config.yaml');

  await fs.writeFile(
    firstConfig,
    ['model:', '  default: gpt-4o', '  provider: copilot', ''].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    secondConfig,
    ['model:', '  default: Nemotron-Cascade-2-30B-A3B', '  provider: custom', ''].join('\n'),
    'utf8',
  );

  try {
    const firstModels = await listHermesModels({ configPath: firstConfig });
    const secondModels = await listHermesModels({ configPath: secondConfig });

    assert.deepEqual(firstModels.map((entry) => entry.id), ['gpt-4o']);
    assert.deepEqual(secondModels.map((entry) => entry.id), ['Nemotron-Cascade-2-30B-A3B']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
