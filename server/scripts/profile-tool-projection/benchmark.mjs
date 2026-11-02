import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Session } from 'node:inspector';
import { createDb } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from '../../dist/__tests__/helpers/embedded-postgres.js';
import { createProfileProjectionFixture } from '../../dist/__tests__/helpers/tool-profile-projection-fixture.js';
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] ?? fallback; };
const output = path.resolve(option('--output-dir', '/tmp/paperclip-tool-projection'));
const repeats = Number(option('--repeat', '5'));
assert.ok(Number.isInteger(repeats) && repeats > 0, '--repeat must be a positive integer');
assert.equal(typeof global.gc, 'function', 'Run Node with --expose-gc');
const build = JSON.parse(await readFile(new URL('../../dist/.profile-projection-build.json', import.meta.url), 'utf8'));
await mkdir(output, { recursive: true });
const variants = {};
for (const label of ['baseline', 'pending', 'combined']) {
  const p = label === 'combined' ? './service.js' : `./.${label}-service.js`;
  const a = label === 'combined' ? './attention.js' : `./.${label}-attention.js`;
  variants[label] = {
    profileFactory: (await import(new URL(`../../dist/services/tool-access/profiles/${p}`, import.meta.url))).createToolProfileService,
    attentionFactory: (await import(new URL(`../../dist/services/tool-access/catalog/${a}`, import.meta.url))).createToolAppAttention,
  };
}
const database = await startEmbeddedPostgresTestDatabase('paperclip-hotpaths-owned-');
const db = createDb(database.connectionString, { maxConnections: 1 });
let queries = 0, rows = 0;
const measuredDb = new Proxy(db, { get(target, key) {
  if (key !== 'select') return Reflect.get(target, key);
  return (...fields) => {
    const builder = target.select(...fields), from = builder.from.bind(builder);
    builder.from = (...args) => {
      const selection = from(...args), execute = selection.execute.bind(selection);
      selection.execute = async () => { const result = await execute(); queries++; rows += result.length; return result; };
      return selection;
    };
    return builder;
  };
} });
const records = [];
const emit = record => { records.push(record); console.log(JSON.stringify(record)); };
try {
  const fixture = await createProfileProjectionFixture(db);
  const now = () => new Date('2026-02-01T00:00:00Z');
  for (const variant of Object.values(variants)) {
    const profiles = variant.profileFactory(measuredDb, now);
    const attention = variant.attentionFactory(measuredDb, now);
    variant.profiles = () => profiles.listProfiles(fixture.company.id);
    variant.attention = () => attention(fixture.company.id);
  }
  emit({ kind: 'environment', node: process.version, platform: process.platform, arch: process.arch,
    build: 'esbuild transpiled ES modules, node24 target; no runtime TypeScript loader',
    ...build, forcedGc: true,
    fixture: { profiles: 200, activeTools: 1900, removedTools: 695, rules: 76000, agents: 12 }, repeats,
    caveat: 'Local synthetic service workload, shared developer host; not hosted page-load acceptance' });
  for (const owner of ['profiles', 'attention']) {
    const expected = await variants.baseline[owner]();
    for (const label of ['pending', 'combined']) assert.deepEqual(await variants[label][owner](), expected);
    emit({ kind: 'correctness', owner, completeOutputEquality: true });
  }
  for (let round = 0; round < repeats; round++) {
    for (const owner of ['profiles', 'attention']) {
      const order = round % 2 ? ['combined', 'pending', 'baseline'] : ['baseline', 'pending', 'combined'];
      for (const label of order) {
        global.gc?.(); queries = 0; rows = 0;
        const started = performance.now(), cpu = process.cpuUsage();
        const result = await variants[label][owner]();
        const used = process.cpuUsage(cpu);
        emit({ kind: 'timing', round, owner, label, wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000,
          queries, rows, resultCount: owner === 'profiles' ? result.length : result.items?.length });
      }
    }
  }
  for (const owner of ['profiles', 'attention']) {
    for (const label of ['baseline', 'pending', 'combined']) {
      global.gc?.();
      const session = new Session(); session.connect();
      const post = (method, args = {}) => new Promise((resolve, reject) => session.post(method, args, (error, value) => error ? reject(error) : resolve(value)));
      try {
        await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 });
        await post('Profiler.start');
        await variants[label][owner]();
        const { profile } = await post('Profiler.stop');
        await writeFile(`${output}/${owner}-${label}.cpuprofile`, JSON.stringify(profile));
        emit({ kind: 'profile', owner, label, durationMs: (profile.endTime - profile.startTime) / 1000, samples: profile.samples?.length });
      } finally { session.disconnect(); }
    }
  }
} finally {
  try {
    await writeFile(`${output}/measurements.json`, JSON.stringify(records, null, 2));
  } finally {
    try { await db.$client.end({ timeout: 1 }); }
    finally { await database.cleanup(); }
  }
}
