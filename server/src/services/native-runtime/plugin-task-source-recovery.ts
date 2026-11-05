import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, companies, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { environmentTaskOperationSchema, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import { parseNativeExecutionInput, inspectDurablePrpCheckpointHeader, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { resolvePluginTaskResume } from "../plugin-task-resume.js";
import { legacyShutdownWorkspaceResourceProtected } from "../legacy-shutdown-workspace-settlement.js";
import { NativeExecutionContext } from "./native-execution-context.js";
import { isCurrentNativeControllerProcess } from "./native-restart-recovery.js";
import { nativeWorkspaceExportPendingForResource } from "./native-workspace-finalization-state.js";
import { lockSourceRecoveryCoordinators } from "./native-source-recovery-ownership.js";
import { loadNativeRunnerCheckpointHeader } from "./native-runner-checkpoint.js";
import { nativeSha256 as fingerprint } from "./canonical.js";

type Identity = Extract<PluginEnvironmentTaskOperation, { kind: "prepare" }>["requirements"]["identity"];
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const keys = ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"] as const;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const deny = (): never => { throw new Error("native_source_recovery_ownership_unverified"); };

export type PluginTaskSourceRecovery = {
  schema: "paperclip.runner.source-recovery.v1";
  resumeFrom: string;
  sourceLeaseId: string;
  identity: Identity;
  consumerLeaseId: string;
  consumerRunId: string;
  controllerBootId: string;
  controllerGeneration: number;
  contextId: string;
  accountIdentity: string;
  sourceProfileSha256: string;
  consumerProfileSha256: string;
};

function readRecovery(value: unknown): PluginTaskSourceRecovery | null {
  const v = record(value);
  const identity = environmentTaskOperationSchema.safeParse({ kind: "read_state", identity: v.identity });
  return v.schema === "paperclip.runner.source-recovery.v1" && identity.success &&
    ["resumeFrom", "sourceLeaseId", "consumerLeaseId", "consumerRunId", "controllerBootId", "contextId", "accountIdentity"].every(key => typeof v[key] === "string" && v[key] !== "") &&
    Number.isSafeInteger(v.controllerGeneration) && Number(v.controllerGeneration) >= 0 &&
    [v.sourceProfileSha256, v.consumerProfileSha256].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    ? v as unknown as PluginTaskSourceRecovery : null;
}

async function inspect(tx: Transaction, input: {
  companyId: string; leaseId: string; context: NativeExecutionContext; identity: Identity; resumeFrom: string; accountIdentity: string;
}, expected?: PluginTaskSourceRecovery) {
  input.context.assertOpen();
  const binding = input.context.execution.binding;
  if (binding.companyId !== input.companyId || input.identity.runId === binding.runId) return deny();
  await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
  const owners = await lockSourceRecoveryCoordinators(tx, input.companyId, [input.identity.runId, binding.runId]);
  const owner = owners.find(value => value.runId === binding.runId), prior = owners.find(value => value.runId === input.identity.runId);
  // NOWAIT preserves the established coordinator-first order without waiting
  // behind a workspace-maintenance path which already holds the issue.
  const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, binding.issueId))).for("update", { noWait: true });
  const runs = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    inArray(heartbeatRuns.id, [input.identity.runId, binding.runId])));
  const current = runs.find(value => value.id === binding.runId), source = runs.find(value => value.id === input.identity.runId);
  const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, input.leaseId))).for("update");
  const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, binding.agentId)));
  const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId));
  if (!owner || !owner.leaseOwner || !owner.leaseExpiresAt || owner.leaseExpiresAt.getTime() <= Date.now() ||
      !isCurrentNativeControllerProcess(owner) || owner.resultId || ["committed", "applied", "terminal_failure"].includes(owner.phase) ||
      !prior || prior.phase !== "committed" || !prior.resultId || prior.leaseOwner ||
      !current || current.status !== "running" || current.nativeIssueId !== binding.issueId || current.agentId !== binding.agentId || current.resultJson?.nativeCancellation ||
      !source || source.status !== "succeeded" || !source.finishedAt || source.runtimeMode !== "native" || source.agentId !== binding.agentId || source.nativeIssueId !== binding.issueId ||
      source.runnerInstanceId !== input.identity.runnerInstanceId || source.nativeSessionId !== input.identity.normalizedSessionId ||
      !issue || issue.executionRunId !== binding.runId || issue.assigneeAgentId !== binding.agentId || issue.status !== "in_progress" ||
      company?.status !== "active" || agent?.lifecycleState !== "ready" || ["paused", "terminated", "pending_approval"].includes(agent.status) ||
      !lease || lease.heartbeatRunId !== binding.runId || lease.issueId !== binding.issueId || lease.status !== "active" || lease.releasedAt ||
      lease.expiresAt && lease.expiresAt.getTime() <= Date.now() || lease.metadata?.runnerTaskRetiring === true) return deny();
  input.context.assertNativeLease({ bootId: owner.controllerBootId!, leaseOwner: owner.leaseOwner, generation: owner.controllerGeneration });
  const header = await loadNativeRunnerCheckpointHeader(tx, { companyId: input.companyId, issueId: binding.issueId, runId: source.id });
  const protocolIdentity = header ? inspectDurablePrpCheckpointHeader(header) : null;
  if (!protocolIdentity || keys.some(key => protocolIdentity[key] !== input.identity[key])) return deny();
  const sourceExecution = parseNativeExecutionInput(source.runnerProfileJson?.nativeExecutionInput);
  const consumerExecution = parseNativeExecutionInput(current.runnerProfileJson?.nativeExecutionInput);
  if (sourceExecution.provider.kind !== "codex" || consumerExecution.provider.kind !== "codex" ||
      sourceExecution.binding.companyId !== input.companyId || sourceExecution.binding.issueId !== binding.issueId ||
      sourceExecution.binding.agentId !== binding.agentId || sourceExecution.binding.runId !== source.id ||
      sourceExecution.session.normalizedSessionId !== input.identity.normalizedSessionId ||
      fingerprint(consumerExecution) !== fingerprint(input.context.execution)) return deny();
  const sourceTask = await resolvePluginTaskResume(tx as unknown as Db, { companyId: input.companyId, leaseId: input.leaseId,
    priorIdentity: input.identity, inspectCheckpoint: true });
  if (sourceTask !== input.resumeFrom) return deny();
  const sources = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.heartbeatRunId, source.id), eq(environmentLeases.providerLeaseId, sourceTask))).for("update");
  if (sources.length !== 1) return deny();
  const sourceLease = sources[0]!;
  const saved = record(sourceLease.metadata?.runnerTaskIdentity);
  const aliases = { runnerInstanceId: "runnerId", environmentLeaseId: "leaseId", runId: "runId", normalizedSessionId: "sessionId", turnId: "turnId", itemId: "itemId" } as const;
  if (keys.some(key => saved[aliases[key]] !== input.identity[key]) ||
      await nativeWorkspaceExportPendingForResource(tx as unknown as Db, sourceLease, binding.runId) ||
      await legacyShutdownWorkspaceResourceProtected(tx as unknown as Db, sourceLease)) return deny();
  const allocations = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.provider, sourceLease.provider!),
    eq(environmentLeases.providerLeaseId, sourceTask)));
  if (allocations.some(value => value.companyId !== input.companyId ||
      value.id !== sourceLease.id && value.id !== lease.id && ["active", "retained", "pending_cleanup"].includes(value.status))) return deny();
  const recovery: PluginTaskSourceRecovery = { schema: "paperclip.runner.source-recovery.v1", identity: input.identity,
    resumeFrom: sourceTask, sourceLeaseId: sourceLease.id, consumerLeaseId: lease.id, consumerRunId: binding.runId,
    controllerBootId: owner.controllerBootId!, controllerGeneration: owner.controllerGeneration, contextId: input.context.id, accountIdentity: input.accountIdentity,
    sourceProfileSha256: fingerprint(source.runnerProfileJson?.nativeExecutionInput), consumerProfileSha256: fingerprint(current.runnerProfileJson?.nativeExecutionInput) };
  if (expected && fingerprint(recovery) !== fingerprint(expected)) return deny();
  input.context.assertOpen();
  if (owner.leaseExpiresAt.getTime() <= Date.now() || lease.expiresAt && lease.expiresAt.getTime() <= Date.now()) return deny();
  return { recovery, sourceLease, lease, sourceExecution, consumerExecution, owner };
}

/** Only current B's native authority can consume succeeded A for maintenance. */
export async function claimPluginTaskSourceRecovery(db: Db, input: {
  companyId: string; leaseId: string; context: NativeExecutionContext; identity: Identity; resumeFrom: string; accountIdentity: string;
  sourceRecoveryVersion?: 1;
  matchesExecution(source: NativeExecutionInput): boolean;
}): Promise<PluginTaskSourceRecovery> {
  if (input.sourceRecoveryVersion !== 1 || !input.accountIdentity) return deny();
  return db.transaction(async tx => {
    const inspected = await inspect(tx, input);
    if (!input.matchesExecution(inspected.sourceExecution)) return deny();
    const { recovery, sourceLease, lease } = inspected;
    const consumer = { leaseId: lease.id, runId: recovery.consumerRunId, resumeFrom: recovery.resumeFrom,
      identity: recovery.identity, accountIdentity: recovery.accountIdentity };
    const existing = sourceLease.metadata?.runnerTaskSourceConsumer;
    if (existing && fingerprint(existing) !== fingerprint(consumer)) return deny();
    const others = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.provider, sourceLease.provider!),
      sql`${environmentLeases.id} <> ${lease.id}`,
      sql`${environmentLeases.metadata}->>'runnerTaskResumeFrom' = ${input.resumeFrom}`));
    if (others.length) return deny();
    input.context.assertOpen();
    if (inspected.owner.leaseExpiresAt!.getTime() <= Date.now()) return deny();
    await tx.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runnerTaskSourceConsumer: consumer })}::jsonb` })
      .where(eq(environmentLeases.id, sourceLease.id));
    await tx.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ runnerTaskSourceRecovery: recovery })}::jsonb` })
      .where(eq(environmentLeases.id, lease.id));
    return recovery;
  });
}

async function assertSourceIdentity(db: Db, input: {
  companyId: string; leaseId: string; context: NativeExecutionContext | undefined;
  identity: Identity; accountIdentity?: string; resumeFrom?: string; requireDispatched?: boolean;
}): Promise<PluginTaskSourceRecovery> {
  if (!input.context) return deny();
  const { identity } = input;
  return db.transaction(async tx => {
    const [lease] = await tx.select({ metadata: environmentLeases.metadata }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, input.leaseId)));
    const expected = readRecovery(lease?.metadata?.runnerTaskSourceRecovery);
    if (!expected || keys.some(key => expected.identity[key] !== identity[key]) ||
        input.resumeFrom !== undefined && expected.resumeFrom !== input.resumeFrom || expected.accountIdentity !== input.accountIdentity) return deny();
    const inspected = await inspect(tx, { ...input, context: input.context!, resumeFrom: expected.resumeFrom, accountIdentity: expected.accountIdentity }, expected);
    if (input.requireDispatched && (inspected.lease.metadata?.runnerTaskDispatched !== true ||
        inspected.lease.metadata?.runnerTaskExecutionStopped === true)) return deny();
    const consumer = record(inspected.sourceLease.metadata?.runnerTaskSourceConsumer);
    if (consumer.leaseId !== input.leaseId || consumer.runId !== expected.consumerRunId || consumer.resumeFrom !== expected.resumeFrom || consumer.accountIdentity !== expected.accountIdentity ||
        fingerprint(consumer.identity) !== fingerprint(identity)) return deny();
    return expected;
  });
}

/** The worker never derives this exception from an arbitrary mismatched run ID. */
export async function assertPluginTaskSourceRecovery(db: Db, input: {
  companyId: string; leaseId: string; context: NativeExecutionContext | undefined;
  operation: Extract<PluginEnvironmentTaskOperation, { kind: "prepare" | "submit" }>;
}): Promise<PluginTaskSourceRecovery> {
  const operation = input.operation;
  if (operation.recoveryPurpose !== "source_reconcile" || !operation.resumeFrom) return deny();
  const identity = operation.kind === "prepare" ? operation.requirements.identity : {
    runnerInstanceId: operation.runner.runnerId, environmentLeaseId: operation.runner.leaseId, runId: operation.runner.runId,
    normalizedSessionId: operation.runner.sessionId, turnId: operation.runner.turnId, itemId: operation.runner.itemId,
  };
  return assertSourceIdentity(db, { ...input, identity, resumeFrom: operation.resumeFrom, accountIdentity: operation.accountIdentity });
}

/** A fresh source incarnation can attach B without pretending it was warm reuse. */
export async function assertPluginTaskSourceAttachment(db: Db, input: {
  companyId: string; leaseId: string; context: NativeExecutionContext | undefined;
  operation: Extract<PluginEnvironmentTaskOperation, { kind: "prepare" }>;
}): Promise<PluginTaskSourceRecovery> {
  const { operation } = input, target = operation.requirements.identity;
  if (!operation.priorIdentity || operation.recoveryPurpose || operation.resumeFrom || operation.requirements.provider !== "codex") return deny();
  const recovery = await assertSourceIdentity(db, { ...input, identity: operation.priorIdentity, accountIdentity: operation.accountIdentity, requireDispatched: true });
  if (target.runId !== recovery.consumerRunId || ["runnerInstanceId", "environmentLeaseId", "normalizedSessionId"].some(key =>
    target[key as keyof Identity] !== recovery.identity[key as keyof Identity])) return deny();
  return recovery;
}
