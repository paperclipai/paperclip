import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAcpFormElicitation } from "./acp-question-adapter.js";
import { createPiLaunchSpec, PiAssistantMessages, piAssistantChunk, PiToolIdentities, PiRpcFrames, PiTurnUsage, PiUiBridge } from "./pi-acp-runtime.js";

const temporary: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
function fixture() {
  const connection = { requestPermission: vi.fn(), unstable_createElicitation: vi.fn() };
  const process = { sendExtensionUiResponse: vi.fn().mockResolvedValue(undefined) };
  return { connection, process, bridge: new PiUiBridge("session-a", connection, process) };
}

describe("Pi native assistant boundaries", () => {
  const namespace = "00000000-0000-4000-8000-000000000000";
  const message = (timestamp = 1, stopReason = "stop") => ({ role: "assistant", timestamp, content: [], stopReason });
  it("assigns actual message occurrences across warm prompts and preserves empty boundaries", () => {
    const messages = new PiAssistantMessages(namespace); const ids: unknown[] = [];
    for (const reason of ["toolUse", "stop", "length", "aborted", "error"]) {
      const start = messages.normalize({ type: "message_start", message: message() });
      const delta = messages.normalize({ type: "message_update", message: message(), assistantMessageEvent: { type: "thinking_delta", delta: "thought" } });
      const end = messages.normalize({ type: "message_end", message: message(1, reason) });
      const chunk = piAssistantChunk(start.paperclipAssistantMessage);
      ids.push(chunk.messageId);
      expect(chunk).toMatchObject({ content: { text: "" }, _meta: { kind: "start" } });
      expect(piAssistantChunk(delta.paperclipAssistantMessage, "thought", true)).toMatchObject({ messageId: chunk.messageId, sessionUpdate: "agent_thought_chunk" });
      expect(piAssistantChunk(end.paperclipAssistantMessage)).toMatchObject({ messageId: chunk.messageId, content: { text: "" }, _meta: { kind: `end:${reason}` } });
      messages.normalize({ type: "agent_settled" });
    }
    expect(new Set(ids).size).toBe(5);
    const loaded = new PiAssistantMessages("00000000-0000-4000-8000-000000000001");
    expect(piAssistantChunk(loaded.normalize({ type: "message_start", message: message() }).paperclipAssistantMessage).messageId).not.toBe(ids[0]);
  });
  it.each(["message_update", "message_end"])("rejects missing starts for %s and poisons subsequent input", type => {
    const messages = new PiAssistantMessages(namespace);
    expect(() => messages.normalize({ type, message: message() })).toThrow("boundary");
    expect(() => messages.normalize({ type: "message_start", message: message() })).toThrow("boundary");
  });
  it.each([
    { type: "message_start", message: message() },
    { type: "message_end", message: message(2) },
    { type: "message_end", message: message(1, "invented") },
    { type: "message_update", message: { role: "assistant", content: [] } },
    { type: "message_start", message: { role: "toolResult" } },
    { type: "agent_settled" },
  ])("rejects duplicate, reordered, malformed or missing ends: $type", event => {
    const messages = new PiAssistantMessages(namespace);
    messages.normalize({ type: "message_start", message: message() });
    expect(() => messages.normalize(event)).toThrow("boundary");
  });
  it("does not mint assistant identities for history, tools, retries or compaction", () => {
    const messages = new PiAssistantMessages(namespace);
    for (const event of [
      { type: "message_start", message: { role: "user" } },
      { type: "message_end", message: { role: "toolResult" } },
      { type: "auto_retry_end" }, { type: "compaction_end" }, { type: "agent_settled" },
    ]) expect(messages.normalize(event)).toEqual(event);
    expect(() => piAssistantChunk({ messageId: "invented", phase: "start" })).toThrow("provenance");
    const start = messages.normalize({ type: "message_start", message: message() });
    expect(() => piAssistantChunk(start.paperclipAssistantMessage, "synthetic")).toThrow("synthetic");
  });
});

describe("Pi occurrence identity", () => {
  const namespace = "00000000-0000-4000-8000-000000000000";
  it("aligns independent wrapper and extension counters without resetting warm prompts", () => {
    const wrapper = new PiToolIdentities(namespace); const extension = new PiToolIdentities(namespace);
    const ids: string[] = [];
    for (let iteration = 1; iteration <= 3; iteration++) {
      wrapper.normalize({ type: "turn_start" }); extension.begin();
      const id = extension.bind("call_0", "write", { path: "out", content: "x" }, true);
      const event = wrapper.normalize({ type: "tool_execution_start", toolCallId: "call_0", toolName: "write", args: { content: "x", path: "out" } });
      expect(event.toolCallId).toBe(id); expect(wrapper.provenance(id)).toMatchObject({ nativeToolCallId: "call_0", modelIteration: iteration });
      expect(wrapper.normalize({ type: "tool_execution_end", toolCallId: "call_0" }).toolCallId).toBe(id);
      ids.push(id); wrapper.normalize({ type: "turn_end" }); extension.end();
    }
    expect(new Set(ids).size).toBe(3);
  });
  it("poisons exhausted iteration and tool bounds", () => {
    const exhausted = new PiToolIdentities(namespace);
    // Exercise the numerical guard without performing MAX_SAFE_INTEGER turns.
    (exhausted as unknown as { ordinal: number }).ordinal = Number.MAX_SAFE_INTEGER;
    expect(() => exhausted.begin()).toThrow("ambiguous");
    expect(() => exhausted.identity("call")).toThrow("unavailable");
    const full = new PiToolIdentities(namespace); full.begin();
    for (let index = 0; index < 4096; index++) full.identity(`call_${index}`);
    expect(() => full.identity("call_4096")).toThrow("bound");
    expect(() => full.identity("call_0")).toThrow("unavailable");
  });
  it("fails closed on missing/duplicate iteration boundaries and ambiguous duplicate tools", () => {
    const missing = new PiToolIdentities(namespace);
    expect(() => missing.bind("call", "write", {})).toThrow("iteration");
    expect(() => missing.begin()).toThrow("ambiguous");
    const invalid = new PiToolIdentities(namespace); invalid.begin();
    expect(() => invalid.bind("call", "x".repeat(257), {})).toThrow("invalid");
    expect(() => invalid.bind("valid", "read", {})).toThrow("iteration");
    const duplicate = new PiToolIdentities(namespace); duplicate.begin();
    expect(() => duplicate.begin()).toThrow("ambiguous");
    expect(() => duplicate.identity("call")).toThrow("unavailable");
    const tools = new PiToolIdentities(namespace); tools.begin(); tools.bind("call", "write", {}, true);
    expect(() => tools.bind("call", "read", {}, true)).toThrow("conflict");
    expect(() => tools.bind("different", "read", {})).toThrow("iteration");
  });
});

describe("Pi ACP bridge", () => {
  it.each([
    ["select", { options: ["Red", "Blue"] }, "Blue", { value: "Blue" }],
    ["confirm", { message: "Proceed?" }, false, { confirmed: false }],
    ["input", { placeholder: "Name" }, "Ada", { value: "Ada" }],
    ["editor", { prefill: "Old\nText" }, "New\nText", { value: "New\nText" }],
  ])("round-trips %s as questions independently of permission auto-approval", async (method, extra, answer, expected) => {
    const f = fixture(); f.connection.unstable_createElicitation.mockResolvedValue({ action: "accept", content: { answer } });
    await f.bridge.handle({ id: "q1", method, title: "Choice", ...extra });
    expect(f.connection.requestPermission).not.toHaveBeenCalled();
    expect(f.connection.unstable_createElicitation).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-a", mode: "form", requestedSchema: expect.objectContaining({ required: ["answer"] }) }));
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "q1", ...expected });
  });

  it("transport preserves blank editor prefill and empty accept independently of canonical required validation", async () => {
    const f = fixture(); f.connection.unstable_createElicitation.mockResolvedValue({ action: "accept", content: { answer: "" } });
    await f.bridge.handle({ id: "blank", method: "editor", title: "Draft", prefill: "" });
    expect(f.connection.unstable_createElicitation.mock.calls[0]![0]).toMatchObject({ requestedSchema: { properties: { answer: { default: "" } } } });
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "blank", value: "" });
    f.connection.unstable_createElicitation.mockResolvedValue({ action: "cancel" });
    await f.bridge.handle({ id: "dismissed", method: "editor", title: "Draft", prefill: "" });
    expect(f.process.sendExtensionUiResponse).toHaveBeenLastCalledWith({ id: "dismissed", cancelled: true });
  });

  it.each(["input", "editor"])("documents canonical %s blank-answer rejection without inventing an empty accept", async method => {
    const f = fixture();
    f.connection.unstable_createElicitation.mockImplementation(async request => {
      const normalized = normalizeAcpFormElicitation(request)!;
      const question = normalized.questionSet.questions[0]!;
      expect(question.required).toBe(true);
      for (const text of ["", " \n\t"]) {
        expect(() => normalized.accept({ schema: "paperclip.question_response.v1", answers: { [question.id]: { text } } })).toThrow("is required");
      }
      return normalized.accept({ schema: "paperclip.question_response.v1", answers: { [question.id]: { text: "\nAccepted text\n" } } });
    });
    await f.bridge.handle({ id: "canonical", method, title: "Draft", prefill: "" });
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "canonical", value: "\nAccepted text\n" });
  });

  it.each(["", "  Draft\n界 🌒\n\\n literal  "])("delivers editor prefill %j through canonical initialText and returns only the exact edited answer", async prefill => {
    const f = fixture();
    const edited = "  Revised\n界 🌒\n\\n stays literal  ";
    f.connection.unstable_createElicitation.mockImplementation(async request => {
      const normalized = normalizeAcpFormElicitation(request)!;
      const question = normalized.questionSet.questions[0]!;
      expect(question).toMatchObject({ answerMode: "text", initialText: prefill, required: true });
      // Initial content is an editable draft, never an implicit answer.
      expect(f.process.sendExtensionUiResponse).not.toHaveBeenCalled();
      expect(() => normalized.accept({ schema: "paperclip.question_response.v1", answers: {} })).toThrow();
      expect(() => normalized.accept({ schema: "paperclip.question_response.v1", answers: { [question.id]: { text: "" } } })).toThrow("is required");
      return normalized.accept({ schema: "paperclip.question_response.v1", answers: { [question.id]: { text: edited } } });
    });
    await f.bridge.handle({ id: "canonical-prefill", method: "editor", title: "Draft", prefill });
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "canonical-prefill", value: edited });
  });

  it.each(["a".repeat(1000), "界".repeat(1000), "🌒".repeat(500)])("passes the canonical character limit through the real form normalizer", async (label) => {
    const f = fixture();
    f.connection.unstable_createElicitation.mockImplementation(async request => {
      const normalized = normalizeAcpFormElicitation(request)!;
      expect(normalized.questionSet.title).toBe(label);
      expect(normalized.questionSet.questions[0]!.options![0]!.label).toBe(label);
      return normalized.accept({ schema: "paperclip.question_response.v1", answers: { [normalized.questionSet.questions[0]!.id]: { selectedOptionIds: ["option-1"] } } });
    });
    await f.bridge.handle({ id: "boundary", method: "select", title: label, options: [label] });
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledWith({ id: "boundary", value: label });
  });

  it.each([
    { title: "a".repeat(1001), options: ["ok"] },
    { title: "ok", options: ["界".repeat(1001)] },
  ])("reports external unsupported questions without presenting or silently cancelling them", async extra => {
    const f = fixture();
    await expect(f.bridge.handle({ id: "oversize", method: "select", ...extra })).rejects.toThrow("unsupported or invalid");
    expect(f.connection.unstable_createElicitation).not.toHaveBeenCalled();
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "oversize", cancelled: true });
  });

  it("sends only offered native permission choices and keeps questions separate", async () => {
    const f = fixture(); f.connection.requestPermission.mockResolvedValue({ outcome: { outcome: "selected", optionId: "allow_always" } });
    const event = { id: "p1", method: "select", title: 'paperclip.pi.permission.v1:{"toolCallId":"tool-a","nativeToolCallId":"native-a","modelIteration":1,"toolName":"bash","input":{"command":"pwd"}}' };
    await f.bridge.handle(event);
    expect(f.connection.unstable_createElicitation).not.toHaveBeenCalled();
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "p1", value: "Allow for this session" });
    expect(f.connection.requestPermission.mock.calls[0]![0]).toMatchObject({ toolCall: { toolCallId: "tool-a", kind: "execute" }, options: [{ kind: "allow_once" }, { kind: "allow_always" }, { kind: "reject_once" }] });
    await f.bridge.handle(event); expect(f.connection.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("expires pending requests and discards a late answer exactly once", async () => {
    const f = fixture(); let answer!: (value: unknown) => void;
    f.connection.unstable_createElicitation.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const request = f.bridge.handle({ id: "q", method: "input", title: "Question" });
    f.bridge.cancelAll(); f.bridge.cancelAll();
    answer({ action: "accept", content: { answer: "stale" } }); await request;
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "q", cancelled: true });
  });

  it("honors Pi dialog deadlines and rejects invalid answers", async () => {
    vi.useFakeTimers(); const f = fixture(); let answer!: (value: unknown) => void;
    f.connection.unstable_createElicitation.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const request = f.bridge.handle({ id: "q", method: "select", title: "Question", options: ["A"], timeout: 100 });
    await vi.advanceTimersByTimeAsync(100);
    answer({ action: "accept", content: { answer: "not-an-offered-option" } }); await request;
    expect(f.process.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: "q", cancelled: true });
    f.connection.unstable_createElicitation.mockResolvedValue({ action: "accept", content: { answer: "other" } });
    await expect(f.bridge.handle({ id: "q2", method: "select", title: "Question", options: ["A"] })).rejects.toThrow("unsupported or invalid");
    expect(f.process.sendExtensionUiResponse).toHaveBeenLastCalledWith({ id: "q2", cancelled: true });
  });

  it("uses LF framing across UTF-8 chunks without splitting Unicode separators", () => {
    const seen: unknown[] = []; const frames = new PiRpcFrames((value) => seen.push(value));
    const bytes = Buffer.from(JSON.stringify({ text: "🌒\u2028\u2029" }) + "\r\n");
    for (const byte of bytes) frames.write(Uint8Array.of(byte)); frames.end();
    expect(seen).toEqual([{ text: "🌒\u2028\u2029" }]);
    expect(() => new PiRpcFrames(() => {}, 2).write(Buffer.from("xxx"))).toThrow("bound");
    const truncated = new PiRpcFrames(() => {}); truncated.write(Buffer.from('{"x":1}'));
    expect(() => truncated.end()).toThrow("inside");
  });

  it("reports actual incremental usage and resets the failure after a successful retry", () => {
    const usage = new PiTurnUsage(); const failed = { role: "assistant", timestamp: 1, stopReason: "error", usage: { input: 4, output: 1, cacheRead: 2, cacheWrite: 3, cost: { total: 0.01 } } };
    usage.accept(failed); usage.accept(failed);
    expect(usage.response()).toMatchObject({ usage: { totalTokens: 10 }, _meta: { jetbrains: { air: { sessionFailure: { severity: "error" } } } } });
    usage.accept({ ...failed, timestamp: 2, stopReason: "stop" });
    expect(usage.response()).toMatchObject({ usage: { inputTokens: 8, totalTokens: 20 } });
    usage.accept(failed); // A duplicate old failure cannot undo a successful retry.
    expect(usage.response()._meta).toBeUndefined();
    expect(usage.response()).toMatchObject({ usage: { _meta: { paperclipPi: { costUsd: 0.02, costSource: "pi_pricing_estimate" } } } });
    usage.reset(); expect(usage.response()).toEqual({});
  });

  it("does not invent missing cache totals or zero cost", () => {
    const usage = new PiTurnUsage();
    usage.accept({ role: "assistant", timestamp: 1, stopReason: "stop", usage: { input: 4, output: 2 } });
    expect(usage.response()).toEqual({ usage: {
      inputTokens: 4, outputTokens: 2, _meta: { paperclipPi: { provenance: "assistant_message_receipts" } },
    } });
    usage.accept({ role: "assistant", timestamp: 2, stopReason: "stop", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
    expect(usage.response()).toEqual({ usage: {
      inputTokens: 8, outputTokens: 4, _meta: { paperclipPi: { provenance: "assistant_message_receipts" } },
    } });
  });

  it("accounts compaction receipts once and does not fabricate partial coverage", () => {
    const usage = new PiTurnUsage();
    usage.accept({ role: "assistant", timestamp: 1, stopReason: "error", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } });
    const compacted = { firstKeptEntryId: "entry-2", tokensBefore: 100, summary: "Context summary", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: { total: 0.02 } } };
    usage.acceptCompaction(compacted); usage.acceptCompaction(compacted);
    expect(usage.response()).toMatchObject({ usage: { inputTokens: 11, outputTokens: 6, totalTokens: 19, _meta: { paperclipPi: { provenance: "assistant_message_and_compaction_receipts", costUsd: 0.03 } } }, _meta: { jetbrains: { air: { sessionFailure: { severity: "error" } } } } });
    usage.acceptCompaction({ summary: "Missing usage" });
    expect(usage.response().usage).toEqual({ _meta: { paperclipPi: { provenance: "assistant_message_and_compaction_receipts" } } });
  });

  it("launches verified paths only and rejects session escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-pi-launch-")); temporary.push(root);
    await mkdir(join(root, "sessions"));
    for (const name of ["node", "cli.js", "extension.js"]) await writeFile(join(root, name), "verified");
    const environment = {
      PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", PAPERCLIP_PI_READ_ONLY: "0",
      PAPERCLIP_PI_NODE_EXECUTABLE: join(root, "node"), PAPERCLIP_PI_ENTRYPOINT: join(root, "cli.js"), PAPERCLIP_PI_EXTENSION_PATH: join(root, "extension.js"),
      PI_CODING_AGENT_DIR: root,
    };
    const launch = createPiLaunchSpec({ cwd: root, mcpServers: [] }, environment);
    expect(launch.command).toBe(join(root, "node"));
    expect(launch.args).toEqual(expect.arrayContaining(["--no-extensions", "--no-approve", "--no-skills", "--offline"]));
    const ambient = createPiLaunchSpec({ cwd: root }, { ...environment, AGENT_HOME: "/ambient/unregistered" });
    expect(ambient.env.AGENT_HOME).toBeUndefined();
    expect(JSON.parse(ambient.env.PAPERCLIP_PI_RUNTIME_CONFIGURATION!).agentHome).toBeUndefined();
    const agentHome = await realpath(root);
    const bound = createPiLaunchSpec({ cwd: root }, { ...environment, AGENT_HOME: "/ambient/unregistered", PAPERCLIP_PI_AGENT_HOME: agentHome });
    expect(bound.env.AGENT_HOME).toBe(agentHome);
    expect(JSON.parse(bound.env.PAPERCLIP_PI_RUNTIME_CONFIGURATION!).agentHome).toBe(agentHome);
    for (const path of ["/", "relative", join(root, "cli.js")]) expect(() => createPiLaunchSpec({ cwd: root }, { ...environment, PAPERCLIP_PI_AGENT_HOME: path })).toThrow("registered directory");
    expect(() => createPiLaunchSpec({ cwd: root }, { ...environment, PAPERCLIP_PI_NODE_EXECUTABLE: "pi" })).toThrow("binding");
    await symlink(join(root, "cli.js"), join(root, "sessions", "escape.jsonl"));
    expect(() => createPiLaunchSpec({ cwd: root, sessionPath: join(root, "sessions", "escape.jsonl") }, environment)).toThrow("escaped");
  });
});
