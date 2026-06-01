/**
 * $0 Max-seat rotation for the claude_local adapter (ROCAA-325).
 *
 * When the primary Claude seat returns `claude_auth_required` (out-of-extra-usage
 * or auth error), this module cycles through a list of credentialed Max seats
 * before allowing the Tier 1 paid fallback to fire.
 *
 * Configuration:
 *   PAPERCLIP_CLAUDE_SEAT_PROFILES — colon-separated list of absolute profile
 *   directories (each containing a valid `.credentials.json`). Rotation order
 *   follows list order. If unset, no rotation is attempted.
 *
 * State:
 *   ~/.cache/paperclip-seat-rotation/current.json — tracks which seat index was
 *   last tried within the current rotation epoch.  Resets when all seats are
 *   exhausted or when `resetSeatRotation()` is called.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── On-disk shape ────────────────────────────────────────────────────────────

export interface SeatRotationState {
  /** Absolute profile dirs that were healthy at rotation-start. */
  profiles: string[];
  /** Index into `profiles` of the seat to try next (0 = first fallback). */
  nextIndex: number;
  /** ISO timestamp of last state write. */
  updatedAt: string;
  /**
   * True when every profile in the list has returned `auth_required` during
   * the current epoch.  Resets to false only when `resetSeatRotation` is called.
   */
  exhausted: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function defaultSeatCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PAPERCLIP_SEAT_ROTATION_CACHE_DIR;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".cache", "paperclip-seat-rotation");
}

/**
 * Parse `PAPERCLIP_CLAUDE_SEAT_PROFILES` into an ordered list of candidate
 * profile directories.  Skips profiles that lack `.credentials.json`.
 */
export function resolveHealthySeatProfiles(
  env: NodeJS.ProcessEnv = process.env,
  fsExistsSync: (p: string) => boolean = existsSync,
): string[] {
  const raw = env.PAPERCLIP_CLAUDE_SEAT_PROFILES ?? "";
  if (raw.trim().length === 0) return [];
  return raw
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => fsExistsSync(join(p, ".credentials.json")));
}

function readState(cacheDir: string): SeatRotationState | null {
  const file = join(cacheDir, "current.json");
  if (!existsSync(file)) return null;
  try {
    const obj = JSON.parse(readFileSync(file, "utf8")) as SeatRotationState;
    if (!Array.isArray(obj.profiles) || typeof obj.nextIndex !== "number") return null;
    return obj;
  } catch {
    return null;
  }
}

function writeState(cacheDir: string, state: SeatRotationState): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "current.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SeatRotationDeps {
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  /** Injected for tests. */
  fsExistsSync?: (p: string) => boolean;
}

export interface NextSeatResult {
  /**
   * The profile directory to use for the next attempt, or `null` when all
   * seats are exhausted (caller should allow Tier 1 gate to proceed).
   */
  profileDir: string | null;
  /** `true` when every seat has been tried and all returned auth_required. */
  allExhausted: boolean;
}

/**
 * Return the next healthy seat to try.
 *
 * Initialises state from `PAPERCLIP_CLAUDE_SEAT_PROFILES` on the first call
 * after a reset.  On each subsequent call the index advances by one.  When
 * the list is exhausted, returns `{ profileDir: null, allExhausted: true }`.
 *
 * Thread-safety note: state is written synchronously.  Race conditions are
 * possible if multiple adapters run concurrently on the same host; this is
 * acceptable for the typical single-agent heartbeat cadence.
 */
export function pickNextSeat(deps: SeatRotationDeps = {}): NextSeatResult {
  const env = deps.env ?? process.env;
  const cacheDir = deps.cacheDir ?? defaultSeatCacheDir(env);
  const fsExists = deps.fsExistsSync ?? existsSync;

  const profiles = resolveHealthySeatProfiles(env, fsExists);
  if (profiles.length === 0) {
    return { profileDir: null, allExhausted: true };
  }

  const prior = readState(cacheDir);
  // If state exists and the profile list matches, advance; otherwise restart.
  const sameProfiles =
    prior !== null &&
    prior.profiles.length === profiles.length &&
    prior.profiles.every((p, i) => p === profiles[i]);

  let nextIndex: number;
  if (!sameProfiles || prior === null) {
    nextIndex = 0;
  } else if (prior.exhausted) {
    return { profileDir: null, allExhausted: true };
  } else {
    nextIndex = prior.nextIndex;
  }

  if (nextIndex >= profiles.length) {
    writeState(cacheDir, {
      profiles,
      nextIndex: profiles.length,
      updatedAt: new Date().toISOString(),
      exhausted: true,
    });
    return { profileDir: null, allExhausted: true };
  }

  const profileDir = profiles[nextIndex];
  writeState(cacheDir, {
    profiles,
    nextIndex: nextIndex + 1,
    updatedAt: new Date().toISOString(),
    exhausted: false,
  });

  return { profileDir, allExhausted: false };
}

/**
 * Reset the rotation epoch.  Call this after a successful run so the next
 * auth failure starts from the beginning of the list.
 */
export function resetSeatRotation(deps: SeatRotationDeps = {}): void {
  const env = deps.env ?? process.env;
  const cacheDir = deps.cacheDir ?? defaultSeatCacheDir(env);
  const fsExists = deps.fsExistsSync ?? existsSync;

  const profiles = resolveHealthySeatProfiles(env, fsExists);
  writeState(cacheDir, {
    profiles,
    nextIndex: 0,
    updatedAt: new Date().toISOString(),
    exhausted: false,
  });
}
