import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import type { StoryCheck, StoryRun } from "./everyday-observations.js";
import { pollUntil } from "./api.js";
import { validControllerOutageReceipt, type ControllerOutageReceipt } from "./controller-outage.js";
import { validControllerRecoveryReceipt } from "./controller-recovery-observer.js";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export interface RemoteRestartEvent {
  seq: number; sourceSeq: number; sourceEventId: string; eventType: string;
  sourceKind: "runner" | "control_plane"; turnId: string | null;
  toolExecutionId: string | null; toolCompleted: boolean; toolFailed: boolean;
  payloadSha256: string; sha256: string;
}
export interface RemoteRestartBoundary {
  identity: { runId: string; companyId: string; agentId: string; issueId: string;
    runnerInstanceId: string; nativeSessionId: string; processPid: number | null; processStartedAt: string | null;
    taskIdentitySha256?: string };
  lease: { id: string; environmentId: string; executionWorkspaceId: string | null; providerLeaseSha256: string };
  events: RemoteRestartEvent[];
}
export interface RemoteRestartEvidence {
  expectedReplacements?: number;
  replacements?: Array<{ before: RemoteRestartBoundary; after: RemoteRestartBoundary; outage: ControllerOutageReceipt }>;
  outage?: ControllerOutageReceipt;
  before?: RemoteRestartBoundary;
  after?: RemoteRestartBoundary;
  final?: { run: StoryRun; events: RemoteRestartEvent[]; operations: Row[];
    scheduledRetry: unknown; recoveryActions: Row[]; observedAt?: string };
}

export async function waitForRemoteRestartBoundary(input: {
  deadlineAt: number;
  load: () => Promise<{ run: StoryRun | undefined; boundary?: RemoteRestartBoundary }>;
}): Promise<RemoteRestartBoundary> {
  const observed = await pollUntil({
    label: "active remote native turn with completed tool receipt",
    deadlineAt: input.deadlineAt,
    load: input.load,
    accept: state => state.run?.status === "running" && state.boundary !== undefined,
    reject: state => !state.run || state.run.status !== "running"
      ? "Remote restart boundary unexercised: original run ended before fault injection" : undefined,
  });
  return observed.boundary!;
}

export function projectRemoteRestartRun(run: StoryRun): StoryRun {
  return { id: run.id, companyId: run.companyId, agentId: run.agentId, nativeIssueId: run.nativeIssueId,
    status: run.status, runtimeMode: run.runtimeMode, runnerInstanceId: run.runnerInstanceId, nativeSessionId: run.nativeSessionId,
    nativePhase: run.nativePhase === "committed" ? "committed" : null,
    resultJson: { finalizationPhase: run.resultJson?.finalizationPhase === "committed" ? "committed" : null,
      workspaceFinalizeStatus: run.resultJson?.workspaceFinalizeStatus === "succeeded" ? "succeeded" : null,
      nextAttemptAt: run.resultJson?.nextAttemptAt == null ? null : "scheduled",
      failureCode: run.resultJson?.failureCode == null ? null : "present" } };
}

/** Keep only receipt identities and hashes; never retain provider text or tool arguments. */
export function projectRemoteRestartEvents(run: StoryRun, rows: readonly Row[]): RemoteRestartEvent[] {
  const seen = new Set<string>();
  const cursors = new Map<string, number>();
  let lastSeq = 0;
  return rows.filter(row => record(row.payload).prpEvent !== undefined).map(row => {
    const event = record(record(row.payload).prpEvent);
    const source = event.sourceInstanceId;
    const runnerSource = event.sourceKind === "runner" && source === run.runnerInstanceId;
    const controllerSource = event.sourceKind === "control_plane" && source === `${run.runnerInstanceId}:control`
      && ["run.result.accepted", "run.terminal"].includes(String(event.eventType));
    if (row.companyId !== run.companyId || row.runId !== run.id || !isValidNativePrpEnvelope(event, row.protocolSchemaVersion)
      || event.runId !== run.id || event.normalizedSessionId !== run.nativeSessionId || event.eventType !== row.eventType
      || (!runnerSource && !controllerSource) || !id(source) || !id(event.sourceEventId)
      || !Number.isSafeInteger(row.seq) || Number(row.seq) <= lastSeq || !Number.isSafeInteger(event.sourceSeq)
      || Number(event.sourceSeq) <= (cursors.get(source) ?? 0) || seen.has(event.sourceEventId)
      || event.sourceEventId !== `${source}:${run.id}:${event.sourceSeq}`) {
      throw new Error("Remote restart has foreign, duplicate or invalid native receipts");
    }
    seen.add(event.sourceEventId); cursors.set(source, Number(event.sourceSeq)); lastSeq = Number(row.seq);
    const payload = record(event.payload);
    return { seq: lastSeq, sourceSeq: Number(event.sourceSeq), sourceEventId: event.sourceEventId,
      eventType: String(event.eventType), sourceKind: event.sourceKind as RemoteRestartEvent["sourceKind"],
      turnId: id(event.turnId) ? event.turnId : null,
      toolExecutionId: id(payload.executionId) ? payload.executionId : null,
      toolCompleted: event.eventType === "tool.execution.completed" && payload.status === "completed",
      toolFailed: event.eventType === "tool.execution.completed" && payload.status !== "completed",
      payloadSha256: digest(payload),
      sha256: digest(event) };
  });
}

export function observeRemoteRestartBoundary(run: StoryRun, rows: readonly Row[], leases: readonly Row[], scope: {
  companyId: string; agentId: string; issueId: string; environmentId: string;
}, recovered = false): RemoteRestartBoundary {
  if (run.companyId !== scope.companyId || run.agentId !== scope.agentId || run.nativeIssueId !== scope.issueId
    || !(run.status === "running" || (recovered && run.status === "succeeded"))
    || run.runtimeMode !== "native" || !id(run.id) || !id(run.runnerInstanceId) || !id(run.nativeSessionId)) {
    throw new Error("Remote restart boundary requires the original live native process");
  }
  const owned = leases.filter(lease => lease.companyId === scope.companyId && lease.environmentId === scope.environmentId
    && lease.issueId === scope.issueId && lease.heartbeatRunId === run.id
    && (lease.provider === "daytona" || lease.provider === "plugin" || String(lease.provider).startsWith("plugin:"))
    && ((lease.status === "active" && lease.releasedAt == null) || (recovered && run.status === "succeeded"))
    && id(lease.id) && id(lease.providerLeaseId));
  if (owned.length !== 1) throw new Error("Remote restart boundary requires one exact active sandbox lease");
  const lease = owned[0]!;
  const metadata = record(lease.metadata), task = record(metadata.runnerTaskIdentity);
  const plugin = lease.provider === "plugin" || String(lease.provider).startsWith("plugin:");
  if (plugin) {
    // The normal task authority clears dispatch only after provider status confirms
    // execution stopped. Completion during the outage must retain that proof.
    const settled = recovered && run.status === "succeeded"
      && metadata.runnerTaskDispatched === false && metadata.runnerTaskExecutionStopped === true;
    if (run.processPid != null || run.processStartedAt != null || (!settled && metadata.runnerTaskDispatched !== true)
      || task.runnerId !== run.runnerInstanceId || task.runId !== run.id || task.sessionId !== run.nativeSessionId
      || !id(task.leaseId) || !id(task.turnId) || !id(task.itemId)) {
      throw new Error("Remote restart requires the admitted plugin task identity, not the controller PID");
    }
  } else if (!Number.isSafeInteger(run.processPid) || Number(run.processPid) <= 0
    || !id(run.processStartedAt) || !Number.isFinite(Date.parse(run.processStartedAt))) {
    throw new Error("Remote restart boundary requires the original live native process");
  }
  const events = projectRemoteRestartEvents(run, rows);
  const starts = events.filter(event => event.eventType === "turn.started" && event.sourceKind === "runner");
  const completed = events.filter(event => event.toolCompleted && event.sourceKind === "runner" && event.toolExecutionId);
  if (starts.length !== 1 || !id(starts[0]!.turnId) || completed.length === 0
    || completed.some(event => event.turnId !== starts[0]!.turnId)
    || (!recovered && events.some(event => ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted", "run.terminal"].includes(event.eventType)))) {
    throw new Error("Remote restart boundary has no completed tool in an active original provider turn");
  }
  return {
    identity: { runId: run.id, companyId: scope.companyId, agentId: scope.agentId, issueId: scope.issueId,
      runnerInstanceId: run.runnerInstanceId, nativeSessionId: run.nativeSessionId,
      processPid: plugin ? null : Number(run.processPid), processStartedAt: plugin ? null : run.processStartedAt!,
      ...(plugin ? { taskIdentitySha256: digest({ runnerId: task.runnerId, leaseId: task.leaseId,
        runId: task.runId, sessionId: task.sessionId, turnId: task.turnId, itemId: task.itemId }) } : {}) },
    lease: { id: String(lease.id), environmentId: scope.environmentId,
      executionWorkspaceId: typeof lease.executionWorkspaceId === "string" ? lease.executionWorkspaceId : null,
      providerLeaseSha256: digest(lease.providerLeaseId) },
    events,
  };
}

function retainsPrefix(before: readonly RemoteRestartEvent[], after: readonly RemoteRestartEvent[]): boolean {
  return before.length > 0 && after.length >= before.length && before.every((event, index) => digest(event) === digest(after[index]));
}

export function gradeRemoteRestart(evidence: RemoteRestartEvidence | undefined): StoryCheck[] {
  const { before, after, final } = evidence ?? {};
  const check = (id: string, passed: boolean, detail: string) => ({ id, passed, detail });
  const sameIdentity = Boolean(before && after && digest(before.identity) === digest(after.identity)
    && digest(before.lease) === digest(after.lease) && retainsPrefix(before.events, after.events));
  const run = final?.run;
  const identity = before?.identity;
  const finalIdentity = Boolean(identity && run && run.id === identity.runId && run.companyId === identity.companyId
    && run.agentId === identity.agentId && run.nativeIssueId === identity.issueId && run.runtimeMode === "native"
    && run.runnerInstanceId === identity.runnerInstanceId && run.nativeSessionId === identity.nativeSessionId);
  const events = final?.events ?? [];
  const turnId = before?.events.find(event => event.eventType === "turn.started")?.turnId;
  const once = (kind: string, source: RemoteRestartEvent["sourceKind"]) => events.filter(event => event.eventType === kind && event.sourceKind === source).length === 1;
  // Reattachment can redeliver an already-observed activity notification. Its
  // stable identity and exact payload must agree; a new submission, changed
  // result or failed tool is not receipt replay and must never pass this cell.
  const starts = events.filter(event => event.eventType === "turn.started" && event.sourceKind === "runner");
  const tools = events.filter(event => event.toolCompleted);
  const toolResults = new Map<string, string>();
  let consistentToolResults = true;
  for (const event of tools) {
    if (!event.toolExecutionId || (toolResults.has(event.toolExecutionId) && toolResults.get(event.toolExecutionId) !== event.payloadSha256)) consistentToolResults = false;
    else toolResults.set(event.toolExecutionId, event.payloadSha256);
  }
  const nativeCompletion = finalIdentity && Boolean(before && after && retainsPrefix(after.events, events))
    && once("turn.submitted", "runner") && starts.length > 0 && new Set(starts.map(event => event.payloadSha256)).size === 1
    && once("turn.completed", "runner")
    && once("run.result.accepted", "control_plane") && once("run.terminal", "control_plane")
    && events.filter(event => event.eventType.startsWith("turn.")).every(event => event.turnId === turnId || (event.eventType === "turn.submitted" && event.turnId === null))
    && consistentToolResults && !events.some(event => event.toolFailed);
  const operations = final?.operations ?? [];
  const saved = finalIdentity && run?.status === "succeeded" && run.nativePhase === "committed"
    && run.resultJson?.finalizationPhase === "committed" && run.resultJson.workspaceFinalizeStatus === "succeeded"
    && run.resultJson.nextAttemptAt == null && run.resultJson.failureCode == null
    && operations.some(operation => operation.companyId === identity?.companyId && operation.heartbeatRunId === identity?.runId
      && operation.issueId === identity?.issueId && operation.phase === "workspace_finalize" && operation.status === "succeeded"
      && operation.executionWorkspaceId === before?.lease.executionWorkspaceId)
    && !operations.some(operation => ["pending", "queued", "running"].includes(String(operation.status)))
    && final?.scheduledRetry == null && !final?.recoveryActions.some(action => ["active", "pending"].includes(String(action.status)));
  const expectedReplacements = evidence?.expectedReplacements ?? 1;
  const replacements = evidence?.replacements;
  const allReplacements = replacements === undefined ? expectedReplacements === 1
    : replacements.length === expectedReplacements && replacements.every((step, index, all) => {
      const previous = all[index - 1];
      const preservesIdentity = digest(step.before.identity) === digest(step.after.identity)
        && digest(step.before.lease) === digest(step.after.lease)
        && retainsPrefix(step.before.events, step.after.events);
      const authenticated = validControllerOutageReceipt(step.outage) && validControllerRecoveryReceipt(step.outage)
        && step.outage.recovery?.binding.runId === step.before.identity.runId
        && step.outage.recovery.binding.companyId === step.before.identity.companyId
        && step.outage.recovery.binding.issueId === step.before.identity.issueId
        && step.outage.recovery.runnerInstanceId === step.before.identity.runnerInstanceId
        && step.outage.recovery.nativeSessionId === step.before.identity.nativeSessionId;
      const artifactsPresent = expectedReplacements <= 1 || Boolean(step.outage.previousArtifact && step.outage.replacementArtifact);
      const chained = !previous || (retainsPrefix(previous.after.events, step.before.events)
        && (!step.outage.previousArtifact || Boolean(previous.outage.replacementArtifact
          && digest(previous.outage.replacementArtifact) === digest(step.outage.previousArtifact))));
      return preservesIdentity && authenticated && artifactsPresent && chained;
    });
  return [
    check("remote-restart-same-execution-and-lease", sameIdentity, "The original run, native session, admitted runner identity and sandbox lease survive replacement."),
    check("remote-restart-native-completion-once", nativeCompletion, "The original provider turn completes once and retains its native receipt prefix."),
    check("remote-restart-files-finalized", Boolean(saved), "The original run commits its workspace receipt and leaves no active operation or recovery."),
    check("remote-restart-fault-exercised", validControllerOutageReceipt(evidence?.outage), "The main server exited, its cache was retired, and a distinct replacement became ready after the requested outage."),
    check("remote-restart-authenticated-recovery", validControllerRecoveryReceipt(evidence?.outage)
      && evidence?.outage?.recovery?.binding.runId === identity?.runId
      && evidence?.outage?.recovery?.runnerInstanceId === identity?.runnerInstanceId
      && evidence?.outage?.recovery?.nativeSessionId === identity?.nativeSessionId,
    "Natural ownership acquisition and new authenticated runner receipts were observed within the original 420-second grace."),
    check("remote-restart-backlog-settled", Boolean(saved && nativeCompletion && final?.observedAt
      && Date.parse(final.observedAt) >= Date.parse(evidence?.outage?.startedAt ?? "") + (evidence?.outage?.recovery?.resumedProcessingObservedAfterMs ?? Infinity)),
    "Canonical terminal and workspace receipts settle the original backlog after reattachment."),
    check("remote-restart-all-replacements", allReplacements,
      "Every requested upgrade and rollback exercised the original running execution and retained its receipts."),
  ];
}
