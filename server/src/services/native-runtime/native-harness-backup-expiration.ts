import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  environmentLeases,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunnerCheckpoints,
  type Db,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { nativeHarnessStateBase } from "./native-harness-backup-stamp.js";
import { nativeSessionScopeDigestIsBusy } from "./native-session-executor.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";

export const NATIVE_HARNESS_BACKUP_EXPIRATION_INTERVAL_MS = 60 * 60 * 1000;
export const NATIVE_HARNESS_BACKUP_EXPIRATION_STARTUP_DELAY_MS = 2 * 60 * 1000;
export const NATIVE_HARNESS_BACKUP_EXPIRATION_DEFAULT_DAYS = 7;
export const NATIVE_RUNNER_EVIDENCE_RETENTION_DEFAULT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTINUITY_ARCHIVE_PATTERN = /^(\d{1,15})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUARANTINE_PATTERN =
  /^([0-9a-f]{64})\.(?:identity_indeterminate|identity_mismatch)\.(\d{1,15})\.\d{1,10}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUARANTINE_CLEANUP_PATTERN = /^[0-9a-f]{64}\.identity_indeterminate\.cleanup\./;
const EXPIRED_PREFIX = ".expired-";
const RETIRING_PREFIX = ".retiring-";
const LIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"];
const SETTLED_FINALIZATION_PHASES = ["committed", "terminal_failure"];
const LIVE_LEASE_STATUSES = ["active", "released", "retained", "pending_cleanup"];
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];
const MAX_CONTROL_PLANE_STATE_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_EXPIRATION_MAX_FAILED_PASSES = 3;

export type NativeHarnessBackupExpirationOptions = {
  closedForDays?: number;
  evidenceRetentionDays?: number;
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
  evidenceCandidates: number;
  evidenceCandidateBytes: number;
  evidenceRemoved: number;
  evidenceReclaimedBytes: number;
  expiredCheckpoints: number;
  checkpointCandidates: number;
  failed: number;
  truncated: boolean;
  skipped: Record<string, number>;
};

type EvidenceContext = {
  dryRun: boolean;
  isSessionBusy: (scopeDigest: string) => boolean;
  now: number;
  retentionMs: number;
  retainedBefore: number;
  canInspect: () => boolean;
  dueAt: (at: number) => void;
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
    evidenceCandidates: 0,
    evidenceCandidateBytes: 0,
    evidenceRemoved: 0,
    evidenceReclaimedBytes: 0,
    expiredCheckpoints: 0,
    checkpointCandidates: 0,
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
  input: { scopeDigest: string | null; identity: SessionIdentity; closedBefore: Date; checkpoint?: boolean },
): Promise<{ reason: string } | { companyId: string; agentId: string; runIds: string[] }> {
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
  if (input.checkpoint && runs.some(run => run.finishedAt! >= input.closedBefore)) return { reason: "recent_run" };
  const issueIds = [...new Set(runs.map((run) => run.issueId).filter((id): id is string => Boolean(id)))];
  if (issueIds.length === 0) return { reason: "issue_unknown" };
  const issueRows = await tx
    .select({
      id: issues.id,
      status: issues.status,
      executionRunId: issues.executionRunId,
      closedAt: sql<Date | null>`coalesce(${issues.completedAt}, ${issues.cancelledAt})`,
    })
    .from(issues)
    .where(and(eq(issues.companyId, owner.companyId), inArray(issues.id, issueIds)))
    .for("share");
  if (issueRows.length !== issueIds.length) return { reason: "issue_unknown" };
  for (const issue of issueRows) {
    if (!CLOSED_ISSUE_STATUSES.includes(issue.status)) return { reason: "issue_open" };
    if (input.checkpoint && issue.executionRunId) return { reason: "live_run" };
    const closedAt = issue.closedAt ? new Date(issue.closedAt) : null;
    if (!closedAt || closedAt >= input.closedBefore) return { reason: "recently_closed" };
  }
  const runIds = runs.map((run) => run.id);
  const finalizationQuery = tx
    .select({ phase: nativeRunFinalizations.phase, recoveryState: nativeRunFinalizations.recoveryState,
      leaseOwner: nativeRunFinalizations.leaseOwner })
    .from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds))
    .orderBy(asc(nativeRunFinalizations.runId));
  const finalizations = await (input.checkpoint ? finalizationQuery.for("update") : finalizationQuery);
  if ((input.checkpoint && finalizations.length !== runIds.length)
    || finalizations.some(row => !SETTLED_FINALIZATION_PHASES.includes(row.phase) || row.leaseOwner)) {
    return { reason: "pending_finalization" };
  }
  const leaseReferences = [
    inArray(environmentLeases.heartbeatRunId, runIds),
  ];
  if (input.scopeDigest) leaseReferences.push(
    sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'sessionScopeSha256' = ${input.scopeDigest}`,
  );
  if (input.checkpoint) leaseReferences.push(
    inArray(environmentLeases.issueId, issueIds),
    and(eq(environmentLeases.companyId, owner.companyId),
      sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'normalizedSessionId' = ${input.identity.normalizedSessionId}`)!,
  );
  if (input.identity.environmentLeaseId) {
    leaseReferences.push(eq(environmentLeases.id, input.identity.environmentLeaseId));
  }
  const [lease] = await tx
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(and(inArray(environmentLeases.status, LIVE_LEASE_STATUSES), or(...leaseReferences)))
    .limit(1);
  if (lease) return { reason: "live_lease" };
  return { ...owner, runIds };
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
  let resume: { scope: string; archive: string } | null = null;
  let quarantineCursor: string | null = null;
  let phase: "sessions" | "quarantine" = "sessions";
  let passActive = false;
  let evidencePass = false;
  let evidenceDueAt = 0;
  let passDueAt = Number.POSITIVE_INFINITY;
  let checkpointCursor: string | null = null;

  async function expireCheckpoints(options: {
    closedBefore: Date; dryRun: boolean; maxEntries: number; maxRemovals: number; shouldContinue: () => boolean;
  }, result: NativeHarnessBackupExpirationResult) {
    // The partial header index enumerates retained checkpoints without reading
    // event payloads or scanning runs that have no checkpoint left to expire.
    const candidates = await db.select({ runId: heartbeatRuns.id, sessionId: heartbeatRuns.nativeSessionId })
      .from(nativeRunnerCheckpoints)
      .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, nativeRunnerCheckpoints.runId))
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, nativeRunFinalizations.runId))
      .where(and(
        sql`${nativeRunnerCheckpoints.part} = 'header'`,
        checkpointCursor ? gt(nativeRunnerCheckpoints.runId, checkpointCursor) : undefined,
        lt(heartbeatRuns.finishedAt, options.closedBefore),
        inArray(nativeRunFinalizations.phase, SETTLED_FINALIZATION_PHASES),
        isNull(nativeRunFinalizations.leaseOwner), isNull(nativeRunFinalizations.recoveryState),
      ))
      .orderBy(asc(nativeRunnerCheckpoints.runId)).limit(options.maxEntries + 1);
    let processed = 0;
    let removed = 0;
    for (const candidate of candidates) {
      if (!options.shouldContinue() || processed >= options.maxEntries || removed >= options.maxRemovals) {
        result.truncated = true;
        return;
      }
      processed++;
      checkpointCursor = candidate.runId;
      if (!candidate.sessionId) continue; // Unknown identity is never expiration evidence.
      try {
        const expired = await db.transaction(async tx => {
          const blocker = await sessionRetentionBlocker(tx, {
            scopeDigest: null, checkpoint: true, closedBefore: options.closedBefore,
            identity: { runId: candidate.runId, normalizedSessionId: candidate.sessionId!, environmentLeaseId: null },
          });
          if ("reason" in blocker) return false;
          const [resume] = await tx.select({ id: agentTaskSessions.id }).from(agentTaskSessions).where(and(
            eq(agentTaskSessions.companyId, blocker.companyId), eq(agentTaskSessions.agentId, blocker.agentId),
            or(inArray(agentTaskSessions.lastRunId, blocker.runIds),
              sql`${agentTaskSessions.sessionParamsJson}->>'sessionId' = ${candidate.sessionId}`),
          )).limit(1);
          if (resume) return false;
          result.checkpointCandidates++;
          if (options.dryRun) return false;
          // Serialize with checkpoint writers and retire every old authority for
          // this session, including a predecessor authorized for warm handoff.
          await tx.update(nativeRunFinalizations).set({
            controllerGeneration: sql`${nativeRunFinalizations.controllerGeneration} + 1`,
          }).where(inArray(nativeRunFinalizations.runId, blocker.runIds));
          const rows = await tx.delete(nativeRunnerCheckpoints).where(and(
            eq(nativeRunnerCheckpoints.companyId, blocker.companyId), eq(nativeRunnerCheckpoints.runId, candidate.runId),
          )).returning({ part: nativeRunnerCheckpoints.part });
          return rows.length > 0;
        });
        if (expired) { removed++; result.expiredCheckpoints++; }
      } catch (err) {
        result.failed++;
        logger.warn({ err, runId: candidate.runId }, "native runner checkpoint expiration skipped a run");
      }
    }
    checkpointCursor = null;
  }

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

  async function removeExpiredLeftovers(parent: string, context: EvidenceContext, result: NativeHarnessBackupExpirationResult) {
    for (const name of await fs.readdir(parent).catch(() => [] as string[])) {
      if (!name.startsWith(EXPIRED_PREFIX) || !UUID_PATTERN.test(name.slice(EXPIRED_PREFIX.length))) continue;
      if (!context.canInspect()) {
        context.dueAt(context.now);
        return;
      }
      result.checked++;
      await removeBackupTree(path.join(parent, name));
    }
  }

  async function retireEvidence(
    parent: string,
    name: string,
    scopeDigest: string,
    stampedAt: number,
    context: EvidenceContext,
    result: NativeHarnessBackupExpirationResult,
  ) {
    const skip = (reason: string) => {
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
    };
    const target = path.join(parent, name);
    const stat = await fs.lstat(target).catch(() => null);
    if (path.dirname(target) !== parent || !stat?.isDirectory()) {
      return skip("unsafe_path");
    }
    const createdAt = stampedAt > 0 && stampedAt <= context.now ? stampedAt : stat.mtimeMs;
    if (createdAt >= context.retainedBefore) {
      context.dueAt(createdAt + context.retentionMs);
      return skip("recent_evidence");
    }
    if (context.isSessionBusy(scopeDigest)) {
      context.dueAt(context.now);
      return skip("session_active");
    }
    const bytes = await allocatedBytes(target);
    result.evidenceCandidates++;
    result.evidenceCandidateBytes += bytes;
    if (context.dryRun) return;
    if (context.isSessionBusy(scopeDigest)) {
      context.dueAt(context.now);
      return skip("session_active");
    }
    const trash = path.join(parent, `${EXPIRED_PREFIX}${randomUUID()}`);
    await fs.rename(target, trash);
    await removeBackupTree(trash);
    result.evidenceRemoved++;
    result.evidenceReclaimedBytes += bytes;
  }

  async function retireContinuityBreaks(
    root: string,
    scopeDigest: string,
    resumeAfter: string | null,
    context: EvidenceContext,
    result: NativeHarnessBackupExpirationResult,
  ): Promise<string | null> {
    const parent = path.join(root, "continuity-breaks");
    const stat = await fs.lstat(parent).catch(() => null);
    if (!stat) return null;
    if (!stat.isDirectory()) {
      result.skipped.unsafe_path = (result.skipped.unsafe_path ?? 0) + 1;
      return null;
    }
    if (!context.dryRun) await removeExpiredLeftovers(parent, context, result);
    let last = resumeAfter ?? "";
    const names = (await fs.readdir(parent)).filter((name) => name > last).sort();
    for (const name of names) {
      const match = CONTINUITY_ARCHIVE_PATTERN.exec(name);
      if (!match) continue;
      if (!context.canInspect()) return last;
      result.checked++;
      last = name;
      try {
        await retireEvidence(parent, name, scopeDigest, Number(match[1]), context, result);
      } catch (err) {
        result.failed++;
        context.dueAt(context.now);
        logger.warn({ err, scope: scopeDigest }, "native runner evidence retention skipped a continuity archive");
      }
    }
    if (!context.dryRun) await fs.rmdir(parent).catch(() => undefined);
    return null;
  }

  async function retireQuarantine(
    base: string,
    context: EvidenceContext,
    result: NativeHarnessBackupExpirationResult,
  ): Promise<boolean> {
    const parent = path.join(base, "quarantine");
    const stat = await fs.lstat(parent).catch(() => null);
    if (!stat) return true;
    if (!stat.isDirectory()) {
      result.skipped.unsafe_path = (result.skipped.unsafe_path ?? 0) + 1;
      return true;
    }
    if (!context.dryRun && quarantineCursor === null) await removeExpiredLeftovers(parent, context, result);
    const names = (await fs.readdir(parent)).sort();
    const pending = quarantineCursor ? names.filter((name) => name > quarantineCursor!) : names;
    for (const name of pending) {
      const match = QUARANTINE_PATTERN.exec(name);
      const cleanupArchive = QUARANTINE_CLEANUP_PATTERN.test(name);
      if (!match && !cleanupArchive) continue;
      if (!context.canInspect()) return false;
      result.checked++;
      quarantineCursor = name;
      if (!match) {
        result.skipped.cleanup_archive = (result.skipped.cleanup_archive ?? 0) + 1;
        continue;
      }
      try {
        await retireEvidence(parent, name, match[1]!, Number(match[2]), context, result);
      } catch (err) {
        result.failed++;
        context.dueAt(context.now);
        logger.warn({ err, scope: match[1] }, "native runner evidence retention skipped a quarantine entry");
      }
    }
    quarantineCursor = null;
    return true;
  }

  function noteEvidence(writtenAt: number) {
    evidenceDueAt = Math.min(evidenceDueAt, writtenAt + evidenceRetentionMs());
  }

  function evidenceRetentionMs(options: NativeHarnessBackupExpirationOptions = {}) {
    return Math.max(
      1,
      options.evidenceRetentionDays ?? defaults.evidenceRetentionDays ?? NATIVE_RUNNER_EVIDENCE_RETENTION_DEFAULT_DAYS,
    ) * DAY_MS;
  }

  async function tick(options: NativeHarnessBackupExpirationOptions = {}) {
    const closedForDays = Math.max(
      1,
      options.closedForDays ?? defaults.closedForDays ?? NATIVE_HARNESS_BACKUP_EXPIRATION_DEFAULT_DAYS,
    );
    const retentionMs = evidenceRetentionMs(options);
    const dryRun = options.dryRun ?? defaults.dryRun ?? false;
    const maxEntries = Math.max(1, options.maxEntries ?? defaults.maxEntries ?? 200);
    const maxRemovals = Math.max(1, options.maxRemovals ?? defaults.maxRemovals ?? 50);
    const shouldContinue = options.shouldContinue ?? defaults.shouldContinue ?? (() => true);
    const isSessionBusy = options.isSessionBusy ?? defaults.isSessionBusy ?? nativeSessionScopeDigestIsBusy;
    const base = path.resolve(options.stateBase ?? defaults.stateBase ?? nativeHarnessStateBase());
    const now = (options.now ?? defaults.now ?? new Date()).getTime();
    const closedBefore = new Date(now - closedForDays * DAY_MS);
    const result = emptyResult();
    const hasBudget = () => shouldContinue() && result.candidates + result.evidenceCandidates < maxRemovals;
    if (!passActive) {
      passActive = true;
      evidencePass = evidenceDueAt <= now;
      if (evidencePass) {
        evidenceDueAt = Number.POSITIVE_INFINITY;
        passDueAt = Number.POSITIVE_INFINITY;
      }
    }
    const context: EvidenceContext = {
      dryRun,
      isSessionBusy,
      now,
      retentionMs,
      retainedBefore: now - retentionMs,
      canInspect: () => hasBudget() && result.checked < maxEntries,
      dueAt: (at) => {
        passDueAt = Math.min(passDueAt, at);
      },
    };

    if (phase === "sessions") {
      const names = (await fs.readdir(base).catch(() => [] as string[]))
        .filter((name) => SCOPE_PATTERN.test(name))
        .sort();
      const pending = cursor ? names.filter((name) => name > cursor!) : names;
      for (const name of pending) {
        if (!hasBudget() || result.checked >= maxEntries) {
          result.truncated = true;
          break;
        }
        const resumeAfter = resume?.scope === name ? resume.archive : null;
        if (resume && name >= resume.scope) resume = null;
        if (resumeAfter === null) result.checked++;
        const previous = cursor;
        cursor = name;
        const root = path.join(base, name);
        if (path.dirname(root) !== base || !(await isRealDirectory(root))) {
          result.skipped.unsafe_path = (result.skipped.unsafe_path ?? 0) + 1;
          continue;
        }
        if (resumeAfter === null) {
          try {
            await expireSession(root, name, { dryRun, isSessionBusy, closedBefore }, result);
          } catch (err) {
            result.failed++;
            logger.warn({ err, scope: name }, "native harness backup expiration skipped a session");
          }
        }
        if (!evidencePass) continue;
        let stoppedAt: string | null = null;
        try {
          stoppedAt = await retireContinuityBreaks(root, name, resumeAfter, context, result);
        } catch (err) {
          result.failed++;
          context.dueAt(now);
          logger.warn({ err, scope: name }, "native runner evidence retention skipped a session");
        }
        if (stoppedAt !== null) {
          resume = { scope: name, archive: stoppedAt };
          cursor = previous;
          result.truncated = true;
          break;
        }
      }
      if (result.truncated) return result;
      cursor = null;
      if (!evidencePass) {
        passActive = false;
        return result;
      }
      phase = "quarantine";
    }
    try {
      if (!(await retireQuarantine(base, context, result))) {
        result.truncated = true;
        return result;
      }
    } catch (err) {
      result.failed++;
      context.dueAt(now);
      quarantineCursor = null;
      logger.warn({ err }, "native runner evidence retention skipped quarantine");
    }
    phase = "sessions";
    passActive = false;
    evidencePass = false;
    evidenceDueAt = Math.min(evidenceDueAt, passDueAt);
    return result;
  }

  async function tickCheckpoints(options: NativeHarnessBackupExpirationOptions = {}) {
    const closedForDays = Math.max(1, options.closedForDays ?? defaults.closedForDays ?? NATIVE_HARNESS_BACKUP_EXPIRATION_DEFAULT_DAYS);
    const result = emptyResult();
    const shouldContinue = options.shouldContinue ?? defaults.shouldContinue ?? (() => true);
    if (!shouldContinue()) return { ...result, truncated: true };
    await expireCheckpoints({
      closedBefore: new Date((options.now ?? defaults.now ?? new Date()).getTime() - closedForDays * DAY_MS),
      dryRun: options.dryRun ?? defaults.dryRun ?? false,
      maxEntries: Math.max(1, options.maxEntries ?? defaults.maxEntries ?? 200),
      maxRemovals: Math.max(1, options.maxRemovals ?? defaults.maxRemovals ?? 50),
      shouldContinue,
    }, result);
    return result;
  }

  function registerCheckpointExpiration(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>) {
    // Opportunistic startup retention, not a recurring expiry obligation. A
    // protected/recent checkpoint is reconsidered on the next server startup.
    // Persisted rows remain safe; seven days is a minimum age, not a deadline.
    let pending = true;
    let retryFailedPage = false;
    let failedPasses = 0;
    const failedPass = (err?: unknown) => {
      pending = ++failedPasses < CHECKPOINT_EXPIRATION_MAX_FAILED_PASSES;
      logger.warn({ err, failedPasses }, pending
        ? "startup checkpoint expiration will retry a failed pass"
        : "startup checkpoint expiration retries exhausted; retained checkpoints deferred to next startup");
    };
    return coordinator.register(DELIVERY_QUEUES.nativeCheckpointExpiration, {
      retryMs: 1000,
      pausePassiveMaintenance: true,
      run: async () => {
        if (!pending) return;
        try {
          const result = await tickCheckpoints();
          retryFailedPage ||= result.failed > 0;
          pending = result.truncated || retryFailedPage;
          if (!result.truncated) {
            if (retryFailedPage) failedPass();
            retryFailedPage = false;
          }
          if (result.checkpointCandidates || result.failed) logger.info(result, "startup native checkpoint expiration");
        } catch (err) {
          // Candidate-query failures need the same finite startup budget as
          // per-row failures; the shared coordinator otherwise retries forever.
          failedPass(err);
        }
      },
      hasPending: async () => pending,
    });
  }

  return { tick, noteEvidence, tickCheckpoints, registerCheckpointExpiration };
}
