import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  realizeExecutionWorkspace,
  type ExecutionWorkspaceAgentRef,
  type ExecutionWorkspaceInput,
  type ExecutionWorkspaceIssueRef,
  type RealizedExecutionWorkspace,
} from "./workspace-runtime.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";

/**
 * WorktreeProvisioner (GST-951 plan §4.1, §4.3): a thin wrapper around
 * `realizeExecutionWorkspace` that serialises *materialisation* per
 * project. `git worktree add` against the same parent repo is not
 * concurrent-safe; reuse lookups, however, are intentionally not gated.
 *
 * Lookup → reuse stays outside the lock so two heartbeats for the same
 * issue do not serialise unnecessarily. Only the path that actually
 * touches the parent repo's references runs under the advisory lock.
 */

function projectProvisionLockKey(projectId: string): bigint {
  // pg_advisory_xact_lock takes a signed 64-bit bigint. We
  // deterministically derive one from the project id so concurrent
  // calls for the same project serialise without taking a
  // process-wide lock. Mask off the sign bit to stay inside the signed
  // int8 range (Postgres rejects values > 2^63-1).
  const digest = createHash("sha256").update(`ws:provision:${projectId}`).digest("hex");
  const raw = BigInt("0x" + digest.slice(0, 16));
  return raw & 0x7fffffffffffffffn;
}

export interface ProvisionWorktreeInput {
  db: Db;
  base: ExecutionWorkspaceInput;
  config: Record<string, unknown>;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  recorder?: WorkspaceOperationRecorder | null;
}

export interface ProvisionedWorktree extends RealizedExecutionWorkspace {
  /** True when the call took the project advisory lock. */
  lockTaken: boolean;
}

/**
 * Provision (or reuse) a per-issue git worktree. Reuse is fast and never
 * holds the project lock; first-time provisioning serialises on
 * `pg_advisory_xact_lock(hashtext('ws:provision:'||projectId))`.
 */
export async function provisionExecutionWorkspaceWithLock(
  input: ProvisionWorktreeInput,
): Promise<ProvisionedWorktree> {
  const { db, base, config, issue, agent, recorder } = input;

  const strategyType = readWorkspaceStrategyType(config);
  if (strategyType !== "git_worktree" || !base.projectId) {
    const realized = await realizeExecutionWorkspace({
      base,
      config,
      issue,
      agent,
      recorder: recorder ?? null,
    });
    return { ...realized, lockTaken: false };
  }

  return await runProjectScopedProvisioning(db, base.projectId, async () => {
    const realized = await realizeExecutionWorkspace({
      base,
      config,
      issue,
      agent,
      recorder: recorder ?? null,
    });
    return { ...realized, lockTaken: true };
  });
}

/**
 * Helper: run `fn` inside a Postgres transaction with the project's
 * provision advisory lock held. The lock is automatically released when
 * the transaction commits or rolls back, which matches `pg_advisory_xact_lock`
 * semantics. We do not perform any persistent DB writes inside the lock;
 * the lock exists solely to serialise the on-disk `git worktree add`.
 */
async function runProjectScopedProvisioning<T>(
  db: Db,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = projectProvisionLockKey(projectId);
  const txCapableDb = db as unknown as {
    transaction?: (callback: (tx: Db) => Promise<void>) => Promise<void>;
  };
  if (typeof txCapableDb.transaction !== "function") {
    // Backend without transaction support (e.g. test doubles) — skip the
    // lock rather than crashing.
    return await fn();
  }
  let result!: T;
  await txCapableDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey.toString()}::bigint)`);
    result = await fn();
  });
  return result;
}

function readWorkspaceStrategyType(config: Record<string, unknown>): string {
  const raw = config.workspaceStrategy;
  if (!raw || typeof raw !== "object") return "project_primary";
  const type = (raw as Record<string, unknown>).type;
  return typeof type === "string" && type.length > 0 ? type : "project_primary";
}
