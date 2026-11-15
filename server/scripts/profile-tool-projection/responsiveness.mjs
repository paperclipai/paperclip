import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { createDb } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from '../../dist/__tests__/helpers/embedded-postgres.js';
import { createProfileProjectionFixture } from '../../dist/__tests__/helpers/tool-profile-projection-fixture.js';
const index = process.argv.indexOf('--output-dir');
const output = path.resolve(index < 0 ? '/tmp/paperclip-tool-projection' : process.argv[index + 1]);
assert.equal(typeof global.gc, 'function', 'Run Node with --expose-gc');
await mkdir(output, { recursive: true });
const database = await startEmbeddedPostgresTestDatabase('paperclip-hotpaths-http-owned-');
const db = createDb(database.connectionString, { maxConnections: 1 });
const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"status":"ok"}'); });
let probe;
const control = async message => {
  const reply = once(probe, 'message', { signal: AbortSignal.timeout(30000) });
  probe.send(message);
  return (await reply)[0];
};
const records = [];
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  probe = fork(new URL('./probe.mjs', import.meta.url), { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const fixture = await createProfileProjectionFixture(db);
  const variants = {}, now = () => new Date('2026-02-01T00:00:00Z');
  for (const label of ['baseline', 'combined']) {
    const p = label === 'combined' ? 'service' : '.baseline-service';
    const a = label === 'combined' ? 'attention' : '.baseline-attention';
    const profiles = (await import(new URL(`../../dist/services/tool-access/profiles/${p}.js`, import.meta.url))).createToolProfileService(db, now);
    const attention = (await import(new URL(`../../dist/services/tool-access/catalog/${a}.js`, import.meta.url))).createToolAppAttention(db, now);
    variants[label] = { profiles: () => profiles.listProfiles(fixture.company.id), attention: () => attention(fixture.company.id) };
  }
  for (const variant of Object.values(variants)) for (const owner of ['profiles', 'attention']) await variant[owner]();
  for (let round = 0; round < 3; round++) {
    for (const owner of ['profiles', 'attention']) {
      for (const label of round % 2 ? ['combined', 'baseline'] : ['baseline', 'combined']) {
        global.gc?.();
        await control({ kind: 'arm', port: server.address().port });
        const start = performance.now();
        await variants[label][owner]();
        const operationMs = performance.now() - start;
        const result = await control({ kind: 'stop' });
        const good = result.times.filter(value => typeof value === 'number');
        const record = { kind: 'responsiveness', round, owner, label, operationMs,
          completedHealthRequests: good.length, maxHealthMs: good.length ? Math.max(...good) : null,
          errors: result.times.filter(value => typeof value !== 'number'),
          scope: 'Separate-process HTTP probe to a minimal liveness handler in the same Node event loop as the real service; not the full application health route' };
        records.push(record); console.log(JSON.stringify(record));
      }
    }
  }
} finally {
  try {
    await writeFile(path.join(output, 'responsiveness.json'), JSON.stringify(records, null, 2));
  } finally {
    try {
      if (probe && probe.exitCode === null && probe.signalCode === null) {
        const exited = once(probe, 'exit');
        if (probe.connected) probe.send({ kind: 'close' });
        else probe.kill();
        await exited;
      }
    } finally {
      try { await new Promise(resolve => server.close(resolve)); }
      finally {
        try { await db.$client.end({ timeout: 1 }); }
        finally { await database.cleanup(); }
      }
    }
  }
}
