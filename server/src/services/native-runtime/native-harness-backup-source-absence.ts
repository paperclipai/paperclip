import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, nativeHarnessBackups, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { nativeHarnessStateBase } from "./native-harness-backup-stamp.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";

export const NATIVE_HARNESS_BACKUP_SOURCE_ABSENT_KEY = "nativeHarnessBackupSourceAbsent";
const SCHEMA = "paperclip.native-harness-backup-source-absent.v1";
const terminal = ["succeeded", "failed", "cancelled", "interrupted", "timed_out"];
type Scopes = Record<string, { manifestSha256s: string[]; recordedAt: string }>;
export type NativeHarnessBackupSourceAbsence = "source_gone_recorded" | "selected_source_absent" | "selected_source_retiring" | "selected_source_unsettled" | "selected_source_busy";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function localSourceState(scopeDigest: string): Promise<"gone" | "present" | "retiring" | "unsettled"> {
  const backups = join(nativeHarnessStateBase(), scopeDigest, "failover-backups");
  const missing = (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; };
  if (await lstat(join(backups, "current")).catch(missing)) return "present";
  const names = (await readdir(backups).catch(missing) ?? []).filter(name => !name.startsWith(".expired-"));
  if (names.some(name => name.startsWith(".retiring-"))) return "retiring";
  return names.length ? "unsettled" : "gone";
}

export async function recordNativeHarnessBackupSourceAbsence(db: Db, input: {
  companyId: string; selectedSessionId: string; scopeDigest: string; signal: AbortSignal;
}): Promise<NativeHarnessBackupSourceAbsence> {
  if (!/^[a-f0-9]{64}$/.test(input.scopeDigest)) return "selected_source_absent";
  const publications: ActivityPublication[] = [];
  const outcome = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    input.signal.throwIfAborted();
    await tx.execute(sql`set local lock_timeout = '1s'`);
    const [selection] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, input.companyId),
      eq(agentTaskSessions.id, input.selectedSessionId), eq(agentTaskSessions.adapterType, "paperclip_runner"))).for("update");
    if (!selection?.lastRunId) return "selected_source_absent" as const;
    if (!await tryLockNativeWorkspaceFinalization(tx, { companyId: input.companyId, runId: selection.lastRunId })) return "selected_source_absent" as const;
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.id, selection.lastRunId), eq(heartbeatRuns.agentId, selection.agentId))).for("update");
    const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    if (!run?.nativeIssueId || !run.nativeSessionId || !run.finishedAt || !terminal.includes(run.status)
      || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date(clock.now)
      || adapterExecutionControls.has(run.id) || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner != null) {
      return "selected_source_absent" as const;
    }
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.runId, run.id))).for("update");
    if (coordinator && (coordinator.leaseOwner || coordinator.nextAttemptAt)) return "selected_source_absent" as const;
    const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.status, ["queued", "running"]), or(eq(heartbeatRuns.nativeIssueId, run.nativeIssueId),
        eq(heartbeatRuns.issueId, run.nativeIssueId), eq(heartbeatRuns.nativeSessionId, run.nativeSessionId)))).limit(1);
    if (active) return "selected_source_absent" as const;
    const [current] = await tx.select({ id: nativeHarnessBackups.id }).from(nativeHarnessBackups).where(and(
      eq(nativeHarnessBackups.companyId, input.companyId), eq(nativeHarnessBackups.scopeDigest, input.scopeDigest),
      eq(nativeHarnessBackups.status, "current"))).limit(1);
    if (current) return "selected_source_absent" as const;
    const leases = await tx.execute<{ manifest: string }>(sql`select e.metadata->'nativeHarnessBackup'->>'manifestSha256' as manifest
      from environment_leases e where e.company_id = ${input.companyId}::uuid and e.issue_id = ${run.nativeIssueId}::uuid
        and e.metadata->'nativeHarnessBackup'->>'schema' = 'paperclip.native-harness-backup-stamp.v2'
        and e.metadata->'nativeHarnessBackup'->>'normalizedSessionId' = ${run.nativeSessionId}
        and e.metadata->'nativeHarnessBackup'->>'sessionScopeSha256' = ${input.scopeDigest}
      order by e.id for share of e`);
    const manifests = [...new Set(leases.map(row => row.manifest).filter(value => /^sha256:[a-f0-9]{64}$/.test(value ?? "")))].sort();
    if (!manifests.length) return "selected_source_absent" as const;
    input.signal.throwIfAborted();
    const local = await localSourceState(input.scopeDigest);
    if (local === "retiring") return "selected_source_retiring" as const;
    if (local === "unsettled") return "selected_source_unsettled" as const;
    if (local === "present") return "selected_source_absent" as const;
    const profile = object(run.runnerProfileJson), recorded = object(profile[NATIVE_HARNESS_BACKUP_SOURCE_ABSENT_KEY]);
    const scopes: Scopes = recorded.schema === SCHEMA ? { ...object(recorded.scopes) } as Scopes : {};
    const previous = scopes[input.scopeDigest]?.manifestSha256s ?? [];
    if (manifests.every(manifest => previous.includes(manifest))) return "source_gone_recorded" as const;
    const recordedAt = new Date(clock.now).toISOString();
    scopes[input.scopeDigest] = { manifestSha256s: [...new Set([...previous, ...manifests])].sort(), recordedAt };
    await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, [NATIVE_HARNESS_BACKUP_SOURCE_ABSENT_KEY]: { schema: SCHEMA, scopes } } })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, input.companyId)));
    await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "native-harness-preservation",
      action: "native_harness_backup_source_gone_recorded", entityType: "heartbeat_run", entityId: run.id,
      agentId: run.agentId, runId: run.id, details: { scopeDigest: input.scopeDigest, manifestSha256s: manifests,
        selectedSessionId: input.selectedSessionId } }, publications);
    return "source_gone_recorded" as const;
  }).catch((error: { code?: string; cause?: { code?: string } }) => {
    input.signal.throwIfAborted();
    if ((error?.code ?? error?.cause?.code) === "55P03") return "selected_source_busy" as const;
    throw error;
  });
  for (const publication of publications) publishActivity(publication);
  return outcome;
}
