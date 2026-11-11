import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { NATIVE_PREPARATION_HANDOFF_VERSION } from "./native-active-runs.js";
import { readNativePreparationPublication, readNativeGenericWarmPublication } from "./native-runner-checkpoint.js";
import { hasNativeExecutionStartEvidence } from "./native-restart-recovery.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { nativeRunnerLaunchMatchesPublication, readNativeRunnerLaunchIntent,
  nativeRemoteLaunchMatchesPublication, readNativeRemoteRunnerLaunchIntent } from "./native-runner-launch-intent.js";
import { readNativeWarmPreparation } from "./native-warm-preparation.js";
import { resolveNativeGenericWarmAttachmentRecovery } from "./native-generic-warm-attachment.js";

type Scope = { companyId: string; issueId: string; runId: string; controllerBootId: string; deadline?: number };

async function readPreparationProof(db: Db, scope: Scope, liveOwner: boolean) {
  if (scope.deadline !== undefined && Date.now() >= scope.deadline) return null;
  const [row] = await db.select({ agentId: heartbeatRuns.agentId, runnerInstanceId: heartbeatRuns.runnerInstanceId,
    nativeSessionId: heartbeatRuns.nativeSessionId, processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId, processStartedAt: heartbeatRuns.processStartedAt,
    profile: sql<Record<string, unknown>>`jsonb_build_object('hasRemoteWorkspace', ${heartbeatRuns.runnerProfileJson} ? 'remoteWorkspace',
      'hasPluginLaunchIntent', ${heartbeatRuns.runnerProfileJson} ? 'nativeRunnerLaunchIntent',
      'hasRemoteLaunchIntent', ${heartbeatRuns.runnerProfileJson} ? 'nativeRemoteRunnerLaunchIntent',
      'hasCarriedProviderSession', (nullif(${heartbeatRuns.runnerProfileJson}#>>'{sessionCheckpoint,providerSessionId}','') is not null
        or (jsonb_typeof(${heartbeatRuns.runnerProfileJson}#>'{sessionCheckpoint,providerIdentity}')='object'
          and ${heartbeatRuns.runnerProfileJson}#>'{sessionCheckpoint,providerIdentity}'!='{}'::jsonb)),
      'nativePreparationHandoffVersion', ${heartbeatRuns.runnerProfileJson}->'nativePreparationHandoffVersion',
      'nativeWorkspaceSync', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync',
      'remoteWorkspace', ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace')`,
    generation: nativeRunFinalizations.controllerGeneration, owner: nativeRunFinalizations.leaseOwner,
  }).from(heartbeatRuns).innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId), eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId)))
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId),
      eq(heartbeatRuns.nativeIssueId, scope.issueId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "native"),
      eq(agents.adapterType, "paperclip_runner"), eq(nativeRunFinalizations.phase, "observed"),
      eq(nativeRunFinalizations.controllerBootId, scope.controllerBootId),
      liveOwner ? gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`) : undefined,
      isNull(nativeRunFinalizations.resultId),
      isNull(nativeRunFinalizations.failureCode))).limit(1);
  if (!row || row.profile.nativePreparationHandoffVersion !== NATIVE_PREPARATION_HANDOFF_VERSION
    || !row.runnerInstanceId || !row.nativeSessionId || !row.owner || row.generation < 1) return null;
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(row.profile.remoteWorkspace);
  if (row.profile.hasRemoteWorkspace && !parsed.success) return null;
  const remote = row.profile.hasRemoteWorkspace ? parsed.success ? parsed.data : null
    : readNativeWorkspaceSyncReference(row.profile.nativeWorkspaceSync);
  const leases = await db.select({ id: environmentLeases.id, providerLeaseId: environmentLeases.providerLeaseId,
    pluginTask: sql<boolean>`${environmentLeases.metadata}->>'runnerTaskLease' = 'true'`,
    dispatched: sql<boolean>`${environmentLeases.metadata}->>'runnerTaskDispatched' = 'true'`,
  }).from(environmentLeases).where(and(eq(environmentLeases.companyId, scope.companyId),
    eq(environmentLeases.issueId, scope.issueId), eq(environmentLeases.heartbeatRunId, scope.runId),
    sql`${environmentLeases.metadata}->>'agentId' = ${row.agentId}`,
    eq(environmentLeases.status, "active"), isNull(environmentLeases.releasedAt), isNull(environmentLeases.cleanupStatus),
    sql`(${environmentLeases.expiresAt} is null or ${environmentLeases.expiresAt} > clock_timestamp())`,
    sql`coalesce(${environmentLeases.metadata}->>'runnerTaskExecutionStopped', 'false') != 'true'`,
    sql`coalesce(${environmentLeases.metadata}->>'runnerTaskRetiring', 'false') != 'true'`,
    remote ? and(eq(environmentLeases.id, remote.leaseId), eq(environmentLeases.providerLeaseId, remote.providerLeaseId))
      : sql`${environmentLeases.metadata}->>'runnerTaskLease' = 'true'`,
  )).limit(2);
  if (leases.length !== 1) return null;
  const lease = leases[0]!;
  if (remote && lease.pluginTask) return null;
  if (row.profile.hasPluginLaunchIntent && !lease.pluginTask || row.profile.hasRemoteLaunchIntent && lease.pluginTask) return null;
  if (!lease?.providerLeaseId || remote && remote.state !== "prepared") return null;
  const generic = await readNativeGenericWarmPublication(db, scope);
  if (generic) {
    const target = generic.publication.targetIdentity;
    if (target.runnerInstanceId !== row.runnerInstanceId || target.normalizedSessionId !== row.nativeSessionId
      || target.environmentLeaseId !== (lease.pluginTask ? lease.id : remote?.workspaceId)) return null;
    const recovery = await resolveNativeGenericWarmAttachmentRecovery({ db,
      currentRun: { id: scope.runId, companyId: scope.companyId, nativeIssueId: scope.issueId }, ...generic,
      owner: { companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId, authorityRunId: scope.runId,
        bootId: scope.controllerBootId, generation: row.generation, leaseOwner: row.owner },
      ...(!liveOwner ? { allowExpiredOwner: true } : {}) });
    if (!recovery) return null;
    return { kind: "launching" as const, runnerInstanceId: row.runnerInstanceId, nativeSessionId: row.nativeSessionId,
      environmentLeaseId: lease.id, warmAttachment: true as const };
  }
  const publication = await readNativePreparationPublication(db, scope);
  if (!publication || scope.deadline !== undefined && Date.now() >= scope.deadline) return null;
  const binding = { runnerInstanceId: row.runnerInstanceId, nativeSessionId: row.nativeSessionId, environmentLeaseId: lease.id };
  if (publication.kind === "absent") {
    if (!row.profile.hasPluginLaunchIntent && !row.profile.hasRemoteLaunchIntent && !lease.dispatched
      && !await hasNativeExecutionStartEvidence(db, { companyId: scope.companyId, id: scope.runId })
      && await readNativeWarmPreparation(db, { ...scope, agentId: row.agentId,
        runnerInstanceId: row.runnerInstanceId, nativeSessionId: row.nativeSessionId })) {
      return { kind: "preparing" as const, ...binding, warmSource: true as const };
    }
    if (row.profile.hasPluginLaunchIntent || row.profile.hasRemoteLaunchIntent
      || row.profile.hasCarriedProviderSession || row.processPid || row.processGroupId || row.processStartedAt || lease.dispatched
      || await hasNativeExecutionStartEvidence(db, { companyId: scope.companyId, id: scope.runId })) return null;
    return { kind: "preparing" as const, ...binding };
  }
  const proof = publication.publication;
  if (proof.bootId !== scope.controllerBootId || proof.generation !== row.generation || proof.leaseOwner !== row.owner
    || proof.identity.runnerInstanceId !== row.runnerInstanceId || proof.identity.normalizedSessionId !== row.nativeSessionId
    || proof.identity.environmentLeaseId !== (lease.pluginTask ? lease.id : remote?.workspaceId)) return null;
  if (proof.kind === "launching") {
    if (!lease.pluginTask) {
      const saved = await readNativeRemoteRunnerLaunchIntent(db, scope);
      if (saved) {
        if (saved.environmentLeaseId !== lease.id || saved.providerLeaseId !== lease.providerLeaseId
          || !nativeRemoteLaunchMatchesPublication(saved, proof)) return null;
        return { kind: "launching" as const, ...binding };
      }
      if (row.profile.hasRemoteLaunchIntent) return null;
    }
    const intent = await readNativeRunnerLaunchIntent(db, scope);
    if (intent) {
      if (!lease.pluginTask || intent.environmentLeaseId !== lease.id || intent.taskId !== lease.providerLeaseId
        || !nativeRunnerLaunchMatchesPublication(intent, proof)) return null;
      return { kind: "launching" as const, ...binding };
    }
    if (row.profile.hasPluginLaunchIntent) return null;
    if (row.processPid || row.processGroupId || row.processStartedAt || lease.dispatched) return null;
    return { kind: "preparing" as const, ...binding };
  }
  if (row.profile.hasPluginLaunchIntent || row.profile.hasRemoteLaunchIntent || lease.dispatched) return null;
  if ((row.processPid || row.processGroupId || row.processStartedAt || row.profile.hasCarriedProviderSession)
    && !await readNativeWarmPreparation(db, { ...scope, agentId: row.agentId,
      runnerInstanceId: row.runnerInstanceId, nativeSessionId: row.nativeSessionId })) return null;
  return { kind: "preparing" as const, ...binding };
}

export function readNativePreparationHandoffReadiness(db: Db, scope: Scope) {
  return readPreparationProof(db, scope, true);
}

export function readNativePreparationRecoveryProof(db: Db, scope: Scope) {
  return readPreparationProof(db, scope, false);
}

export async function nativePreparationClaimNeverLaunched(db: Pick<Db, "select">, scope: {
  companyId: string; issueId: string; runId: string; leaseOwner: string; controllerGeneration: number;
}) {
  const [row] = await db.select({ reason: sql<string>`${nativeRunFinalizations.recoveryHistory}->-1->>'reason'` })
    .from(nativeRunFinalizations).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(eq(nativeRunFinalizations.companyId, scope.companyId), eq(nativeRunFinalizations.issueId, scope.issueId),
      eq(nativeRunFinalizations.runId, scope.runId), eq(nativeRunFinalizations.leaseOwner, scope.leaseOwner),
      eq(nativeRunFinalizations.controllerGeneration, scope.controllerGeneration), eq(nativeRunFinalizations.phase, "observed"),
      gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
      sql`${heartbeatRuns.runnerProfileJson}->>'nativePreparationHandoffVersion' = ${String(NATIVE_PREPARATION_HANDOFF_VERSION)}`))
    .limit(1);
  return row?.reason === "durable_preparation_before_launch";
}
