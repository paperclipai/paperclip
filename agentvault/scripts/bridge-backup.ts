#!/usr/bin/env tsx
/**
 * Bridge Backup Script
 *
 * End-to-end automated backup flow:
 *  1. Read lastSynced timestamp from ~/.agentvault/bridge-state.json
 *  2. Serialize agent data to JSON
 *  3. Gzip the payload
 *  4. Spawn `agentvault backup export` as a child process
 *  5. Update lastSynced timestamp on success
 *
 * Usage:
 *   npx tsx scripts/bridge-backup.ts <agent-name> [--canister-id <id>] [--full]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

// ── Paths ────────────────────────────────────────────────────────────────────

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const BRIDGE_STATE_FILE = path.join(AGENTVAULT_DIR, 'bridge-state.json');
const BACKUPS_DIR = path.join(AGENTVAULT_DIR, 'backups');

// ── Bridge State ─────────────────────────────────────────────────────────────

interface BridgeState {
  lastSynced: string | null;
  lastBackupPath: string | null;
  lastAgentName: string | null;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadBridgeState(): BridgeState {
  try {
    if (fs.existsSync(BRIDGE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(BRIDGE_STATE_FILE, 'utf8')) as BridgeState;
    }
  } catch {
    // Corrupt state file — start fresh
  }
  return { lastSynced: null, lastBackupPath: null, lastAgentName: null };
}

function saveBridgeState(state: BridgeState): void {
  ensureDir(path.dirname(BRIDGE_STATE_FILE));
  fs.writeFileSync(BRIDGE_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Serialization & Compression ──────────────────────────────────────────────

interface BackupPayload {
  agentName: string;
  canisterId?: string;
  lastSynced: string | null;
  initiatedAt: string;
}

/**
 * Serialize backup metadata to JSON and gzip-compress it.
 * Returns the path to the compressed `.json.gz` staging file.
 */
async function serializeAndCompress(payload: BackupPayload): Promise<string> {
  const json = JSON.stringify(payload, null, 2);
  const stagingPath = path.join(
    BACKUPS_DIR,
    `bridge-staging-${Date.now()}.json.gz`,
  );

  ensureDir(BACKUPS_DIR);

  const source = Readable.from(Buffer.from(json, 'utf8'));
  const gzip = createGzip({ level: 9 });
  const dest = fs.createWriteStream(stagingPath);

  await pipeline(source, gzip, dest);
  return stagingPath;
}

// ── Child Process: agentvault backup ─────────────────────────────────────────

interface SpawnBackupOptions {
  agentName: string;
  canisterId?: string;
  full?: boolean;
}

/**
 * Spawn `agentvault backup export` as a child process and wait for it to
 * complete. Throws on non-zero exit or if the process times out (2 minutes).
 */
async function spawnBackup(opts: SpawnBackupOptions): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = opts.full ? 'zip' : 'json';
  const outputPath = path.join(BACKUPS_DIR, `${opts.agentName}-${timestamp}-bridge.${ext}`);

  const args = ['backup', 'export', opts.agentName, '--output', outputPath];

  if (opts.canisterId) {
    args.push('--canister-id', opts.canisterId);
  }
  if (opts.full) {
    args.push('--full');
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const cliPath = path.resolve(scriptDir, '..', 'dist', 'cli', 'index.js');

  const bin = fs.existsSync(cliPath) ? 'node' : 'agentvault';
  const spawnArgs = bin === 'node' ? [cliPath, ...args] : args;

  console.log(`[bridge-backup] Spawning: ${bin} ${spawnArgs.join(' ')}`);

  const result = await execa(bin, spawnArgs, {
    timeout: 120_000,
    reject: false,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr || result.stdout || 'unknown error';
    throw new Error(`agentvault backup exited with code ${result.exitCode}: ${stderr}`);
  }

  console.log(`[bridge-backup] Backup written to ${outputPath}`);
  return outputPath;
}

// ── CLI Argument Parsing ─────────────────────────────────────────────────────

interface CliArgs {
  agentName: string;
  canisterId?: string;
  full: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: npx tsx scripts/bridge-backup.ts <agent-name> [--canister-id <id>] [--full]');
    process.exit(0);
  }

  const agentName = args[0]!;
  let canisterId: string | undefined;
  let full = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--canister-id' && args[i + 1]) {
      canisterId = args[++i];
    } else if (args[i] === '--full') {
      full = true;
    }
  }

  return { agentName, canisterId, full };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { agentName, canisterId, full } = parseArgs();
  const now = new Date().toISOString();

  console.log(`[bridge-backup] Starting backup bridge for agent "${agentName}" at ${now}`);

  // 1. Read lastSynced from local state
  const state = loadBridgeState();
  console.log(
    `[bridge-backup] Last synced: ${state.lastSynced ?? 'never'}`,
  );

  // 2. Serialize payload and gzip-compress it
  const payload: BackupPayload = {
    agentName,
    canisterId,
    lastSynced: state.lastSynced,
    initiatedAt: now,
  };

  const stagingPath = await serializeAndCompress(payload);
  console.log(`[bridge-backup] Staged compressed payload: ${stagingPath}`);

  // 3. Spawn agentvault backup child process
  let backupPath: string;
  try {
    backupPath = await spawnBackup({ agentName, canisterId, full });
  } finally {
    // Clean up staging file regardless of backup outcome
    try {
      if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
    } catch {
      // Non-critical
    }
  }

  // 4. Save new lastSynced timestamp
  const updatedState: BridgeState = {
    lastSynced: now,
    lastBackupPath: backupPath,
    lastAgentName: agentName,
  };
  saveBridgeState(updatedState);

  console.log(`[bridge-backup] Bridge state saved — lastSynced: ${now}`);
  console.log(`[bridge-backup] Backup complete: ${backupPath}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[bridge-backup] Fatal error: ${msg}`);
  process.exit(1);
});
