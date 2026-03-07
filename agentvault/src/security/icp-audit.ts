/**
 * ICP On-Chain Audit Log — AgentVault MFA Layer 5
 *
 * Writes every MFA approval event to ICP stable memory so the audit trail
 * is tamper-evident, globally verifiable, and independent of the local filesystem.
 *
 * Design
 * ──────
 *  • Each audit entry is serialised to JSON and submitted via an update call to
 *    the AgentVault canister's `storeMfaAuditEntry` method.
 *  • The canister appends entries to a stable Vec (survives upgrades) and enforces:
 *      – Append-only: no deletions, no overwrites.
 *      – Caller-checked: only authorised principals can write.
 *      – nonce-ordered: entries with nonce N+1 must arrive after N.
 *  • Reads use `getMfaAuditLog(branchId)` — a query call, free and fast.
 *  • If the ICP node is unreachable, entries are buffered in a local YAML queue
 *    and replayed the next time `flushIcpAuditQueue()` is called.
 *
 * Canister interface (Candid excerpt — see canister/agent.mo)
 * ────────────────────────────────────────────────────────────
 *   storeMfaAuditEntry : (MfaAuditEntryInput) -> (variant { ok : nat; err : text })
 *   getMfaAuditLog     : (branchId : text)    -> (vec MfaAuditEntry)          query
 *
 * Setup
 * ──────
 *  Set AGENTVAULT_CANISTER_ID and AGENTVAULT_IC_HOST in environment or icp.yaml.
 *  If neither is set the module operates in local-only mode (no ICP calls).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';
import type { MfaAuditEntry } from './mfa-approval.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const MFA_DIR = path.join(os.homedir(), '.agentvault', 'mfa');
const ICP_QUEUE_FILE = path.join(MFA_DIR, 'icp-audit-queue.yaml');

function ensureMfaDir(): void {
  fs.mkdirSync(MFA_DIR, { recursive: true });
}

/** ICP configuration — reads from env or falls back to local-only mode. */
function getIcpConfig(): { canisterId: string; host: string } | null {
  const canisterId =
    process.env['AGENTVAULT_CANISTER_ID'] ??
    process.env['CANISTER_ID_AGENT'] ??
    null;
  const host = process.env['AGENTVAULT_IC_HOST'] ?? 'https://ic0.app';
  if (!canisterId) return null;
  return { canisterId, host };
}

// ─── Queue (offline buffer) ───────────────────────────────────────────────────

interface QueuedEntry {
  entry: MfaAuditEntry;
  queuedAt: string;
  attempts: number;
}

function loadQueue(): QueuedEntry[] {
  if (!fs.existsSync(ICP_QUEUE_FILE)) return [];
  return parse(fs.readFileSync(ICP_QUEUE_FILE, 'utf8')) as QueuedEntry[];
}

function saveQueue(q: QueuedEntry[]): void {
  ensureMfaDir();
  fs.writeFileSync(ICP_QUEUE_FILE, stringify(q), 'utf8');
}

// ─── ICP canister actor (lazy import to avoid hard dep when ICP not configured) ─

async function buildActor(canisterId: string, host: string) {
  // Dynamic import keeps startup fast when ICP is not configured
  const { HttpAgent, Actor } = await import('@dfinity/agent');

  const icpAuditIdl = ({ IDL }: { IDL: any }) =>
    IDL.Service({
      storeMfaAuditEntry: IDL.Func(
        [
          IDL.Record({
            id: IDL.Text,
            requestId: IDL.Text,
            branchId: IDL.Text,
            event: IDL.Text,
            nonce: IDL.Opt(IDL.Nat),
            challengeHash: IDL.Opt(IDL.Text),
            auditToken: IDL.Opt(IDL.Text),
            deviceFingerprint: IDL.Opt(IDL.Text),
            timestamp: IDL.Text,
            detail: IDL.Opt(IDL.Text),
          }),
        ],
        [IDL.Variant({ ok: IDL.Nat, err: IDL.Text })],
        [],
      ),
      getMfaAuditLog: IDL.Func(
        [IDL.Text],
        [
          IDL.Vec(
            IDL.Record({
              id: IDL.Text,
              requestId: IDL.Text,
              branchId: IDL.Text,
              event: IDL.Text,
              nonce: IDL.Opt(IDL.Nat),
              challengeHash: IDL.Opt(IDL.Text),
              auditToken: IDL.Opt(IDL.Text),
              deviceFingerprint: IDL.Opt(IDL.Text),
              timestamp: IDL.Text,
              detail: IDL.Opt(IDL.Text),
            }),
          ),
        ],
        ['query'],
      ),
    });

  const agent = await HttpAgent.create({ host });
  // Fetch root key on non-mainnet hosts (local replica)
  if (!host.includes('ic0.app')) {
    await agent.fetchRootKey().catch(() => {
      // Non-fatal — local replica may not be running
    });
  }

  return Actor.createActor(icpAuditIdl, { agent, canisterId });
}

// ─── Candid helpers ───────────────────────────────────────────────────────────

/** Convert an MfaAuditEntry to the Candid record expected by storeMfaAuditEntry. */
function toCanisterRecord(e: MfaAuditEntry): Record<string, unknown> {
  return {
    id: e.id,
    requestId: e.requestId,
    branchId: e.branchId,
    event: e.event,
    nonce: e.nonce !== undefined ? [BigInt(e.nonce)] : [],
    challengeHash: e.challengeHash ? [e.challengeHash] : [],
    auditToken: e.auditToken ? [e.auditToken] : [],
    deviceFingerprint: e.deviceFingerprint ? [e.deviceFingerprint] : [],
    timestamp: e.timestamp,
    detail: e.detail ? [e.detail] : [],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Submit an MFA audit entry to the ICP canister.
 *
 * If ICP is unreachable or not configured:
 *   – The entry is added to the local retry queue (`~/.agentvault/mfa/icp-audit-queue.yaml`).
 *   – Returns { ok: false, queued: true } — the entry is NOT lost.
 *
 * @param entry - Audit entry to persist on-chain
 */
export async function submitIcpAuditEntry(
  entry: MfaAuditEntry,
): Promise<{ ok: true; index: bigint } | { ok: false; queued: boolean; reason: string }> {
  const config = getIcpConfig();

  if (!config) {
    // No canister configured — queue locally and return
    enqueueLocally(entry);
    return { ok: false, queued: true, reason: 'icp-not-configured' };
  }

  try {
    const actor = await buildActor(config.canisterId, config.host);
    const rec = toCanisterRecord(entry);
    const result = (await (actor as any).storeMfaAuditEntry(rec)) as
      | { ok: bigint }
      | { err: string };

    if ('ok' in result) {
      return { ok: true, index: result.ok };
    } else {
      enqueueLocally(entry);
      return { ok: false, queued: true, reason: result.err };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    enqueueLocally(entry);
    return { ok: false, queued: true, reason };
  }
}

/**
 * Query the ICP canister for the full audit log of a branch.
 *
 * Falls back to an empty array if ICP is not configured or unreachable.
 * The caller should merge the result with the local YAML audit log.
 */
export async function queryIcpAuditLog(branchId: string): Promise<MfaAuditEntry[]> {
  const config = getIcpConfig();
  if (!config) return [];

  try {
    const actor = await buildActor(config.canisterId, config.host);
    const raw = (await (actor as any).getMfaAuditLog(branchId)) as Array<Record<string, unknown>>;

    return raw.map((r) => ({
      id: r['id'] as string,
      requestId: r['requestId'] as string,
      branchId: r['branchId'] as string,
      event: r['event'] as MfaAuditEntry['event'],
      nonce: Array.isArray(r['nonce']) && r['nonce'].length > 0
        ? Number(r['nonce'][0])
        : undefined,
      challengeHash: Array.isArray(r['challengeHash']) && r['challengeHash'].length > 0
        ? (r['challengeHash'][0] as string)
        : undefined,
      auditToken: Array.isArray(r['auditToken']) && r['auditToken'].length > 0
        ? (r['auditToken'][0] as string)
        : undefined,
      deviceFingerprint: Array.isArray(r['deviceFingerprint']) && r['deviceFingerprint'].length > 0
        ? (r['deviceFingerprint'][0] as string)
        : undefined,
      timestamp: r['timestamp'] as string,
      detail: Array.isArray(r['detail']) && r['detail'].length > 0
        ? (r['detail'][0] as string)
        : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Retry queued audit entries that previously failed to reach ICP.
 *
 * Call this periodically (e.g. on CLI startup or via `agentvault repo audit --flush`).
 * Returns the number of entries successfully flushed.
 */
export async function flushIcpAuditQueue(): Promise<number> {
  const queue = loadQueue();
  if (queue.length === 0) return 0;

  const config = getIcpConfig();
  if (!config) return 0;

  let flushed = 0;
  const remaining: QueuedEntry[] = [];

  for (const item of queue) {
    item.attempts += 1;
    const result = await submitIcpAuditEntry(item.entry);
    if (result.ok) {
      flushed += 1;
    } else {
      // Keep in queue; cap at 10 attempts to avoid infinite retry
      if (item.attempts < 10) {
        remaining.push(item);
      }
    }
  }

  saveQueue(remaining);
  return flushed;
}

/** Return the number of entries currently in the local retry queue. */
export function getIcpQueueDepth(): number {
  return loadQueue().length;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function enqueueLocally(entry: MfaAuditEntry): void {
  ensureMfaDir();
  const queue = loadQueue();
  queue.push({ entry, queuedAt: new Date().toISOString(), attempts: 0 });
  saveQueue(queue);
}
