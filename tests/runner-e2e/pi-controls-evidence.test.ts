import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CodexHarnessSession } from "../../packages/paperclip-runner/src/drivers/codex/codex-harness-session.js";
import { assertSamePiPending, observePiControlPending, readPiStopSettlement, readPiSteeringAcknowledgement, readPiSteeringSettlement } from "./pi-controls-evidence.js";
import { stopPiAtPendingPermission } from "./pi-controls-flow.js";
import { piControlFixture, piControlCaller, piCancellationId } from "./pi-controls-test-fixture.js";
import { runnerMatrix, runnerSuites, suiteDefinitionHash, validateRunnerCatalog } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { assertRemoteNativeEvidencePrerequisites } from "./prerequisites.js";

type Row = Record<string, any>;
const event = (row: Row) => row.payload.prpEvent;
function cancelled() {
  const f = piControlFixture(), pending = f.pending(); f.cancel();
  const binding = { pending, caller: piControlCaller, cancellationRequestId: piCancellationId, dispatchMonotonicNs: String(BigInt(pending.observedMonotonicNs) + 1n) };
  return { f, binding, read: () => readPiStopSettlement({ ...f.state(), ...binding }) };
}
function streamedWrite() {
  const f = piControlFixture();
  f.events.pop();
  event(f.events[0]!).payload = { ...f.tool, target: null, inputUpdated: false };
  f.append("tool.execution.progressed", { ...f.tool, target: null, inputUpdated: true });
  f.append("tool.execution.progressed", { ...f.tool, inputUpdated: true });
  f.append("runtime_request.created", { request: f.request });
  return f;
}
describe("Pi pending control identity", () => {
  it("accepts Pi native permission/start without invented provider notices", () => expect(piControlFixture().pending()).toMatchObject({ toolCallId: "pi-tool", executionId: "pi-tool", turnId: "turn" }));
  it("accepts streamed arguments only after the same execution proves its exact path", () => {
    const f = streamedWrite();
    expect(f.pending()).toMatchObject({ startedSourceSeq: 1, requestSourceSeq: 4 });
  });
  it.each([
    ["no complete target", (f: ReturnType<typeof streamedWrite>) => { event(f.events[2]!).payload.target = null; }],
    ["conflicting partial target", f => { event(f.events[1]!).payload.target = "other.txt"; }],
    ["target lost after admission", f => { f.append("tool.execution.progressed", { ...f.tool, target: null }); }],
    ["different execution supplied target", f => { event(f.events[2]!).payload.executionId = "other"; }],
    ["terminal before target", f => { f.events[1]!.eventType = event(f.events[1]!).eventType = "tool.execution.completed"; event(f.events[1]!).payload.status = "failed"; }],
  ] satisfies Array<[string, (f: ReturnType<typeof streamedWrite>) => void]>)("rejects streamed write with %s", (_name, mutate) => {
    const f = streamedWrite(); mutate(f); expect(() => f.pending()).toThrow();
  });
  it("retains the partial start hash through actual callback cancellation", () => {
    const f = streamedWrite(), pending = f.pending(); f.cancel();
    expect(readPiStopSettlement({ ...f.state(), pending, caller: piControlCaller, cancellationRequestId: piCancellationId,
      dispatchMonotonicNs: String(BigInt(pending.observedMonotonicNs) + 1n) })).toMatchObject({ normalCompletionAccepted: false });
  });
  it("admits permission-first ACP only after both canonical boundaries exist", () => {
    const f = piControlFixture(); f.events.reverse();
    f.events.forEach((r, i) => { r.seq = event(r).sourceSeq = i + 1; event(r).sourceEventId = `source:run:${i + 1}`; });
    expect(f.pending().requestSourceSeq).toBe(1);
  });
  it.each([
    ["wrong provider", (f: ReturnType<typeof piControlFixture>) => { f.request.origin.provider = "copilot"; }],
    ["foreign source", f => { event(f.events[1]!).sourceInstanceId = "other"; }],
    ["foreign company", f => { f.events[0]!.companyId = "other"; }],
    ["changed write path", f => { f.tool.target = "other.txt"; }],
    ["write already ended", f => { f.append("tool.execution.completed", { ...f.tool, status: "failed" }); }],
    ["answered request", f => { f.append("runtime_request.resolved", { requestId: "request", action: "decline" }); }],
    ["normal completion", f => { f.append("turn.completed", { status: "completed" }); }],
    ["extra native write", f => { f.append("tool.execution.started", { ...f.tool, executionId: "other" }); }],
    ["missing decline", f => { f.request.choices = []; }],
    ["missing tool origin", f => { f.events.shift(); }],
    ["duplicate event", f => { f.events.push(f.events[0]!); }],
    ["non-native run", f => { f.run.runtimeMode = "legacy"; }],
    ["prior Stop", f => { f.run.resultJson.startupCancellation = {}; }],
  ] satisfies Array<[string, (f: ReturnType<typeof piControlFixture>) => void]>)("rejects %s", (_name, mutate) => { const f = piControlFixture(); mutate(f); expect(() => f.pending()).toThrow(); });
});
describe("Pi active Stop settlement", () => {
  it("uses the production terminal mapper and actually cancels the pending callback", () => {
    const s = cancelled(); expect(s.f.responses).toHaveLength(1); expect(s.read()).toMatchObject({ normalCompletionAccepted: false, schema: "paperclip.e2e.pi-stop-settlement.v1" });
  });
  it.each([
    ["normal terminal", (s: ReturnType<typeof cancelled>) => { event(s.f.events.at(-1)!).eventType = s.f.events.at(-1)!.eventType = "turn.completed"; }],
    ["expired callback", s => { const r = s.f.events.find(r => r.eventType === "runtime_request.cancelled")!; r.eventType = event(r).eventType = "runtime_request.expired"; }],
    ["answered callback", s => { event(s.f.events.find(r => r.eventType === "runtime_request.cancelled")!).payload.action = "decline"; }],
    ["changed pending target", s => { s.f.tool.target = "other.txt"; }],
    ["changed retained hash", s => { s.binding.pending.requestRowSha256 = `sha256:${"a".repeat(64)}`; }],
    ["late pending observation", s => { s.binding.dispatchMonotonicNs = s.binding.pending.observedMonotonicNs; }],
    ["unacknowledged Stop", s => { s.f.run.resultJson.nativeCancellation.dispatchState = "pending"; }],
    ["another caller", s => { s.f.run.resultJson.startupCancellation.requestedBy.userId = "other"; }],
    ["another intent", s => { s.f.run.resultJson.nativeCancellation.intentId = "native-cancellation:other"; }],
    ["extra cancellation effect", s => { s.f.run.resultJson.nativeCancellation.effects.push("pause_agent"); }],
    ["same intent and ack audit", s => { s.f.run.resultJson.nativeCancellation.acknowledgementAuditId = "intent-audit"; }],
    ["completed task", s => { s.f.issue.status = "done"; }],
    ["foreign run", s => { s.f.run.id = "other"; }],
  ] satisfies Array<[string, (s: ReturnType<typeof cancelled>) => void]>)("rejects %s", (_name, mutate) => { const s = cancelled(); mutate(s); expect(s.read).toThrow(); });
  it("retains and rereads the boundary before dispatching one caller UUID", async () => {
    const f = piControlFixture(), order: string[] = [];
    const result = await stopPiAtPendingPermission({ scope: f.scope, caller: piControlCaller, deadlineAt: Date.now() + 1000,
      load: async () => { order.push("load"); return f.state(); }, retain: async () => { order.push("retain"); }, stop: async (runId, uuid) => { order.push("stop"); expect(runId).toBe("run"); return f.cancel(uuid); } });
    expect(order.slice(0, 4)).toEqual(["load", "retain", "load", "stop"]); expect(result.settlement.normalCompletionAccepted).toBe(false);
  });
  it("refuses dispatch when pending state changes during evidence retention", async () => {
    const f = piControlFixture(), stop = vi.fn();
    await expect(stopPiAtPendingPermission({ scope: f.scope, caller: piControlCaller, deadlineAt: Date.now() + 1000, load: async () => f.state(), retain: async () => { f.request.itemId = "changed"; }, stop })).rejects.toThrow("pending boundary changed");
    expect(stop).not.toHaveBeenCalled();
  });
  it("fails immediately on normal completion instead of retrying it as an unsettled cancellation", async () => {
    const f = piControlFixture();
    await expect(stopPiAtPendingPermission({ scope: f.scope, caller: piControlCaller, deadlineAt: Date.now() + 100,
      load: async () => f.state(), retain: async () => {}, stop: async (_runId, uuid) => { const run = f.cancel(uuid); f.run.status = "succeeded"; return run; },
    })).rejects.toThrow(/^Stopped waiting for Pi pending permission cancellation: unexpected terminal$/);
  });
});
function steered() {
  const f = piControlFixture(), pending = f.pending(); f.steer();
  const binding = { pending, commentId: f.commentId, queueId: f.queueId, marker: f.marker, finalMessage: f.marker };
  const ack = readPiSteeringAcknowledgement({ ...f.state(), ...binding });
  assertSamePiPending(pending, observePiControlPending({ ...f.state(), scope: f.scope })); f.finish();
  return { f, binding, ack, read: () => readPiSteeringSettlement({ ...f.state(), ...binding }) };
}
describe("Pi same-turn steering", () => {
  function withControlSettlement() {
    return steered();
  }
  it("keeps exact runner proof when the control plane records result and terminal events", () => {
    expect(withControlSettlement().read()).toMatchObject({ nativeFollowUpTested: false });
  });
  it.each([
    ["foreign control producer", (s: ReturnType<typeof withControlSettlement>) => { event(s.f.events.at(-1)!).sourceInstanceId = "foreign:control"; event(s.f.events.at(-1)!).sourceEventId = "foreign:control:run:2"; }],
    ["foreign control turn", s => { event(s.f.events.at(-1)!).turnId = "foreign"; }],
    ["foreign control session", s => { event(s.f.events.at(-1)!).normalizedSessionId = "foreign"; }],
    ["unknown control event", s => { s.f.events.at(-1)!.eventType = event(s.f.events.at(-1)!).eventType = "runtime_request.resolved"; }],
    ["reordered control sequence", s => { event(s.f.events.at(-1)!).sourceSeq = 1; event(s.f.events.at(-1)!).sourceEventId = "source:control:run:1"; }],
    ["duplicate control terminal", s => { s.f.append("run.terminal", { schema: "paperclip.prp.terminal.v1" }, { sourceKind: "control_plane", sourceInstanceId: "source:control", sourceSeq: 3, sourceEventId: "source:control:run:3" }); }],
    ["unbound control result", s => { event(s.f.events.at(-2)!).payload.result.schema = "foreign"; }],
    ["both control records missing", s => { s.f.events.splice(-2); }],
    ["accepted result missing", s => { s.f.events.splice(-2, 1); }],
    ["control terminal missing", s => { s.f.events.pop(); }],
    ["wrong control summary", s => { event(s.f.events.at(-2)!).payload.result.summary = "Finished"; }],
    ["unfinished control result", s => { event(s.f.events.at(-2)!).payload.result.reportedWorkDisposition = "in_progress"; }],
    ["failed control terminal", s => { event(s.f.events.at(-1)!).payload.runTerminalState = "failed"; }],
    ["interrupted control turn", s => { event(s.f.events.at(-1)!).payload.turnTerminalState = "interrupted"; }],
    ["unfinished control terminal", s => { event(s.f.events.at(-1)!).payload.reportedWorkDisposition = "in_progress"; }],
    ["control terminal before runner completion", s => {
      for (const row of s.f.events.slice(3, 6)) row.seq += 2;
      s.f.events.at(-2)!.seq = 4; s.f.events.at(-1)!.seq = 5;
    }],
  ] satisfies Array<[string, (s: ReturnType<typeof withControlSettlement>) => void]>)("rejects %s", (_name, mutate) => {
    const s = withControlSettlement(); mutate(s); expect(s.read).toThrow();
  });
  it("calibrates against the actual Product ACP facade producer, not Rust's raw transport echo", async () => {
    const f = piControlFixture(), pending = f.pending(), calls: Row[] = [];
    // Only the transport and event sink are doubles. Run the actual public
    // steer method, active-turn check and negotiated Pi capability boundary.
    const session = Object.assign(Object.create(CodexHarnessSession.prototype), {
      driverKind: "acpx_runtime", activeTurnId: "turn", opened: { threadId: "thread" },
      protocolIntegrityFailure: null, terminalTurns: new Map(), acknowledgedSteeringCorrelations: new Map(),
      transport: { turnControlCapabilities: () => ({ steering: true, queuedFollowUp: true }), request: async (method: string, params: Row) => { calls.push({ method, params }); return {}; } },
      emit: (type: string, payload: Row, extra: Row) => f.append(type, payload, extra),
    }) as CodexHarnessSession;
    await session.steer({ turnId: "turn", correlationId: "comment", message: { role: "user", text: "Hidden instruction" } });
    expect(calls).toEqual([{ method: "turn/steer", params: { threadId: "thread", input: [{ type: "text", text: "Hidden instruction", text_elements: [] }], expectedTurnId: "turn", correlationId: "comment" } }]);
    f.run.resultJson.queuedSteeringAcknowledgements = { comment: { status: "acknowledged", queueId: "queue", turnId: "turn", acknowledgedAt: "2026-10-01T00:00:01Z" } };
    const read = () => readPiSteeringAcknowledgement({ ...f.state(), pending, commentId: "comment", queueId: "queue" });
    expect(read().turnId).toBe("turn");
    event(f.events.at(-1)!).itemId = `acpx-control-${createHash("sha256").update("turn:comment").digest("hex")}`;
    expect(read).toThrow("acknowledgement missing");
  });
  it("requires acknowledged steering before denial and the hidden marker in final output", () => expect(steered().read()).toMatchObject({ nativeFollowUpTested: false }));
  it.each([
    ["marker echoed elsewhere", (s: ReturnType<typeof steered>) => { s.binding.finalMessage = "Finished"; }],
    ["narration mixed into final", s => { s.binding.finalMessage = `Working...${s.f.marker}`; }],
    ["another queued comment", s => { s.binding.commentId = "other"; }],
    ["another queue", s => { s.binding.queueId = "other"; }],
    ["another turn acknowledgment", s => { s.f.run.resultJson.queuedSteeringAcknowledgements.comment.turnId = "other"; }],
    ["missing native ack", s => { s.f.events.splice(2, 1); }],
    ["follow-up substituted for steer", s => { event(s.f.events[2]!).payload.mode = "follow_up"; }],
    ["accepted write", s => { event(s.f.events.find(r => r.eventType === "runtime_request.resolved")!).payload.action = "accept"; }],
    ["completed write", s => { event(s.f.events.find(r => r.eventType === "tool.execution.completed")!).payload.status = "completed"; }],
    ["unrelated tool failure", s => { event(s.f.events.find(r => r.eventType === "tool.execution.completed")!).payload.output = "Network error"; }],
    ["cancelled run", s => { s.f.run.status = "cancelled"; }],
    ["unfinished task", s => { s.f.issue.status = "in_progress"; }],
  ] satisfies Array<[string, (s: ReturnType<typeof steered>) => void]>)("rejects %s", (_name, mutate) => { const s = steered(); mutate(s); expect(s.read).toThrow(); });
});
describe("Pi controls catalog admission", () => {
  it("adds exactly four explicit Pi-only cells without widening --all", () => {
    const cells = selectRunnerExecutions(parseRunnerSelectors(["--suite", "pi-controls"]));
    expect(cells).toHaveLength(4); expect(cells.every(c => c.profile.qualificationCandidate === "pi" && c.task.expectedRunCount === 1)).toBe(true);
    expect(cells.map(c => `${c.environment.id}/${c.task.id}`).sort()).toEqual(["daytona/pending-permission-stop", "daytona/same-turn-steering", "local/pending-permission-stop", "local/same-turn-steering"]);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(c => c.suite.id === "pi-controls")).toBe(false);
    expect(validateRunnerCatalog()).toHaveLength(727);
    for (const cell of cells) expect(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    expect(() => assertRemoteNativeEvidencePrerequisites(cells, {})).toThrow();
  });
  it("pins the Pi 1 profile and versioned coverage while retaining active Stop identity", () => {
    // Current profile identity and native/control coverage retain their own fingerprints.
    // Extended v3 states the strict file oracle's task-wide Bash limit.
    const pi = runnerMatrix.find(c => c.profile.qualificationCandidate === "pi")!.profile;
    expect(pi.modelQualification?.qualificationId).toBe("pi:0.0.33:1.0.0:openrouter");
    expect(runnerSuites.find(s => s.id === "pi-native")!.definitionMetadata).toMatchObject({ version: 23, remoteProcExit: "separately-confirmed-absence-after-read-failure", taskCreation: "explicit-title-and-creation-response-id", agentMemoryParent: "public-managed-file-seed-before-admission", incompleteTerminalCleanup: "retirement-retained-with-failed-watch", profileVersion: 19, agentMemoryContent: "utf8-nonce-plus-final-lf", agentMemoryPrompt: "single-json-write-and-content-bound-native-read-both-runs", agentMemoryReadAuthority: "local-withheld-or-exact-remote-agent-run-file", taskPromptTransport: "fenced-markdown-paste-and-multiline-literal-escapes", nativeFinish: "current-contract-objective-evidence-refs", providerFaultExecutable: "stable-preinstalled-runner-link-and-snapshot-node-inode-with-held-bootstrap-fd-3-or-7" });
    expect(runnerSuites.find(s => s.id === "pi-controls")!.definitionMetadata).toMatchObject({ version: 10, remoteProcExit: "separately-confirmed-absence-after-read-failure", taskCreation: "explicit-title-and-creation-response-id", profileVersion: 19,
      remoteProcessIdentity: "observer-pid-startTicks-bootId",
      controlPlaneSettlement: "required-scoped-result-and-terminal-after-runner" });
    expect(runnerSuites.find(s => s.id === "extended-harnesses")!.definitionMetadata).toMatchObject({ version: 5, piFileArtifactTitle: "exact-filename", piFileCommandTransport: "fenced-bash-markdown-paste" });
    for (const cell of runnerMatrix.filter(cell => cell.profile.qualificationCandidate === "pi")) {
      const agent = cell.profile.buildAgent({ environmentId: "environment", environmentFixtureId: cell.environment.id, workspacePath: "/workspace", executionId: cell.id, secretRefs: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "synthetic", version: "latest" } } });
      expect(agent.adapterConfig).toMatchObject({ piThinkingLevel: "low" });
    }
    const hashes = Object.fromEntries(runnerSuites.filter(s => ["pi-native", "native-active-stop", "extended-harnesses", "rich-acp-warm-continuity"].includes(s.id)).map(s => [s.id, suiteDefinitionHash(s)]));
    expect(hashes).toEqual({
      "pi-native": "90f2e901d7f39bfb6bbadcf63bc78e410a3b071af980f3a23979747e3d5f2021",
      "native-active-stop": "2d4fdeeb75bd531b309bd1b35cfa5680ceefdeee6b7155b068dd011ce9901980",
      "rich-acp-warm-continuity": "331b88d9538a132670789fb7864df7df5f4bf294ae19b62f53d8a02f901774f0",
      "extended-harnesses": "5de4fac78d4d581bc0954f07b5cf2df2862d37f8b0205325eede6d9ef6d9f5e6",
    });
    expect(runnerMatrix.filter(c => c.profile.qualificationCandidate === "pi" && c.suite.id !== "pi-controls")).toHaveLength(22);
  });
});
