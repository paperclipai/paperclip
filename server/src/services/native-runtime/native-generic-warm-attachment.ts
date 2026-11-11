import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { inspectDurablePrpCheckpointHeader, inspectWarmRunTransition,
  parseNativeExecutionInput, type DurablePrpCheckpoint, type DurableRecoveryIdentity,
  type NativeExecutionInput, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { preparationSha256 } from "./native-preparation-checkpoint.js";
import { readNativeCheckpointPublicationIdentity, type NativeRunnerCheckpointOwner } from "./native-runner-checkpoint.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { rebindNativeSessionCheckpoint } from "./native-session-resume.js";

type FrozenRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "nativeIssueId" |
  "nativeSessionId" | "runnerInstanceId" | "runtimeMode" | "status" | "createdAt" | "startedAt" | "finishedAt" |
  "runnerProfileJson" | "resultJson" | "errorCode" | "nativePhase">;
const runColumns = { id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
  nativeIssueId: heartbeatRuns.nativeIssueId, nativeSessionId: heartbeatRuns.nativeSessionId,
  runnerInstanceId: heartbeatRuns.runnerInstanceId, runtimeMode: heartbeatRuns.runtimeMode, status: heartbeatRuns.status,
  createdAt: heartbeatRuns.createdAt, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
  errorCode: heartbeatRuns.errorCode, nativePhase: heartbeatRuns.nativePhase,
  resultJson: sql<Record<string, unknown>>`jsonb_build_object('nativeCancellation', ${heartbeatRuns.resultJson}->'nativeCancellation')`,
  runnerProfileJson: sql<Record<string, unknown>>`jsonb_build_object(
    'nativeExecutionInput', ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput',
    'sessionCheckpoint', ${heartbeatRuns.runnerProfileJson}->'sessionCheckpoint',
    'nativeToolContractFingerprint', ${heartbeatRuns.runnerProfileJson}->'nativeToolContractFingerprint',
    'nativePreparationHandoffVersion', ${heartbeatRuns.runnerProfileJson}->'nativePreparationHandoffVersion',
    'nativePreparationHandoffSourceRunId', ${heartbeatRuns.runnerProfileJson}->'nativePreparationHandoffSourceRunId')` };
const boundedProfile = sql`octet_length(coalesce(${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput', 'null'::jsonb)::text) <= 1048576
  and octet_length(coalesce(${heartbeatRuns.runnerProfileJson}->'sessionCheckpoint', 'null'::jsonb)::text) <= 1048576`;
const record = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, any> : {};
const identityKeys = ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"] as const;
const identity = (value: unknown): value is DurableRecoveryIdentity => {
  const candidate = record(value);
  return identityKeys.every(key => typeof candidate[key] === "string" && candidate[key].length > 0)
    && Object.keys(candidate).length === identityKeys.length;
};
const commandWire = (command: Record<string, unknown>) => {
  const { status: _status, result: _result, ...wire } = command;
  return wire;
};

export type NativeGenericWarmAttachmentPublication = {
  schema: "paperclip.native-generic-warm-attachment.v1";
  sourceIdentity: DurableRecoveryIdentity;
  targetIdentity: DurableRecoveryIdentity;
  phase: "preparing" | "queued" | "transition";
  commandPart: string | null;
  commandSha256: string | null;
  headerSha256: string;
  runnerVersion: string;
  runnerDigest: string;
  bootId: string;
  generation: number;
  leaseOwner: string;
};

export function nativeGenericWarmAttachmentPublication(checkpoint: DurablePrpCheckpoint,
  owner: NativeRunnerCheckpointOwner): NativeGenericWarmAttachmentPublication | null {
  try {
    if (owner.runId !== owner.authorityRunId || checkpoint.runId !== owner.runId) return null;
    const headerText = checkpoint.records.get("header");
    if (!headerText || Buffer.byteLength(headerText) > 1024 * 1024 || !inspectDurablePrpCheckpointHeader(headerText)) return null;
    const header = JSON.parse(headerText), state = record(header.state);
    if (header.schema !== "paperclip.runner.controller-checkpoint.v3" || state.preparationHandoff?.version !== 1) return null;
    const completed = record(state.completedWarmTransition);
    const transition = record(state.warmTransition ?? (completed.receipt?.newIdentity?.runId === owner.runId ? completed : null));
    const preparing = record(state.preparingRunAttachment);
    let lastPart: string | null = null;
    for (const key of checkpoint.records.keys()) if (/^command:[0-9]+$/.test(key)
      && (lastPart === null || Number(key.slice(8)) > Number(lastPart.slice(8)))) lastPart = key;
    const lastText = lastPart ? checkpoint.records.get(lastPart)! : null;
    if (lastText && Buffer.byteLength(lastText) > 1024 * 1024) return null;
    const last = lastText ? JSON.parse(lastText) : null;
    const pending = last?.type === "run.attach" && last.status === "pending"
      && last.payload?.paperclipNextAuthority?.identity?.runId === owner.runId ? { part: lastPart!, command: last } : null;
    const selected = pending ?? (transition.command ? { part: `command:${transition.command.controllerSeq}`, command: transition.command } : null);
    const source = transition.receipt?.oldIdentity ?? preparing.sourceIdentity ?? state.identity;
    const target = transition.receipt?.newIdentity ?? preparing.targetIdentity
      ?? selected?.command.payload?.paperclipNextAuthority?.identity;
    if (!identity(source) || !identity(target) || source.runId === target.runId || target.runId !== owner.runId
      || !["runnerInstanceId", "environmentLeaseId", "normalizedSessionId"].every(key => source[key as keyof typeof source] === target[key as keyof typeof target])
      || ![source, target].some(value => isDeepStrictEqual(value, state.identity))) return null;
    if (selected && (selected.command.type !== "run.attach" || selected.command.status === "failed"
      || !isDeepStrictEqual(selected.command.payload?.paperclipNextAuthority?.identity, target))) return null;
    if (!selected && (!identity(preparing.sourceIdentity) || !identity(preparing.targetIdentity))) return null;
    return { schema: "paperclip.native-generic-warm-attachment.v1", sourceIdentity: source, targetIdentity: target,
      phase: transition.receipt ? "transition" : selected ? "queued" : "preparing",
      commandPart: selected?.part ?? null, commandSha256: selected ? nativeSha256(commandWire(selected.command)) : null,
      headerSha256: preparationSha256(headerText), runnerVersion: header.runnerVersion, runnerDigest: header.runnerDigest,
      bootId: owner.bootId, generation: owner.generation, leaseOwner: owner.leaseOwner };
  } catch { return null; }
}

export type NativeGenericWarmAttachmentRecovery = NativeGenericWarmAttachmentPublication & {
  sourceRun: FrozenRun;
  currentRun: FrozenRun;
  sourceExecution: NativeExecutionInput;
  currentExecution: NativeExecutionInput;
  checkpoint: PersistedNativeSession;
  targetCheckpoint: PersistedNativeSession | null;
};

export async function resolveNativeGenericWarmAttachmentRecovery(input: {
  db: Pick<Db, "select" | "execute">;
  currentRun: Pick<FrozenRun, "id" | "companyId" | "nativeIssueId">;
  publication: NativeGenericWarmAttachmentPublication;
  header: string;
  owner: NativeRunnerCheckpointOwner;
  allowExpiredOwner?: true;
  matchesExecution?: (previous: NativeExecutionInput, current: NativeExecutionInput) => boolean;
}): Promise<NativeGenericWarmAttachmentRecovery | null> {
  const { publication: proof, owner } = input;
  if (proof.schema !== "paperclip.native-generic-warm-attachment.v1" || !identity(proof.sourceIdentity)
    || !identity(proof.targetIdentity) || Buffer.byteLength(input.header) > 1024 * 1024
    || proof.headerSha256 !== preparationSha256(input.header)
    || !["preparing", "queued", "transition"].includes(proof.phase)
    || (proof.phase === "preparing" ? proof.commandPart !== null || proof.commandSha256 !== null
      : !/^command:[0-9]+$/.test(proof.commandPart ?? "") || !/^[0-9a-f]{64}$/.test(proof.commandSha256 ?? ""))
    || proof.sourceIdentity.runId === proof.targetIdentity.runId
    || !["runnerInstanceId", "environmentLeaseId", "normalizedSessionId"].every(key => proof.sourceIdentity[key as keyof DurableRecoveryIdentity] === proof.targetIdentity[key as keyof DurableRecoveryIdentity])
    || proof.bootId !== owner.bootId || proof.generation !== owner.generation || proof.leaseOwner !== owner.leaseOwner
    || owner.runId !== owner.authorityRunId || owner.runId !== input.currentRun.id
    || owner.companyId !== input.currentRun.companyId || owner.issueId !== input.currentRun.nativeIssueId) return null;
  const [owned] = await input.db.select({ run: runColumns }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId), eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId)))
    .innerJoin(issues, and(eq(issues.id, heartbeatRuns.nativeIssueId), eq(issues.companyId, heartbeatRuns.companyId),
      eq(issues.executionRunId, heartbeatRuns.id)))
    .where(and(eq(heartbeatRuns.id, owner.runId), eq(heartbeatRuns.companyId, owner.companyId),
      eq(nativeRunFinalizations.controllerBootId, owner.bootId), eq(nativeRunFinalizations.controllerGeneration, owner.generation),
      eq(nativeRunFinalizations.leaseOwner, owner.leaseOwner),
      input.allowExpiredOwner ? undefined : gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
      eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.resultId),
      isNull(nativeRunFinalizations.failureCode), boundedProfile)).limit(1);
  const current = owned?.run;
  if (!current || current.status !== "running" || current.runtimeMode !== "native" || current.finishedAt !== null
    || isNativeRunnerOwnershipHeld(current) || current.runnerProfileJson?.nativePreparationHandoffVersion !== 1
    || current.runnerInstanceId !== proof.targetIdentity.runnerInstanceId || current.nativeSessionId !== proof.targetIdentity.normalizedSessionId
    || current.id !== proof.targetIdentity.runId || current.runnerProfileJson?.nativePreparationHandoffSourceRunId !== proof.sourceIdentity.runId
    || ["pending", "acknowledged"].includes(record(record(current.resultJson).nativeCancellation).dispatchState)) return null;
  let execution: NativeExecutionInput;
  try { execution = parseNativeExecutionInput(current.runnerProfileJson?.nativeExecutionInput); } catch { return null; }
  if (execution.binding.companyId !== current.companyId || execution.binding.agentId !== current.agentId
    || execution.binding.issueId !== current.nativeIssueId || execution.binding.runId !== current.id
    || execution.session.normalizedSessionId !== current.nativeSessionId || execution.session.lifecyclePolicy?.mode !== "warm"
    || !["codex", "acpx", "opencode"].includes(execution.provider.kind)) return null;
  const [source] = await input.db.select({ run: runColumns, coordinator: { phase: nativeRunFinalizations.phase,
    leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    failureCode: nativeRunFinalizations.failureCode, recoveryState: nativeRunFinalizations.recoveryState },
    resultId: nativeRunResults.id, resultStatus: nativeRunResults.schemaStatus }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId), eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.runId, heartbeatRuns.id), eq(nativeRunResults.companyId, heartbeatRuns.companyId),
      eq(nativeRunResults.issueId, heartbeatRuns.nativeIssueId), eq(nativeRunResults.completionContractId, heartbeatRuns.completionContractId)))
    .where(and(eq(heartbeatRuns.id, proof.sourceIdentity.runId), eq(heartbeatRuns.companyId, current.companyId),
      eq(heartbeatRuns.agentId, current.agentId), eq(heartbeatRuns.nativeIssueId, current.nativeIssueId!), boundedProfile)).limit(1);
  if (!source || source.run.runtimeMode !== "native" || source.run.status !== "succeeded" || !source.run.finishedAt
    || source.run.createdAt >= current.createdAt || source.run.finishedAt > (current.startedAt ?? current.createdAt) || source.coordinator.phase !== "committed"
    || source.coordinator.leaseOwner !== null || source.coordinator.leaseExpiresAt !== null || source.coordinator.failureCode !== null
    || source.coordinator.recoveryState !== null || source.resultStatus !== "accepted"
    || source.run.runnerInstanceId !== current.runnerInstanceId || source.run.nativeSessionId !== current.nativeSessionId) return null;
  let previous: NativeExecutionInput;
  try { previous = parseNativeExecutionInput(source.run.runnerProfileJson?.nativeExecutionInput); } catch { return null; }
  if (input.matchesExecution && !input.matchesExecution(previous, execution)) return null;
  const checkpoint = rebindNativeSessionCheckpoint({ previousRun: source.run, currentExecution: execution, executionTargetKind: "remote" });
  if (!checkpoint) return null;
  const target = current.runnerProfileJson?.sessionCheckpoint as PersistedNativeSession | undefined;
  const targetIdentity = record(record(target).identity);
  if (target && (targetIdentity.runId !== current.id || targetIdentity.companyId !== current.companyId
    || targetIdentity.agentId !== current.agentId || targetIdentity.issueId !== current.nativeIssueId
    || targetIdentity.sessionId !== current.nativeSessionId || target.providerSessionId !== checkpoint.providerSessionId
    || !isDeepStrictEqual(target.providerIdentity, checkpoint.providerIdentity))) return null;
  const sourcePublication = await readNativeCheckpointPublicationIdentity(input.db, { companyId: current.companyId,
    issueId: current.nativeIssueId!, runId: source.run.id });
  if (!sourcePublication || !isDeepStrictEqual(sourcePublication.identity, proof.sourceIdentity)) return null;
  const artifact = JSON.parse(sourcePublication.header);
  if (artifact.runnerVersion !== proof.runnerVersion || artifact.runnerDigest !== proof.runnerDigest) return null;
  return { ...proof, sourceRun: source.run, currentRun: current, sourceExecution: previous, currentExecution: execution,
    checkpoint, targetCheckpoint: target ?? null };
}

export function inspectNativeGenericWarmAttachment(input: {
  recovery: NativeGenericWarmAttachmentRecovery;
  controlPlaneState: unknown;
  runnerState: unknown;
  now?: number;
}): ReturnType<typeof inspectWarmRunTransition> {
  const { recovery } = input;
  const proof = inspectWarmRunTransition({ controlPlaneState: input.controlPlaneState, runnerState: input.runnerState,
    expectedNewIdentity: recovery.targetIdentity, expectedRunnerVersion: recovery.runnerVersion,
    expectedRunnerDigest: recovery.runnerDigest, now: input.now });
  if (!proof || !isDeepStrictEqual(proof.receipt.oldIdentity, recovery.sourceIdentity)) return null;
  const state = record(input.controlPlaneState), command = record(state.warmTransition ?? state.completedWarmTransition).command
    ?? (Array.isArray(state.commands) ? state.commands.find((value: any) => value.type === "run.attach" && value.commandId === proof.receipt.commandId) : null);
  return command && recovery.commandSha256 === nativeSha256(commandWire(command)) ? proof : null;
}
