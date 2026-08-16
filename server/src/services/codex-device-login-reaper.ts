import { inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { adapterAuthSessions } from "@paperclipai/db";
import {
  ADAPTER_AUTH_ACTIVE_STATUSES,
  decodePendingTerminal,
  LOGIN_LEASE_SESSION_TAG_KEY,
  observeSandboxDelete,
  terminalCleanupWrite,
  type AdapterAuthReaperStore,
  type SandboxDeleteResult,
} from "./codex-device-login-service.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { environmentService } from "./environments.js";

// The restart-safe cleanup backstop for adapter login sessions.
//
// The in-process five-minute timer in the login-session service stays the
// primary control. This reaper is the backstop. It runs on server startup and on
// a fixed interval, so sandbox cleanup survives a server restart and a delete
// failure. The reaper sweeps three sets:
//
//  1. The expired non-terminal sessions. It deletes the login sandbox and marks
//     the session `timed_out`.
//  2. The terminal sessions left in the internal `cleanup_pending` state. It
//     retries the delete and clears `cleanup_pending` only on a provider
//     confirmation. A `not_found` result is the idempotent confirmation.
//  3. The tagged provider leases that no live session references. Such a lease is
//     an orphan from a crash between lease acquisition and the durable session
//     write. It deletes the orphan.
//
// Security: the reaper records no secret data. A cleanup never puts a URL, a
// code, a credential byte, an account identifier, or a lease identifier into a
// public response. The `cleanup_pending` state stays internal; the reaper
// resolves the terminal public status before it clears the state.

/** The provider lease reference the reaper deletes through. */
export interface LoginLeaseRef {
  environmentId: string;
  providerLeaseId: string;
}

/** A login-tagged provider lease. The tag carries the session identifier, so the
 *  reaper matches the lease against the live session rows. */
export interface TaggedLease extends LoginLeaseRef {
  sessionId: string;
}

/**
 * The sandbox side the reaper drives. A production runtime binds it to the
 * environment runtime; a test binds it to a fake. The delete is idempotent, so a
 * repeated delete of an already-gone sandbox returns `not_found` and never
 * throws.
 */
export interface LoginSessionCleanupRuntime {
  /** Delete the sandbox behind a provider lease. It returns the provider result
   *  and throws only on a failed delete. */
  deleteSandbox(ref: LoginLeaseRef): Promise<SandboxDeleteResult>;
  /** List the login-tagged provider leases. Each carries its session identifier
   *  from the tag. */
  listTaggedLeases(): Promise<TaggedLease[]>;
}

/** The counts one sweep produced. The scheduler logs a non-empty result. */
export interface ReaperSweepResult {
  /** The expired non-terminal sessions the sweep marked `timed_out`. */
  expiredTimedOut: number;
  /** The terminal `cleanup_pending` sessions the sweep retried. */
  cleanupRetried: number;
  /** The terminal `cleanup_pending` sessions the sweep cleared on a confirmation. */
  cleanupCleared: number;
  /** The orphan tagged leases the sweep deleted. */
  orphanLeasesDeleted: number;
  /** The sessions still in `cleanup_pending` after the sweep. A failed delete
   *  keeps the state for the next sweep. */
  cleanupPendingRemaining: number;
}

export interface CodexDeviceLoginReaperDeps {
  store: AdapterAuthReaperStore;
  runtime: LoginSessionCleanupRuntime;
  now?: () => Date;
}

export function createCodexDeviceLoginReaper(deps: CodexDeviceLoginReaperDeps) {
  const { store, runtime } = deps;
  const now = deps.now ?? (() => new Date());

  // Retry the delete for the terminal sessions already in `cleanup_pending`. The
  // sweep runs this first, so a delete that fails in the expired scan below does
  // not retry at once in the same sweep.
  async function sweepCleanupPending(): Promise<{
    retried: number;
    cleared: number;
    remaining: number;
  }> {
    const pending = await store.listCleanupPendingSessions();
    let retried = 0;
    let cleared = 0;
    let remaining = 0;
    for (const row of pending) {
      const decoded = decodePendingTerminal(row.failureReason);
      const finishedAt = row.finishedAt ?? now();
      if (!row.providerLeaseId) {
        // No lease reference to retry. Resolve the terminal so the row never
        // stays pending forever.
        await store.setStatus({
          sessionId: row.id,
          status: decoded.terminal,
          at: now(),
          failureReason: decoded.reason,
          finishedAt,
        });
        cleared += 1;
        continue;
      }
      retried += 1;
      const observation = await observeSandboxDelete(() =>
        runtime.deleteSandbox({
          environmentId: row.environmentId,
          providerLeaseId: row.providerLeaseId!,
        }),
      );
      if (observation.confirmed) {
        // The provider confirmed the delete. Clear `cleanup_pending` and record
        // the retained terminal public status.
        await store.setStatus({
          sessionId: row.id,
          status: decoded.terminal,
          at: now(),
          failureReason: decoded.reason,
          finishedAt,
        });
        cleared += 1;
      } else {
        // The delete failed again. Keep `cleanup_pending` for the next sweep.
        remaining += 1;
      }
    }
    return { retried, cleared, remaining };
  }

  // Terminate every expired non-terminal session and mark it `timed_out`. A
  // failed delete records `cleanup_pending`, so the next sweep retries it. The
  // scan already excludes a session that still holds a live promotion claim, so
  // the reaper never releases a slot whose credential write is in progress.
  async function sweepExpiredSessions(at: Date): Promise<{
    timedOut: number;
    newlyPending: number;
  }> {
    const expired = await store.listExpiredActiveSessions(at);
    let timedOut = 0;
    let newlyPending = 0;
    for (const row of expired) {
      // Claim the terminalization with a conditional write from the row's current
      // status. The claim reserves `cleanup_pending` and releases the company
      // slot. A lost claim means the session owner reached a terminal first, so
      // the reaper deletes nothing and leaves the row alone. This closes the
      // lost-update race on the slot.
      //
      // Take the promotion critical-section lock around the claim. The credential
      // promotion holds the same lock across its ownership check and its
      // credential write, so the reclaim of a stale `promoting` row never
      // interleaves with a live write. A crashed owner drops the lock, so the
      // reaper still reclaims the stalled row on a later sweep.
      const pendingWrite = terminalCleanupWrite(false, "timed_out", null);
      const claimed = await store.withCompanyAdapterPromotionLock(
        row.companyId,
        row.adapterType,
        () =>
          store.compareAndSetStatus({
            sessionId: row.id,
            expectedStatuses: [row.status],
            status: pendingWrite.status,
            at: now(),
            failureReason: pendingWrite.failureReason,
            finishedAt: now(),
            promotionExpiresAt: null,
          }),
      );
      if (!claimed) continue;

      // The reaper owns the row now. Delete the sandbox, then finalize the
      // terminal only from the reserved `cleanup_pending` state.
      const observation = row.providerLeaseId
        ? await observeSandboxDelete(() =>
            runtime.deleteSandbox({
              environmentId: row.environmentId,
              providerLeaseId: row.providerLeaseId!,
            }),
          )
        : // No lease reference on the row. There is no sandbox to delete through
          // it. Any orphan provider lease is caught by the tagged-lease scan.
          { observed: false, confirmed: true };
      if (observation.confirmed) {
        await store.compareAndSetStatus({
          sessionId: row.id,
          expectedStatuses: ["cleanup_pending"],
          status: "timed_out",
          at: now(),
          failureReason: null,
          finishedAt: now(),
        });
        timedOut += 1;
      } else {
        // The delete failed. Keep `cleanup_pending` for the next sweep to retry.
        newlyPending += 1;
      }
    }
    return { timedOut, newlyPending };
  }

  // Delete the tagged provider leases that no live session references. Such a
  // lease is an orphan from a crash between lease acquisition and the durable
  // session write. The delete is idempotent, so a repeated sweep does not fail.
  async function sweepOrphanLeases(): Promise<number> {
    const [referenced, tagged] = await Promise.all([
      store.listLeaseReferences(),
      runtime.listTaggedLeases(),
    ]);
    const referencedSet = new Set(referenced);
    let deleted = 0;
    for (const lease of tagged) {
      if (referencedSet.has(lease.providerLeaseId)) continue;
      const observation = await observeSandboxDelete(() =>
        runtime.deleteSandbox({
          environmentId: lease.environmentId,
          providerLeaseId: lease.providerLeaseId,
        }),
      );
      // A confirmed delete removes the orphan. A failed delete leaves it for the
      // next sweep.
      if (observation.confirmed) deleted += 1;
    }
    return deleted;
  }

  async function sweep(): Promise<ReaperSweepResult> {
    const at = now();
    const cleanup = await sweepCleanupPending();
    const expired = await sweepExpiredSessions(at);
    const orphanLeasesDeleted = await sweepOrphanLeases();
    return {
      expiredTimedOut: expired.timedOut,
      cleanupRetried: cleanup.retried,
      cleanupCleared: cleanup.cleared,
      orphanLeasesDeleted,
      cleanupPendingRemaining: cleanup.remaining + expired.newlyPending,
    };
  }

  return { sweep };
}

export type CodexDeviceLoginReaper = ReturnType<typeof createCodexDeviceLoginReaper>;

// ---------------------------------------------------------------------------
// The production runtime binding.
// ---------------------------------------------------------------------------

export interface ProductionLoginSessionReaperRuntimeDeps {
  db: Db;
  environmentRuntime: EnvironmentRuntimeService;
}

/**
 * Build the production cleanup runtime. It deletes a login sandbox through the
 * environment runtime and lists the login-tagged provider leases from the lease
 * store. The delete is idempotent: an already-gone lease returns `not_found`.
 */
export function createProductionLoginSessionReaperRuntime(
  deps: ProductionLoginSessionReaperRuntimeDeps,
): LoginSessionCleanupRuntime {
  const environmentsSvc = environmentService(deps.db);
  return {
    async deleteSandbox(ref) {
      const environment = await environmentsSvc.getById(ref.environmentId);
      if (!environment) {
        // The environment is gone, so the sandbox is gone. Treat it as an
        // idempotent confirmed delete.
        return { outcome: "not_found" };
      }
      const leases = await environmentsSvc.listLeases(ref.environmentId);
      const lease = leases.find((candidate) => candidate.providerLeaseId === ref.providerLeaseId);
      if (!lease) {
        // No live lease row holds this provider lease. The sandbox is already
        // released, so the delete is an idempotent confirmation.
        return { outcome: "not_found" };
      }
      const driverKey =
        typeof lease.metadata?.driver === "string" ? lease.metadata.driver : environment.driver;
      const runtimeDriver = deps.environmentRuntime.getDriver(driverKey);
      if (!runtimeDriver) {
        throw new Error(`Environment driver "${driverKey}" is not registered.`);
      }
      const released = await runtimeDriver.releaseRunLease({
        environment,
        lease,
        status: "released",
      });
      // A failed provider cleanup is not a confirmed delete. The reaper keeps
      // `cleanup_pending` and retries on the next sweep.
      if (released?.cleanupStatus === "failed") {
        throw new Error("The sandbox delete did not confirm.");
      }
      return { outcome: "deleted" };
    },
    async listTaggedLeases() {
      // The candidate environments are those with a login session that still
      // owns a lease. An orphan session row keeps its environment, so this set
      // covers every orphan lease.
      const environmentRows = await deps.db
        .selectDistinct({ environmentId: adapterAuthSessions.environmentId })
        .from(adapterAuthSessions)
        .where(
          inArray(adapterAuthSessions.status, [
            ...ADAPTER_AUTH_ACTIVE_STATUSES,
            "cleanup_pending",
          ]),
        );
      const tagged: TaggedLease[] = [];
      for (const { environmentId } of environmentRows) {
        const leases = await environmentsSvc.listLeases(environmentId, { status: "active" });
        for (const lease of leases) {
          const sessionId = lease.metadata?.[LOGIN_LEASE_SESSION_TAG_KEY];
          if (typeof sessionId === "string" && lease.providerLeaseId) {
            tagged.push({ environmentId, providerLeaseId: lease.providerLeaseId, sessionId });
          }
        }
      }
      return tagged;
    },
  };
}
