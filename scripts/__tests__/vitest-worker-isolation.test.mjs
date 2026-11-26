import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL('../../', import.meta.url));
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const api = fileURLToPath(new URL('../../node_modules/vitest/dist/index.js', import.meta.url));
const setup = path.join(root, 'server/src/__tests__/setup-supertest.ts');

for (const parallel of [false, true]) test(`isolated forks retain fresh state with file parallelism ${parallel}`, () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pc-fork-proof-')));
  try {
    const record = path.join(directory, 'workers.ndjson');
    const config = path.join(directory, 'vitest.config.mjs');
    const files = ['first.test.ts', 'second.test.ts'];
    for (const file of files) writeFileSync(path.join(directory, file), `
      import { expect, it, vi } from ${JSON.stringify(api)};
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      it('starts clean and can contaminate only its own worker', async () => {
        expect(globalThis.serializedLeak).toBeUndefined();
        expect(process.env.PAPERCLIP_SERIALIZED_LEAK).toBeUndefined();
        expect(vi.isFakeTimers()).toBe(false);
        expect(existsSync(process.env.PAPERCLIP_CONFIG)).toBe(false);
        appendFileSync(${JSON.stringify(record)}, JSON.stringify({
          name: ${JSON.stringify(file)}, pid: process.pid, home: process.env.PAPERCLIP_HOME,
          config: process.env.PAPERCLIP_CONFIG, instance: process.env.PAPERCLIP_INSTANCE_ID,
        }) + '\\n');
        writeFileSync(process.env.PAPERCLIP_CONFIG, '{}');
        // In parallel mode both real workers must arrive before either exits.
        // This fails if the controller silently falls back to serial execution.
        if (${parallel}) {
          const { readFileSync } = await import('node:fs');
          const deadline = Date.now() + 10_000;
          while (readFileSync(${JSON.stringify(record)}, 'utf8').trim().split('\\n').length < 2) {
            if (Date.now() > deadline) throw new Error('second isolated worker did not start');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        globalThis.serializedLeak = true;
        process.env.PAPERCLIP_SERIALIZED_LEAK = 'leaked';
        vi.useFakeTimers();
      });
    `);
    for (const order of [files, [...files].reverse()]) {
      rmSync(record, { force: true });
      writeFileSync(config, `import Sequencer from './sequencer.mjs'; export default ${JSON.stringify({
        root: directory,
        test: {
          include: order, pool: 'forks', isolate: true, fileParallelism: parallel,
          maxWorkers: parallel ? 2 : 1, setupFiles: [setup],
          sequence: { sequencer: '__SEQUENCER__' },
        },
      }).replace('"__SEQUENCER__"', 'Sequencer')};`);
      writeFileSync(path.join(directory, 'sequencer.mjs'), `export default class {
        shard(tests) { return tests; }
        sort(tests) { return tests.sort((a, b) => ${JSON.stringify(order)}.indexOf(a.moduleId.split('/').pop()) - ${JSON.stringify(order)}.indexOf(b.moduleId.split('/').pop())); }
      }`);
      const result = spawnSync(process.execPath, [vitest, 'run', '--config', config], {
        cwd: root, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PAPERCLIP_HOME: path.join(directory, 'controller-home'),
          PAPERCLIP_CONFIG: path.join(directory, 'controller-config.json'), PAPERCLIP_INSTANCE_ID: 'controller' },
      });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      const workers = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(workers.length, 2);
      assert.deepEqual(workers.map((worker) => worker.name).sort(), [...order].sort());
      if (!parallel) assert.deepEqual(workers.map((worker) => worker.name), order);
      for (const key of ['pid', 'home', 'config', 'instance']) assert.equal(new Set(workers.map((worker) => worker[key])).size, 2, key);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
