// Detects codex_local upstream/MCP transport stalls and emits a periodic
// synthetic keepalive on the adapter side. The keepalive bumps Paperclip's
// `lastOutputAt` while codex is silently retrying an upstream stream so the
// silent-run detector doesn't fire on a transient outage.
//
// Background: EIG-235 (umbrella) → EIG-238 / EIG-281 sub-pattern. Codex's MCP
// client can stall for hours with backoff between the rmcp `worker quit with
// fatal` event and the next `Reconnecting...` line, emitting nothing on
// stdout/stderr in between, which freezes Paperclip's silence clock.

const STREAM_STALL_PATTERNS: RegExp[] = [
  /worker quit with fatal:\s*Client error:\s*HTTP request failed/i,
  /Reconnecting\.\.\.\s*\d+\s*\/\s*\d+/i,
  /stream disconnected\b/i,
  /Connection reset by peer/i,
  /rmcp[^\n]*?\bfatal\b/i,
  /codex_models_manager:\s*failed to refresh available models/i,
  /failed to record rollout items:\s*\w+\s*[a-f0-9-]+\s*not found/i,
];

const KEEPALIVE_LINE_PREFIX = "[paperclip] codex_local: upstream stream stalled";

export function codexUpstreamKeepaliveLinePrefix(): string {
  return KEEPALIVE_LINE_PREFIX;
}

export function isCodexUpstreamStreamSignal(line: string): boolean {
  if (!line) return false;
  // Never re-detect our own keepalive output.
  if (line.startsWith(KEEPALIVE_LINE_PREFIX)) return false;
  return STREAM_STALL_PATTERNS.some((re) => re.test(line));
}

export function findCodexUpstreamStreamSignal(chunk: string): string | null {
  if (!chunk) return null;
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isCodexUpstreamStreamSignal(line)) {
      return line.length > 240 ? `${line.slice(0, 240)}…` : line;
    }
  }
  return null;
}

export function chunkHasNonStallOutput(chunk: string): boolean {
  if (!chunk) return false;
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(KEEPALIVE_LINE_PREFIX)) continue;
    if (!isCodexUpstreamStreamSignal(line)) return true;
  }
  return false;
}

type EmitFn = (stream: "stdout" | "stderr", chunk: string) => unknown;

export type CodexUpstreamKeepaliveOptions = {
  emit: EmitFn;
  intervalMs: number;
  // Optional ceiling on synthetic emits so a runaway codex hang doesn't fill
  // the run-log indefinitely. 0 (default) means unlimited.
  maxEmits?: number;
  setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  now?: () => number;
};

export type CodexUpstreamKeepaliveController = {
  observe(stream: "stdout" | "stderr", chunk: string): void;
  stop(): void;
  readonly emitCount: number;
  readonly active: boolean;
  readonly lastSignal: string | null;
};

export function createCodexUpstreamKeepalive(
  options: CodexUpstreamKeepaliveOptions,
): CodexUpstreamKeepaliveController {
  const intervalMs = Math.max(0, Math.floor(options.intervalMs ?? 0));
  const maxEmits = Math.max(0, Math.floor(options.maxEmits ?? 0));
  const setIntervalImpl =
    options.setIntervalImpl ??
    ((handler: () => void, ms: number) => setInterval(handler, ms) as unknown);
  const clearIntervalImpl =
    options.clearIntervalImpl ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const now = options.now ?? Date.now;

  let timer: unknown = null;
  let lastSignal: string | null = null;
  let emitCount = 0;
  let stopped = false;

  const emitOne = () => {
    if (stopped) return;
    if (maxEmits > 0 && emitCount >= maxEmits) {
      clearTimer();
      return;
    }
    emitCount += 1;
    const isoNow = new Date(now()).toISOString();
    const message =
      `${KEEPALIVE_LINE_PREFIX} ` +
      `(last signal: ${JSON.stringify(lastSignal ?? "")}; keepalive #${emitCount} at ${isoNow})\n`;
    try {
      const out = options.emit("stdout", message);
      if (out && typeof (out as Promise<unknown>).then === "function") {
        (out as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Swallow emit errors; the keepalive must never crash the run.
    }
  };

  const clearTimer = () => {
    if (timer != null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  const startTimer = () => {
    if (intervalMs <= 0 || timer != null || stopped) return;
    timer = setIntervalImpl(emitOne, intervalMs);
    const maybeUnref = (timer as { unref?: () => unknown } | null)?.unref;
    if (typeof maybeUnref === "function") {
      try {
        maybeUnref.call(timer);
      } catch {
        // ignore
      }
    }
  };

  return {
    observe(_stream, chunk) {
      if (stopped || !chunk) return;
      const stallSignal = findCodexUpstreamStreamSignal(chunk);
      if (stallSignal) {
        lastSignal = stallSignal;
        startTimer();
        return;
      }
      // Real output ends the stall window. Pure rollout-noise / empty chunks
      // are filtered out by the caller before reaching `observe`, so any chunk
      // we see here that doesn't match the stall patterns is genuine progress.
      if (chunkHasNonStallOutput(chunk)) {
        lastSignal = null;
        clearTimer();
      }
    },
    stop() {
      stopped = true;
      clearTimer();
    },
    get emitCount() {
      return emitCount;
    },
    get active() {
      return timer != null;
    },
    get lastSignal() {
      return lastSignal;
    },
  };
}
