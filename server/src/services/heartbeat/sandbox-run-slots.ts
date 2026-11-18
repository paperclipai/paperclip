import { and, eq, inArray } from "drizzle-orm";
import { agents, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { isExecutionForcedToKubernetes } from "../execution-allowlist.js";
import { instanceSettingsService } from "../instance-settings.js";

/**
 * Server-wide limit on concurrently running sandbox-backed runs (TECH-9015).
 *
 * The Paperclip server process does per-run work for every sandbox run (pod
 * execs, the file bridge, log tails), and it saturates at about 20 concurrent
 * Kubernetes runs (TECH-8174). Over the limit a queued run is not claimed: it
 * stays `queued` and starts when a slot frees. Nothing fails or retries.
 *
 * Accounting comes from persisted run state: a slot is held by every `running`
 * run whose agent is placed on a capped sandbox provider. Every terminal path
 * (success, failure, cancel, timeout, reaped after a restart) leaves `running`,
 * so it frees the slot without any release call. The only in-process state is
 * a reservation that covers the claim itself (cleared as soon as the claim
 * returns) and the list of waiting runs, used for fair ordering and for the
 * "waiting for a sandbox slot" event. A restart clears both; the queue rebuilds
 * them on the next pass.
 *
 * The count reads all running runs in the database, so with several server
 * tasks the limit is shared by them (prod runs one task).
 */

/** Sandbox providers whose runs count against the limit. Add a provider key to opt it in. */
export const SANDBOX_RUN_SLOT_PROVIDERS: ReadonlySet<string> = new Set(["kubernetes"]);
export const DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS = 20;
export const MAX_CONCURRENT_SANDBOX_RUNS_ENV = "PAPERCLIP_MAX_CONCURRENT_SANDBOX_RUNS";

/** A reservation outlives its claim only if the process stalls; it then stops counting. */
const RESERVATION_TTL_MS = 2 * 60_000;
/**
 * A waiter that has not been re-checked recently (for example its agent is
 * paused or at its own run limit, so its queue pass never reaches the limit
 * check) no longer holds its place ahead of others. The periodic queue pass
 * (30 s by default) re-checks every live waiter well within this. Promotion
 * parks such a waiter at once, so this bound only matters without a promotion.
 */
const WAITER_STALE_MS = 90_000;
const PLACEMENT_CACHE_MS = 5_000;

/** Unset or empty: the default. 0 turns the limit off. Anything else invalid: the default. */
export function parseMaxConcurrentSandboxRuns(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    logger.warn(
      { env: MAX_CONCURRENT_SANDBOX_RUNS_ENV, value: raw },
      `invalid ${MAX_CONCURRENT_SANDBOX_RUNS_ENV}; using the default of ${DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS}`,
    );
    return DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS;
  }
  return value;
}

export interface SandboxPlacement {
  forcedKubernetes: boolean;
  managedSandboxOnly: boolean;
  managedSandboxProvider: string | null;
  instanceDefaultEnvironmentId: string | null;
  environments: Map<string, { driver: string; provider: string | null }>;
}

/**
 * The sandbox provider a run of this agent is placed on, if that provider is
 * capped. Mirrors the environment choice in `selectHeartbeatEnvironment`:
 * forced Kubernetes, then the agent default, the instance default, and the
 * managed-sandbox redirect of the local environment.
 */
export function cappedSandboxProviderForAgent(
  placement: SandboxPlacement,
  agent: { defaultEnvironmentId: string | null },
): string | null {
  let provider: string | null = null;
  if (placement.forcedKubernetes) {
    provider = "kubernetes";
  } else {
    const environmentId = agent.defaultEnvironmentId ?? placement.instanceDefaultEnvironmentId;
    const environment = environmentId ? placement.environments.get(environmentId) : undefined;
    if (!environmentId || environment?.driver === "local") {
      provider = placement.managedSandboxOnly ? placement.managedSandboxProvider : null;
    } else if (environment?.driver === "sandbox") {
      provider = environment.provider;
    }
  }
  return provider && SANDBOX_RUN_SLOT_PROVIDERS.has(provider) ? provider : null;
}

export interface SandboxSlotEntry {
  runId: string;
  companyId: string;
  agentId: string;
  /** A turn of an agent conversation. Goes ahead of background runs. */
  conversation: boolean;
  /** FIFO key: when the run was queued. */
  queuedAtMs: number;
}

/**
 * Fair order for waiting runs: conversation turns first, then the company with
 * the fewest sandbox runs (running plus waiting ahead of this one), then FIFO.
 * One company's burst therefore interleaves with other companies' runs instead
 * of draining first.
 */
export function rankSandboxSlotEntries<T extends SandboxSlotEntry>(
  entries: readonly T[],
  heldByCompany: ReadonlyMap<string, number>,
): T[] {
  const fifo = [...entries].sort((a, b) => a.queuedAtMs - b.queuedAtMs || a.runId.localeCompare(b.runId));
  const aheadInCompany = new Map<string, number>();
  const keyed = fifo.map((entry) => {
    const ahead = aheadInCompany.get(entry.companyId) ?? 0;
    aheadInCompany.set(entry.companyId, ahead + 1);
    return { entry, share: (heldByCompany.get(entry.companyId) ?? 0) + ahead };
  });
  keyed.sort((a, b) =>
    Number(b.entry.conversation) - Number(a.entry.conversation) ||
    a.share - b.share ||
    a.entry.queuedAtMs - b.entry.queuedAtMs ||
    a.entry.runId.localeCompare(b.entry.runId));
  return keyed.map(({ entry }) => entry);
}

interface Waiter extends SandboxSlotEntry {
  provider: string;
  waitingSinceMs: number;
  lastCheckedAtMs: number;
  /** Bumped on every limit check; promotion uses it to see which waiters were not re-checked. */
  checkSeq: number;
  /**
   * Its agent's queue pass did not re-check it when a slot was offered (paused,
   * at its own run limit, ...). A parked waiter does not hold its place ahead
   * of others until its next limit check.
   */
  parked: boolean;
}

export type SandboxSlotDecision =
  | { admitted: true; reserved: boolean; waitedMs: number | null; inUse: number; limit: number }
  | { admitted: false; firstRefusal: boolean; inUse: number; limit: number; position: number };

export interface SandboxRunSlotGateOptions {
  now?: () => number;
  /** Defaults to the environment variable, read on every decision. */
  limit?: () => number;
  loadPlacement?: (db: Db) => Promise<SandboxPlacement>;
}

async function loadSandboxPlacement(db: Db): Promise<SandboxPlacement> {
  const settingsSvc = instanceSettingsService(db);
  const [settings, experimental, rows] = await Promise.all([
    settingsSvc.get(),
    settingsSvc.getExperimental(),
    db
      .select({ id: environments.id, driver: environments.driver, config: environments.config, metadata: environments.metadata })
      .from(environments)
      .where(eq(environments.status, "active")),
  ]);
  const managedSandboxOnly = experimental.enableManagedSandboxOnly === true;
  const environmentById = new Map<string, { driver: string; provider: string | null }>();
  let managedSandboxProvider: string | null = null;
  for (const row of rows) {
    const provider = typeof row.config?.provider === "string" ? row.config.provider : null;
    environmentById.set(row.id, { driver: row.driver, provider });
    if (row.driver === "sandbox" && row.metadata?.managedByPaperclip === true) managedSandboxProvider = provider;
  }
  return {
    forcedKubernetes: isExecutionForcedToKubernetes({ executionMode: settings.general.executionMode, managedSandboxOnly }),
    managedSandboxOnly,
    managedSandboxProvider,
    instanceDefaultEnvironmentId: settings.defaultEnvironmentId ?? null,
    environments: environmentById,
  };
}

export function createSandboxRunSlotGate(options: SandboxRunSlotGateOptions = {}) {
  const now = options.now ?? Date.now;
  let parsedLimit: { raw: string | undefined; value: number } | null = null;
  const limit = options.limit ?? (() => {
    const raw = process.env[MAX_CONCURRENT_SANDBOX_RUNS_ENV];
    if (!parsedLimit || parsedLimit.raw !== raw) parsedLimit = { raw, value: parseMaxConcurrentSandboxRuns(raw) };
    return parsedLimit.value;
  });
  const loadPlacement = options.loadPlacement ?? loadSandboxPlacement;
  const waiters = new Map<string, Waiter>();
  const reservations = new Map<string, { companyId: string; reservedAtMs: number }>();
  let checkSeq = 0;
  let placementCache: { db: Db; atMs: number; placement: Promise<SandboxPlacement> } | null = null;
  let lockTail: Promise<unknown> = Promise.resolve();
  let promoting: Promise<void> | null = null;
  let promoteAgain = false;

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = lockTail.then(fn, fn);
    lockTail = result.catch(() => undefined);
    return result;
  }

  function placementFor(db: Db) {
    if (!placementCache || placementCache.db !== db || now() - placementCache.atMs > PLACEMENT_CACHE_MS) {
      const placement = loadPlacement(db);
      placementCache = { db, atMs: now(), placement };
      placement.catch(() => { if (placementCache?.placement === placement) placementCache = null; });
    }
    return placementCache.placement;
  }

  /** The capped provider for runs of this agent, or null when they are not counted (or the limit is off). */
  async function providerForAgent(db: Db, agent: { defaultEnvironmentId: string | null }) {
    if (limit() <= 0) return null;
    return cappedSandboxProviderForAgent(await placementFor(db), agent);
  }

  /** Running runs that hold a slot, plus in-flight claims. */
  async function occupancy(db: Db) {
    const placement = await placementFor(db);
    const rows = await db
      .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, defaultEnvironmentId: agents.defaultEnvironmentId })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(eq(heartbeatRuns.status, "running"));
    const running = rows.filter((row) => cappedSandboxProviderForAgent(placement, row) !== null);
    const runningIds = new Set(running.map((row) => row.id));
    const at = now();
    for (const [runId, reservation] of reservations) {
      if (runningIds.has(runId) || at - reservation.reservedAtMs > RESERVATION_TTL_MS) reservations.delete(runId);
    }
    const heldByCompany = new Map<string, number>();
    for (const companyId of [...running.map((row) => row.companyId), ...[...reservations.values()].map((r) => r.companyId)]) {
      heldByCompany.set(companyId, (heldByCompany.get(companyId) ?? 0) + 1);
    }
    return { inUse: running.length + reservations.size, heldByCompany };
  }

  /** Waiters whose run is still queued; the others are forgotten. */
  async function pruneWaiters(db: Db, keepRunId: string | null) {
    const ids = [...waiters.keys()].filter((id) => id !== keepRunId);
    if (ids.length === 0) return;
    const queued = new Set(
      (await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(inArray(heartbeatRuns.id, ids), eq(heartbeatRuns.status, "queued"))))
        .map((row) => row.id),
    );
    for (const id of ids) if (!queued.has(id)) waiters.delete(id);
  }

  /**
   * Decide whether a queued sandbox run may be claimed now. Admission reserves
   * a slot until `settle` is called after the claim. A refused run is recorded
   * as waiting and stays queued.
   */
  function admit(db: Db, candidate: SandboxSlotEntry & { provider: string }): Promise<SandboxSlotDecision> {
    return withLock(async () => {
      const max = limit();
      if (max <= 0) return { admitted: true, reserved: false, waitedMs: null, inUse: 0, limit: max };
      const { inUse, heldByCompany } = await occupancy(db);
      await pruneWaiters(db, candidate.runId);
      const at = now();
      const existing = waiters.get(candidate.runId);
      const entry: Waiter = {
        ...candidate,
        waitingSinceMs: existing?.waitingSinceMs ?? at,
        lastCheckedAtMs: at,
        checkSeq: ++checkSeq,
        parked: false,
      };
      const contenders = [...waiters.values()].filter((waiter) =>
        waiter.runId !== candidate.runId && !waiter.parked && at - waiter.lastCheckedAtMs <= WAITER_STALE_MS);
      const position = rankSandboxSlotEntries([...contenders, entry], heldByCompany)
        .findIndex((waiter) => waiter.runId === candidate.runId);
      if (max - inUse > position) {
        waiters.delete(candidate.runId);
        reservations.set(candidate.runId, { companyId: candidate.companyId, reservedAtMs: at });
        return { admitted: true, reserved: true, waitedMs: existing ? at - existing.waitingSinceMs : null, inUse, limit: max };
      }
      waiters.set(candidate.runId, entry);
      return { admitted: false, firstRefusal: !existing, inUse, limit: max, position: position + 1 };
    });
  }

  /** Drop the claim reservation; a claimed run is now counted from its `running` row. */
  function settle(runId: string) {
    reservations.delete(runId);
  }

  async function freeSlots(db: Db) {
    const max = limit();
    if (max <= 0) return Number.POSITIVE_INFINITY;
    return max - (await withLock(() => occupancy(db))).inUse;
  }

  /**
   * After a run ends, offer free slots to waiting runs in fair order. Each
   * waiter's agent goes through its normal queue start, which re-checks the
   * limit. Overlapping calls coalesce into one more pass.
   */
  function promoteWaiters(db: Db, startAgent: (agentId: string) => Promise<unknown>): Promise<void> {
    if (waiters.size === 0) return Promise.resolve();
    if (promoting) {
      promoteAgain = true;
      return promoting;
    }
    promoting = (async () => {
      try {
        do {
          promoteAgain = false;
          const { heldByCompany } = await withLock(() => occupancy(db));
          const agentIds = [...new Set(rankSandboxSlotEntries([...waiters.values()], heldByCompany).map((w) => w.agentId))];
          for (const agentId of agentIds) {
            if ((await freeSlots(db)) <= 0) break;
            const checkedBefore = checkSeq;
            await startAgent(agentId).catch((err) => {
              logger.warn({ err, agentId }, "failed to start a run waiting for a sandbox slot");
            });
            // The agent's queue pass did not reach these waiters (paused, at
            // its own limit, ...): stop them holding slots ahead of others.
            for (const waiter of waiters.values()) {
              if (waiter.agentId === agentId && waiter.checkSeq <= checkedBefore) waiter.parked = true;
            }
          }
        } while (promoteAgain && waiters.size > 0);
      } finally {
        promoting = null;
      }
    })();
    return promoting;
  }

  return {
    limit,
    providerForAgent,
    admit,
    settle,
    freeSlots,
    promoteWaiters,
    /** Test and diagnostics view. */
    snapshot: () => ({
      waiting: [...waiters.keys()],
      parked: [...waiters.values()].filter((waiter) => waiter.parked).map((waiter) => waiter.runId),
      reserved: [...reservations.keys()],
    }),
  };
}

export type SandboxRunSlotGate = ReturnType<typeof createSandboxRunSlotGate>;

/** One gate per process: every heartbeat service instance shares it. */
export const sandboxRunSlots = createSandboxRunSlotGate();
