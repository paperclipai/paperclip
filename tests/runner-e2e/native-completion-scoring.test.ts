import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rehydrateRunnerdItemNotification } from "../../packages/paperclip-runner/src/live/runnerd-codex-transport.js";
import { gradeNativeCompletion, type NativeCompletionObservation } from "./native-completion-scoring.js";
type Row = Record<string, unknown>;
function sample(blocked = true, compatibility = false): NativeCompletionObservation {
  const body = blocked ? "Deployment remains blocked until access is granted. Release Owner must Grant deployment access. BLOCKED_probe" : "Saved the requested document.";
  const result = { reportedWorkDisposition: blocked ? "blocked" : "done", ...(blocked ? { blocker: { owner: { name: "Release Owner" }, unblockAction: "Grant deployment access", scope: "task_wide" } } : {}) };
  const event = (seq: number, eventType: string, payload: Row, sourceKind = "runner"): Row => ({ seq, eventType, protocolSchemaVersion: 1,
    sourceEventId: `event${seq}`, sourceInstanceId: sourceKind, sourceSeq: seq,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "run", eventType,
      sourceKind, sourceEventId: `event${seq}`, sourceInstanceId: sourceKind, sourceSeq: seq, payload } } });
  const tool = blocked ? "paperclip_block" : "paperclip_finish";
  return { caseId: blocked ? "native-blocked-report" : "assigned-skill-explicit-invocation", companyId: "company", agentId: "agent", marker: "BLOCKED_probe",
    issue: { id: "issue", companyId: "company", assigneeAgentId: "agent", status: result.reportedWorkDisposition },
    runs: [{ id: "run", nativeIssueId: "issue", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "native", resultJson: { nativeResult: result } }],
    comments: [{ createdByRunId: "run", authorAgentId: "agent", body }],
    initial: { issueIds: [], agentIds: ["agent"] }, state: { issueIds: ["issue"], agentIds: ["agent"], documentCount: blocked ? 0 : 1, interactionCount: 0 }, workspaceChanged: false,
    events: [compatibility ? event(1, "item.started", { kind: "tool_call", item: { type: "tool_call", id: "tool", name: tool } }) : event(1, "tool.execution.started", { name: tool, executionId: "tool" }), event(2, "run.result.proposed", result),
      compatibility ? event(3, "item.completed", { kind: "tool_result", item: { type: "tool_result", status: "completed", id: "tool" } }) : event(3, "tool.execution.completed", { name: tool, status: "completed", executionId: "tool" }),
      event(4, "item.completed", { kind: "agentMessage", channel: "final", item: { type: "agentMessage", phase: "final_answer", text: body, channel: "final" } }),
      event(5, "run.result.accepted", { result }, "control_plane"), event(6, "run.terminal", { runTerminalState: "succeeded", turnTerminalState: "completed" }, "control_plane")],
  };
}
function payload(input: NativeCompletionObservation, index: number): Row { return ((input.events[index]!.payload as Row).prpEvent as Row).payload as Row; }
describe("native completion independent oracle", () => {
  it.each([[true, false], [true, true], [false, false], [false, true]])("accepts disposition %s compatibility %s with final before late control-plane acceptance", (blocked, compatibility) => expect(gradeNativeCompletion(sample(blocked, compatibility)).passed).toBe(true));
  it.each(["paperclip_finish", "paperclip_block"])("carries normalized %s identity through rehydration into the exact-call oracle", name => {
    // The Rust normalization calibration asserts these exact fixture bytes.
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/native-completion/terminal-tool-carrier.json", import.meta.url), "utf8")) as {
      cases: Array<{ name: string; normalizedPayload: Row }>;
    };
    const normalized = fixture.cases.find(value => value.name === name)!.normalizedPayload;
    const started = rehydrateRunnerdItemNotification(normalized, "thread", "turn");
    expect(started.item).toMatchObject({ id: "terminal-call", type: "tool_call", name });
    const completed = rehydrateRunnerdItemNotification({ provider: "codex", itemId: "terminal-call", kind: "tool_result", status: "completed", channel: "detail", text: null }, "thread", "turn");
    const value = sample(name === "paperclip_block", true);
    payload(value, 0).item = started.item;
    payload(value, 2).item = completed.item;
    expect(gradeNativeCompletion(value).passed).toBe(true);
    (payload(value, 2).item as Row).id = "different-call";
    expect(gradeNativeCompletion(value).checks.find(check => check.id === "final-after-tool-result")?.passed).toBe(false);
  });
  it("accepts authoritative acceptance before the provider final", () => {
    const value = sample();
    const events = [...value.events];
    value.events = [events[0]!, events[1]!, events[2]!, events[4]!, events[3]!, events[5]!].map((event, index) => ({ ...event, seq: index + 1 }));
    expect(gradeNativeCompletion(value).passed).toBe(true);
  });
  it("accepts complete public streams containing non-PRP lifecycle rows", () => {
    const value = sample();
    value.events = [{ seq: 1, eventType: "lifecycle" }, ...value.events.map(event => ({ ...event, seq: Number(event.seq) + 1 }))];
    expect(gradeNativeCompletion(value).passed).toBe(true);
  });
  it.each(["canonical", "compatibility"])("rejects an unmatched %s terminal result", kind => {
    const value = sample(true, kind === "compatibility");
    if (kind === "canonical") payload(value, 2).executionId = "unmatched";
    else (payload(value, 2).item as Row).id = "unmatched";
    expect(gradeNativeCompletion(value).passed).toBe(false);
  });
  it.each(["missing-name", "unrelated-named-tool", "contradictory-result-name"])("rejects compatibility finishing identity %s despite a matching ID", name => {
    const value = sample(true, true);
    if (name === "missing-name") delete (payload(value, 0).item as Row).name;
    if (name === "unrelated-named-tool") (payload(value, 0).item as Row).name = "write_document";
    if (name === "contradictory-result-name") (payload(value, 2).item as Row).name = "write_document";
    expect(gradeNativeCompletion(value).checks.find(check => check.id === "final-after-tool-result")?.passed).toBe(false);
  });
  it.each(["extra-run", "retry", "continuation", "wrong-account", "wrong-agent", "wrong-disposition", "punctuated-action", "wrong-scope", "missing-final", "summary-fallback", "pre-tool-final", "post-admission-call", "missing-acceptance", "runner-acceptance", "failed-terminal", "event-gap", "binding-mismatch", "extra-task", "extra-agent", "extra-document", "interaction", "changed-workspace", "process-call", "marker-only", "contradiction", "wrong-reply-run"])("rejects %s", name => {
    const value = sample(); const run = value.runs[0]!;
    if (name === "extra-run") value.runs = [run, { ...run, id: "extra" }];
    if (name === "retry") run.retryOfRunId = "prior";
    if (name === "continuation") run.continuationAttempt = 1;
    if (name === "wrong-account") run.companyId = "other";
    if (name === "wrong-agent") run.agentId = "other";
    if (name === "wrong-disposition") value.issue.status = "done";
    if (name === "punctuated-action") ((run.resultJson as Row).nativeResult as {blocker: {unblockAction: string}}).blocker.unblockAction = "Grant deployment access.";
    if (name === "wrong-scope") ((run.resultJson as Row).nativeResult as {blocker: {scope: string}}).blocker.scope = "step";
    if (name === "missing-final" || name === "summary-fallback") payload(value, 3).kind = "summary", (payload(value, 3).item as Row).type = "summary";
    if (name === "pre-tool-final") (payload(value, 2).name = "other");
    if (name === "post-admission-call") value.events[3]!.eventType = "tool.execution.started";
    if (name === "missing-acceptance") value.events[4]!.eventType = "other";
    if (name === "runner-acceptance") ((value.events[4]!.payload as Row).prpEvent as Row).sourceKind = "runner";
    if (name === "failed-terminal") payload(value, 5).runTerminalState = "failed";
    if (name === "event-gap") value.events[1]!.seq = 20;
    if (name === "binding-mismatch") ((value.events[1]!.payload as Row).prpEvent as Row).runId = "other";
    if (name === "extra-task") value.state.issueIds.push("extra");
    if (name === "extra-agent") value.state.agentIds.push("extra");
    if (name === "extra-document") value.state.documentCount = 1;
    if (name === "interaction") value.state.interactionCount = 1;
    if (name === "changed-workspace") value.workspaceChanged = true;
    if (name === "process-call") payload(value, 0).transport = "process";
    if (name === "marker-only" || name === "contradiction") {
      const text = name === "marker-only" ? "BLOCKED_probe" : "Deployment is not blocked. Release Owner completed Grant deployment access. BLOCKED_probe";
      (payload(value, 3).item as Row).text = text; value.comments[0]!.body = text;
    }
    if (name === "wrong-reply-run") value.comments[0]!.createdByRunId = "other";
    expect(gradeNativeCompletion(value).passed).toBe(false);
  });
  it.each([undefined, "other-issue"])("rejects missing or wrong native issue attribution %s", nativeIssueId => {
    const value = sample(); value.runs[0]!.nativeIssueId = nativeIssueId;
    expect(gradeNativeCompletion(value).passed).toBe(false);
  });
  it.each(["missing-action-envelope", "wrong-action-source", "missing-source-identity", "extra-wrong-source-result"])("rejects %s", name => {
    const value = sample();
    if (name === "missing-action-envelope") value.events[0]!.payload = {};
    if (name === "wrong-action-source") ((value.events[0]!.payload as Row).prpEvent as Row).sourceKind = "control_plane";
    if (name === "missing-source-identity") {
      delete value.events[0]!.sourceEventId;
      delete ((value.events[0]!.payload as Row).prpEvent as Row).sourceEventId;
    }
    if (name === "extra-wrong-source-result") {
      const extra = structuredClone(value.events[4]!);
      ((extra.payload as Row).prpEvent as Row).sourceKind = "runner";
      value.events = [...value.events, { ...extra, seq: 7 }];
    }
    expect(gradeNativeCompletion(value).passed).toBe(false);
  });
});
