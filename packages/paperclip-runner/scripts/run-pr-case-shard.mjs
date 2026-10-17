import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCaseShards } from '../../../scripts/run-vitest-case-shards.mjs';

export const RUNNER_CASE_FILES = [
  'src/live/runnerd-codex-transport.test.ts',
  'src/live/runnerd-codex-transport-deadlines.test.ts',
  'src/drivers/opencode/opencode-server-driver.test.ts',
];

export async function runRunnerCaseShard(shardIndex, shardCount) {
  assert.ok(Number.isSafeInteger(shardCount) && shardCount > 0, 'Invalid shard count');
  assert.ok(Number.isSafeInteger(shardIndex) && shardIndex >= 0 && shardIndex < shardCount, 'Invalid shard index');
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = mkdtempSync(join(tmpdir(), 'paperclip-runner-case-shard-'));
  const requested = Number(process.env.VITEST_MAX_WORKERS ?? availableParallelism());
  assert.ok(Number.isSafeInteger(requested) && requested > 0, 'Invalid worker budget');
  let cursor = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(requested, RUNNER_CASE_FILES.length) }, async () => {
    while (cursor < RUNNER_CASE_FILES.length) {
      const index = cursor++;
      try {
        results[index] = { value: await runCaseShards({ file: RUNNER_CASE_FILES[index], cwd, workers: 1,
          shardIndex, shardCount, directory: join(directory, String(index)) }) };
      } catch (error) { results[index] = { error }; }
    }
  }));
  const failures = results.filter(result => result.error).map(result => result.error);
  if (failures.length) throw new AggregateError(failures, 'Runner case shard failed');
  return results.map(result => result.value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const match = /^--shard=(\d+)\/(\d+)$/.exec(process.argv[2] ?? '');
  assert.ok(match && process.argv.length === 3, 'Usage: run-pr-case-shard.mjs --shard=N/M');
  await runRunnerCaseShard(Number(match[1]) - 1, Number(match[2]));
}
