// Renew the bot-side lease before each designer tool invocation.
// No-ops in desktop mode (env vars unset).
import * as fs from 'node:fs';
import * as path from 'node:path';

export async function maybeRenewLease(): Promise<void> {
  const runDir = process.env.DESIGNER_RUN_DIR;
  const host = process.env.CCROTATE_DESIGNER_LEASE_HOST;
  if (!runDir || !host) return;
  let leaseId: string;
  try {
    leaseId = fs.readFileSync(path.join(runDir, 'lease-id'), 'utf8').trim();
  } catch {
    return;
  }
  if (!leaseId) return;
  try {
    await fetch(`${host}/renew`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: leaseId, durationSec: 3600 }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn('[designer] lease renew failed:', (e as Error).message);
  }
}
