// ExecStopPost only, after every measured window. It keeps authentic systemd
// exit metadata before transient-unit GC; it never connects to the database.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, validateRelease, shaFile } from './resource-contract.mjs';

export const EXIT_KEYS = ['Id', 'InvocationID', 'ExecMainPID', 'ExecMainCode', 'ExecMainStatus', 'Result'];
export function parseExitShow(text) {
  const result = {};
  for (const line of text.trim().split('\n')) {
    const at = line.indexOf('='); assert.ok(at > 0); const key = line.slice(0, at);
    assert.ok(EXIT_KEYS.includes(key)); assert.equal(Object.hasOwn(result, key), false); result[key] = line.slice(at + 1);
  }
  assert.deepEqual(Object.keys(result).sort(), [...EXIT_KEYS].sort()); return result;
}
export function validateExitProof(proof, release, ready, readySha256, writerSha256) {
  assert.equal(proof.schema, 'native-ingestion-systemd-pg-exit/v1');
  assert.equal(proof.sourceReleaseSha256, release.releaseSha256); assert.equal(proof.nonce, release.nonce);
  assert.equal(proof.readyReceiptSha256, readySha256); assert.equal(proof.writerSha256, writerSha256);
  assert.equal(proof.writerSha256, ready.exitWriterSha256);
  assert.equal(proof.bootId, ready.bootId); assert.equal(proof.pid, ready.pid); assert.equal(proof.starttimeTicks, ready.starttimeTicks);
  assert.equal(proof.unit.Id, `paperclip-ingestion-pgdiag-${release.nonce}.service`);
  assert.equal(proof.unit.InvocationID, ready.invocationId); assert.equal(Number(proof.unit.ExecMainPID), ready.pid);
  assert.equal(proof.unit.ExecMainCode, '1'); assert.equal(proof.unit.ExecMainStatus, '0'); assert.equal(proof.unit.Result, 'success');
  assert.deepEqual(proof.systemdExit, { SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0' });
  assert.equal(proof.complete, true); assert.equal(proof.normalPgShutdown, true); return proof;
}
async function main() {
  if (!process.argv.includes('--record-systemd-exit')) {
    console.log(JSON.stringify({ sourceOnly: true, starts: 0, purpose: 'ExecStopPost exit receipt, outside measured windows only' })); return;
  }
  const option = key => process.argv.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3);
  const file = option('release'), expected = option('release-sha256'); assert.equal(await shaFile(file), expected);
  const release = validateRelease(await json(file)); release.releaseSha256 = expected;
  const readyFile = path.join(release.output, 'pg-service.json'), readyBytes = await readFile(readyFile), ready = JSON.parse(readyBytes);
  assert.equal(ready.sourceReleaseSha256, expected); assert.equal(ready.nonce, release.nonce);
  const unitName = `paperclip-ingestion-pgdiag-${release.nonce}.service`;
  const { stdout } = await promisify(execFile)('/usr/bin/systemctl', ['show', '--property=' + EXIT_KEYS.join(','), unitName], { timeout: 5000, maxBuffer: 65536 });
  const proof = { schema: 'native-ingestion-systemd-pg-exit/v1', recordedAtMs: Date.now(), sourceReleaseSha256: expected,
    nonce: release.nonce, readyReceiptSha256: hash(readyBytes), writerSha256: await shaFile(fileURLToPath(import.meta.url)),
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), pid: ready.pid, starttimeTicks: ready.starttimeTicks,
    unit: parseExitShow(stdout), systemdExit: Object.fromEntries(['SERVICE_RESULT', 'EXIT_CODE', 'EXIT_STATUS'].map(key => [key, process.env[key]])),
    complete: true, normalPgShutdown: true, measuredWindow: false, shutdownCpuIncludedInEventRatios: false };
  let failure;
  try { validateExitProof(proof, release, ready, hash(readyBytes), proof.writerSha256); }
  catch (error) { failure = error; proof.complete = false; proof.normalPgShutdown = false; proof.failure = String(error.message); }
  const target = path.join(release.output, 'pg-systemd-exit.json'), temporary = target + '.tmp';
  await assert.rejects(lstat(target), error => error.code === 'ENOENT');
  await writeFile(temporary, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, target);
  if (failure) throw failure;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
