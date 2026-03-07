/**
 * Mirror Sync — ICP inter-canister state mirroring
 *
 * Helpers for the TypeScript CLI side of canister mirroring.
 * The actual inter-canister calls live in canister/agent.mo.
 *
 * Mirror config is stored in ~/.agentvault/mirror-config.json
 * so it survives CLI restarts without re-deployment.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const MIRROR_CONFIG_FILE = path.join(AGENTVAULT_DIR, 'mirror-config.json');

function ensureDir(p: string): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Config ─────────────────────────────────────────────────────────────────────

export interface MirrorConfig {
  primaryCanisterId: string;
  mirrorCanisterId: string;
  network: string;
  registeredAt: string;
}

export function saveMirrorConfig(cfg: MirrorConfig): void {
  ensureDir(MIRROR_CONFIG_FILE);
  fs.writeFileSync(MIRROR_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

export function loadMirrorConfig(): MirrorConfig | null {
  try {
    if (fs.existsSync(MIRROR_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(MIRROR_CONFIG_FILE, 'utf8')) as MirrorConfig;
    }
  } catch {/* ignore */}
  return null;
}

export function deleteMirrorConfig(): void {
  if (fs.existsSync(MIRROR_CONFIG_FILE)) fs.unlinkSync(MIRROR_CONFIG_FILE);
}

// ── ICP client helpers ─────────────────────────────────────────────────────────

async function getClient(network: string) {
  const { createICPClient } = await import('../deployment/icpClient.js');
  return createICPClient({ network: network as 'local' | 'ic' });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface MirrorSetResult {
  success: boolean;
  primaryCanisterId: string;
  mirrorCanisterId: string;
  error?: string;
}

/**
 * Register a mirror canister on the primary canister via inter-canister call.
 * Persists the config locally for future CLI invocations.
 */
export async function setMirrorCanister(
  primaryCanisterId: string,
  mirrorCanisterId: string,
  network = 'ic'
): Promise<MirrorSetResult> {
  try {
    const client = await getClient(network);
    const result = await client.callAgentMethod(primaryCanisterId, 'setMirrorCanister', [
      mirrorCanisterId,
    ]);

    const ok =
      result !== null &&
      typeof result === 'object' &&
      'ok' in (result as object);

    if (!ok) {
      const errMsg =
        result !== null &&
        typeof result === 'object' &&
        'err' in (result as object)
          ? String((result as { err: unknown }).err)
          : 'Unknown error from canister';
      return { success: false, primaryCanisterId, mirrorCanisterId, error: errMsg };
    }

    const cfg: MirrorConfig = {
      primaryCanisterId,
      mirrorCanisterId,
      network,
      registeredAt: new Date().toISOString(),
    };
    saveMirrorConfig(cfg);

    return { success: true, primaryCanisterId, mirrorCanisterId };
  } catch (err) {
    return {
      success: false,
      primaryCanisterId,
      mirrorCanisterId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SyncResult {
  success: boolean;
  direction: 'push' | 'pull';
  primaryCanisterId: string;
  mirrorCanisterId: string;
  syncedAt?: string;
  error?: string;
}

/**
 * Push state from primary → mirror (inter-canister call on primary).
 */
export async function syncToMirror(
  primaryCanisterId: string,
  mirrorCanisterId: string,
  network = 'ic'
): Promise<SyncResult> {
  try {
    const client = await getClient(network);
    const result = await client.callAgentMethod(primaryCanisterId, 'syncToMirror', [
      mirrorCanisterId,
    ]);

    const ok =
      result !== null &&
      typeof result === 'object' &&
      'ok' in (result as object);

    if (!ok) {
      const errMsg =
        result !== null &&
        typeof result === 'object' &&
        'err' in (result as object)
          ? String((result as { err: unknown }).err)
          : 'Unknown error from canister';
      return {
        success: false,
        direction: 'push',
        primaryCanisterId,
        mirrorCanisterId,
        error: errMsg,
      };
    }

    return {
      success: true,
      direction: 'push',
      primaryCanisterId,
      mirrorCanisterId,
      syncedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      success: false,
      direction: 'push',
      primaryCanisterId,
      mirrorCanisterId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pull state from mirror → primary (inter-canister call on primary).
 * Used to recover a wiped primary from its mirror.
 */
export async function syncFromMirror(
  primaryCanisterId: string,
  mirrorCanisterId: string,
  network = 'ic'
): Promise<SyncResult> {
  try {
    const client = await getClient(network);
    const result = await client.callAgentMethod(primaryCanisterId, 'syncFromMirror', [
      mirrorCanisterId,
    ]);

    const ok =
      result !== null &&
      typeof result === 'object' &&
      'ok' in (result as object);

    if (!ok) {
      const errMsg =
        result !== null &&
        typeof result === 'object' &&
        'err' in (result as object)
          ? String((result as { err: unknown }).err)
          : 'Unknown error from canister';
      return {
        success: false,
        direction: 'pull',
        primaryCanisterId,
        mirrorCanisterId,
        error: errMsg,
      };
    }

    return {
      success: true,
      direction: 'pull',
      primaryCanisterId,
      mirrorCanisterId,
      syncedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      success: false,
      direction: 'pull',
      primaryCanisterId,
      mirrorCanisterId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MirrorStatusResult {
  configured: boolean;
  primaryCanisterId?: string;
  mirrorCanisterId?: string;
  network?: string;
  registeredAt?: string;
  primaryAlive?: boolean;
  mirrorAlive?: boolean;
  error?: string;
}

/**
 * Check liveness of both primary and mirror canisters.
 */
export async function getMirrorStatus(network?: string): Promise<MirrorStatusResult> {
  const cfg = loadMirrorConfig();
  if (!cfg) {
    return { configured: false };
  }

  const net = network ?? cfg.network;

  const probe = async (id: string): Promise<boolean> => {
    try {
      const client = await getClient(net);
      const status = await client.getCanisterStatus(id);
      return status.status?.toLowerCase() === 'running';
    } catch {
      return false;
    }
  };

  const [primaryAlive, mirrorAlive] = await Promise.all([
    probe(cfg.primaryCanisterId),
    probe(cfg.mirrorCanisterId),
  ]);

  return {
    configured: true,
    primaryCanisterId: cfg.primaryCanisterId,
    mirrorCanisterId: cfg.mirrorCanisterId,
    network: net,
    registeredAt: cfg.registeredAt,
    primaryAlive,
    mirrorAlive,
  };
}
