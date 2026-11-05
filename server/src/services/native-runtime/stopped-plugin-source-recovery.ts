import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { PluginEnvironmentTaskResult } from "@paperclipai/plugin-sdk";
import { inspectDurablePrpCheckpointHeader, inspectSourceReconciliationLaunchRequirements, parseNativeExecutionInput,
  type DurableRecoveryIdentity, type NativeExecutionInput, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { resolvePluginTaskResume } from "../plugin-task-resume.js";
import { NativeControllerRecoveryWaitingError, resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { NativeExecutionContext } from "./native-execution-context.js";
import { nativeSha256 } from "./canonical.js";
import { readPluginTaskSourceRecovery } from "./native-source-recovery-reference.js";
import { loadNativeRunnerCheckpointHeader } from "./native-runner-checkpoint.js";

/** A stopped-source reference selects the pre-attach lane, never a fake B snapshot. */
export async function readPendingPluginSourceRecovery(db: Db, input: {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "nativeIssueId" | "nativeSessionId" | "runnerProfileJson">;
  lease: { id: string; metadata: Record<string, unknown> } | undefined;
  ownCheckpoint: boolean;
}) {
  const raw = input.lease?.metadata.runnerTaskSourceRecovery;
  if (raw == null || input.ownCheckpoint) return null;
  const reference = readPluginTaskSourceRecovery(raw), run = input.run;
  const unproven = { kind: "unproven" as const };
  if (!reference || reference.consumerRunId !== run.id || reference.consumerLeaseId !== input.lease!.id ||
      reference.identity.runId === run.id || reference.identity.normalizedSessionId !== run.nativeSessionId ||
      reference.consumerProfileSha256 !== nativeSha256(run.runnerProfileJson?.nativeExecutionInput)) return unproven;
  const [source] = await db.select({ run: heartbeatRuns, owner: nativeRunFinalizations }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id)).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, reference.identity.runId),
      eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.nativeIssueId, run.nativeIssueId!)));
  const [sourceLease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
    eq(environmentLeases.id, reference.sourceLeaseId), eq(environmentLeases.heartbeatRunId, reference.identity.runId)));
  const consumer = sourceLease?.metadata?.runnerTaskSourceConsumer as Record<string, unknown> | undefined;
  const taskIdentity = input.lease!.metadata.runnerTaskIdentity as Record<string, unknown> | undefined;
  const aliases = { runnerInstanceId: "runnerId", environmentLeaseId: "leaseId", runId: "runId", normalizedSessionId: "sessionId", turnId: "turnId", itemId: "itemId" } as const;
  const header = await loadNativeRunnerCheckpointHeader(db, { companyId: run.companyId, issueId: run.nativeIssueId!, runId: reference.identity.runId });
  const identity = header ? inspectDurablePrpCheckpointHeader(header) : null;
  if (!source || source.run.status !== "succeeded" || source.owner.phase !== "committed" || !source.owner.resultId || source.owner.leaseOwner ||
      reference.sourceProfileSha256 !== nativeSha256(source.run.runnerProfileJson?.nativeExecutionInput) ||
      consumer?.leaseId !== input.lease!.id || consumer.runId !== run.id || consumer.resumeFrom !== reference.resumeFrom ||
      consumer.accountIdentity !== reference.accountIdentity || nativeSha256(consumer.identity) !== nativeSha256(reference.identity) || !identity ||
      Object.entries(reference.identity).some(([key, value]) => identity[key as keyof DurableRecoveryIdentity] !== value) ||
      (taskIdentity ? Object.entries(reference.identity).some(([key, value]) => taskIdentity[aliases[key as keyof DurableRecoveryIdentity]] !== value)
        : input.lease!.metadata.runnerTaskDispatched === true)) return unproven;
  return { kind: "source" as const, reference };
}

export type StoppedPluginSourceRecovery = {
  identity: DurableRecoveryIdentity;
  checkpoint: PersistedNativeSession;
  previousExecution: NativeExecutionInput;
  resumeFrom: string;
  launch: { requirements: NonNullable<ReturnType<typeof inspectSourceReconciliationLaunchRequirements>> };
  runnerArtifact: { version: string; digest: string };
  dispatched: boolean;
};

/** Attachment staging can change the prompt after canonical run admission. */
export async function createStoppedSourceExecutionContext(input: {
  db: Db; execution: NativeExecutionInput; preparedExecutionAdmission?: { admissionSha256: string; preparedSha256: string };
  timeoutMs: number; owner: { bootId: string; leaseOwner: string; generation: number };
}): Promise<NativeExecutionContext> {
  const [run] = await input.db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.execution.binding.companyId), eq(heartbeatRuns.id, input.execution.binding.runId)));
  const canonical = parseNativeExecutionInput(run?.profile?.nativeExecutionInput);
  if (nativeSha256(canonical) !== (input.preparedExecutionAdmission?.admissionSha256 ?? nativeSha256(input.execution)) ||
      input.preparedExecutionAdmission && nativeSha256(input.execution) !== input.preparedExecutionAdmission.preparedSha256) {
    throw new Error("native_source_recovery_execution_changed");
  }
  const context = new NativeExecutionContext(canonical, input.timeoutMs);
  context.bindNativeLease(input.owner); context.pluginSupported = true;
  return context;
}

/** Discovery selects one canonical source. It grants no provider or tool authority. */
export async function inspectStoppedPluginSourceRecovery(input: {
  db: Db;
  execution: NativeExecutionInput;
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>;
  description: Extract<PluginEnvironmentTaskResult, { kind: "description" }>;
  readControlState(): unknown;
  matchesExecution(previous: NativeExecutionInput, recordedConfigDigest: string): boolean;
}): Promise<StoppedPluginSourceRecovery | undefined> {
  const { target, execution, description } = input;
  if (execution.provider.kind !== "codex" || execution.session.lifecyclePolicy.mode !== "warm" ||
      target.transport !== "sandbox" || !target.runnerTask || !target.leaseId || description.sourceRecoveryVersion !== 1) return;
  const deny = (): never => { throw new Error("native_stopped_source_recovery_unproven"); };
  const [lease] = await input.db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, execution.binding.companyId), eq(environmentLeases.id, target.leaseId)));
  const pending = lease?.metadata?.runnerTaskSourceRecovery as { schema?: unknown; consumerRunId?: unknown; consumerLeaseId?: unknown;
    resumeFrom?: unknown; identity?: DurableRecoveryIdentity } | undefined;
  if (!pending && target.sandboxLeaseAcquisition?.outcome === "resumed") return;
  const recovered = await resolveNativeControllerRecovery(input.db, { ...execution.binding,
    currentRunId: execution.binding.runId, normalizedSessionId: execution.session.normalizedSessionId! });
  if (recovered.kind === "no_prior_execution") return;
  if (recovered.kind === "waiting_for_owner") throw new NativeControllerRecoveryWaitingError(recovered.deadline);
  if (recovered.kind !== "recoverable") return deny();
  const header = recovered.checkpoint.records.get("header"), identity = header ? inspectDurablePrpCheckpointHeader(header) : null;
  if (!identity || identity.runId === execution.binding.runId) return deny();
  if (!pending) {
    try {
      await resolvePluginTaskResume(input.db, { companyId: execution.binding.companyId,
        leaseId: target.leaseId, priorIdentity: identity });
      return; // A retained suspension already has ordinary continuation authority.
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Plugin Runner retained session is not authorized") throw error;
    }
  }
  const [source] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, execution.binding.companyId), eq(heartbeatRuns.id, identity.runId)));
  if (!source || source.status !== "succeeded") return deny();
  const previousExecution = parseNativeExecutionInput(source.runnerProfileJson?.nativeExecutionInput);
  const snapshot = recovered.snapshot;
  if (previousExecution.provider.kind !== "codex" || !input.matchesExecution(previousExecution, recovered.metadata.configDigest) ||
      snapshot.activeTurnId !== null || !Array.isArray(snapshot.pendingRuntimeRequests) || snapshot.pendingRuntimeRequests.length ||
      snapshot.goal?.status === "active" || !snapshot.sessionId || !snapshot.providerSessionId) return deny();
  const requirements = inspectSourceReconciliationLaunchRequirements(input.readControlState(), {
    identity, provider: "codex", runtimeContextDigest: "runtimeContext" in previousExecution ? previousExecution.runtimeContext.aggregateDigest : null,
    settings: { ...("webSearch" in previousExecution.provider && previousExecution.provider.webSearch === "disabled"
      ? { disableCodexWebSearch: true } : {}) },
  });
  if (!requirements || description.executionContextVersion !== 1 || description.launchPreparationVersion !== 1 ||
      description.projectAuthCheckVersion !== 1 || recovered.checkpoint.runnerVersion !== description.runner.version ||
      recovered.checkpoint.runnerDigest !== description.runner.digest) return deny();
  if (pending && (pending.schema !== "paperclip.runner.source-recovery.v1" || pending.consumerRunId !== execution.binding.runId ||
      pending.consumerLeaseId !== lease!.id || !pending.identity ||
      Object.entries(identity).some(([key, value]) => pending.identity![key as keyof DurableRecoveryIdentity] !== value))) return deny();
  const resumeFrom = pending ? pending.resumeFrom : await resolvePluginTaskResume(input.db, { companyId: execution.binding.companyId,
    leaseId: target.leaseId, priorIdentity: identity, inspectCheckpoint: true });
  if (typeof resumeFrom !== "string" || !resumeFrom) return deny();
  return { identity, checkpoint: snapshot, previousExecution, resumeFrom, launch: { requirements },
    runnerArtifact: { version: recovered.checkpoint.runnerVersion, digest: recovered.checkpoint.runnerDigest },
    dispatched: pending !== undefined && lease!.metadata?.runnerTaskDispatched === true };
}
