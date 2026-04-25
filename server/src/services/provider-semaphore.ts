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
// - Waiters are ordered (priorityTier asc, enqueuedAt asc) so a CEO (p0)
//   heartbeat always preempts a backlog of researcher (p3) heartbeats waiting
//   on the same Opus slot. PMSA-17 / [PMSA-11] §3.2.
// - Aging: a waiter that has been queued longer than
//   AGENT_PRIORITY_TIER_AGING_INTERVAL_MS bumps one tier toward p0 every
//   interval, so p3 work cannot be starved indefinitely behind a steady
//   stream of higher-priority arrivals. PMSA-17 / [PMSA-11] §3.2.

import {
  AGENT_PRIORITY_TIERS,
  agentPriorityTierRank,
  bumpAgentPriorityTier,
  DEFAULT_AGENT_PRIORITY_TIER,
  type AgentPriorityTier,
} from "@paperclipai/shared";

const OPUS_PROVIDER = "anthropic" as const;
const OPUS_MODEL_FAMILY = "opus" as const;

const DEFAULT_OPUS_CAPACITY = 2;
const MIN_OPUS_CAPACITY = 1;
const MAX_OPUS_CAPACITY = 32;

// Time a waiter must sit in the queue before it is bumped one tier toward p0.
// Five minutes per the [PMSA-11] §3.2 starvation-prevention requirement.
export const AGENT_PRIORITY_TIER_AGING_INTERVAL_MS = 5 * 60 * 1000;

export type ProviderSlotKey =
  `${string}:${typeof OPUS_PROVIDER}:${typeof OPUS_MODEL_FAMILY}`;

interface Waiter {
  runId: string;
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  // Tier captured at enqueue time. agedTier folds in any aging promotions
  // applied since enqueue so we keep the original priority for telemetry.
  initialTier: AgentPriorityTier;
  agedTier: AgentPriorityTier;
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
  priorityTier?: AgentPriorityTier;
  // Override for tests so we don't have to advance real clock 5 minutes.
  agingIntervalMs?: number;
  now?: () => number;
}

// Compares two waiters under the (tier asc, enqueuedAt asc) ordering used
// for both queue insertion and pop selection. Returns negative if `a` should
// be served first, positive if `b`, zero if tied.
function compareWaiters(a: Waiter, b: Waiter): number {
  const tierDelta =
    agentPriorityTierRank(a.agedTier) - agentPriorityTierRank(b.agedTier);
  if (tierDelta !== 0) return tierDelta;
  return a.enqueuedAt - b.enqueuedAt;
}

// Re-applies aging to every waiter in the queue. Called immediately before
// any selection (insert or pop) so the queue is always evaluated against the
// freshest aging snapshot. O(n) — n is bounded by number of agents per
// company, so cheap in practice.
function applyAgingToQueue(
  queue: Waiter[],
  now: number,
  agingIntervalMs: number,
): void {
  if (agingIntervalMs <= 0) return;
  for (const waiter of queue) {
    const waited = now - waiter.enqueuedAt;
    if (waited <= 0) continue;
    const bumps = Math.floor(waited / agingIntervalMs);
    if (bumps <= 0) continue;
    const initialIdx = agentPriorityTierRank(waiter.initialTier);
    const targetIdx = Math.max(0, initialIdx - bumps);
    const targetTier = AGENT_PRIORITY_TIERS[targetIdx];
    if (
      agentPriorityTierRank(targetTier) < agentPriorityTierRank(waiter.agedTier)
    ) {
      waiter.agedTier = targetTier;
    }
  }
}

// Insert a waiter while keeping the queue sorted by (agedTier asc,
// enqueuedAt asc). Linear scan from the back since most arrivals share the
// p2 default tier and append-at-tail is the common case.
function insertWaiterOrdered(queue: Waiter[], waiter: Waiter): void {
  let insertAt = queue.length;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (compareWaiters(queue[i], waiter) <= 0) {
      insertAt = i + 1;
      break;
    }
    insertAt = i;
  }
  queue.splice(insertAt, 0, waiter);
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

  const now = options.now ? options.now() : Date.now();
  const agingIntervalMs =
    options.agingIntervalMs ?? AGENT_PRIORITY_TIER_AGING_INTERVAL_MS;
  const initialTier = options.priorityTier ?? DEFAULT_AGENT_PRIORITY_TIER;
  const queue = waiters.get(key) ?? [];
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      runId,
      resolve,
      reject,
      enqueuedAt: now,
      initialTier,
      agedTier: initialTier,
    };
    applyAgingToQueue(queue, now, agingIntervalMs);
    insertWaiterOrdered(queue, waiter);
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

export interface ReleaseProviderSlotOptions {
  // Override for tests so we don't have to advance real clock 5 minutes.
  agingIntervalMs?: number;
  now?: () => number;
}

export interface ReleaseProviderSlotResult {
  released: boolean;
  promotedRunId: string | null;
  promotedTier: AgentPriorityTier | null;
  promotedInitialTier: AgentPriorityTier | null;
  promotedWaitedMs: number | null;
}

export function releaseProviderSlot(
  key: ProviderSlotKey,
  runId: string,
  options: ReleaseProviderSlotOptions = {},
): ReleaseProviderSlotResult {
  const occupants = inflight.get(key);
  let released = false;
  if (occupants?.delete(runId)) {
    released = true;
    if (occupants.size === 0) inflight.delete(key);
  }

  const queue = waiters.get(key);
  if (!queue || queue.length === 0) {
    return {
      released,
      promotedRunId: null,
      promotedTier: null,
      promotedInitialTier: null,
      promotedWaitedMs: null,
    };
  }

  // Re-evaluate aging right before the pick so a waiter that has crossed
  // the aging threshold while sitting at the back is promoted before the
  // selection runs.
  const now = options.now ? options.now() : Date.now();
  const agingIntervalMs =
    options.agingIntervalMs ?? AGENT_PRIORITY_TIER_AGING_INTERVAL_MS;
  applyAgingToQueue(queue, now, agingIntervalMs);
  queue.sort(compareWaiters);

  const next = queue.shift()!;
  if (queue.length === 0) waiters.delete(key);
  else waiters.set(key, queue);

  const nextOccupants = inflight.get(key) ?? new Set<string>();
  nextOccupants.add(next.runId);
  inflight.set(key, nextOccupants);
  next.resolve();

  return {
    released,
    promotedRunId: next.runId,
    promotedTier: next.agedTier,
    promotedInitialTier: next.initialTier,
    promotedWaitedMs: now - next.enqueuedAt,
  };
}

export function getInflightCount(key: ProviderSlotKey): number {
  return inflight.get(key)?.size ?? 0;
}

export function getWaiterCount(key: ProviderSlotKey): number {
  return waiters.get(key)?.length ?? 0;
}

export interface ProviderSemaphoreSnapshot {
  inflight: Array<{ key: ProviderSlotKey; runIds: string[] }>;
  waiting: Array<{
    key: ProviderSlotKey;
    runIds: string[];
    tiers: AgentPriorityTier[];
  }>;
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
      tiers: list.map((w) => w.agedTier),
    })),
  };
}

// Bumps a known waiter one tier toward p0. Currently exposed so tests and
// future explicit-promotion paths (manual ops escalation) can shortcut the
// time-based aging logic. No-op when the waiter is already at p0.
export function bumpWaiterPriority(
  key: ProviderSlotKey,
  runId: string,
): { promoted: boolean; tier: AgentPriorityTier | null } {
  const queue = waiters.get(key);
  if (!queue) return { promoted: false, tier: null };
  const waiter = queue.find((w) => w.runId === runId);
  if (!waiter) return { promoted: false, tier: null };
  const next = bumpAgentPriorityTier(waiter.agedTier);
  if (next === waiter.agedTier)
    return { promoted: false, tier: waiter.agedTier };
  waiter.agedTier = next;
  queue.sort(compareWaiters);
  return { promoted: true, tier: next };
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
