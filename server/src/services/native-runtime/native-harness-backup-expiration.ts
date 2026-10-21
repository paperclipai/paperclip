import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  environmentLeases,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { nativeHarnessStateBase } from "./native-harness-backup-stamp.js";
import { nativeSessionScopeDigestIsBusy } from "./native-session-executor.js";

export const NATIVE_HARNESS_BACKUP_EXPIRATION_INTERVAL_MS = 60 * 60 * 1000;
export const NATIVE_HARNESS_BACKUP_EXPIRATION_STARTUP_DELAY_MS = 2 * 60 * 1000;
export const NATIVE_HARNESS_BACKUP_EXPIRATION_DEFAULT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPIRED_PREFIX = ".expired-";
const RETIRING_PREFIX = ".retiring-";
const LIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"];
const SETTLED_FINALIZATION_PHASES = ["committed", "terminal_failure"];
const LIVE_LEASE_STATUSES = ["active", "released", "retained", "pending_cleanup"];
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];
const MAX_CONTROL_PLANE_STATE_BYTES = 4 * 1024 * 1024;

export type NativeHarnessBackupExpirationOptions = {
  closedForDays?: number;
  dryRun?: boolean;
  maxEntries?: number;
  maxRemovals?: number;
  now?: Date;
  stateBase?: string;
  shouldContinue?: () => boolean;
  isSessionBusy?: (scopeDigest: string) => boolean;
};

export type NativeHarnessBackupExpirationResult = {
  checked: number;
  candidates: number;
  candidateBytes: number;
  expired: number;
  reclaimedBytes: number;
  clearedTaskSessions: number;
  failed: number;
  truncated: boolean;
  skipped: Record<string, number>;
};

type SessionIdentity = {
  runId: string;
  normalizedSessionId: string;
  environmentLeaseId: string | null;
};

function emptyResult(): NativeHarnessBackupExpirationResult {
  return {
    checked: 0,
    candidates: 0,
    candidateBytes: 0,
    expired: 0,
    reclaimedBytes: 0,
    clearedTaskSessions: 0,
    failed: 0,
    truncated: false,
    skipped: {},
  };
}

async function isRealDirectory(target: string): Promise<boolean> {
  const stat = await fs.lstat(target).catch(() => null);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

async function removeBackupTree(target: string): Promise<void> {
  const prepare = async (current: string): Promise<void> => {
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat?.isDirectory()) return;
    await fs.chmod(current, (stat.mode & 0o777) | 0o700);
    for (const name of await fs.readdir(current)) await prepare(path.join(current, name));
  };
  await prepare(target);
  await fs.rm(target, { recursive: true, force: true });
}

async function allocatedBytes(target: string): Promise<number> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  let bytes = stat.blocks * 512;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of await fs.readdir(target).catch(() => [] as string[])) {
      bytes += await allocatedBytes(path.join(target, entry));
    }
  }
  return bytes;
}

async function readSessionIdentity(root: string): Promise<SessionIdentity | null> {
  try {
    const statePath = path.join(root, "control-plane", "control-plane-state.json");
    const stat = await fs.lstat(statePath);
    if (!stat.isFile() || stat.size > MAX_CONTROL_PLANE_STATE_BYTES) return null;
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { identity?: Record<string, unknown> };
    const identity = state.identity ?? {};
    const runId = identity.runId;
    const normalizedSessionId = identity.normalizedSessionId;
    const environmentLeaseId = identity.environmentLeaseId;
    if (typeof runId !== "string" || !UUID_PATTERN.test(runId)) return null;
    if (typeof normalizedSessionId !== "string" || !UUID_PATTERN.test(normalizedSessionId)) return null;
    return {
      runId,
      normalizedSessionId,
      environmentLeaseId:
        typeof environmentLeaseId === "string" && UUID_PATTERN.test(environmentLeaseId)
          ? environmentLeaseId
          : null,
    };
  } catch {
    return null;
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function sessionRetentionBlocker(
  tx: Tx,
  input: { scopeDigest: string; identity: SessionIdentity; closedBefore: Date },
): Promise<{ reason: string } | { companyId: string; agentId: string }> {
  const [owner] = await tx
    .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.identity.runId));
  if (!owner) return { reason: "run_missing" };
  const runs = await tx
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      finishedAt: heartbeatRuns.finishedAt,
      issueId: sql<string | null>`coalesce(${heartbeatRuns.nativeIssueId}, ${heartbeatRuns.issueId})`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, owner.companyId),
        eq(heartbeatRuns.agentId, owner.agentId),
        eq(heartbeatRuns.nativeSessionId, input.identity.normalizedSessionId),
      ),
    );
  if (runs.some((run) => LIVE_RUN_STATUSES.includes(run.status) || !run.finishedAt)) {
    return { reason: "live_run" };
  }
  const issueIds = [...new Set(runs.map((run) => run.issueId).filter((id): id is string => Boolean(id)))];
  if (issueIds.length === 0) return { reason: "issue_unknown" };
  const issueRows = await tx
    .select({
      id: issues.id,
      status: issues.status,
      closedAt: sql<Date | null>`coalesce(${issues.completedAt}, ${issues.cancelledAt})`,
    })
    .from(issues)
    .where(and(eq(issues.companyId, owner.companyId), inArray(issues.id, issueIds)))
    .for("share");
  if (issueRows.length !== issueIds.length) return { reason: "issue_unknown" };
  for (const issue of issueRows) {
    if (!CLOSED_ISSUE_STATUSES.includes(issue.status)) return { reason: "issue_open" };
    const closedAt = issue.closedAt ? new Date(issue.closedAt) : null;
    if (!closedAt || closedAt >= input.closedBefore) return { reason: "recently_closed" };
  }
  const runIds = runs.map((run) => run.id);
  const [pending] = await tx
    .select({ runId: nativeRunFinalizations.runId })
    .from(nativeRunFinalizations)
    .where(
      and(
        inArray(nativeRunFinalizations.runId, runIds),
        or(
          notInArray(nativeRunFinalizations.phase, SETTLED_FINALIZATION_PHASES),
          sql`${nativeRunFinalizations.recoveryState} is not null`,
          sql`${nativeRunFinalizations.leaseOwner} is not null`,
        ),
      ),
    )
    .limit(1);
  if (pending) return { reason: "pending_finalization" };
  const leaseReferences = [
    sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'sessionScopeSha256' = ${input.scopeDigest}`,
    inArray(environmentLeases.heartbeatRunId, runIds),
  ];
  if (input.identity.environmentLeaseId) {
    leaseReferences.push(eq(environmentLeases.id, input.identity.environmentLeaseId));
  }
  const [lease] = await tx
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(and(inArray(environmentLeases.status, LIVE_LEASE_STATUSES), or(...leaseReferences)))
    .limit(1);
  if (lease) return { reason: "live_lease" };
  return owner;
}

async function hasLiveRun(db: Db, owner: { companyId: string; agentId: string }, sessionId: string) {
  const [run] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, owner.companyId),
        eq(heartbeatRuns.agentId, owner.agentId),
        eq(heartbeatRuns.nativeSessionId, sessionId),
        or(inArray(heartbeatRuns.status, LIVE_RUN_STATUSES), isNull(heartbeatRuns.finishedAt)),
      ),
    )
    .limit(1);
  return Boolean(run);
}

export function nativeHarnessBackupExpirationService(
  db: Db,
  defaults: NativeHarnessBackupExpirationOptions = {},
) {
  let cursor: string | null = null;

  async function settleLeftovers(backupRoot: string) {
    const current = path.join(backupRoot, "current");
    for (const name of await fs.readdir(backupRoot).catch(() => [] as string[])) {
      const target = path.join(backupRoot, name);
      if (name.startsWith(RETIRING_PREFIX) && UUID_PATTERN.test(name.slice(RETIRING_PREFIX.length))) {
        if (!(await isRealDirectory(current))) await fs.rename(target, current);
        else await removeBackupTree(target);
      } else if (name.startsWith(EXPIRED_PREFIX) && UUID_PATTERN.test(name.slice(EXPIRED_PREFIX.length))) {
        await removeBackupTree(target);
      }
    }
  }

  async function expireSession(
    root: string,
    scopeDigest: string,
    options: Required<Pick<NativeHarnessBackupExpirationOptions, "dryRun" | "isSessionBusy">> & {
      closedBefore: Date;
    },
    result: NativeHarnessBackupExpirationResult,
  ) {
    const skip = (reason: string) => {
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
    };
    const backupRoot = path.join(root, "failover-backups");
    const current = path.join(backupRoot, "current");
    if (!options.dryRun) await settleLeftovers(backupRoot);
    if (!(await isRealDirectory(current))) return skip("no_backup");
    if (await fs.lstat(path.join(root, "cleanup-activation.json")).then(() => true, () => false)) {
      return skip("cleanup_active");
    }
    if (options.isSessionBusy(scopeDigest)) return skip("session_active");
    const backupStat = await fs.stat(current);
    if (backupStat.mtime >= options.closedBefore) return skip("recent_backup");
    const identity = await readSessionIdentity(root);
    if (!identity) return skip("identity_unknown");

    const decision = await db.transaction(async (tx) => {
      const blocker = await sessionRetentionBlocker(tx, {
        scopeDigest,
        identity,
        closedBefore: options.closedBefore,
      });
      if ("reason" in blocker) return blocker;
      if (options.dryRun) return { owner: blocker, cleared: 0 };
      const cleared = await tx
        .delete(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, blocker.companyId),
            eq(agentTaskSessions.agentId, blocker.agentId),
            sql`${agentTaskSessions.sessionParamsJson}->>'sessionId' = ${identity.normalizedSessionId}`,
          ),
        )
        .returning({ id: agentTaskSessions.id });
      return { owner: blocker, cleared: cleared.length };
    });
    if ("reason" in decision) return skip(decision.reason);

    const bytes = await allocatedBytes(current);
    result.candidates++;
    result.candidateBytes += bytes;
    if (options.dryRun) return;
    result.clearedTaskSessions += decision.cleared;
    if (options.isSessionBusy(scopeDigest)) return skip("session_active");
    const id = randomUUID();
    const retiring = path.join(backupRoot, `${RETIRING_PREFIX}${id}`);
    const trash = path.join(backupRoot, `${EXPIRED_PREFIX}${id}`);
    await fs.rename(current, retiring);
    let liveRun: boolean;
    try {
      liveRun = await hasLiveRun(db, decision.owner, identity.normalizedSessionId);
    } catch (err) {
      await fs.rename(retiring, current);
      throw err;
    }
    if (liveRun) {
      await fs.rename(retiring, current);
      return skip("live_run");
    }
    await fs.rename(retiring, trash);
    await removeBackupTree(trash);
    result.expired++;
    result.reclaimedBytes += bytes;
  }

  async function tick(options: NativeHarnessBackupExpirationOptions = {}) {
    const closedForDays = Math.max(
      1,
      options.closedForDays ?? defaults.closedForDays ?? NATIVE_HARNESS_BACKUP_EXPIRATION_DEFAULT_DAYS,
    );
    const dryRun = options.dryRun ?? defaults.dryRun ?? false;
    const maxEntries = Math.max(1, options.maxEntries ?? defaults.maxEntries ?? 200);
    const maxRemovals = Math.max(1, options.maxRemovals ?? defaults.maxRemovals ?? 50);
    const shouldContinue = options.shouldContinue ?? defaults.shouldContinue ?? (() => true);
    const isSessionBusy = options.isSessionBusy ?? defaults.isSessionBusy ?? nativeSessionScopeDigestIsBusy;
    const base = path.resolve(options.stateBase ?? defaults.stateBase ?? nativeHarnessStateBase());
    const closedBefore = new Date((options.now ?? defaults.now ?? new Date()).getTime() - closedForDays * DAY_MS);
    const result = emptyResult();

    const names = (await fs.readdir(base).catch(() => [] as string[]))
      .filter((name) => SCOPE_PATTERN.test(name))
      .sort();
    const pending = cursor ? names.filter((name) => name > cursor!) : names;
    for (const name of pending) {
      if (!shouldContinue() || result.checked >= maxEntries || result.candidates >= maxRemovals) {
        result.truncated = true;
        break;
      }
      result.checked++;
      cursor = name;
      const root = path.join(base, name);
      if (path.dirname(root) !== base || !(await isRealDirectory(root))) {
        result.skipped.unsafe_path = (result.skipped.unsafe_path ?? 0) + 1;
        continue;
      }
      try {
        await expireSession(root, name, { dryRun, isSessionBusy, closedBefore }, result);
      } catch (err) {
        result.failed++;
        logger.warn({ err, scope: name }, "native harness backup expiration skipped a session");
      }
    }
    if (!result.truncated) cursor = null;
    return result;
  }

  return { tick };
}
