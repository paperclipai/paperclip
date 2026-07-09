import { parseJson } from "@paperclipai/adapter-utils/server-utils";

export const DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS = 7 * 60 * 1000;
export const CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS = 5_000;

export type CodexOutputInactivityMonitorResolution =
  | { mode: "default"; timeoutMs: number }
  | { mode: "configured"; timeoutMs: number }
  | { mode: "disabled"; reason: "explicit_null" }
  | { mode: "default"; timeoutMs: number; reason: "non_positive" };

/**
 * Resolve the inactivity monitor timeout from raw adapter config.
 *
 * - `null`         → disabled (explicit escape hatch).
 * - missing/`undefined` → default 7m.
 * - number > 0     → configured value.
 * - number ≤ 0     → default 7m (and a `non_positive` note for logging).
 */
export function resolveCodexInactivityTimeout(rawValue: unknown): CodexOutputInactivityMonitorResolution {
  if (rawValue === null) return { mode: "disabled", reason: "explicit_null" };
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    if (rawValue > 0) return { mode: "configured", timeoutMs: rawValue };
    return { mode: "default", timeoutMs: DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS, reason: "non_positive" };
  }
  return { mode: "default", timeoutMs: DEFAULT_CODEX_OUTPUT_INACTIVITY_TIMEOUT_MS };
}

export interface CodexOutputInactivityMonitorState {
  fired: boolean;
  spawnedAt: number;
  lastEventAt: number;
  firedAt: number | null;
  parsedEventCount: number;
}

export interface CodexOutputInactivityMonitorOptions {
  timeoutMs: number;
  onFire: (state: CodexOutputInactivityMonitorState) => void;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Per-line predicate. When omitted, any line that successfully parses as
   * JSON via the codex JSONL parser counts as a heartbeat event.
   */
  isHeartbeatLine?: (line: string) => boolean;
}

export interface CodexOutputInactivityMonitorHandle {
  noteStdoutChunk(chunk: string): void;
  /** Returns the current state without stopping the timer. */
  state(): CodexOutputInactivityMonitorState;
  /** Cancels any pending timer and returns the final state. */
  stop(): CodexOutputInactivityMonitorState;
}

function defaultIsHeartbeatLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return parseJson(trimmed) !== null;
}

export function createCodexOutputInactivityMonitor(
  options: CodexOutputInactivityMonitorOptions,
): CodexOutputInactivityMonitorHandle {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const isHeartbeatLine = options.isHeartbeatLine ?? defaultIsHeartbeatLine;
  const timeoutMs = options.timeoutMs;

  if (!(timeoutMs > 0)) {
    throw new Error(`createCodexOutputInactivityMonitor requires timeoutMs > 0 (got ${timeoutMs})`);
  }

  const spawnedAt = now();
  const state: CodexOutputInactivityMonitorState = {
    fired: false,
    spawnedAt,
    lastEventAt: spawnedAt,
    firedAt: null,
    parsedEventCount: 0,
  };
  let timerHandle: unknown = null;
  let stopped = false;

  const fire = () => {
    if (state.fired || stopped) return;
    state.fired = true;
    state.firedAt = now();
    timerHandle = null;
    options.onFire({ ...state });
  };

  const arm = () => {
    if (stopped || state.fired) return;
    if (timerHandle != null) clearTimer(timerHandle);
    timerHandle = setTimer(fire, timeoutMs);
  };

  arm();

  return {
    noteStdoutChunk(chunk: string) {
      if (stopped || state.fired) return;
      let sawHeartbeat = false;
      for (const rawLine of chunk.split(/\r?\n/)) {
        if (isHeartbeatLine(rawLine)) {
          sawHeartbeat = true;
          state.parsedEventCount += 1;
        }
      }
      if (sawHeartbeat) {
        state.lastEventAt = now();
        arm();
      }
    },
    state() {
      return { ...state };
    },
    stop() {
      stopped = true;
      if (timerHandle != null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
      return { ...state };
    },
  };
}

/**
 * Format the inactivity monitor error message in the canonical
 * `monitor: no codex output for {N}m {S}s` shape consumed by NEE-81.
 */
export function formatOutputInactivityMonitorErrorMessage(elapsedMs: number): string {
  const total = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `monitor: no codex output for ${minutes}m ${seconds}s`;
}
