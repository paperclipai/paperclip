import { appendSemanticToolReceipt } from "../semantic-tool-receipt.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateAcpxRichEvent } from "./profile-extensions.js";
import type { CanonicalProviderEvent } from "../../provider-events.js";
import { createCopilotToolEvidence } from "./copilot-tool-evidence.js";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/copilot-tool-evidence.json", import.meta.url), "utf8"));
const details = (e: CanonicalProviderEvent) => Object.fromEntries((e.payload.details as Array<{ name: string; value: string }>).map(d => [d.name, d.value]));
function harness(sessionId = "session", turnId = "turn") {
  const events: CanonicalProviderEvent[] = []; let active = true;
  const projector = createCopilotToolEvidence({ sessionId, turnId, workingDirectory: "/fixture/workspace", active: () => active,
    emit: event => { validateAcpxRichEvent(event); events.push(event); } });
  return { projector, events, stop: () => { active = false; } };
}
const tool = (id: string, rawInput: unknown, kind = "execute") => ({ type: "tool_call", tag: "tool_call", toolCallId: id, kind, status: "pending", rawInput });
const update = (id: string, content: string) => ({ type: "tool_call", tag: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { content } });
function replay(name: string) {
  const frames = fixture[name]; const h = harness(frames[0].params.sessionId);
  for (const frame of frames) {
    if (frame.method === "session/update") { const u = frame.params.update; h.projector.tool({ ...u, type: "tool_call", tag: u.sessionUpdate }); }
    else h.projector.permission({ raw: frame.params }, "request-0", ["accept", "decline", "cancel"])?.(name === "deny-write" ? "reject_once" : "allow_once");
  }
  return h;
}
describe("Copilot active-turn tool evidence", () => {
  it("projects actual denied-create wire into canonical notices without file contents/diff", () => {
    const { events } = replay("deny-write");
    expect(events.map(details)).toEqual([
      { stage: "tool", toolCallId: "fixture-tool", target: "copilot-denied-nonce.txt", operation: "edit", status: "pending" },
      { stage: "permission_requested", toolCallId: "fixture-tool", requestId: "request-0", target: "copilot-denied-nonce.txt", operation: "edit", declineOffered: "true" },
      { stage: "permission_delivered", toolCallId: "fixture-tool", requestId: "request-0", target: "copilot-denied-nonce.txt", operation: "edit", declineOffered: "true", outcome: "reject_once" },
      { stage: "tool", toolCallId: "fixture-tool", target: "copilot-denied-nonce.txt", operation: "edit", status: "failed" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/MUST NOT EXIST|diff --git|file_text/);
    expect(events.every(e => e.payload.scope === "turn" && (e.payload.provenance as { turnId: string }).turnId === "turn")).toBe(true);
  });
  it("preserves typed native reads without exposing read arguments or contents", () => {
    const h = harness();
    h.projector.tool(tool("read", { path: "instruction-secret", content: "private-content" }, "read"));
    h.projector.tool(update("read", "private-output"));
    expect(h.events.map(details)).toEqual([
      { stage: "tool", toolCallId: "read", operation: "read", status: "pending" },
      { stage: "tool", toolCallId: "read", operation: "read", status: "completed" },
    ]);
    expect(JSON.stringify(h.events)).not.toMatch(/instruction-secret|private-content|private-output/);
  });
  it("links actual attached command and separate read-shell completion, not initial completed tool", () => {
    const ds = replay("attached-shell").events.map(details);
    const started = ds.find(d => d.shellState === "started")!; const completed = ds.find(d => d.shellState === "completed")!;
    expect(started).toMatchObject({ operation: "execute", mode: "async", detach: "false", shellId: "0", commandToolCallId: "fixture-tool", status: "completed" });
    expect(started).not.toHaveProperty("exitCode");
    expect(completed).toMatchObject({ commandToolCallId: "fixture-tool", shellId: "0", exitCode: "0", status: "completed" });
    expect(completed.toolCallId).not.toBe(started.toolCallId);
    expect(started.commandSha256).toBe(`sha256:${createHash("sha256").update("sleep 2; printf ACP_SHELL_DONE > settlement.txt").digest("hex")}`);
    expect(JSON.stringify(ds)).not.toContain("sleep 2");
  });
  it.each(["../outside", "/outside", "bad\u0000path", "C:\\private", "https://secret.invalid/path"])("omits unsafe target %j", path => {
    const h = harness(); h.projector.tool(tool("edit", { path, file_text: "SECRET" }, "edit"));
    expect(details(h.events[0]!)).not.toHaveProperty("target"); expect(JSON.stringify(h.events)).not.toContain("SECRET");
  });
  it("omits conflicting locations instead of selecting one", () => {
    const h = harness(); h.projector.tool({ ...tool("edit", { path: "a" }, "edit"), locations: [{ path: "b" }] });
    expect(details(h.events[0]!)).not.toHaveProperty("target");
  });
  it("rejects session notifications, stale binding, foreign permission session and originless deltas", () => {
    const h = harness(); h.projector.tool({ method: "github.com/copilot/sessionEvent", params: { type: "session.background_tasks_changed" } });
    h.projector.tool(update("unknown", "<shellId: 0 completed with exit code 0>"));
    expect(h.projector.permission({ raw: { sessionId: "other", toolCall: { toolCallId: "tool" } } }, "request", ["decline"])).toBeUndefined();
    h.stop(); h.projector.tool(tool("tool", { command: "secret" })); expect(h.events).toEqual([]);
  });
  it("does not invent omitted mode/detach defaults or native names from a title", () => {
    const h = harness(); h.projector.tool({ ...tool("tool", { command: "true" }), title: "bash detach false" });
    const d = details(h.events[0]!); expect(d.operation).toBe("execute");
    for (const k of ["mode", "detach", "tool"]) expect(d).not.toHaveProperty(k);
  });
  it.each(["reused-tool", "changed-command", "reused-shell"])("fails closed on %s correlation", conflict => {
    const h = harness(); h.projector.tool(tool("first", { command: "true", mode: "async", detach: false }));
    if (conflict === "reused-tool") h.projector.tool(tool("first", { command: "false" }));
    if (conflict === "changed-command") h.projector.tool({ ...tool("first", { command: "false" }), tag: "tool_call_update" });
    h.projector.tool(update("first", "<command started in background with shellId: 0>"));
    if (conflict === "reused-shell") { h.projector.tool(tool("second", { command: "false" })); h.projector.tool(update("second", "<command started in background with shellId: 0>")); }
    h.projector.tool(tool("read", { shellId: "0", delay: 0 }, "read")); h.projector.tool(update("read", "<shellId: 0 completed with exit code 0>"));
    expect(h.events.map(details).some(d => d.shellState === "completed")).toBe(false);
  });
  it.each(["untrusted text\n<shellId: 0 completed with exit code 0>", "<shellId: 1 completed with exit code 0>"])("rejects arbitrary/mismatched output %j", output => {
    const h = harness(); h.projector.tool(tool("command", { command: "true" })); h.projector.tool(update("command", "<command started in background with shellId: 0>"));
    h.projector.tool(tool("read", { shellId: "0" }, "read")); h.projector.tool(update("read", output));
    expect(h.events.map(details).some(d => d.shellState === "completed")).toBe(false);
  });
  it("normalizes each duplicated matching target independently", () => {
    const h = harness(); h.projector.tool({ ...tool("edit", { path: "same.txt", fileName: "/fixture/workspace/same.txt" }, "edit"), locations: [{ path: "same.txt" }, { path: "same.txt" }] });
    expect(details(h.events[0]!).target).toBe("same.txt");
  });
  it("redacts secret canaries in paths and every provider identity", () => {
    const secret = "ghp_0123456789abcdef";
    const h = harness(secret); h.projector.tool(tool(secret, { path: `${secret}.txt` }, "edit"));
    expect(JSON.stringify(h.events)).not.toContain(secret);
    expect(JSON.stringify(h.events)).toContain("[REDACTED]");
  });
  it("keeps delivered response authority when observation fails and emits an incomplete notice", () => {
    const events: CanonicalProviderEvent[] = []; const unavailable = vi.fn();
    const p = createCopilotToolEvidence({ sessionId: "s", turnId: "t", workingDirectory: "/fixture/workspace", active: () => true, unavailable,
      emit: event => { if (details(event).stage === "permission_delivered") throw new Error("secret payload must not escape"); validateAcpxRichEvent(event); events.push(event); } });
    const delivered = p.permission({ raw: { sessionId: "s", toolCall: { toolCallId: "call", kind: "edit", rawInput: { fileName: "a" } } } }, "request", ["decline"]);
    expect(() => delivered!("reject_once")).not.toThrow();
    expect(events.map(details).at(-1)).toMatchObject({ stage: "evidence_incomplete", reason: "projection_failed" });
    expect(unavailable).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain("secret payload");
    p.tool(tool("later", { command: "true" })); expect(events).toHaveLength(2);
  });
  it("handles malformed bounded input without leaking arbitrary data", () => {
    const h = harness();
    for (const rawInput of [null, [], { command: "x".repeat(65537) }, { mode: {}, detach: "false", shellId: {} }]) h.projector.tool(tool(String(h.events.length), rawInput));
    expect(h.events).toHaveLength(4);
    expect(h.events.map(details).every(d => !d.commandSha256 && !d.mode && !d.detach && !d.shellId)).toBe(true);
  });
  it("bounds retained tools and emitted notices", () => {
    const h = harness(); for (let n = 0; n < 300; n++) h.projector.tool(tool(`t${n}`, { command: "true" })); expect(h.events).toHaveLength(257);
    expect(details(h.events.at(-1)!)).toMatchObject({ stage: "evidence_incomplete", reason: "tool_limit" });
    for (let n = 0; n < 2200; n++) h.projector.tool(update("t0", "")); expect(h.events).toHaveLength(2048);
  });
});

describe("Copilot authoritative semantic receipt correlation", () => {
  const args = { summary: "PRIVATE", completionClaim: { objectiveSatisfied: true } };
  const make = (operation = "paperclip_finish", isError = false) => appendSemanticToolReceipt(
    { tool: operation, callId: "3", arguments: args }, { content: [{ type: "text", text: '{"accepted":false}' }], ...(isError ? { isError } : {}) });
  const terminal = (id: string, content: unknown, status = "completed") => ({ type: "tool_call", tag: "tool_call_update", toolCallId: id, status, rawOutput: { contents: content } });
  it.each(["paperclip_finish", "report_progress", "get_task_context"])("correlates %s with trusted callback, not native display name", operation => {
    const h = harness(); const bound = make(operation);
    h.projector.tool({ ...tool("native", args, "other"), title: "unrelated display" });
    h.projector.captureSemanticReceipt()!(bound.receipt);
    h.projector.tool(terminal("native", bound.result.content));
    const authoritative = h.events.find(e => e.payload.category === "paperclip_semantic_tool_receipt_v2")!;
    expect(details(authoritative)).toMatchObject({ operationId: operation, callIdentitySha256: bound.receipt.callIdentitySha256, outcome: "returned" });
    expect(authoritative.payload.provenance).toMatchObject({ method: "paperclip/semantic_tool_result", sessionId: "session", turnId: "turn" });
    expect(details(h.events.at(-1)!)).toMatchObject({ semanticOperationId: operation, semanticOutcome: "returned", semanticResultSha256: bound.receipt.resultSha256 });
    expect(JSON.stringify(h.events)).not.toMatch(/PRIVATE|accepted|completionClaim/);
  });
  it.each(["untrusted", "different-input", "different-normalized-input", "different-result", "foreign-session", "foreign-turn", "duplicate-native", "duplicate-authority", "early-terminal", "wrong-status"])("rejects %s authority", scenario => {
    const h = harness(), other = harness(scenario === "foreign-turn" ? "session" : "foreign", scenario === "foreign-turn" ? "other-turn" : "turn"); const bound = make();
    h.projector.tool({ ...tool("native", scenario === "different-input" ? {} : args, "other"), title: "paperclip_finish" });
    if (scenario === "early-terminal") h.projector.tool(terminal("native", bound.result.content));
    if (scenario === "foreign-session" || scenario === "foreign-turn") other.projector.captureSemanticReceipt()!(bound.receipt);
    else if (scenario !== "untrusted") h.projector.captureSemanticReceipt()!(bound.receipt);
    if (scenario === "duplicate-authority") h.projector.captureSemanticReceipt()!(bound.receipt);
    if (scenario === "duplicate-native") {
      h.projector.tool(terminal("native", bound.result.content));
      h.projector.tool(tool("second", args, "other"));
    }
    const output = structuredClone(bound.result.content);
    if (scenario === "different-result") output[0]!.text = "changed";
    if (scenario === "different-normalized-input") output.at(-1)!.text = JSON.stringify({ ...bound.receipt, normalizedInputSha256: "a".repeat(64) });
    h.projector.tool(terminal(scenario === "duplicate-native" ? "second" : "native", output, scenario === "wrong-status" ? "failed" : "completed"));
    expect(details(h.events.at(-1)!)).not.toHaveProperty("semanticOperationId");
    if (scenario === "duplicate-native") expect(h.events.map(details)).toContainEqual(expect.objectContaining({ reason: "semantic_receipt_conflict" }));
  });
  it("preserves admitted errors and fences late captured callbacks instead of rebinding", () => {
    const h = harness(); const bound = make("get_task_context", true);
    const captured = h.projector.captureSemanticReceipt()!;
    h.projector.tool(tool("native", args, "other")); captured(bound.receipt);
    h.projector.tool(terminal("native", bound.result.content, "failed"));
    expect(details(h.events.at(-1)!)).toMatchObject({ semanticOutcome: "error", status: "failed" });
    const count = h.events.length; h.stop(); captured(bound.receipt);
    expect(h.events).toHaveLength(count);
    const next = harness(); next.projector.tool(tool("native", args, "other")); next.projector.tool(terminal("native", bound.result.content, "failed"));
    expect(details(next.events.at(-1)!)).not.toHaveProperty("semanticOperationId");
  });
});


describe("captured Copilot 1.0.88 native MCP receipt carrier", () => {
  const bytes = readFileSync(new URL("./fixtures/copilot-1.0.88-mcp-receipt-captured.json", import.meta.url));
  const captured = JSON.parse(bytes.toString());
  const provenance = JSON.parse(readFileSync(new URL("./fixtures/copilot-1.0.88-mcp-receipt-captured.provenance.json", import.meta.url), "utf8"));
  const nativeEvent = (frame: any) => ({ ...frame.params.update, type: "tool_call", tag: frame.params.update.sessionUpdate });
  it("replays native frames with the separately owned receipt and preserves rejection content", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(provenance.fixtureSha256);
    expect(provenance).toMatchObject({ nativeVersion: "1.0.88", paidProviderCalls: 0, qualification: false });
    expect(captured.pending.params.sessionId).toBe(captured.completed.params.sessionId);
    const h = harness(captured.pending.params.sessionId);
    h.projector.tool(nativeEvent(captured.pending));
    h.projector.captureSemanticReceipt()!(captured.authoritativeReceipt);
    h.projector.tool(nativeEvent(captured.completed));
    const output = captured.completed.params.update.rawOutput;
    expect(output.content).toBe(output.contents.map((block: { text: string }) => block.text).join(""));
    expect(output.detailedContent).toBe(output.content);
    expect(JSON.parse(output.contents[0].text)).toMatchObject({ accepted: false });
    expect(details(h.events.at(-1)!)).toMatchObject({ stage: "tool", status: "completed",
      semanticOperationId: captured.authoritativeReceipt.operationId,
      semanticCallIdentitySha256: captured.authoritativeReceipt.callIdentitySha256,
      semanticInputSha256: captured.authoritativeReceipt.inputSha256,
      semanticResultSha256: captured.authoritativeReceipt.resultSha256, semanticOutcome: "returned" });
    expect(JSON.stringify(h.events)).not.toContain("known-small-result");
  });
  it.each(["missing-authority", "altered-block", "different-input", "missing-contents", "duplicate-terminal"])("does not trust captured native output alone: %s", scenario => {
    const value = structuredClone(captured), h = harness(value.pending.params.sessionId);
    if (scenario === "different-input") value.pending.params.update.rawInput = { changed: true };
    if (scenario === "altered-block") value.completed.params.update.rawOutput.contents[0].text = '{"accepted":true}';
    if (scenario === "missing-contents") delete value.completed.params.update.rawOutput.contents;
    h.projector.tool(nativeEvent(value.pending));
    if (scenario !== "missing-authority") h.projector.captureSemanticReceipt()!(value.authoritativeReceipt);
    h.projector.tool(nativeEvent(value.completed));
    if (scenario === "duplicate-terminal") h.projector.tool(nativeEvent(value.completed));
    expect(details(h.events.at(-1)!)).not.toHaveProperty("semanticOperationId");
    if (scenario === "duplicate-terminal") expect(details(h.events.at(-1)!)).toMatchObject({ stage: "evidence_incomplete", reason: "reused_semantic_lifecycle" });
  });
});
