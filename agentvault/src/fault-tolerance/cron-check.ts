/**
 * Cron Check — daily canister liveness check + auto-restore
 *
 * When the primary canister is unreachable or stopped, this module:
 *  1. Finds the most recent local backup (JSON or zip-wrapped JSON)
 *  2. Validates the backup manifest
 *  3. Triggers `agentvault backup import` to restore the agent
 *
 * Designed to be invoked by a system cron entry at 00:01 daily:
 *   1 0 * * * agentvault cron --check <canister-id> [--agent <name>]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getLastBackupInfo } from './backup-status.js';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const CRON_LOG = path.join(AGENTVAULT_DIR, 'cron.log');
const CRON_STATE_FILE = path.join(AGENTVAULT_DIR, 'cron-state.json');

// ── Logging ──────────────────────────────────────────────────────────────────

function ensureDir(p: string): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try {
    ensureDir(CRON_LOG);
    fs.appendFileSync(CRON_LOG, line, 'utf8');
  } catch {
    // If logging fails we still continue
  }
  process.stdout.write(line);
}

// ── Cron State ────────────────────────────────────────────────────────────────

export interface CronState {
  lastCheckISO: string;
  lastCheckResult: 'alive' | 'restored' | 'restore-failed' | 'no-backup';
  lastRestoreISO?: string;
  lastRestoreBackup?: string;
  consecutiveFailures: number;
}

function loadCronState(): CronState | null {
  try {
    if (fs.existsSync(CRON_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CRON_STATE_FILE, 'utf8')) as CronState;
    }
  } catch {/* ignore */}
  return null;
}

function saveCronState(state: CronState): void {
  try {
    ensureDir(CRON_STATE_FILE);
    fs.writeFileSync(CRON_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {/* ignore */}
}

// ── Canister Liveness ─────────────────────────────────────────────────────────

export type CanisterLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Probe the canister and return its liveness status.
 *
 * Uses the ICP client when available; falls back to "unknown" so that
 * auto-restore is NOT triggered on connectivity issues alone (conservative).
 */
async function probeCanister(
  canisterId: string,
  network: string
): Promise<CanisterLiveness> {
  try {
    const { createICPClient } = await import('../deployment/icpClient.js');
    const client = createICPClient({ network: network as 'local' | 'ic' });
    const status = await client.getCanisterStatus(canisterId);
    const s = status.status?.toLowerCase() ?? '';
    if (s === 'running') return 'alive';
    if (s === 'stopped') return 'dead';
    return 'unknown';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('WARN', `Canister probe failed: ${msg}`);
    return 'unknown';
  }
}

// ── Restore ───────────────────────────────────────────────────────────────────

export interface RestoreResult {
  success: boolean;
  backupPath?: string;
  agentName?: string;
  error?: string;
}

/**
 * Attempt to restore from the most recent local backup.
 */
async function restoreFromBackup(agentName?: string): Promise<RestoreResult> {
  const info = getLastBackupInfo(agentName);
  if (!info.found || !info.filePath) {
    return { success: false, error: 'No local backup found' };
  }

  log('INFO', `Restoring from backup: ${info.filePath} (age: ${info.ageHuman})`);

  try {
    const { importBackup } = await import('../backup/backup.js');
    const result = await importBackup({
      inputPath: info.filePath,
      targetAgentName: agentName,
      overwrite: true,
    });

    if (result.success) {
      log('INFO', `Restore succeeded — agent: ${result.agentName}, components: ${result.components.join(', ')}`);
      return { success: true, backupPath: info.filePath, agentName: result.agentName };
    } else {
      log('ERROR', `Restore failed: ${result.error ?? 'unknown'}`);
      return { success: false, backupPath: info.filePath, error: result.error };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', `Restore threw: ${msg}`);
    return { success: false, backupPath: info.filePath, error: msg };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface CronCheckOptions {
  canisterId: string;
  agentName?: string;
  network?: string;
  /** When true, only check — do NOT trigger restore even if canister is dead */
  dryRun?: boolean;
}

export interface CronCheckResult {
  canisterId: string;
  liveness: CanisterLiveness;
  action: 'none' | 'restore-skipped' | 'restore-attempted';
  restore?: RestoreResult;
  cronState: CronState;
}

/**
 * Run the daily canister-liveness check.
 *
 * - If canister is alive  → log OK, done.
 * - If canister is dead   → restore from latest local backup.
 * - If liveness unknown   → log warning, do NOT auto-restore (network blip).
 */
export async function runCronCheck(opts: CronCheckOptions): Promise<CronCheckResult> {
  const { canisterId, agentName, network = 'ic', dryRun = false } = opts;

  log('INFO', `Cron check — canister: ${canisterId}, network: ${network}${dryRun ? ' (dry-run)' : ''}`);

  const liveness = await probeCanister(canisterId, network);
  log('INFO', `Canister liveness: ${liveness}`);

  let action: CronCheckResult['action'] = 'none';
  let restore: RestoreResult | undefined;

  if (liveness === 'dead') {
    if (dryRun) {
      log('WARN', 'Canister is DEAD — dry-run mode, skipping restore');
      action = 'restore-skipped';
    } else {
      log('WARN', 'Canister is DEAD — attempting restore from local backup');
      action = 'restore-attempted';
      restore = await restoreFromBackup(agentName);
    }
  } else if (liveness === 'unknown') {
    log('WARN', 'Canister liveness unknown (network issue?). Skipping auto-restore to avoid false positive.');
  }

  const prev = loadCronState();
  const cronState: CronState = {
    lastCheckISO: new Date().toISOString(),
    lastCheckResult:
      liveness === 'alive'
        ? 'alive'
        : liveness === 'dead' && restore?.success
        ? 'restored'
        : liveness === 'dead' && restore && !restore.success
        ? 'restore-failed'
        : 'no-backup',
    consecutiveFailures:
      liveness !== 'alive'
        ? (prev?.consecutiveFailures ?? 0) + 1
        : 0,
    ...(restore?.success
      ? {
          lastRestoreISO: new Date().toISOString(),
          lastRestoreBackup: restore.backupPath,
        }
      : {
          lastRestoreISO: prev?.lastRestoreISO,
          lastRestoreBackup: prev?.lastRestoreBackup,
        }),
  };

  saveCronState(cronState);
  return { canisterId, liveness, action, restore, cronState };
}

// ── Crontab Installation ───────────────────────────────────────────────────────

export interface InstallCronOptions {
  canisterId: string;
  agentName?: string;
  network?: string;
  /** cron time expression; default "1 0 * * *" (00:01 daily) */
  cronTime?: string;
  /** Full path to the agentvault CLI binary; auto-detected if omitted */
  cliBin?: string;
}

/**
 * Print the crontab line that should be installed.
 * Returns the crontab line as a string so the caller can display it.
 */
export function buildCronLine(opts: InstallCronOptions): string {
  const {
    canisterId,
    agentName,
    network = 'ic',
    cronTime = '1 0 * * *',
    cliBin = 'agentvault',
  } = opts;

  const agentFlag = agentName ? ` --agent ${agentName}` : '';
  const netFlag = ` --network ${network}`;
  return `${cronTime} ${cliBin} cron check ${canisterId}${agentFlag}${netFlag} >> ${CRON_LOG} 2>&1`;
}

/**
 * Read the last cron run state from disk.
 */
export function readCronState(): CronState | null {
  return loadCronState();
}
