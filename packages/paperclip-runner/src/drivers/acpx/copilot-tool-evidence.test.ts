import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateAcpxRichEvent } from "./profile-extensions.js";
import type { CanonicalProviderEvent } from "../../provider-events.js";
import { createCopilotToolEvidence } from "./copilot-tool-evidence.js";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/copilot-tool-evidence.json", import.meta.url), "utf8"));
const details = (e: CanonicalProviderEvent) => Object.fromEntries((e.payload.details as Array<{ name: string; value: string }>).map(d => [d.name, d.value]));
function harness(sessionId = "session") {
  const events: CanonicalProviderEvent[] = []; let active = true;
  const projector = createCopilotToolEvidence({ sessionId, turnId: "turn", workingDirectory: "/fixture/workspace", active: () => active,
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
