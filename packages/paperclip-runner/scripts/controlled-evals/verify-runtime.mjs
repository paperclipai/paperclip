import { isEntrypoint } from './entrypoint.mjs';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const RUNTIME_MAX_BYTES = 32 * 1_048_576;
export const RUNTIME_MAX_FILES = 4096;
export const RUNTIME_MAX_RECEIPT_BYTES = 2 * 1_048_576;
export function encodeRuntimeReceipt(receipt) {
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  if (bytes.length > RUNTIME_MAX_RECEIPT_BYTES) throw new Error('Controller runtime receipt exceeds its byte allowance');
  return bytes;
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function readRegular(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Runtime artifact contains an oversized or nonregular file');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('Runtime artifact changed during verification');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

export async function verifyControllerRuntime({ directory, sourceRevision, receiptSha256 }) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '') || !/^[a-f0-9]{64}$/.test(receiptSha256 ?? '')) throw new Error('Runtime verification requires trusted revision and receipt digest');
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error('Runtime root must be a real directory');
  const receiptBytes = await readRegular(join(root, 'runtime.json'), RUNTIME_MAX_RECEIPT_BYTES);
  if (sha256(receiptBytes) !== receiptSha256) throw new Error('Runtime receipt digest mismatch');
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (receipt.schema !== 'paperclip.runner-eval.controller-runtime/v1' || receipt.sourceRevision !== sourceRevision
      || receipt.nodeMajor !== 24 || !Number.isSafeInteger(receipt.payloadBytes) || receipt.payloadBytes < 1 || receipt.payloadBytes + receiptBytes.length > RUNTIME_MAX_BYTES
      || !receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files)
      || !Object.keys(receipt.files).length || Object.keys(receipt.files).length >= RUNTIME_MAX_FILES) throw new Error('Invalid runtime receipt');
  const pending = new Map(Object.entries(receipt.files));
  let bytes = 0, entries = 0;
  async function inspect(path, prefix = '') {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (++entries > RUNTIME_MAX_FILES * 2) throw new Error('Too many runtime artifact entries');
      const name = prefix + item.name, fullPath = join(path, item.name);
      if (item.isDirectory()) await inspect(fullPath, name + '/');
      else if (item.isFile()) {
        if (name === 'runtime.json') continue;
        const expected = pending.get(name);
        if (!expected || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 0 || expected.sizeBytes > RUNTIME_MAX_BYTES
            || !/^[a-f0-9]{64}$/.test(expected.sha256 ?? '')) throw new Error('Unexpected runtime artifact file');
        const data = await readRegular(fullPath, Math.min(expected.sizeBytes, RUNTIME_MAX_BYTES - bytes));
        bytes += data.length;
        if (data.length !== expected.sizeBytes || sha256(data) !== expected.sha256) throw new Error('Runtime artifact content mismatch');
        pending.delete(name);
      } else throw new Error('Runtime artifact contains a nonregular entry');
    }
  }
  await inspect(root);
  if (pending.size || bytes !== receipt.payloadBytes) throw new Error('Runtime artifact inventory mismatch');
  for (const name of ['run.mjs', 'archive.mjs', 'runtime.mjs']) {
    if (!Object.hasOwn(receipt.files, `controlled-evals/${name}`)) throw new Error('Runtime entrypoint is missing');
  }
  return { sourceRevision, receiptSha256, totalBytes: bytes + receiptBytes.length, files: Object.keys(receipt.files).length + 1 };
}

if (await isEntrypoint(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error('Usage: verify-runtime.mjs <directory> <source-revision> <trusted-receipt-sha256>');
  process.stdout.write(JSON.stringify(await verifyControllerRuntime({ directory: process.argv[2], sourceRevision: process.argv[3], receiptSha256: process.argv[4] })) + '\n');
}
