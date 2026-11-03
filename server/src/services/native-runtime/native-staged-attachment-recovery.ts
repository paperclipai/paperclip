import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import {
  inspectDurablePrpCheckpointHeader,
  inspectStagedRunAttachmentHeader,
  parseNativeExecutionInput,
  type DurableRecoveryIdentity,
  type NativeExecutionInput,
  type PersistedNativeSession,
  type StagedRunAttachment,
} from "../../vendor/paperclip-runner/index.js";
import { loadNativeRunnerCheckpointHeader } from "./native-runner-checkpoint.js";
import { rebindNativeSessionCheckpoint } from "./native-session-resume.js";

type FrozenRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "nativeIssueId" | "nativeSessionId" | "runnerInstanceId" |
  "runtimeMode" | "status" | "runnerProfileJson" | "finishedAt">;

type StagedHeaderProof = NonNullable<ReturnType<typeof inspectStagedRunAttachmentHeader>>;
export type NativeStagedAttachmentRecovery = Omit<StagedRunAttachment, "runAttachTemplate"> &
  Pick<StagedHeaderProof, "protocolIdentity" | "phase" | "receipt"> & {
  sourceRun: FrozenRun;
  sourceExecution: NativeExecutionInput;
  currentExecution: NativeExecutionInput;
  /** In-memory input only. It is not a published/resumable target snapshot. */
  checkpoint: PersistedNativeSession;
  /** A published target snapshot takes precedence over the source rebound. */
  hasTargetCheckpoint: boolean;
  targetCheckpoint: PersistedNativeSession | null;
  runnerVersion: string;
  runnerDigest: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function boundTargetCheckpoint(run: FrozenRun, source: PersistedNativeSession): PersistedNativeSession | null {
  const snapshot = record(run.runnerProfileJson?.sessionCheckpoint), identity = record(snapshot.identity);
  if (typeof snapshot.sessionId !== "string" || !snapshot.sessionId || identity.runId !== run.id ||
    identity.companyId !== run.companyId || identity.issueId !== run.nativeIssueId || identity.agentId !== run.agentId ||
    identity.sessionId !== run.nativeSessionId) return null;
  // A target checkpoint may advance cursor/goal/tool progress, but cannot change
  // the provider session retained by this attachment. Do not rebound it again.
  if ((source.providerSessionId != null && source.providerSessionId !== snapshot.providerSessionId) ||
    (source.providerIdentity != null && !isDeepStrictEqual(source.providerIdentity, snapshot.providerIdentity))) return null;
  return structuredClone(snapshot) as unknown as PersistedNativeSession;
}

function frozenExecution(run: FrozenRun): NativeExecutionInput | null {
  try {
    const execution = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput);
    return run.runtimeMode === "native" && execution.binding.runId === run.id &&
      execution.binding.companyId === run.companyId && execution.binding.agentId === run.agentId &&
      execution.binding.issueId === run.nativeIssueId && execution.session.normalizedSessionId === run.nativeSessionId
      ? execution : null;
  } catch { return null; }
}

function matchesRun(identity: DurableRecoveryIdentity, run: FrozenRun): boolean {
  return identity.runId === run.id && identity.runnerInstanceId === run.runnerInstanceId &&
    identity.normalizedSessionId === run.nativeSessionId;
}

/** Staging proves which prior attachment may be inspected, not that it is alive
 * or that work may be dispatched. Classification reads only two indexed point
 * lookups: the named source/result and its encrypted header. The executor must
 * re-read this proof with its private scope/config matcher before any RPC, then
 * independently prove the physical Runner and authenticate the target tuple. */
export async function resolveNativeStagedAttachmentRecovery(input: {
  db: Pick<Db, "select">;
  currentRun: FrozenRun;
  header: string;
  expectedTarget?: DurableRecoveryIdentity;
  matchesExecution?: (previous: NativeExecutionInput, current: NativeExecutionInput) => boolean;
}): Promise<NativeStagedAttachmentRecovery | null> {
  const proof = inspectStagedRunAttachmentHeader(input.header);
  const current = frozenExecution(input.currentRun);
  if (!proof || !current || current.provider.kind !== "codex" || !["running", "failed"].includes(input.currentRun.status) ||
    !matchesRun(proof.attachment.targetIdentity, input.currentRun) ||
    (input.expectedTarget && !isDeepStrictEqual(proof.attachment.targetIdentity, input.expectedTarget))) return null;
  const { attachment } = proof;
  const [source] = await input.db.select({ run: heartbeatRuns, coordinator: nativeRunFinalizations,
    resultId: nativeRunResults.id, resultStatus: nativeRunResults.schemaStatus }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId), eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.runId, heartbeatRuns.id), eq(nativeRunResults.companyId, heartbeatRuns.companyId),
      eq(nativeRunResults.issueId, heartbeatRuns.nativeIssueId)))
    .where(and(eq(heartbeatRuns.id, attachment.sourceIdentity.runId), eq(heartbeatRuns.companyId, input.currentRun.companyId),
      eq(heartbeatRuns.agentId, input.currentRun.agentId), eq(heartbeatRuns.nativeIssueId, current.binding.issueId)))
    .limit(1);
  if (!source || source.run.companyId !== current.binding.companyId || source.run.agentId !== current.binding.agentId ||
    source.run.nativeIssueId !== current.binding.issueId || !matchesRun(attachment.sourceIdentity, source.run) ||
    source.run.status !== "succeeded" || source.run.finishedAt === null || source.coordinator.phase !== "committed" ||
    source.coordinator.companyId !== current.binding.companyId || source.coordinator.issueId !== current.binding.issueId ||
    source.coordinator.runId !== source.run.id || !source.coordinator.resultId ||
    source.coordinator.resultId !== source.resultId || source.resultStatus !== "accepted" ||
    source.coordinator.leaseOwner !== null || source.coordinator.leaseExpiresAt !== null) return null;
  const previous = frozenExecution(source.run);
  if (!previous || (input.matchesExecution && !input.matchesExecution(previous, current))) return null;
  // Reuse the existing provider, tool-contract, workspace, runtime-context and
  // normalized-session compatibility owner; no second set of digest formulas.
  const checkpoint = rebindNativeSessionCheckpoint({ previousRun: source.run, currentExecution: current, executionTargetKind: "remote" });
  if (!checkpoint || !(typeof checkpoint.providerSessionId === "string" && checkpoint.providerSessionId.length > 0 ||
    checkpoint.providerIdentity && Object.keys(checkpoint.providerIdentity).length > 0)) return null;
  const hasTargetCheckpoint = input.currentRun.runnerProfileJson?.sessionCheckpoint != null;
  const targetCheckpoint = hasTargetCheckpoint ? boundTargetCheckpoint(input.currentRun, checkpoint) : null;
  if (hasTargetCheckpoint && !targetCheckpoint) return null;
  const sourceHeader = await loadNativeRunnerCheckpointHeader(input.db, {
    companyId: source.run.companyId, issueId: current.binding.issueId, runId: source.run.id,
  });
  if (!sourceHeader || !isDeepStrictEqual(inspectDurablePrpCheckpointHeader(sourceHeader), attachment.sourceIdentity)) return null;
  // The codec above has validated this bounded header's artifact fields. A
  // staged target cannot silently select different bytes from its source.
  const sourceArtifact = JSON.parse(sourceHeader) as { runnerVersion: string; runnerDigest: string };
  if (sourceArtifact.runnerVersion !== proof.runnerVersion || sourceArtifact.runnerDigest !== proof.runnerDigest) return null;
  return { ...attachment, sourceRun: source.run, sourceExecution: previous, currentExecution: current,
    checkpoint, hasTargetCheckpoint, targetCheckpoint,
    protocolIdentity: proof.protocolIdentity, phase: proof.phase, receipt: proof.receipt,
    runnerVersion: proof.runnerVersion, runnerDigest: proof.runnerDigest };
}
