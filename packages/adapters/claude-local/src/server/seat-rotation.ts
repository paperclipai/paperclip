/**
 * Seat-rotation retry support for the `claude-seat-rotator` watchdog.
 *
 * The seat rotator (https://github.com/.../claude-seat-rotator) moves a single
 * Claude Team Premium seat between accounts. During the ~5-25 s seat-swap
 * window, `api.anthropic.com` returns HTTP 403 with a body matching
 * `Your organization does not have access to Claude` for any in-flight
 * Claude CLI call, because the active account briefly holds no Premium seat.
 *
 * The watchdog mitigates the window by writing a marker file at
 * `~/.claude/seat-rotator-switching.json` before starting a swap and clearing
 * it after completion. This module reads that marker and exposes a liveness
 * helper so the adapter can retry the spawned Claude CLI with linear backoff
 * instead of bubbling the 403 up as a hard failure.
 *
 * Marker schema is mirrored from `claude-seat-rotator/src/switch-marker.ts`.
 * Treat the schema as a stable contract — bump `SEAT_ROTATION_MARKER_PATH` or
 * the parser if the rotator changes its on-disk format.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SEAT_ROTATION_MARKER_PATH = join(
  homedir(),
  ".claude",
  "seat-rotator-switching.json",
);

export interface SeatRotationMarker {
  from: string;
  to: string;
  startedAt: string;
  expectedDurationMs: number;
  pid: number;
}

export function readSeatRotationMarker(
  path: string = SEAT_ROTATION_MARKER_PATH,
): SeatRotationMarker | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.from !== "string" ||
    typeof obj.to !== "string" ||
    typeof obj.startedAt !== "string" ||
    typeof obj.expectedDurationMs !== "number" ||
    typeof obj.pid !== "number"
  ) {
    return null;
  }
  return {
    from: obj.from,
    to: obj.to,
    startedAt: obj.startedAt,
    expectedDurationMs: obj.expectedDurationMs,
    pid: obj.pid,
  };
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    // EPERM means the pid exists but is owned by another user — still alive.
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * "Alive" = marker present, pid alive, and not older than 2× the rotator's
 * own expected duration. Older markers are treated as stale leftovers from a
 * crashed watchdog.
 */
export function isSeatRotationInProgress(
  now: Date = new Date(),
  reader: () => SeatRotationMarker | null = readSeatRotationMarker,
  pidLivenessCheck: (pid: number) => boolean = isPidAlive,
): { inProgress: boolean; marker: SeatRotationMarker | null } {
  const marker = reader();
  if (!marker) return { inProgress: false, marker: null };
  if (!pidLivenessCheck(marker.pid)) return { inProgress: false, marker };

  const startedAt = Date.parse(marker.startedAt);
  if (Number.isFinite(startedAt)) {
    const ageMs = now.getTime() - startedAt;
    const staleAfterMs = Math.max(marker.expectedDurationMs * 2, 60_000);
    if (ageMs > staleAfterMs) return { inProgress: false, marker };
  }
  return { inProgress: true, marker };
}

export const SEAT_ROTATION_RETRY_DEFAULT_BUDGET_MS = 45_000;
export const SEAT_ROTATION_RETRY_DEFAULT_BASE_BACKOFF_MS = 3_000;

export interface SeatRotationRetryConfig {
  totalBudgetMs?: number;
  baseBackoffMs?: number;
  isInProgress?: () => { inProgress: boolean; marker: SeatRotationMarker | null };
  onLog?: (message: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Retry `runAttempt` while `isAccessError(attempt)` is true and we are inside
 * the seat-rotation switching window. Caps total wall-clock at
 * `totalBudgetMs` (~45 s by default, sized for 2× the rotator's own 30 s
 * expected duration). When the marker is absent or stale, retry once at most
 * — covers the small race where the 403 surfaces before the rotator has
 * written its marker file, but doesn't wait forever on unrelated 403s.
 */
export async function retryDuringSeatRotation<T>(
  initial: T,
  isAccessError: (attempt: T) => boolean,
  runAttempt: () => Promise<T>,
  config?: SeatRotationRetryConfig,
): Promise<T> {
  if (!isAccessError(initial)) return initial;

  const totalBudgetMs = config?.totalBudgetMs ?? SEAT_ROTATION_RETRY_DEFAULT_BUDGET_MS;
  const baseBackoffMs = config?.baseBackoffMs ?? SEAT_ROTATION_RETRY_DEFAULT_BASE_BACKOFF_MS;
  const isInProgress = config?.isInProgress ?? (() => isSeatRotationInProgress());
  const sleep = config?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const onLog = config?.onLog ?? (() => undefined);
  const now = config?.now ?? (() => Date.now());

  const startedAt = now();
  let attempt = initial;
  let retries = 0;

  while (isAccessError(attempt)) {
    const elapsed = now() - startedAt;
    const remaining = totalBudgetMs - elapsed;
    if (remaining <= 0) break;

    const liveness = isInProgress();
    if (!liveness.inProgress && retries >= 1) break;

    const backoff = Math.min(baseBackoffMs * (retries + 1), remaining);
    const markerNote = liveness.inProgress
      ? `live (pid ${liveness.marker?.pid ?? "?"})`
      : liveness.marker
      ? "stale"
      : "absent";
    await onLog(
      `[paperclip] seat-rotation 403 detected (marker ${markerNote}); retrying in ${backoff} ms (attempt ${retries + 1}).`,
    );

    await sleep(backoff);
    attempt = await runAttempt();
    retries += 1;
  }

  return attempt;
}
