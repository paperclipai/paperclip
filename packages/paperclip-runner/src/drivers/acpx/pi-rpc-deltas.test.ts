import { describe, expect, it } from "vitest";
import { PiAssistantMessages, PiRpcMessageDeltas, PiToolIdentities, piNativeFailure } from "./pi-acp-runtime.js";

// Pi 1 modes/json-event.js strips message and partial from message_update.
// The real SDK/package contract separately executes that actual serializer.
const start = (timestamp = 1) => ({ type: "message_start", message: { role: "assistant", timestamp, content: [], stopReason: "pending" } });
const end = (stopReason = "stop", timestamp = 1) => ({ type: "message_end", message: { role: "assistant", timestamp, content: [], stopReason } });
const delta = (type: string, contentIndex = 0, extra = {}) => ({ type: "message_update", usage: {}, assistantMessageEvent: { type, contentIndex, ...extra } });
function fixture() {
  const wire = new PiRpcMessageDeltas(); const messages = new PiAssistantMessages("00000000-0000-4000-8000-000000000001"); const tools = new PiToolIdentities("00000000-0000-4000-8000-000000000001");
  return (event: Record<string, unknown>) => tools.normalize(messages.normalize(wire.normalize(event)));
}

describe("pinned Pi 1 serialized message deltas", () => {
  it.each(["text", "thinking"])("binds %s deltas to the native occurrence without synthetic final content", kind => {
    const accept = fixture(); accept({ type: "turn_start" }); const first = accept(start());
    accept(delta(`${kind}_start`));
    const streamed = accept(delta(`${kind}_delta`, 0, { delta: "native text" }));
    expect(streamed.paperclipAssistantMessage).toMatchObject({ messageId: (first.paperclipAssistantMessage as any).messageId, phase: "delta" });
    expect(streamed.assistantMessageEvent).toMatchObject({ delta: "native text" });
    accept(delta(`${kind}_end`, 0, { content: "native text" }));
    expect(accept({ ...end(), message: { ...end().message, content: [{ type: kind, [kind === "text" ? "text" : "thinking"]: "native text" }] } }).paperclipAssistantMessage).toMatchObject({ phase: "end", stopReason: "stop" });
    accept({ type: "turn_end" }); accept({ type: "agent_settled" });
  });
  it.each(["text", "thinking"])("rejects a mismatched %s end and remains poisoned", kind => {
    const wire = new PiRpcMessageDeltas(); wire.normalize(start()); wire.normalize(delta(`${kind}_start`));
    wire.normalize(delta(`${kind}_delta`, 0, { delta: "observed" }));
    expect(() => wire.normalize(delta(`${kind}_end`, 0, { content: "different" }))).toThrow("boundary");
    expect(() => wire.normalize(start(2))).toThrow("boundary");
  });
  for (const kind of ["text", "thinking"]) for (const reason of ["stop", "error", "aborted"]) {
    it.each(["missing", "wrong-type", "different-content"])(`rejects %s final ${kind} content after a valid end (${reason})`, change => {
      const wire = new PiRpcMessageDeltas(); wire.normalize(start()); wire.normalize(delta(`${kind}_start`));
      wire.normalize(delta(`${kind}_delta`, 0, { delta: "observed" })); wire.normalize(delta(`${kind}_end`, 0, { content: "observed" }));
      const block = { type: change === "wrong-type" ? "toolCall" : kind, [kind === "text" ? "text" : "thinking"]: change === "different-content" ? "different" : "observed" };
      expect(() => wire.normalize({ ...end(reason), message: { ...end(reason).message, content: change === "missing" ? [] : [block] } })).toThrow("boundary");
      expect(() => wire.normalize(start(2))).toThrow("boundary");
    });
  }
  it("bounds aggregate streaming across blocks at exactly 4 MiB", () => {
    const wire = new PiRpcMessageDeltas(); wire.normalize(start());
    wire.normalize(delta("text_start", 0)); wire.normalize(delta("thinking_start", 1));
    const chunk = "x".repeat(262_144);
    for (let index = 0; index < 16; index++) expect(() => wire.normalize(delta(index % 2 ? "thinking_delta" : "text_delta", index % 2, { delta: chunk }))).not.toThrow();
    expect(() => wire.normalize(delta("text_delta", 0, { delta: "x" }))).toThrow("boundary");
    expect(() => wire.normalize(start(2))).toThrow("boundary");
  });
  it.each(["stop", "error", "aborted"])("retains a native final-only %s receipt without synthesizing streamed blocks", reason => {
    // Pi 1 agent-loop may emit start(finalMessage), end(finalMessage) when a
    // provider supplies a terminal result without a stream start. Unobserved
    // final blocks are native receipt content, not attested streamed deltas.
    const accept = fixture(); accept({ type: "turn_start" });
    const message = { ...end(reason).message, content: [{ type: "text", text: "native terminal body" }] };
    expect(accept({ type: "message_start", message }).assistantMessageEvent).toBeUndefined();
    const terminal = accept({ type: "message_end", message });
    expect(terminal.message).toEqual(message); expect(terminal.assistantMessageEvent).toBeUndefined();
    expect(terminal.paperclipAssistantMessage).toMatchObject({ phase: "end", stopReason: reason });
    accept({ type: "turn_end" }); accept({ type: "agent_settled" });
  });
  it("correlates interleaved tool indices and preserves final arguments and native IDs", () => {
    const accept = fixture(); accept({ type: "turn_start" }); accept(start());
    const ids = [0, 1].map(index => (accept(delta("toolcall_start", index, { id: `call_${index}`, toolName: `tool_${index}` })).assistantMessageEvent as any).toolCall.id);
    for (const index of [1, 0]) {
      expect((accept(delta("toolcall_delta", index, { delta: '{"value":' })).assistantMessageEvent as any).toolCall).toMatchObject({ id: ids[index], partialArgs: '{"value":' });
      accept(delta("toolcall_delta", index, { delta: `${index}}` }));
      const final = accept(delta("toolcall_end", index, { toolCall: { type: "toolCall", id: `call_${index}`, name: `tool_${index}`, arguments: { value: index } } }));
      expect((final.assistantMessageEvent as any).toolCall).toMatchObject({ id: ids[index], arguments: { value: index } });
    }
    accept({ ...end("toolUse"), message: { ...end("toolUse").message, content: [0, 1].map(index => ({ type: "toolCall", id: `call_${index}`, name: `tool_${index}`, arguments: { value: index } })) } });
    for (const index of [0, 1]) expect(accept({ type: "tool_execution_start", toolCallId: `call_${index}`, toolName: `tool_${index}`, args: { value: index } }).toolCallId).toBe(ids[index]);
  });
  it("defers an initially absent tool identity until its native final receipt", () => {
    const accept = fixture(); accept({ type: "turn_start" }); accept(start());
    expect((accept(delta("toolcall_start", 0, { id: "", toolName: "" })).assistantMessageEvent as any).toolCall.id).toBe("");
    accept(delta("toolcall_delta", 0, { delta: "{}" }));
    expect((accept(delta("toolcall_end", 0, { toolCall: { type: "toolCall", id: "final-id", name: "tool", arguments: {} } })).assistantMessageEvent as any).toolCall.id).toMatch(/^pi-/);
  });
  it.each(["missing", "foreign-id", "foreign-name", "foreign-arguments"])("rejects %s in the final native tool receipt", change => {
    const accept = fixture(); accept({ type: "turn_start" }); accept(start());
    const call = { type: "toolCall", id: "a", name: "tool", arguments: { value: 1 } };
    accept(delta("toolcall_start", 0, { id: "a", toolName: "tool" })); accept(delta("toolcall_end", 0, { toolCall: call }));
    const changed = { ...call, ...(change === "foreign-id" ? { id: "b" } : change === "foreign-name" ? { name: "other" } : change === "foreign-arguments" ? { arguments: { value: 2 } } : {}) };
    expect(() => accept({ ...end("toolUse"), message: { ...end("toolUse").message, content: change === "missing" ? [] : [changed] } })).toThrow("boundary");
  });
  it("rejects actual execution arguments that disagree with the completed native stream", () => {
    const accept = fixture(); accept({ type: "turn_start" }); accept(start());
    const call = { type: "toolCall", id: "a", name: "tool", arguments: { value: 1 } };
    accept(delta("toolcall_start", 0, { id: "a", toolName: "tool" })); accept(delta("toolcall_end", 0, { toolCall: call }));
    accept({ ...end("toolUse"), message: { ...end("toolUse").message, content: [call] } });
    expect(() => accept({ type: "tool_execution_start", toolCallId: "a", toolName: "tool", args: { value: 2 } })).toThrow("identity conflict");
  });
  it.each(["error", "aborted"])("closes incomplete stream blocks on authoritative %s, then admits a fresh occurrence", reason => {
    const accept = fixture(); accept({ type: "turn_start" }); accept(start()); accept(delta("text_start")); accept(end(reason)); accept({ type: "turn_end" }); accept({ type: "agent_settled" });
    accept({ type: "turn_start" }); expect(accept(start(2)).paperclipAssistantMessage).toMatchObject({ phase: "start" });
  });
  it.each([
    [delta("text_delta", 0, { delta: "orphan" })],
    [start(), delta("text_delta", 0, { delta: "no block" })],
    [start(), delta("text_start"), delta("text_start")],
    [start(), delta("text_start"), delta("thinking_delta", 0, { delta: "wrong kind" })],
    [start(), delta("text_start"), end()],
    [start(), end(), delta("text_start")],
    [start(), start()],
    [start(), delta("text_start", -1)],
    [start(), delta("text_start", 4096)],
    [start(), delta("text_start", 0.5)],
    [start(), delta("text_start"), delta("text_end", 0, { content: "" }), delta("text_delta", 0, { delta: "stale" })],
    [start(), { ...delta("text_start"), message: start().message }],
    [start(), delta("text_start", 0, { partial: {} })],
    [start(), delta("toolcall_start", 0, { id: "a", toolName: "tool" }), delta("toolcall_start", 1, { id: "a", toolName: "tool" })],
    [start(), delta("toolcall_start", 0, { id: "a", toolName: "tool" }), delta("toolcall_end", 0, { toolCall: { type: "toolCall", id: "b", name: "tool", arguments: {} } })],
    [start(), delta("toolcall_start", 0, { id: "a", toolName: "tool" }), delta("toolcall_end", 0, { toolCall: { type: "toolCall", id: "a", name: "other", arguments: {} } })],
    [start(), delta("text_start"), delta("text_delta", 0, { delta: "x".repeat(262_145) })],
  ])("rejects malformed, duplicate or stale wire sequences %# and remains poisoned", (...events) => {
    const wire = new PiRpcMessageDeltas();
    expect(() => { for (const event of events) wire.normalize(event as any); }).toThrow("boundary");
    expect(() => wire.normalize(start(2))).toThrow("boundary");
  });
});

describe("Pi diagnostic privacy", () => {
  it("retains exact known reasons while withholding arbitrary native content", () => {
    expect(piNativeFailure(new Error("Pi RPC message delta boundary is invalid"))).toMatchObject({ reason: "rpc_delta_boundary_invalid" });
    for (const sensitive of ["Bearer secret-canary", "/private/secret-canary", "https://example.invalid/?key=secret-canary"]) {
      expect(piNativeFailure(new Error(`401: ${sensitive}`))).toEqual({ reason: "provider_http_401", summary: "Pi provider request failed (HTTP 401)" });
      expect(JSON.stringify(piNativeFailure(new Error(sensitive)))).not.toContain("secret-canary");
      expect(piNativeFailure(new Error(sensitive)).reason).toBe("unknown_native_failure");
    }
    expect(piNativeFailure(new Error("Pi RPC message delta boundary is invalid Bearer secret-canary")).reason).toBe("unknown_native_failure");
  });
});
