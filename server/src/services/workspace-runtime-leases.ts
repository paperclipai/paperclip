import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaceRuntimeLeases, heartbeatRuns, issues } from "@paperclipai/db";
import { conflict } from "../errors.js";

type ExecutionWorkspaceRuntimeLeaseRow = typeof executionWorkspaceRuntimeLeases.$inferSelect;
type LeaseTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Issue statuses that keep an issue eligible to drive workspace runtime controls.
 * Shared with the runtime authorization path so "still authorized" and "still owns
 * the lease" cannot drift apart.
 */
export const WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUSES: readonly string[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
];

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Runtime control actions that mutate the workspace and therefore need the lease. */
export const LEASED_WORKSPACE_RUNTIME_ACTIONS: readonly string[] = ["start", "stop", "restart", "repair"];

/**
 * Idle-reclaim policy window. A lease untouched this long may be taken over by the
 * next claimant at claim time. This is a fairness policy, not an ownership proof:
 * dead owners (terminal, hidden or missing issue; terminal or missing run) are
 * released by identity, with no age, both at claim time and by the shared
 * ownership reconciler. For agent-scoped owners, which no identity can prove gone,
 * expiry plus the locked takeover is the fenced handoff.
 */
export const WORKSPACE_RUNTIME_LEASE_TTL_MS = 30 * 60 * 1000;

export type WorkspaceRuntimeLeaseOwner = {
  actorType: string;
  agentId?: string | null;
  runId?: string | null;
  issueId?: string | null;
};

export type WorkspaceRuntimeLeaseStaleReason =
  | "lease_expired"
  | "owner_issue_missing"
  | "owner_issue_hidden"
  | "owner_issue_terminal"
  | "owner_run_missing"
  | "owner_run_terminal";

export type WorkspaceRuntimeLeaseClaim = {
  outcome: "created" | "renewed" | "reclaimed" | "bypassed";
  ownerKey: string | null;
  lease: ExecutionWorkspaceRuntimeLeaseRow | null;
  reclaimedFrom: { ownerKey: string; reason: WorkspaceRuntimeLeaseStaleReason } | null;
};

/**
 * Durable owner identity for a lease. The controlling issue is preferred because a
 * canary lane outlives any single heartbeat run; runs and bare agent keys are only
 * used when no issue is in scope.
 */
export function buildWorkspaceRuntimeLeaseOwnerKey(owner: WorkspaceRuntimeLeaseOwner): string | null {
  if (owner.issueId) return `issue:${owner.issueId}`;
  if (owner.runId) return `run:${owner.runId}`;
  if (owner.agentId) return `agent:${owner.agentId}`;
  return null;
}

export function parseWorkspaceRuntimeLeaseOwnerKey(ownerKey: string): { kind: "issue" | "run" | "agent"; id: string } | null {
  const separator = ownerKey.indexOf(":");
  if (separator <= 0) return null;
  const kind = ownerKey.slice(0, separator);
  const id = ownerKey.slice(separator + 1);
  if (!id) return null;
  if (kind !== "issue" && kind !== "run" && kind !== "agent") return null;
  return { kind, id };
}

/**
 * Proves by identity that an issue- or run-owned lease's owner is gone: the issue
 * is missing, hidden or terminal, or the run is missing or terminal. Returns null
 * while the owner lives, and for agent-scoped or unparseable owners, which have no
 * identity to prove. The shared ownership reconciler's settle and the claim path
 * both use it, so the lane is released on the same proof wherever it is checked.
 */
export async function proveWorkspaceRuntimeLeaseOwnerGone(
  tx: Pick<Db, "select">,
  lease: Pick<ExecutionWorkspaceRuntimeLeaseRow, "ownerKey" | "companyId">,
): Promise<Exclude<WorkspaceRuntimeLeaseStaleReason, "lease_expired"> | null> {
  const owner = parseWorkspaceRuntimeLeaseOwnerKey(lease.ownerKey);
  if (owner?.kind === "issue") {
    const ownerIssue = await tx
      .select({ status: issues.status, hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(and(eq(issues.id, owner.id), eq(issues.companyId, lease.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!ownerIssue) return "owner_issue_missing";
    if (ownerIssue.hiddenAt) return "owner_issue_hidden";
    if (!WORKSPACE_RUNTIME_ELIGIBLE_ISSUE_STATUSES.includes(ownerIssue.status)) return "owner_issue_terminal";
    return null;
  }

  if (owner?.kind === "run") {
    const ownerRun = await tx
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, owner.id), eq(heartbeatRuns.companyId, lease.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!ownerRun) return "owner_run_missing";
    if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(ownerRun.status)) return "owner_run_terminal";
    return null;
  }

  return null;
}

async function evaluateStaleOwner(
  tx: LeaseTx,
  lease: ExecutionWorkspaceRuntimeLeaseRow,
  now: Date,
): Promise<WorkspaceRuntimeLeaseStaleReason | null> {
  // Ownership proof first: a gone issue or run releases the lane with no age
  // involved (the same proof the shared reconciler settles on).
  const gone = await proveWorkspaceRuntimeLeaseOwnerGone(tx, lease);
  if (gone) return gone;
  // Idle reclaim: a POLICY, not an ownership proof. A lease untouched for the
  // TTL is handed to the next claimant even when its issue or run still lives
  // (fairness between issues sharing a workspace). For agent-scoped owners,
  // which no identity can prove gone, expiry plus this locked takeover is the
  // fenced handoff. The reconciler never releases a lease on this rule.
  return lease.expiresAt.getTime() <= now.getTime() ? "lease_expired" : null;
}

function throwLeaseConflict(input: {
  lease: ExecutionWorkspaceRuntimeLeaseRow;
  requestedAction: string;
  requestedOwnerKey: string;
}): never {
  const { lease } = input;
  throw conflict(
    "Another issue run holds the exclusive runtime lease for this execution workspace.",
    {
      code: "workspace_runtime_lease_conflict",
      executionWorkspaceId: lease.executionWorkspaceId,
      requestedAction: input.requestedAction,
      requestedOwnerKey: input.requestedOwnerKey,
      ownerKey: lease.ownerKey,
      ownerIssueId: lease.ownerIssueId,
      ownerRunId: lease.ownerRunId,
      ownerAgentId: lease.ownerAgentId,
      lastAction: lease.lastAction,
      claimedAt: lease.claimedAt.toISOString(),
      renewedAt: lease.renewedAt.toISOString(),
      expiresAt: lease.expiresAt.toISOString(),
      remediation:
        "Do not retry against this execution workspace. Wait for the owning issue to reach a terminal status, ask its owner to release the workspace, or wait for the lease to expire, then retry.",
    },
  );
}

export function workspaceRuntimeLeaseService(db: Db) {
  return {
    async get(executionWorkspaceId: string) {
      return await db
        .select()
        .from(executionWorkspaceRuntimeLeases)
        .where(eq(executionWorkspaceRuntimeLeases.executionWorkspaceId, executionWorkspaceId))
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Atomically claim (or renew, or reclaim from a stale owner) the exclusive runtime
     * lease for an execution workspace. Cross-process exclusivity comes from the unique
     * constraint on execution_workspace_id plus a `SELECT ... FOR UPDATE` on the existing
     * row, so competing claims serialize in the database rather than in one process.
     *
     * Board/operator actors bypass the lease entirely: they keep unconditional control
     * and never take the lane away from an agent run.
     */
    async claim(input: {
      companyId: string;
      executionWorkspaceId: string;
      action: string;
      owner: WorkspaceRuntimeLeaseOwner;
      now?: Date;
      ttlMs?: number;
    }): Promise<WorkspaceRuntimeLeaseClaim> {
      if (input.owner.actorType !== "agent") {
        return { outcome: "bypassed", ownerKey: null, lease: null, reclaimedFrom: null };
      }

      const ownerKey = buildWorkspaceRuntimeLeaseOwnerKey(input.owner);
      if (!ownerKey) {
        return { outcome: "bypassed", ownerKey: null, lease: null, reclaimedFrom: null };
      }

      const now = input.now ?? new Date();
      const expiresAt = new Date(now.getTime() + (input.ttlMs ?? WORKSPACE_RUNTIME_LEASE_TTL_MS));
      const ownerColumns = {
        ownerKey,
        ownerIssueId: input.owner.issueId ?? null,
        ownerRunId: input.owner.runId ?? null,
        ownerAgentId: input.owner.agentId ?? null,
      };

      return await db.transaction(async (tx) => {
        const created = await tx
          .insert(executionWorkspaceRuntimeLeases)
          .values({
            companyId: input.companyId,
            executionWorkspaceId: input.executionWorkspaceId,
            ...ownerColumns,
            lastAction: input.action,
            claimedAt: now,
            renewedAt: now,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: executionWorkspaceRuntimeLeases.executionWorkspaceId })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (created) {
          return { outcome: "created" as const, ownerKey, lease: created, reclaimedFrom: null };
        }

        // The insert above conflicted, so a row exists (and, if a competing claim was
        // mid-flight, the conflict already waited for it to commit). Lock it before
        // deciding whether this caller may take or keep the lane.
        const current = await tx
          .select()
          .from(executionWorkspaceRuntimeLeases)
          .where(eq(executionWorkspaceRuntimeLeases.executionWorkspaceId, input.executionWorkspaceId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current) {
          // The holder released between the conflict and the lock; the caller can retry
          // immediately rather than mutating a workspace it does not own.
          throw conflict("The execution workspace runtime lease changed while it was being claimed.", {
            code: "workspace_runtime_lease_contended",
            executionWorkspaceId: input.executionWorkspaceId,
            requestedAction: input.action,
            remediation: "Retry the runtime control request.",
          });
        }

        if (current.ownerKey === ownerKey) {
          const renewed = await tx
            .update(executionWorkspaceRuntimeLeases)
            .set({
              ...ownerColumns,
              lastAction: input.action,
              renewedAt: now,
              expiresAt,
              updatedAt: now,
            })
            .where(eq(executionWorkspaceRuntimeLeases.id, current.id))
            .returning()
            .then((rows) => rows[0] ?? current);
          return { outcome: "renewed" as const, ownerKey, lease: renewed, reclaimedFrom: null };
        }

        const staleReason = await evaluateStaleOwner(tx, current, now);
        if (!staleReason) {
          throwLeaseConflict({ lease: current, requestedAction: input.action, requestedOwnerKey: ownerKey });
        }

        const reclaimed = await tx
          .update(executionWorkspaceRuntimeLeases)
          .set({
            companyId: input.companyId,
            ...ownerColumns,
            lastAction: input.action,
            claimedAt: now,
            renewedAt: now,
            expiresAt,
            updatedAt: now,
            metadata: {
              reclaimedFromOwnerKey: current.ownerKey,
              reclaimReason: staleReason,
              reclaimedAt: now.toISOString(),
            },
          })
          .where(eq(executionWorkspaceRuntimeLeases.id, current.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reclaimed) {
          throwLeaseConflict({ lease: current, requestedAction: input.action, requestedOwnerKey: ownerKey });
        }

        return {
          outcome: "reclaimed" as const,
          ownerKey,
          lease: reclaimed,
          reclaimedFrom: { ownerKey: current.ownerKey, reason: staleReason },
        };
      });
    },

    /**
     * Give up the lane. `force` is for operator/lifecycle paths (workspace archive);
     * owner-scoped releases only remove a lease the caller actually holds.
     */
    async release(input: {
      executionWorkspaceId: string;
      owner?: WorkspaceRuntimeLeaseOwner;
      force?: boolean;
    }): Promise<{ released: boolean; ownerKey: string | null }> {
      const ownerKey = input.owner ? buildWorkspaceRuntimeLeaseOwnerKey(input.owner) : null;
      if (!input.force && !ownerKey) return { released: false, ownerKey: null };

      const condition = input.force
        ? eq(executionWorkspaceRuntimeLeases.executionWorkspaceId, input.executionWorkspaceId)
        : and(
            eq(executionWorkspaceRuntimeLeases.executionWorkspaceId, input.executionWorkspaceId),
            eq(executionWorkspaceRuntimeLeases.ownerKey, ownerKey!),
          );

      const deleted = await db
        .delete(executionWorkspaceRuntimeLeases)
        .where(condition)
        .returning({ ownerKey: executionWorkspaceRuntimeLeases.ownerKey })
        .then((rows) => rows[0] ?? null);

      return { released: Boolean(deleted), ownerKey: deleted?.ownerKey ?? null };
    },
  };
}

export type WorkspaceRuntimeLeaseService = ReturnType<typeof workspaceRuntimeLeaseService>;
