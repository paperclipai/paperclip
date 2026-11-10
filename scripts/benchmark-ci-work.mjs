import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && baseline !== candidate, 'Pass a separately installed unchanged baseline checkout');
const output = path.resolve(process.argv[3] ?? path.join(candidate, '.ci-benchmark'));
mkdirSync(output, { recursive: true });
const results = [];
const commands = [
  ['general-server', process.execPath, ['scripts/run-vitest-stable.mjs', '--mode', 'general', '--group', 'general-server-without-chat-or-native-runner', '--shard-index', '0', '--shard-count', '12']],
  ['fixtures', 'pnpm', ['exec', 'vitest', 'run', '--project', '@paperclipai/server',
    'server/src/services/workspace-git-snapshot-streaming.test.ts', 'server/src/__tests__/workspace-runtime.test.ts',
    '-t', 'streams.*all four real Git|commits fixed-port reservations']],
];
for (const [variant, cwd] of [['baseline', baseline], ['candidate', candidate]]) {
  for (const [name, command, args] of commands) {
    const profile = path.join(output, `${variant}-${name}`);
    mkdirSync(profile, { recursive: true });
    const started = performance.now();
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GITHUB_WORKSPACE: cwd, NODE_ENV: 'test', PAPERCLIP_CI_PROFILE: 'true',
        PAPERCLIP_CI_PROFILE_DIR: profile, PAPERCLIP_CI_PROFILE_JOB: `benchmark-${variant}-${name}` },
    });
    const wallMs = performance.now() - started;
    writeFileSync(path.join(output, `${variant}-${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    const records = readdirSync(profile).filter((file) => file.endsWith('.ndjson'))
      .flatMap((file) => readFileSync(path.join(profile, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    results.push({ variant, name, wallMs, status: result.status,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
      tests: records.filter((record) => record.kind === 'test' && record.status !== 'skipped')
        .map((record) => [record.file, record.name, record.status]).sort(),
      files: records.filter((record) => record.kind === 'file').map((record) => record.file).sort(),
    });
    writeFileSync(path.join(output, 'results.json'), JSON.stringify({ node: process.version, results }, null, 2));
    assert.equal(result.status, 0, `${variant}/${name} failed: ${result.error ?? ''}; see ${output}`);
    console.log(`${variant}/${name}: ${(wallMs / 1000).toFixed(2)}s`);
  }
}
const rows = [];
for (const [name] of commands) {
  const before = results.find((result) => result.variant === 'baseline' && result.name === name);
  const after = results.find((result) => result.variant === 'candidate' && result.name === name);
  assert.ok(before.tests.length > 0, `${name}: missing test evidence`);
  assert.deepEqual(after.files, before.files, `${name}: file inventory changed`);
  if (name === 'general-server') assert.deepEqual(after.tests, before.tests, 'general server case inventory changed');
  else {
    const contracts = (tests) => {
      const found = new Set();
      for (const [file, title, status] of tests) {
        assert.equal(status, 'passed');
        if (file.endsWith('/workspace-runtime.test.ts') && title.includes('commits fixed-port reservations')) found.add('database');
        if (file.endsWith('/workspace-git-snapshot-streaming.test.ts')) {
          if (title.includes('above 32 MiB')) found.add('large Git lanes');
          if (/stag(?:es|ing)/.test(title)) found.add('bounded staging');
        }
      }
      return [...found].sort();
    };
    for (const result of [before, after]) assert.deepEqual(contracts(result.tests),
      ['bounded staging', 'database', 'large Git lanes'], 'fixture contracts must all execute');
  }
  rows.push(`| ${name} | ${(before.wallMs / 1000).toFixed(2)}s | ${(after.wallMs / 1000).toFixed(2)}s | ${((1 - after.wallMs / before.wallMs) * 100).toFixed(1)}% | ${after.tests.length} |`);
}
const summary = ['| Work | Baseline | Candidate | Reduction | Executed cases |',
  '|---|---:|---:|---:|---:|', ...rows,
  '', 'Paired sequential runs on one host with Node ' + process.version + '. Setup, cache transfer, queue time and the full CI critical path are outside these command timings.',
].join('\n');
writeFileSync(path.join(output, 'summary.md'), summary + '\n');
console.log(summary);
const total = (variant) => results.filter((result) => result.variant === variant).reduce((sum, result) => sum + result.wallMs, 0);
assert.ok(total('candidate') < total('baseline'), 'No combined speedup measured; inspect the paired evidence before claiming an improvement');
