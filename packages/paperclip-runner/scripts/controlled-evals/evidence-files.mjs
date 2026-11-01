import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';

const MiB = 1_048_576;
export const FILE_LIMITS = new Map([
  ['admission.json', MiB], ['request.json', 8 * MiB], ['gateway.json', 8192],
  ['ledger.jsonl', 16 * MiB], ['result.json', MiB], ['provider-artifact.json', 16 * MiB],
  ['observability.json', 131_072], ['otlp-native.jsonl', 2 * MiB], ['otlp-controller.jsonl', 2 * MiB], ['otlp-root.json', 16_384],
  ['stdout.log', MiB], ['stderr.log', MiB],
]);
export const RECEIPT = /^receipts\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
export const limitFor = name => FILE_LIMITS.get(name) ?? (RECEIPT.test(name) ? MiB : 0);

export async function readRegularFile(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Controller evidence is not a bounded regular file');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('Controller evidence changed while being read');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export async function replaceEvidenceFile(path, bytes) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}
