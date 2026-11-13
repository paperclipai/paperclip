import { createHash } from "node:crypto";
import { gradeAntigravityJourneyTurn, antigravityJourneyCheckpoints, type AntigravityJourneyEvidence } from "./antigravity-journey-evidence.js";

/** Synthetic calibration only. No provider, account, or historical session data. */
export function antigravityTurnFixture(second = false) {
  const firstBytes = "ANTIGRAVITY-INSTRUCTION-00000000-0000-4000-8000-000000000001\n";
  const expectedBytes = Buffer.from(firstBytes + (second ? "ANTIGRAVITY-FOLLOWUP-00000000-0000-4000-8000-000000000002\n" : ""));
  const sha256 = createHash("sha256").update(expectedBytes).digest("hex");
  const runId = second ? "run-second" : "run-first", runnerInstanceId = second ? "runner-second" : "runner-first";
  const attachmentId = second ? "attachment-second" : "attachment-first";
  const model = "gemini-3.8-flash-low", profileDigest = `sha256:${"a".repeat(64)}`;
  const providerIdentity = { kind: "acpx", acpxRecordId: "acpx-record", agentSessionId: "provider-session", backendSessionId: "provider-session",
    normalizedSessionId: "native-session", requestedModel: model, effectiveModel: model, permissionMode: "approve-all", workspaceDigest: `sha256:${"b".repeat(64)}`, profileDigest };
  const run: Record<string, any> = { id: runId, companyId: "company", agentId: "agent", issueId: "task", status: "succeeded", runtimeMode: "native", driverKind: "acpx_runtime",
    nativeSessionId: "native-session", runnerInstanceId, costAccountingPending: false,
    processPid: second ? 900002 : 900001, processGroupId: second ? 900002 : 900001, processStartedAt: second ? "2026-10-29T01:00:00.000Z" : "2026-10-29T00:00:00.000Z",
    runnerProfileJson: { backend: "acpx_runtime", nativeExecutionInput: { binding: { runId, companyId: "company", agentId: "agent", issueId: "task" },
      provider: { kind: "acpx", agent: "antigravity", model, profile: { commandDigest: profileDigest } } }, sessionCheckpoint: { providerIdentity } },
    contextSnapshot: { aiConnection: { provider: "google", method: "subscription", connectionId: "connection" }, paperclipEnvironment: { id: "environment", driver: "local", leaseId: `lease-${runId}` } },
    resultJson: { finalizationPhase: "committed", authoritativeDecision: "done", issueStatusAfter: "done", workspaceFinalizeStatus: "succeeded", assessmentId: `assessment-${runId}`, decisionId: `decision-${runId}`,
      nativeResult: { schema: "paperclip.run_result.v1" }, nativeTerminal: { runTerminalState: "succeeded" },
      semanticToolReceipts: { register: { operationId: "register_deliverable", input: { filename: "antigravity-proof.txt", byteSize: expectedBytes.length, sha256 }, result: { attachmentId, disposition: "applied" } } } } };
  const event = (operation: string, seq: number, status = "completed", name = `client_${operation}_file`, execution = `call-${seq}`) => ({
    companyId: "company", runId, seq, sourceInstanceId: runnerInstanceId, sourceSeq: seq, sourceEventId: executorSourceEventId(runnerInstanceId, seq),
    protocolSchemaVersion: 1, eventType: status === "running" ? "tool.execution.started" : "tool.execution.completed", payload: { prpEvent: {
      schema: "paperclip.prp.event.v1", schemaVersion: 1, eventType: status === "running" ? "tool.execution.started" : "tool.execution.completed", runId, sourceKind: "runner", sourceInstanceId: runnerInstanceId,
      sourceSeq: seq, sourceEventId: executorSourceEventId(runnerInstanceId, seq), normalizedSessionId: "native-session", turnId: `turn-${runId}`,
      payload: { operation, status, name, target: "antigravity-proof.txt", executionId: execution } } } });
  const events = second ? [event("read", 1, "running", "client_read_file", "before-read"), event("read", 2, "completed", "client_read_file", "before-read"),
    event("edit", 3, "running", "client_edit_file", "edit-call"), event("edit", 4, "completed", "client_edit_file", "edit-call"),
    event("read", 5, "running", "client_read_file", "read-call"), event("read", 6, "completed", "client_read_file", "read-call")]
    : [event("edit", 1, "running", "client_edit_file", "edit-call"), event("edit", 2, "completed", "client_edit_file", "edit-call"), event("read", 3, "running", "client_read_file", "read-call"), event("read", 4, "completed", "client_read_file", "read-call")];
  events.push(event("execute", events.length + 1, "failed", "paperclip_paperclip_finish"));
  for (const eventType of ["run.result.accepted", "run.terminal"]) {
    const seq = events.length + 1, sourceInstanceId = `${runnerInstanceId}:control`;
    const payload = eventType === "run.result.accepted" ? { result: structuredClone(run.resultJson.nativeResult) }
      : { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" };
    events.push({ companyId: "company", runId, seq, sourceInstanceId, sourceSeq: seq, sourceEventId: `${sourceInstanceId}:${runId}:${seq}`,
      protocolSchemaVersion: 1, eventType, payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, eventType, runId,
        sourceKind: "control_plane", sourceInstanceId, sourceSeq: seq, sourceEventId: `${sourceInstanceId}:${runId}:${seq}`,
        normalizedSessionId: "native-session", turnId: `turn-${runId}`, payload } } } as any);
  }
  return { companyId: "company", agentId: "agent", issueId: "task", connectionId: "connection", environmentId: "environment", model, expectedProfileDigest: profileDigest,
    expectedBytes, afterRunIds: second ? ["run-first"] : [], run,
    issue: { id: "task", companyId: "company", assigneeAgentId: "agent", status: "done" },
    attachment: { id: attachmentId, companyId: "company", issueId: "task", createdByAgentId: "agent", originatingRunId: runId,
      originalFilename: "antigravity-proof.txt", contentType: "text/plain", byteSize: expectedBytes.length, sha256 },
    downloadedBytes: Buffer.from(expectedBytes), events,
    lease: { id: `lease-${runId}`, companyId: "company", environmentId: "environment", heartbeatRunId: runId, status: "released", releasedAt: "2026-10-29T00:00:00Z" },
    retirement: { captured: true, observedProcessCount: 3, remainingProcessCount: 0, identityChanged: false,
      primaryOwner: { runId, pid: run.processPid as number, groupId: run.processGroupId as number, startedAt: run.processStartedAt as string, commandSha256: "c".repeat(64), perTurnArgvVerified: true as const },
      nativeFencesReacquired: true, nativeFenceCount: 3 } };
}

/** Rust durable/state.rs hashes the ACPX executor's stable event identity. */
function executorSourceEventId(runnerInstanceId: string, seq: number) {
  return `event_executor_${createHash("sha256").update("paperclip.executor-event.v1\0").update(runnerInstanceId)
    .update("\0").update(`acpx_provider_${String(seq).padStart(16, "0")}`).digest("hex")}`;
}

export function antigravityEvidenceFixture(): AntigravityJourneyEvidence {
  return { version: 1, setupId: "calibration", hosting: "self-hosted", targetCommit: "a".repeat(40), phase: "persisted", outcome: "passed", assisted: false,
    privacy: "private", authentication: "saved-subscription", model: "gemini-3.8-flash-low", companyId: "company", agentId: "agent", connectionId: "connection",
    checkpoints: Object.fromEntries(antigravityJourneyCheckpoints.map(key => [key, true])),
    turnEvidence: [gradeAntigravityJourneyTurn(antigravityTurnFixture()), gradeAntigravityJourneyTurn(antigravityTurnFixture(true))],
    cleanup: { agent: true, runs: true, connectionPreserved: true } };
}
