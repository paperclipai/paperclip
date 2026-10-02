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
describe("Pi pending control identity", () => {
  it("accepts Pi native permission/start without invented provider notices", () => expect(piControlFixture().pending()).toMatchObject({ toolCallId: "pi-tool", executionId: "pi-tool", turnId: "turn" }));
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
    expect(validateRunnerCatalog()).toHaveLength(469);
    for (const cell of cells) expect(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    expect(() => assertRemoteNativeEvidencePrerequisites(cells, {})).toThrow();
  });
  it("pins the Pi 1 profile and versioned coverage while retaining active Stop identity", () => {
    // Pi 1/profile 13 changes profile-bearing definitions. Coverage v4/v2 adds
    // provider death, pending restart and the strict file oracle; no runtime admission is promoted.
    const pi = runnerMatrix.find(c => c.profile.qualificationCandidate === "pi")!.profile;
    expect(pi.modelQualification?.qualificationId).toBe("pi:0.0.33:1.0.0:openrouter");
    expect(runnerSuites.find(s => s.id === "pi-native")!.definitionMetadata).toMatchObject({ version: 4, profileVersion: 13 });
    expect(runnerSuites.find(s => s.id === "extended-harnesses")!.definitionMetadata).toMatchObject({ version: 2 });
    for (const cell of runnerMatrix.filter(cell => cell.profile.qualificationCandidate === "pi")) {
      const agent = cell.profile.buildAgent({ environmentId: "environment", environmentFixtureId: cell.environment.id, workspacePath: "/workspace", executionId: cell.id, secretRefs: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "synthetic", version: "latest" } } });
      expect(agent.adapterConfig).toMatchObject({ piThinkingLevel: "low" });
    }
    const hashes = Object.fromEntries(runnerSuites.filter(s => ["pi-native", "native-active-stop", "extended-harnesses", "rich-acp-warm-continuity"].includes(s.id)).map(s => [s.id, suiteDefinitionHash(s)]));
    expect(hashes).toEqual({
      "pi-native": "5038d59a5176ca215bc29b2d532c1d51d134442b046dd230c1e060050109964d",
      "native-active-stop": "99682b2b106d816a011834fae5a944ed7729958893709d5b83a19b6f595e7e4d",
      "rich-acp-warm-continuity": "3000c64a9879b95926add1d822530c8812b70a223e94219766554d9c0092eedf",
      "extended-harnesses": "9814841e571cb8bb1dc5188a8577245896e0ce8c851294ac5dea9e3d42689db6",
    });
    expect(runnerMatrix.filter(c => c.profile.qualificationCandidate === "pi" && c.suite.id !== "pi-controls")).toHaveLength(22);
  });
});
