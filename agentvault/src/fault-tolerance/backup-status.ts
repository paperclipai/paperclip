/**
 * Backup Status — last-backup timestamp inspection
 *
 * Scans ~/.agentvault/backups/ and returns information about the most recent
 * backup file for a given agent (or globally if no agent name is supplied).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const BACKUPS_DIR = path.join(AGENTVAULT_DIR, 'backups');

export interface BackupTimestampInfo {
  found: boolean;
  /** Absolute path to the most recent backup file */
  filePath?: string;
  /** ISO-8601 timestamp recorded inside the manifest */
  timestamp?: string;
  /** mtime of the file on disk (may differ when copied) */
  mtimeISO?: string;
  /** Seconds since the backup was taken (based on manifest timestamp) */
  ageSeconds?: number;
  /** Human-readable age string */
  ageHuman?: string;
  agentName?: string;
  /** true when the backup is older than staleThresholdHours */
  stale?: boolean;
  staleThresholdHours: number;
}

function humanAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Find the most recent backup file in BACKUPS_DIR.
 *
 * @param agentName  Optional filter; if omitted, all agent backups are scanned.
 * @param staleThresholdHours  Hours after which a backup is considered stale (default 25).
 */
export function getLastBackupInfo(
  agentName?: string,
  staleThresholdHours = 25
): BackupTimestampInfo {
  const base: BackupTimestampInfo = { found: false, staleThresholdHours };

  if (!fs.existsSync(BACKUPS_DIR)) {
    return base;
  }

  const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.json'));

  // Narrow to agent-specific files when a name is given
  const candidates = agentName
    ? files.filter(f => f.startsWith(`${agentName}-`) || f.startsWith(agentName))
    : files;

  if (candidates.length === 0) {
    return base;
  }

  // Sort by mtime descending — fastest heuristic without parsing every file
  const withStats = candidates
    .map(f => ({ f, mtime: fs.statSync(path.join(BACKUPS_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  // Walk from newest to oldest until we find a valid manifest
  for (const { f, mtime } of withStats) {
    const filePath = path.join(BACKUPS_DIR, f);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const manifest = JSON.parse(raw) as {
        timestamp?: string;
        created?: string;
        agentName?: string;
      };

      const rawTs = manifest.timestamp ?? manifest.created;
      if (!rawTs) continue;

      const ts = new Date(rawTs);
      if (isNaN(ts.getTime())) continue;

      const ageSeconds = Math.floor((Date.now() - ts.getTime()) / 1000);
      const stale = ageSeconds > staleThresholdHours * 3600;

      return {
        found: true,
        filePath,
        timestamp: ts.toISOString(),
        mtimeISO: mtime.toISOString(),
        ageSeconds,
        ageHuman: humanAge(ageSeconds),
        agentName: manifest.agentName ?? agentName,
        stale,
        staleThresholdHours,
      };
    } catch {
      // Corrupt/incomplete file — try the next one
    }
  }

  return base;
}
