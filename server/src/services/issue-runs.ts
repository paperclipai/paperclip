import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueRuns, issues } from "@paperclipai/db";
import {
  ISSUE_RUNS_LOCK_TTL_SECONDS,
  ISSUE_RUNS_STALE_HEARTBEAT_GRACE_SECONDS,
  type IssueRunExecutor,
  type IssueRunRecoveryTrigger,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

/**
 * issue_runs lock contract service — Jarvis-OS Phase-4 (4a-3).
 *
 * Implements the four lock primitives that Hermes/MC-Dispatch use to coordinate
 * issue execution. See workspace docs:
 *   - phase-4-4a-1-lock-contract-mapping-2026-05-13.md (spec→column mapping)
 *   - phase-4-4a-2-stale-lock-recovery-strategy-2026-05-13.md (constants + recovery)
 *
 * Column ↔ spec mapping (Marco-Decision 4D-4=A):
 *   run_id           = lock_id
 *   lease_owner      = locked_by
 *   leased_at        = locked_at
 *   lease_expires_at = expires_at
 *
 * Service callers should use the JS field names below; routes and Hermes-client
 * translate to/from spec naming if/when needed.
 */
export interface IssueRunsService {
  acquire(input: AcquireInput): Promise<AcquireResult>;
  heartbeat(input: HeartbeatInput): Promise<HeartbeatResult>;
  release(input: ReleaseInput): Promise<ReleaseResult>;
  recoverStale(input: RecoverStaleInput): Promise<RecoverStaleResult>;
}

export interface AcquireInput {
  companyId: string;
  issueId: string;
  executor: IssueRunExecutor;
  lockedBy: string;
  ttlSeconds?: number;
  promptSnapshotPath?: string | null;
}

export type AcquireResult =
  | { acquired: true; run: IssueRunRow }
  | { acquired: false; reason: "issue_already_running"; existing: IssueRunRow | null }
  | { acquired: false; reason: "executor_mismatch"; assignedExecutor: IssueRunExecutor; requestedExecutor: IssueRunExecutor };

export interface HeartbeatInput {
  runId: string;
  lockedBy: string;
  extendBySeconds?: number;
}

export type HeartbeatResult =
  | { ok: true; leaseExpiresAt: Date; heartbeatAt: Date }
  | { ok: false; reason: "lock_lost" };

export interface ReleaseInput {
  runId: string;
  lockedBy: string;
  status: "completed" | "failed";
  exitCode?: number | null;
  resultSummary?: string | null;
}

export type ReleaseResult =
  | { ok: true; run: IssueRunRow }
  | { ok: false; reason: "lock_lost" };

export interface RecoverStaleInput {
  trigger: IssueRunRecoveryTrigger;
  limit?: number;
  dryRun?: boolean;
}

export interface RecoveredRun {
  runId: string;
  issueId: string;
  previousOwner: string;
  recoveredAt: Date;
}

export interface RecoverStaleResult {
  trigger: IssueRunRecoveryTrigger;
  dryRun: boolean;
  candidates: RecoveredRun[];
  recovered: RecoveredRun[];
}

export type IssueRunRow = typeof issueRuns.$inferSelect;

export function issueRunsService(db: Db): IssueRunsService {
  return {
    async acquire(input) {
      const assigneeRows = await db
        .select({
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .limit(1);

      if (assigneeRows[0]?.assigneeAgentId) {
        const agentRows = await db
          .select({ executor: agents.executor })
          .from(agents)
          .where(eq(agents.id, assigneeRows[0].assigneeAgentId))
          .limit(1);
        const assignedExecutor = agentRows[0]?.executor;
        if (assignedExecutor && assignedExecutor !== input.executor) {
          return {
            acquired: false,
            reason: "executor_mismatch",
            assignedExecutor: assignedExecutor as IssueRunExecutor,
            requestedExecutor: input.executor,
          };
        }
      }

      const ttl = input.ttlSeconds ?? ISSUE_RUNS_LOCK_TTL_SECONDS;
      const inserted = await db
        .insert(issueRuns)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          executor: input.executor,
          leaseOwner: input.lockedBy,
          leaseExpiresAt: sql`now() + (${ttl} || ' seconds')::interval`,
          status: "running",
          promptSnapshotPath: input.promptSnapshotPath ?? null,
        })
        .onConflictDoNothing({
          target: issueRuns.issueId,
          where: sql`${issueRuns.status} = 'running'`,
        })
        .returning();

      if (inserted[0]) {
        return { acquired: true, run: inserted[0] };
      }

      const existing = await db
        .select()
        .from(issueRuns)
        .where(and(eq(issueRuns.issueId, input.issueId), eq(issueRuns.status, "running")))
        .limit(1);

      return { acquired: false, reason: "issue_already_running", existing: existing[0] ?? null };
    },

    async heartbeat(input) {
      const extend = input.extendBySeconds ?? ISSUE_RUNS_LOCK_TTL_SECONDS;
      const updated = await db
        .update(issueRuns)
        .set({
          heartbeatAt: sql`now()`,
          leaseExpiresAt: sql`now() + (${extend} || ' seconds')::interval`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(issueRuns.runId, input.runId),
            eq(issueRuns.leaseOwner, input.lockedBy),
            eq(issueRuns.status, "running"),
            sql`${issueRuns.leaseExpiresAt} > now()`,
          ),
        )
        .returning({
          leaseExpiresAt: issueRuns.leaseExpiresAt,
          heartbeatAt: issueRuns.heartbeatAt,
        });

      if (!updated[0]) {
        return { ok: false, reason: "lock_lost" };
      }
      return { ok: true, leaseExpiresAt: updated[0].leaseExpiresAt, heartbeatAt: updated[0].heartbeatAt };
    },

    async release(input) {
      const updated = await db
        .update(issueRuns)
        .set({
          status: input.status,
          exitCode: input.exitCode ?? null,
          resultSummary: input.resultSummary ?? null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(issueRuns.runId, input.runId),
            eq(issueRuns.leaseOwner, input.lockedBy),
            eq(issueRuns.status, "running"),
          ),
        )
        .returning();

      if (!updated[0]) {
        const existing = await db
          .select()
          .from(issueRuns)
          .where(eq(issueRuns.runId, input.runId))
          .limit(1);
        if (!existing[0]) {
          throw notFound("issue_run not found");
        }
        if (existing[0].leaseOwner !== input.lockedBy) {
          throw conflict("lock owner mismatch");
        }
        return { ok: false, reason: "lock_lost" };
      }
      return { ok: true, run: updated[0] };
    },

    async recoverStale(input) {
      const limit = input.limit ?? 100;
      const grace = ISSUE_RUNS_STALE_HEARTBEAT_GRACE_SECONDS;
      const recoveredAt = new Date();

      const candidateRows = await db
        .select({
          runId: issueRuns.runId,
          issueId: issueRuns.issueId,
          leaseOwner: issueRuns.leaseOwner,
        })
        .from(issueRuns)
        .where(
          and(
            eq(issueRuns.status, "running"),
            sql`${issueRuns.leaseExpiresAt} < now()`,
            sql`${issueRuns.heartbeatAt} < now() - (${grace} || ' seconds')::interval`,
          ),
        )
        .orderBy(asc(issueRuns.leaseExpiresAt))
        .limit(limit);

      const candidates: RecoveredRun[] = candidateRows.map((row) => ({
        runId: row.runId,
        issueId: row.issueId,
        previousOwner: row.leaseOwner,
        recoveredAt,
      }));

      if (input.dryRun || candidates.length === 0) {
        return { trigger: input.trigger, dryRun: !!input.dryRun, candidates, recovered: [] };
      }

      const recovered: RecoveredRun[] = [];
      for (const cand of candidates) {
        const updated = await db
          .update(issueRuns)
          .set({
            status: "failed_lease_expired",
            updatedAt: sql`now()`,
            resultSummary: sql`coalesce(${issueRuns.resultSummary}, '') || ' [stale-lock recovered ' || now()::text || ']'`,
          })
          .where(
            and(
              eq(issueRuns.runId, cand.runId),
              eq(issueRuns.status, "running"),
              sql`${issueRuns.leaseExpiresAt} < now()`,
              sql`${issueRuns.heartbeatAt} < now() - (${grace} || ' seconds')::interval`,
            ),
          )
          .returning({ runId: issueRuns.runId });

        if (updated[0]) {
          recovered.push(cand);
        }
      }

      return { trigger: input.trigger, dryRun: false, candidates, recovered };
    },
  };
}
