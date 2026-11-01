import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { isDeepStrictEqual } from "node:util";
import type { ConnectionApi } from "./connection-target.js";
import { connectionDelay } from "./connection-target.js";
import { observeRunProcesses, retainRunProcessIdentity } from "./copilot-local-fixtures.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import { collectRunEvents } from "./run-observations.js";
import type { Matcher } from "./types.js";

type Row = Record<string, any>;
const rec = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const requireProof = (condition: unknown, code: string) => { if (!condition) throw new Error(`antigravity_evidence_${code}`); };
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const eventId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x20\x7f]/u.test(value);

export const antigravityJourneyCheckpoints = ["target", "dependencies", "ordinary_picker", "saved_subscription", "exact_model", "setup_probe", "agent_ready", "clean_composer", "instructions_saved", "first_run", "first_artifact", "followup_run", "followup_artifact", "persisted"] as const;
export interface AntigravityPrimaryOwner {
  runId: string; pid: number; groupId: number; startedAt: string; commandSha256: string; perTurnArgvVerified: true;
}
export function validAntigravityPrimaryOwner(value: unknown): value is AntigravityPrimaryOwner {
  const owner = rec(value);
  return Object.keys(owner).length === 6 && Object.keys(owner).every(key => ["runId", "pid", "groupId", "startedAt", "commandSha256", "perTurnArgvVerified"].includes(key))
    && id(owner.runId) && Number.isSafeInteger(owner.pid) && owner.pid > 1 && owner.groupId === owner.pid
    && typeof owner.startedAt === "string" && Number.isFinite(Date.parse(owner.startedAt))
    && /^[a-f0-9]{64}$/u.test(owner.commandSha256) && owner.perTurnArgvVerified === true;
}
/** Capture only a primary whose live argv and OS birth were independently bound
 * by the process observer to this exact run and per_turn lifecycle. */
export function antigravityPrimaryOwner(run: Row, observation: ReturnType<ReturnType<typeof observeRunProcesses>["sample"]>): AntigravityPrimaryOwner | undefined {
  const check = observation.authorityCheck;
  if (!check?.accepted) return;
  requireProof(observation.captured && Number.isFinite(Date.parse(check.observed.start)), "primary_owner_birth");
  // The shared live observer emits a tagged digest. Normalize only that exact
  // producer format into the retained witness's bare SHA-256 field.
  requireProof(/^sha256:[a-f0-9]{64}$/u.test(check.commandSha256), "primary_owner_command_digest");
  const owner: AntigravityPrimaryOwner = { runId: check.authority.runId, pid: check.observed.pid, groupId: check.authority.groupId,
    startedAt: new Date(Date.parse(check.observed.start)).toISOString(), commandSha256: check.commandSha256.slice("sha256:".length), perTurnArgvVerified: true };
  requireProof(validAntigravityPrimaryOwner(owner) && owner.runId === run.id && owner.pid === run.processPid && check.authority.pid === owner.pid
    && Date.parse(check.authority.startedAt) === Date.parse(owner.startedAt)
    && owner.groupId === run.processGroupId && Date.parse(owner.startedAt) === Date.parse(run.processStartedAt)
    && observation.journal.some(process => process.pid === owner.pid && Date.parse(process.start) === Date.parse(owner.startedAt)), "primary_owner_binding");
  return owner;
}
export interface AntigravityJourneyTurnEvidence {
  runId: string; companyId: string; agentId: string; issueId: string; connectionId: string; environmentId: string;
  nativeSessionId: string; runnerInstanceId: string; model: string;
  conversation: { kind: "acpx"; acpxRecordId: string; agentSessionId: string; backendSessionId: string; normalizedSessionId: string;
    requestedModel: string; effectiveModel: string; permissionMode: string; workspaceDigest: string; profileDigest: string };
  artifact: { attachmentId: string; filename: string; sha256: string; byteSize: number; base64: string };
  finalization: { phase: "committed"; decision: "done"; assessmentId: string; decisionId: string; observedAt: string;
    acceptedEventSeq: number; terminalEventSeq: number; nativeResultSha256: string };
  toolLifecycle: { completedFileOperations: number; failedFileOperations: number; failedFinishOperations: number };
  retirement: { captured: boolean; observedProcessCount: number; remainingProcessCount: number; identityChanged: boolean;
    primaryOwner: AntigravityPrimaryOwner; nativeFencesReacquired: boolean; nativeFenceCount: number; leaseId: string; leaseStatus: string };
}
export interface AntigravityJourneyEvidence {
  version: 1; setupId: string; hosting: "self-hosted"; targetCommit: string | null;
  phase: string; outcome: "running" | "passed" | "failed" | "awaiting_user" | "missing_credential" | "blocked_target";
  assisted: boolean; privacy: "private"; authentication: "saved-subscription"; model: string;
  companyId?: string; agentId?: string; connectionId?: string;
  checkpoints: Partial<Record<typeof antigravityJourneyCheckpoints[number], boolean>>;
  turnEvidence: AntigravityJourneyTurnEvidence[];
  cleanup: { agent: boolean; runs: boolean; connectionPreserved: boolean };
}
interface TurnScope {
  companyId: string; agentId: string; issueId: string; connectionId: string; environmentId: string;
  model: string; expectedProfileDigest: string; expectedBytes: Buffer; afterRunIds: readonly string[];
}

/** Grade actual public objects and downloaded bytes, never an agent's summary.
 * Capture this before reopening the task: finalizer coordinator pointers are mutable. */
export function gradeAntigravityJourneyTurn(input: TurnScope & {
  run: Row; issue: Row; attachment: Row; downloadedBytes: Buffer; events: Row[]; lease: Row;
  retirement: Omit<AntigravityJourneyTurnEvidence["retirement"], "leaseId" | "leaseStatus">;
}): AntigravityJourneyTurnEvidence {
  const r = input.run, result = rec(r.resultJson), profile = rec(r.runnerProfileJson), checkpoint = rec(profile.sessionCheckpoint);
  const native = rec(profile.nativeExecutionInput), provider = rec(native.provider), binding = rec(native.binding);
  const connection = rec(rec(r.contextSnapshot).aiConnection), environment = rec(rec(r.contextSnapshot).paperclipEnvironment);
  const identity = rec(checkpoint.providerIdentity), a = input.attachment;
  requireProof(id(r.id) && !input.afterRunIds.includes(r.id) && r.companyId === input.companyId && r.agentId === input.agentId
    && r.issueId === input.issueId && r.status === "succeeded" && r.runtimeMode === "native"
    && r.driverKind === "acpx_runtime" && id(r.nativeSessionId) && id(r.runnerInstanceId) && r.costAccountingPending === false, "run_binding");
  requireProof(binding.runId === r.id && binding.companyId === input.companyId && binding.agentId === input.agentId && binding.issueId === input.issueId
    && profile.backend === "acpx_runtime" && provider.kind === "acpx" && provider.agent === "antigravity" && provider.model === input.model
    && environment.id === input.environmentId && environment.driver === "local" && connection.provider === "google"
    && connection.method === "subscription" && connection.connectionId === input.connectionId, "selected_provider");
  requireProof(identity.kind === "acpx" && id(identity.acpxRecordId) && id(identity.agentSessionId) && id(identity.backendSessionId)
    && identity.agentSessionId === identity.backendSessionId && identity.normalizedSessionId === r.nativeSessionId
    && identity.requestedModel === input.model && identity.effectiveModel === input.model
    && identity.profileDigest === input.expectedProfileDigest && identity.profileDigest === rec(provider.profile).commandDigest && /^sha256:[a-f0-9]{64}$/u.test(identity.profileDigest)
    && /^sha256:[a-f0-9]{64}$/u.test(identity.workspaceDigest) && identity.permissionMode === "approve-all", "native_identity");
  requireProof(input.issue.id === input.issueId && input.issue.companyId === input.companyId && input.issue.assigneeAgentId === input.agentId
    && input.issue.status === "done" && result.finalizationPhase === "committed" && result.authoritativeDecision === "done"
    && result.issueStatusAfter === "done" && result.workspaceFinalizeStatus === "succeeded" && id(result.assessmentId) && id(result.decisionId)
    && rec(result.nativeResult).schema === "paperclip.run_result.v1" && rec(result.nativeTerminal).runTerminalState === "succeeded", "committed_done");
  const expectedSha = hash(input.expectedBytes);
  requireProof(input.expectedBytes.length > 0 && input.expectedBytes.length <= 4096 && id(a.id) && a.companyId === input.companyId
    && a.issueId === input.issueId && a.createdByAgentId === input.agentId && a.originatingRunId === r.id
    && a.originalFilename === "antigravity-proof.txt" && a.contentType === "text/plain" && a.byteSize === input.expectedBytes.length
    && a.sha256 === expectedSha && input.downloadedBytes.equals(input.expectedBytes), "exact_download");
  const registrations = Object.values(rec(result.semanticToolReceipts)).map(rec).filter(receipt => receipt.operationId === "register_deliverable"
    && rec(receipt.result).attachmentId === a.id);
  requireProof(registrations.length === 1 && rec(registrations[0]!.result).disposition === "applied"
    && rec(registrations[0]!.input).filename === a.originalFilename && rec(registrations[0]!.input).byteSize === a.byteSize
    && rec(registrations[0]!.input).sha256 === a.sha256, "registered_delivery");
  requireProof(input.events.length > 0 && input.events.length <= 20_000, "bounded_events");
  const seen = new Set<string>(), sourceSequences = new Map<string, number>(); let lastSeq = 0;
  const tools: Array<{ event: Row; payload: Row; seq: number }> = [];
  const accepted: Array<{ event: Row; seq: number }> = [], terminals: Array<{ event: Row; seq: number }> = [];
  for (const row of input.events) {
    const event = rec(rec(row.payload).prpEvent);
    if (!Object.keys(event).length) continue;
    requireProof(row.companyId === input.companyId && row.runId === r.id && event.runId === r.id
      && isValidNativePrpEnvelope(event, row.protocolSchemaVersion) && row.eventType === event.eventType
      && Number.isSafeInteger(row.seq) && row.seq > lastSeq && eventId(event.sourceEventId) && !seen.has(event.sourceEventId)
      && row.sourceEventId === event.sourceEventId && row.sourceInstanceId === event.sourceInstanceId
      && row.sourceSeq === event.sourceSeq && Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > (sourceSequences.get(event.sourceInstanceId) ?? 0)
      && ((event.sourceKind === "runner" && event.sourceInstanceId === r.runnerInstanceId)
        || (event.sourceKind === "control_plane" && event.sourceInstanceId === `${r.runnerInstanceId}:control`))
      && event.normalizedSessionId === r.nativeSessionId, "event_binding");
    lastSeq = row.seq; seen.add(event.sourceEventId); sourceSequences.set(event.sourceInstanceId, event.sourceSeq);
    if (event.eventType === "run.result.accepted") accepted.push({ event, seq: row.seq });
    if (event.eventType === "run.terminal") terminals.push({ event, seq: row.seq });
    if (event.eventType.startsWith("tool.execution.")) tools.push({ event, payload: rec(event.payload), seq: row.seq });
  }
  const fileTools = tools.filter(t => t.event.eventType === "tool.execution.completed" && ["read", "edit", "write"].includes(t.payload.operation) && t.payload.target === "antigravity-proof.txt");
  requireProof(fileTools.length > 0 && fileTools.every(t => t.event.sourceKind === "runner" && t.event.sourceInstanceId === r.runnerInstanceId
    && t.event.normalizedSessionId === r.nativeSessionId && t.payload.status === "completed"), "file_tool_lifecycle");
  requireProof(fileTools.some(t => t.payload.operation === "read") && fileTools.some(t => ["edit", "write"].includes(t.payload.operation)), "actual_read_and_write");
  const edits = fileTools.filter(t => ["edit", "write"].includes(t.payload.operation)), reads = fileTools.filter(t => t.payload.operation === "read");
  requireProof(reads.some(t => t.seq > edits.at(-1)!.seq) && (!input.afterRunIds.length || reads.some(t => t.seq < edits[0]!.seq)), "file_read_order");
  for (const terminal of fileTools) {
    const correlated = tools.filter(t => t.payload.executionId === terminal.payload.executionId);
    const starts = correlated.filter(t => t.event.eventType === "tool.execution.started");
    requireProof(id(terminal.payload.executionId) && starts.length === 1 && starts[0]!.seq < terminal.seq
      && correlated.filter(t => t.event.eventType === "tool.execution.completed").length === 1
      && correlated.every(t => t.event.sourceInstanceId === terminal.event.sourceInstanceId && t.event.normalizedSessionId === terminal.event.normalizedSessionId
        && t.event.turnId === terminal.event.turnId && t.payload.operation === terminal.payload.operation && t.payload.target === terminal.payload.target
        && t.seq >= starts[0]!.seq && t.seq <= terminal.seq && t.payload.status === (t === terminal ? "completed" : "running")), "correlated_file_lifecycle");
  }
  requireProof(accepted.length === 1 && terminals.length === 1 && accepted[0]!.seq > fileTools.at(-1)!.seq && terminals[0]!.seq > accepted[0]!.seq
    && [...accepted, ...terminals].every(({ event }) => event.sourceKind === "control_plane" && event.sourceInstanceId === `${r.runnerInstanceId}:control`
      && event.normalizedSessionId === r.nativeSessionId && id(event.turnId))
    && accepted[0]!.event.turnId === terminals[0]!.event.turnId
    && fileTools.every(t => t.event.turnId === accepted[0]!.event.turnId)
    && isDeepStrictEqual(rec(accepted[0]!.event.payload).result, result.nativeResult)
    && rec(terminals[0]!.event.payload).runTerminalState === "succeeded" && rec(terminals[0]!.event.payload).turnTerminalState === "completed"
    && rec(terminals[0]!.event.payload).reportedWorkDisposition === "done", "accepted_native_result");
  const lease = input.lease;
  requireProof(id(lease.id) && lease.id === environment.leaseId && lease.companyId === input.companyId && lease.environmentId === input.environmentId
    && lease.heartbeatRunId === r.id && lease.status === "released" && Boolean(lease.releasedAt), "lease_retirement");
  const retirement = input.retirement;
  requireProof(retirement.captured && retirement.observedProcessCount >= 2 && retirement.remainingProcessCount === 0
    && !retirement.identityChanged && retirement.nativeFencesReacquired && retirement.nativeFenceCount === 3
    && validAntigravityPrimaryOwner(retirement.primaryOwner) && retirement.primaryOwner.runId === r.id
    && retirement.primaryOwner.pid === r.processPid && retirement.primaryOwner.groupId === r.processGroupId
    && Date.parse(retirement.primaryOwner.startedAt) === Date.parse(r.processStartedAt), "physical_retirement");
  const conversation = { kind: "acpx" as const, acpxRecordId: identity.acpxRecordId, agentSessionId: identity.agentSessionId,
    backendSessionId: identity.backendSessionId, normalizedSessionId: identity.normalizedSessionId,
    requestedModel: identity.requestedModel, effectiveModel: identity.effectiveModel, permissionMode: identity.permissionMode,
    workspaceDigest: identity.workspaceDigest, profileDigest: identity.profileDigest };
  return { runId: r.id, companyId: input.companyId, agentId: input.agentId, issueId: input.issueId, connectionId: input.connectionId,
    environmentId: input.environmentId, nativeSessionId: r.nativeSessionId, runnerInstanceId: r.runnerInstanceId, model: input.model, conversation,
    artifact: { attachmentId: a.id, filename: a.originalFilename, sha256: expectedSha, byteSize: input.downloadedBytes.length, base64: input.downloadedBytes.toString("base64") },
    finalization: { phase: "committed", decision: "done", assessmentId: result.assessmentId, decisionId: result.decisionId, observedAt: new Date().toISOString(),
      acceptedEventSeq: accepted[0]!.seq, terminalEventSeq: terminals[0]!.seq, nativeResultSha256: hash(JSON.stringify(result.nativeResult)) },
    toolLifecycle: { completedFileOperations: fileTools.length, failedFileOperations: 0,
      failedFinishOperations: tools.filter(t => t.event.eventType === "tool.execution.completed" && /(?:^|_)paperclip_finish$/u.test(t.payload.name) && t.payload.status === "failed").length },
    retirement: { ...retirement, leaseId: lease.id, leaseStatus: lease.status } };
}

/** Exact same tagged conversation, with a fresh physical Runner per turn. */
export function sameAntigravityConversation(first: AntigravityJourneyTurnEvidence, followup: AntigravityJourneyTurnEvidence) {
  const left = first.retirement.primaryOwner, right = followup.retirement.primaryOwner;
  return first.runId !== followup.runId && validAntigravityPrimaryOwner(left) && validAntigravityPrimaryOwner(right)
    && left.runId === first.runId && right.runId === followup.runId
    && (left.pid !== right.pid || Date.parse(left.startedAt) !== Date.parse(right.startedAt))
    && Date.parse(right.startedAt) > Date.parse(left.startedAt)
    && ["companyId", "agentId", "issueId", "connectionId", "environmentId", "model", "nativeSessionId"].every(key => first[key as keyof typeof first] === followup[key as keyof typeof followup])
    && Object.keys(first.conversation).every(key => first.conversation[key as keyof typeof first.conversation] === followup.conversation[key as keyof typeof followup.conversation]);
}

/** Reacquire all three production lifetime fences together, then release them.
 * Valid only for the declared same-host loopback target; never probe a remote host. */
export async function reacquireAntigravityNativeFences(value: unknown) {
  requireProof(Array.isArray(value) && value.length === 3 && new Set(value).size === 3
    && value.every(p => Number.isSafeInteger(p) && p >= 49152 && p <= 65535), "native_fence_identity");
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    for (const port of value as number[]) {
      const server = createServer(); servers.push(server);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve()); });
    }
    return true;
  } finally {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
    })));
  }
}

/** /issues/:id/runs is an activity summary, whose public identity is runId.
 * Fetch the full row separately before observing any host process. */
export function selectAntigravityIssueRun(summaries: unknown, agentId: string, afterRunIds: readonly string[]): string | null {
  requireProof(Array.isArray(summaries) && summaries.length <= 100, "issue_run_summaries");
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const value of summaries as unknown[]) {
    const summary = rec(value);
    requireProof(id(summary.runId) && summary.agentId === agentId && !seen.has(summary.runId)
      && (summary.id === undefined || summary.id === summary.runId), "issue_run_summary_binding");
    seen.add(summary.runId);
    if (!afterRunIds.includes(summary.runId)) selected.push(summary.runId);
  }
  requireProof(selected.length <= 1, "extra_provider_run");
  return selected[0] ?? null;
}

export async function verifyAntigravityJourneyTurn(input: TurnScope & {
  api: ConnectionApi; deadlineAt: number; observeRun?: (run: Row) => Promise<void>; assertActive?: () => void;
}): Promise<AntigravityJourneyTurnEvidence> {
  requireProof(process.platform === "darwin" && process.arch === "arm64" && new URL(input.api.origin).hostname === "127.0.0.1", "same_host_target_required");
  const observer = observeRunProcesses();
  let processes: ReturnType<typeof observer.sample> | undefined;
  while (Date.now() < input.deadlineAt) {
    input.assertActive?.();
    const summaries = await input.api.get<unknown>(`/api/issues/${input.issueId}/runs`);
    const selected = selectAntigravityIssueRun(summaries, input.agentId, input.afterRunIds);
    if (selected) {
      const run = await input.api.get<Row>(`/api/heartbeat-runs/${selected}`);
      requireProof(run.id === selected && run.companyId === input.companyId && run.agentId === input.agentId && run.issueId === input.issueId, "observed_run_binding");
      if (input.observeRun) await input.observeRun(run);
      const sampled = observer.sample(run.processPid ? { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id } : undefined);
      processes = processes ? retainRunProcessIdentity(processes, sampled) : sampled;
      requireProof(!["failed", "cancelled", "interrupted", "timed_out"].includes(run.status), "terminal_run_failure");
      if (run.status === "succeeded" && run.costAccountingPending === false && rec(run.resultJson).finalizationPhase === "committed") {
        const issue = await input.api.get<Row>(`/api/issues/${input.issueId}`);
        const attachments = await input.api.get<Row[]>(`/api/issues/${input.issueId}/attachments`);
        const matching = attachments.filter(a => a.originatingRunId === run.id && a.originalFilename === "antigravity-proof.txt");
        const leaseId = rec(rec(run.contextSnapshot).paperclipEnvironment).leaseId;
        requireProof(id(leaseId), "lease_identity");
        const lease = await input.api.get<Row>(`/api/environment-leases/${leaseId}`);
        if (issue.status === "done" && lease.status === "released" && processes.live.length === 0) {
          input.assertActive?.();
          requireProof(matching.length === 1 && id(matching[0]!.id) && matching[0]!.byteSize <= 4096, "attachment_selection");
          const downloadedBytes = await input.api.bytes(`/api/attachments/${matching[0]!.id}/content`);
          const events = await collectRunEvents<Row>((afterSeq, limit) => input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
          const fences = rec(rec(rec(run.runnerProfileJson).sessionCheckpoint).providerIdentity).providerLifetimeFenceCandidates;
          const nativeFencesReacquired = await reacquireAntigravityNativeFences(fences);
          const primaryOwner = antigravityPrimaryOwner(run, processes);
          requireProof(primaryOwner, "primary_owner_missing");
          return gradeAntigravityJourneyTurn({ ...input, run, issue, attachment: matching[0]!, downloadedBytes, events, lease,
            retirement: { captured: processes.captured, observedProcessCount: processes.journal.length, remainingProcessCount: processes.live.length,
              identityChanged: processes.identityChanged, primaryOwner: primaryOwner!, nativeFencesReacquired, nativeFenceCount: 3 } });
        }
      }
    }
    await connectionDelay(250);
  }
  throw new Error("antigravity_evidence_turn_deadline");
}

export function gradeAntigravityJourney(evidence: AntigravityJourneyEvidence) {
  const checkpointChecks = antigravityJourneyCheckpoints.map(key => ({ matcher: { kind: "json_path", path: `antigravityJourney.checkpoints.${key}`, expected: true } as Matcher,
    passed: evidence.checkpoints[key] === true, detail: `${key}: ${evidence.checkpoints[key] === true ? "verified" : "missing"}` }));
  const [first, second] = evidence.turnEvidence;
  const fileSequence = first && second && /^[A-Za-z0-9+/=]+$/u.test(first.artifact.base64) && /^[A-Za-z0-9+/=]+$/u.test(second.artifact.base64)
    && /^ANTIGRAVITY-INSTRUCTION-[a-f0-9-]{36}\n$/u.test(Buffer.from(first.artifact.base64, "base64").toString("utf8"))
    && Buffer.from(second.artifact.base64, "base64").toString("utf8").startsWith(Buffer.from(first.artifact.base64, "base64").toString("utf8"))
    && /^ANTIGRAVITY-FOLLOWUP-[a-f0-9-]{36}\n$/u.test(Buffer.from(second.artifact.base64, "base64").toString("utf8").slice(first.artifact.byteSize));
  return [...checkpointChecks,
    { matcher: { kind: "json_path", path: "antigravityJourney.turnEvidence", expected: 2 } as Matcher,
      passed: evidence.turnEvidence.length === 2 && sameAntigravityConversation(first!, second!) && Boolean(fileSequence), detail: "Two independently observed turns in the same tagged native conversation with exact original and appended bytes" },
    { matcher: { kind: "json_path", path: "antigravityJourney.cleanup", expected: true } as Matcher,
      passed: Object.values(evidence.cleanup).every(Boolean), detail: "Owned runs retired and agent cleanup completed; shared saved connection preserved" }];
}

/** Closed retained projection; reject arbitrary native payloads before rendering. */
export function validateAntigravityJourneyEvidence(value: unknown): asserts value is AntigravityJourneyEvidence {
  const closed = (value: unknown, keys: string[]) => {
    const row = rec(value);
    requireProof(Object.keys(row).length > 0 && Object.keys(row).every(key => keys.includes(key)), "retained_shape");
    return row;
  };
  const row = closed(value, ["version", "setupId", "hosting", "targetCommit", "phase", "outcome", "assisted", "privacy", "authentication", "model", "companyId", "agentId", "connectionId", "checkpoints", "turnEvidence", "cleanup"]);
  requireProof(row.version === 1 && /^[a-z0-9-]{1,80}$/u.test(row.setupId) && row.hosting === "self-hosted" && row.privacy === "private"
    && (row.targetCommit === null || /^[a-f0-9]{40}$/u.test(row.targetCommit)) && /^[a-z0-9_]{1,100}$/u.test(row.phase)
    && ["running", "passed", "failed", "awaiting_user", "missing_credential", "blocked_target"].includes(row.outcome)
    && typeof row.assisted === "boolean" && row.authentication === "saved-subscription" && row.model === "gemini-3.8-flash-low"
    && ["companyId", "agentId", "connectionId"].every(key => row[key] === undefined || id(row[key])), "retained_identity");
  requireProof(row.checkpoints && typeof row.checkpoints === "object" && !Array.isArray(row.checkpoints)
    && Object.entries(row.checkpoints).every(([key, v]) => antigravityJourneyCheckpoints.includes(key as typeof antigravityJourneyCheckpoints[number]) && typeof v === "boolean"), "retained_checkpoints");
  const cleanup = closed(row.cleanup, ["agent", "runs", "connectionPreserved"]);
  requireProof(["agent", "runs", "connectionPreserved"].every(key => typeof cleanup[key] === "boolean"), "retained_cleanup");
  requireProof(Array.isArray(row.turnEvidence) && row.turnEvidence.length <= 2, "retained_turn_count");
  for (const turn of row.turnEvidence) {
    const t = closed(turn, ["runId", "companyId", "agentId", "issueId", "connectionId", "environmentId", "nativeSessionId", "runnerInstanceId", "model", "conversation", "artifact", "finalization", "toolLifecycle", "retirement"]);
    requireProof(["runId", "companyId", "agentId", "issueId", "connectionId", "environmentId", "nativeSessionId", "runnerInstanceId"].every(key => id(t[key])) && t.model === row.model, "retained_turn_identity");
    const c = closed(t.conversation, ["kind", "acpxRecordId", "agentSessionId", "backendSessionId", "normalizedSessionId", "requestedModel", "effectiveModel", "permissionMode", "workspaceDigest", "profileDigest"]);
    requireProof(c.kind === "acpx" && ["acpxRecordId", "agentSessionId", "backendSessionId", "normalizedSessionId"].every(key => id(c[key]))
      && c.agentSessionId === c.backendSessionId && c.normalizedSessionId === t.nativeSessionId && c.requestedModel === row.model && c.effectiveModel === row.model
      && c.permissionMode === "approve-all" && [c.workspaceDigest, c.profileDigest].every(v => /^sha256:[a-f0-9]{64}$/u.test(v)), "retained_native_identity");
    const a = closed(t.artifact, ["attachmentId", "filename", "sha256", "byteSize", "base64"]);
    requireProof(id(a.attachmentId) && a.filename === "antigravity-proof.txt" && Number.isSafeInteger(a.byteSize) && a.byteSize > 0 && a.byteSize <= 4096
      && typeof a.base64 === "string" && a.base64.length <= 5464 && /^[A-Za-z0-9+/=]+$/u.test(a.base64)
      && Buffer.from(a.base64, "base64").toString("base64") === a.base64 && Buffer.from(a.base64, "base64").length === a.byteSize
      && hash(Buffer.from(a.base64, "base64")) === a.sha256, "retained_artifact");
    const f = closed(t.finalization, ["phase", "decision", "assessmentId", "decisionId", "observedAt", "acceptedEventSeq", "terminalEventSeq", "nativeResultSha256"]);
    requireProof(f.phase === "committed" && f.decision === "done" && id(f.assessmentId) && id(f.decisionId) && Number.isFinite(Date.parse(f.observedAt))
      && Number.isSafeInteger(f.acceptedEventSeq) && f.acceptedEventSeq > 0 && Number.isSafeInteger(f.terminalEventSeq) && f.terminalEventSeq > f.acceptedEventSeq
      && /^[a-f0-9]{64}$/u.test(f.nativeResultSha256), "retained_finalization");
    const tools = closed(t.toolLifecycle, ["completedFileOperations", "failedFileOperations", "failedFinishOperations"]);
    requireProof(Number.isSafeInteger(tools.completedFileOperations) && tools.completedFileOperations >= 2 && tools.completedFileOperations <= 20_000
      && tools.failedFileOperations === 0 && Number.isSafeInteger(tools.failedFinishOperations) && tools.failedFinishOperations >= 0 && tools.failedFinishOperations <= 20_000, "retained_tools");
    const retired = closed(t.retirement, ["captured", "observedProcessCount", "remainingProcessCount", "identityChanged", "primaryOwner", "nativeFencesReacquired", "nativeFenceCount", "leaseId", "leaseStatus"]);
    requireProof(retired.captured === true && Number.isSafeInteger(retired.observedProcessCount) && retired.observedProcessCount >= 2
      && retired.observedProcessCount <= 1000 && retired.remainingProcessCount === 0 && retired.identityChanged === false
      && validAntigravityPrimaryOwner(retired.primaryOwner) && retired.primaryOwner.runId === t.runId
      && retired.nativeFencesReacquired === true && retired.nativeFenceCount === 3 && id(retired.leaseId) && retired.leaseStatus === "released", "retained_retirement");
  }
}
