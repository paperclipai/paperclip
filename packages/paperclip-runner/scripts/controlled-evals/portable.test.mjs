import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { buildControllerRuntime } from './build-runtime.mjs';
import { encodeRuntimeReceipt, RUNTIME_MAX_RECEIPT_BYTES, verifyControllerRuntime } from './verify-runtime.mjs';

const exec = promisify(execFile);
const source = dirname(fileURLToPath(import.meta.url));
const isolatedProbe = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks, isBuiltin, createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = await realpath(process.argv[2]), prefix = pathToFileURL(root + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (context.parentURL?.startsWith(prefix) && !isBuiltin(result.url) && !result.url.startsWith(prefix)) throw new Error('Runtime depends on a file outside its artifact');
  return result;
} });
const { costRuntime } = await import(prefix + 'controlled-evals/manifest.mjs');
const protobuf = createRequire(join(root, 'server/package.json'))('protobufjs');
const type = protobuf.parse('syntax = "proto3"; message Value { int64 int_value = 3; } message Log { fixed64 time_unix_nano = 1; Value body = 5; } message Scope { repeated Log log_records = 2; } message Resource { repeated Scope scope_logs = 2; } message Data { repeated Resource resource_logs = 1; }').root.lookupType('Data');
const received = [];
const receiptPath = join(process.cwd(), 'protobuf-receipt.jsonl');
const relay = await costRuntime.startEvalOtlpRelay({ projectId: '11111111-1111-4111-8111-111111111111', apiKey: 'synthetic-only',
  campaignId: 'portable', attemptId: 'portable-protobuf', receiptPath, deadlineAt: Date.now() + 10000,
  transport: async (_url, init) => { received.push(type.decode(Buffer.from(init.body)).toJSON()); return Response.json({}); } });
const varint = number => { let value = BigInt(number), bytes = []; do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); };
const message = (field, ...parts) => { const bytes = Buffer.concat(parts); return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]); };
const nanos = '1792879903123456789', integer = '9223372036854775806';
const timestamp = Buffer.alloc(9); timestamp[0] = 9; timestamp.writeBigUInt64LE(BigInt(nanos), 1);
const body = message(1, message(2, message(2, timestamp, message(5, varint(24), varint(integer)))));
try {
  const result = await fetch(relay.baseUrl + '/v1/logs', { method: 'POST', headers: { authorization: 'Bearer ' + relay.token, 'content-type': 'application/x-protobuf' }, body });
  assert.equal(result.status, 200); await result.arrayBuffer();
  assert.equal(received.length, 1);
  const record = received[0].resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(record.timeUnixNano, nanos); assert.equal(record.body.intValue, integer);
} finally { await relay.close(); }
console.log('portable protobuf preserves 64-bit values');
`;

test('copied controller runs without source dependencies, retains native evidence, and detects artifact changes', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-portable-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const built = join(root, 'build'), directory = join(root, 'relocated');
  const sourceRevision = 'a'.repeat(40);
  const receipt = await buildControllerRuntime({ outputDirectory: built, sourceRevision });
  await assert.rejects(buildControllerRuntime({ outputDirectory: built, sourceRevision }), { code: 'EEXIST' });
  await rename(built, directory);
  const input = { directory, sourceRevision, receiptSha256: receipt.receiptSha256 };
  assert.equal((await verifyControllerRuntime(input)).totalBytes, receipt.totalBytes);
  const rawReceipt = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  assert(encodeRuntimeReceipt(rawReceipt).length < RUNTIME_MAX_RECEIPT_BYTES);
  const manyInputs = Object.fromEntries(Array.from({ length: 25_000 }, (_, index) => [`src/part-${index}.ts`, 'a'.repeat(64)]));
  assert.throws(() => encodeRuntimeReceipt({ ...rawReceipt, inputs: manyInputs }), /receipt exceeds its byte allowance/);
  const environment = { PATH: process.env.PATH, ...(process.env.LANG ? { LANG: process.env.LANG } : {}) };
  const probe = join(root, 'probe.mjs'); await writeFile(probe, isolatedProbe);
  const isolated = await exec(process.execPath, [probe, directory], { cwd: root, env: environment, timeout: 20_000 });
  assert.match(isolated.stdout, /preserves 64-bit values/);
  const stdin = exec(process.execPath, ['--input-type=module', '-'], { cwd: root, env: environment, timeout: 10_000 });
  stdin.child.stdin.end(`
    for (const name of ['run.mjs', 'archive.mjs', 'report.mjs', 'verify-runtime.mjs']) await import(${JSON.stringify(pathToFileURL(join(directory, 'controlled-evals') + '/').href)} + name);
    await import(${JSON.stringify(pathToFileURL(join(source, 'build-runtime.mjs')).href)});
    const { isEntrypoint } = await import(${JSON.stringify(pathToFileURL(join(directory, 'controlled-evals/entrypoint.mjs')).href)});
    if (await isEntrypoint(import.meta.url, '/missing/entrypoint.mjs')) throw new Error('Missing entrypoint was accepted');
    console.log('stdin imports are side-effect free');
  `);
  assert.match((await stdin).stdout, /stdin imports are side-effect free/);
  const cases = 'real child requests|disjoint concurrent|controller owns native|cancellation during root export|native post-child otlp-native.jsonl rejects fifo|credential redaction replaces|missing provider artifacts|hosted workers reject reruns|hosted context requires a manifest|failed final OTLP receipt';
  const behavioral = await exec(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', cases, join(source, 'controller.test.mjs')], {
    cwd: root, env: { ...environment, PAPERCLIP_CONTROLLER_TEST_RUNTIME: join(directory, 'controlled-evals') }, timeout: 80_000, maxBuffer: 1_048_576,
  });
  assert.match(behavioral.stdout, /# pass 11\b/);


  const cli = await exec(process.execPath, [join(directory, 'controlled-evals/archive.mjs'), 'report-attempts', join(root, 'empty-attempts')], {
    cwd: root, env: environment, timeout: 10_000,
  }).then(value => value, error => error);
  assert.equal(cli.code, 1); assert.match(cli.stderr, /ENOENT|no such file/);
  const entryAlias = join(root, 'run-alias.mjs'); await symlink(join(directory, 'controlled-evals/run.mjs'), entryAlias);
  const runCli = await exec(process.execPath, [entryAlias], { cwd: root, env: environment, timeout: 10_000 })
    .then(value => value, error => error);
  assert.equal(runCli.code, 2); assert.match(runCli.stderr, /admission or retention failed/);
  await assert.rejects(verifyControllerRuntime({ ...input, sourceRevision: 'b'.repeat(40) }), /Invalid runtime receipt/);
  await assert.rejects(verifyControllerRuntime({ ...input, receiptSha256: '0'.repeat(64) }), /digest mismatch/);
  const file = join(directory, 'controlled-evals/run.mjs'), bytes = await readFile(file);
  await writeFile(file, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(verifyControllerRuntime(input), /oversized|content mismatch/);
  await rm(file); await assert.rejects(verifyControllerRuntime(input), /inventory mismatch/);
  await symlink(probe, file); await assert.rejects(verifyControllerRuntime(input), /nonregular entry/);
  await rm(file); await writeFile(file, bytes);
  const extra = join(directory, 'unexpected.mjs'); await writeFile(extra, 'throw new Error()');
  await assert.rejects(verifyControllerRuntime(input), /Unexpected runtime artifact/);
  await rm(extra);
  assert.equal((await verifyControllerRuntime(input)).receiptSha256, receipt.receiptSha256);
});


test('only the root runtime receipt is excluded from the verified file inventory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runner-runtime-nested-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRevision = 'a'.repeat(40), files = {};
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  let payloadBytes = 0;
  for (const name of ['controlled-evals/run.mjs', 'controlled-evals/archive.mjs', 'controlled-evals/runtime.mjs', 'dependency/runtime.json']) {
    const bytes = Buffer.from(name.endsWith('.json') ? '{"dependency":true}' : 'export {};');
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), bytes);
    files[name] = { sizeBytes: bytes.length, sha256: digest(bytes) }; payloadBytes += bytes.length;
  }
  const receipt = encodeRuntimeReceipt({ schema: 'paperclip.runner-eval.controller-runtime/v1', sourceRevision, nodeMajor: 24, payloadBytes, files });
  await writeFile(join(root, 'runtime.json'), receipt);
  const input = { directory: root, sourceRevision, receiptSha256: digest(receipt) };
  assert.equal((await verifyControllerRuntime(input)).files, 5);
  const nested = join(root, 'dependency/runtime.json'), original = await readFile(nested);
  await writeFile(nested, Buffer.from('{"dependency":fake}'));
  await assert.rejects(verifyControllerRuntime(input), /content mismatch|oversized/);
  await writeFile(nested, original);
  await mkdir(join(root, 'dependency/deeper'));
  await writeFile(join(root, 'dependency/deeper/runtime.json'), '{}');
  await assert.rejects(verifyControllerRuntime(input), /Unexpected runtime artifact file/);
  await rm(join(root, 'dependency/deeper'), { recursive: true });
  assert.equal((await verifyControllerRuntime(input)).files, 5);
});
