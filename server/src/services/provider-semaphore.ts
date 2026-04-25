// Company-wide concurrency semaphore for Opus model invocations.
//
// Acts as an in-process gate that throttles `claude_local` adapter executions
// per company so the shared Anthropic Opus quota is not blown by simultaneous
// agent runs. Other adapters (codex, gemini, ...) and non-Opus Claude models
// bypass the gate entirely.
//
// Design notes:
// - State lives in-memory; the Paperclip server is single-process today.
// - Process restart drops all waiters, but heartbeat_runs.queued is persisted
//   in DB and `startNextQueuedRunForAgent()` will re-pick those on next tick.
// - FIFO ordering only. Per-agent priority is layered on in PMSA-17 (Phase 2-B).

const OPUS_PROVIDER = "anthropic" as const;
const OPUS_MODEL_FAMILY = "opus" as const;

const DEFAULT_OPUS_CAPACITY = 2;
const MIN_OPUS_CAPACITY = 1;
const MAX_OPUS_CAPACITY = 32;

export type ProviderSlotKey =
  `${string}:${typeof OPUS_PROVIDER}:${typeof OPUS_MODEL_FAMILY}`;

interface Waiter {
  runId: string;
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

const inflight = new Map<ProviderSlotKey, Set<string>>();
const waiters = new Map<ProviderSlotKey, Waiter[]>();

export function buildOpusSlotKey(companyId: string): ProviderSlotKey {
  return `${companyId}:${OPUS_PROVIDER}:${OPUS_MODEL_FAMILY}` as ProviderSlotKey;
}

export function isOpusModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  // Anthropic-style ids: "claude-opus-4-7", "claude-opus-4-6"
  if (normalized.startsWith("claude-opus-")) return true;
  // Bedrock-style ids: "us.anthropic.claude-opus-4-6-v1", ARN with .claude-opus-...
  if (normalized.includes("anthropic.claude-opus-")) return true;
  return false;
}

export function shouldThrottleProviderRun(input: {
  adapterType: string;
  model: string | null | undefined;
}): boolean {
  if (input.adapterType !== "claude_local") return false;
  return isOpusModel(input.model);
}

export function resolveOpusConcurrencyCapacity(
  metadata: Record<string, unknown> | null | undefined,
): number {
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).opusConcurrencyMax
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_OPUS_CAPACITY;
  }
  const truncated = Math.trunc(raw);
  if (truncated < MIN_OPUS_CAPACITY) return MIN_OPUS_CAPACITY;
  if (truncated > MAX_OPUS_CAPACITY) return MAX_OPUS_CAPACITY;
  return truncated;
}

export interface AcquireProviderSlotOptions {
  signal?: AbortSignal;
}

export async function acquireProviderSlot(
  key: ProviderSlotKey,
  runId: string,
  capacity: number,
  options: AcquireProviderSlotOptions = {},
): Promise<void> {
  if (capacity < MIN_OPUS_CAPACITY) capacity = MIN_OPUS_CAPACITY;

  const occupants = inflight.get(key) ?? new Set<string>();
  if (occupants.has(runId)) {
    // Already holds a slot — re-entrant acquire is a no-op so callers can be
    // safely retried from defensive try/finally blocks.
    return;
  }
  if (occupants.size < capacity) {
    occupants.add(runId);
    inflight.set(key, occupants);
    return;
  }

  const queue = waiters.get(key) ?? [];
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      runId,
      resolve,
      reject,
      enqueuedAt: Date.now(),
    };
    queue.push(waiter);
    waiters.set(key, queue);

    if (options.signal) {
      const onAbort = () => {
        const current = waiters.get(key);
        if (!current) return;
        const idx = current.indexOf(waiter);
        if (idx >= 0) {
          current.splice(idx, 1);
          if (current.length === 0) waiters.delete(key);
          else waiters.set(key, current);
        }
        reject(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("acquireProviderSlot aborted"),
        );
      };
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function releaseProviderSlot(
  key: ProviderSlotKey,
  runId: string,
): { released: boolean; promotedRunId: string | null } {
  const occupants = inflight.get(key);
  let released = false;
  if (occupants?.delete(runId)) {
    released = true;
    if (occupants.size === 0) inflight.delete(key);
  }

  const queue = waiters.get(key);
  if (!queue || queue.length === 0) {
    return { released, promotedRunId: null };
  }

  // Promote the next waiter so the slot is handed off without a tick gap.
  const nextOccupants = inflight.get(key) ?? new Set<string>();
  const next = queue.shift()!;
  if (queue.length === 0) waiters.delete(key);
  else waiters.set(key, queue);
  nextOccupants.add(next.runId);
  inflight.set(key, nextOccupants);
  next.resolve();
  return { released, promotedRunId: next.runId };
}

export function getInflightCount(key: ProviderSlotKey): number {
  return inflight.get(key)?.size ?? 0;
}

export function getWaiterCount(key: ProviderSlotKey): number {
  return waiters.get(key)?.length ?? 0;
}

export interface ProviderSemaphoreSnapshot {
  inflight: Array<{ key: ProviderSlotKey; runIds: string[] }>;
  waiting: Array<{ key: ProviderSlotKey; runIds: string[] }>;
}

export function snapshotProviderSemaphore(): ProviderSemaphoreSnapshot {
  return {
    inflight: Array.from(inflight.entries()).map(([key, set]) => ({
      key,
      runIds: Array.from(set),
    })),
    waiting: Array.from(waiters.entries()).map(([key, list]) => ({
      key,
      runIds: list.map((w) => w.runId),
    })),
  };
}

// Called at server bootstrap. The in-memory map is naturally empty after a
// process restart, so this only matters when something has put state in
// `inflight` before bootstrap completes (tests, hot-reload). It also rejects
// any stranded waiters so leftover callers do not hang forever.
export function releaseStaleInflightSlots(): {
  inflightCleared: number;
  waitersRejected: number;
} {
  let inflightCleared = 0;
  for (const set of inflight.values()) inflightCleared += set.size;
  inflight.clear();

  let waitersRejected = 0;
  for (const queue of waiters.values()) {
    for (const waiter of queue) {
      waitersRejected++;
      waiter.reject(new Error("provider semaphore reset on bootstrap"));
    }
  }
  waiters.clear();

  return { inflightCleared, waitersRejected };
}

// Test-only: forcibly clears all state without calling waiter rejectors.
// Useful when a test wants a clean slate without observing the rejection.
export function __resetProviderSemaphoreForTests(): void {
  inflight.clear();
  waiters.clear();
}
