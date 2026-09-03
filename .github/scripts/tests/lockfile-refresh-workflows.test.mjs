import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflows = [
  '.github/workflows/refresh-lockfile.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/docker.yml',
];

test('lockfile repair workflows resolve dependencies instead of updating metadata only', async () => {
  for (const workflow of workflows) {
    const contents = await readFile(workflow, 'utf8');
    const repairCommands = contents
      .split('\n')
      .filter((line) => line.includes('pnpm install') && line.includes('--no-frozen-lockfile'));

    assert.ok(repairCommands.length > 0, `${workflow} must contain a lockfile repair command`);
    for (const command of repairCommands) {
      assert.match(command, /--ignore-scripts/);
      assert.doesNotMatch(command, /--lockfile-only/);
    }
  }
});
