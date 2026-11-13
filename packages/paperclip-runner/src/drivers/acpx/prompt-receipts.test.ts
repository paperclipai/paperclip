import { describe, expect, it } from "vitest";
import { createAcpxPromptReceiptCollector, parsePiPromptReceipt } from "./prompt-receipts.js";
import { createGrokSessionOpenGuard } from "./grok-session-rules.js";

const prompt = (id: number, sessionId = "s") => ({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [] } });
const cursorReceipt = { schema: "paperclip.cursor.native-usage.v1", promptId: "12345678-1234-1234-1234-123456789abc" };

describe("prompt response receipts", () => {
  it("collects only for Pi and Cursor", () => {
    for (const agent of ["claude", "codex", "grok", "copilot", "kimi"] as const) expect(createAcpxPromptReceiptCollector(agent)).toBeNull();
  });

  it("binds Pi cost provenance from this turn's own prompt reply", () => {
    const collector = createAcpxPromptReceiptCollector("pi")!;
    collector.begin("turn-1", "s");
    collector.observe("outbound", prompt(7));
    collector.observe("inbound", { jsonrpc: "2.0", id: 6, result: { usage: { _meta: { paperclipPi: { provenance: "assistant_message_receipts", costUsd: 9 } } } } });
    expect(collector.statusFields()).toEqual({});
    collector.observe("inbound", { jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn",
      usage: { _meta: { paperclipPi: { provenance: "assistant_message_receipts", costUsd: 0.12 } } } } });
    expect(collector.statusFields()).toEqual({ piPromptReceipt: { request_id: "turn-1", receipt: { provenance: "assistant_message_receipts", cost_usd: 0.12 } } });
    collector.begin("turn-2", "s");
    expect(collector.statusFields()).toEqual({});
  });

  it("binds a Cursor receipt only to a settled prompt reply", () => {
    const collector = createAcpxPromptReceiptCollector("cursor")!;
    collector.begin("turn-1", "s");
    collector.observe("outbound", prompt(3));
    collector.observe("inbound", { jsonrpc: "2.0", id: 3, result: { stopReason: "max_tokens", _meta: { paperclipCursorUsage: cursorReceipt } } });
    expect(collector.statusFields()).toEqual({});
    collector.begin("turn-2", "s");
    collector.observe("outbound", prompt(4));
    collector.observe("inbound", { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn", _meta: { paperclipCursorUsage: cursorReceipt } } });
    expect(collector.statusFields()).toEqual({ cursorPromptReceipt: { request_id: "turn-2", receipt: cursorReceipt } });
  });

  it("invalidates a turn with a foreign session, a second prompt, an error, or a repeated reply", () => {
    const reply = (id: number) => ({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", _meta: { paperclipCursorUsage: cursorReceipt } } });
    const cases: Array<(collector: NonNullable<ReturnType<typeof createAcpxPromptReceiptCollector>>) => void> = [
      c => { c.observe("outbound", prompt(1, "other")); c.observe("inbound", reply(1)); },
      c => { c.observe("outbound", prompt(1)); c.observe("outbound", prompt(2)); c.observe("inbound", reply(1)); },
      c => { c.observe("outbound", prompt(1)); c.observe("inbound", { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "x" } }); },
      c => { c.observe("outbound", prompt(1)); c.observe("inbound", reply(1)); c.observe("inbound", reply(1)); },
    ];
    for (const run of cases) {
      const collector = createAcpxPromptReceiptCollector("cursor")!;
      collector.begin("turn-1", "s");
      run(collector);
      expect(collector.statusFields()).toEqual({});
    }
  });

  it("accepts only proven Pi provenance with a valid cost", () => {
    expect(parsePiPromptReceipt({ provenance: "assistant_message_and_compaction_receipts" })).toEqual({ provenance: "assistant_message_and_compaction_receipts" });
    for (const raw of [undefined, {}, { provenance: "other" }, { provenance: "assistant_message_receipts", costUsd: -1 },
      { provenance: "assistant_message_receipts", costUsd: Infinity }, { provenance: "assistant_message_receipts", costUsd: "1" }]) {
      expect(parsePiPromptReceipt(raw)).toBeNull();
    }
  });
});

describe("Grok session open", () => {
  it("binds the model on every open and the rules on session/new, without needing an effort", () => {
    const guard = createGrokSessionOpenGuard({ rules: "Follow the task.", model: "grok-4.7" });
    const create = { method: "session/new", params: { cwd: "/w", _meta: { claudeCode: { options: {} }, systemPrompt: { append: "x" } } } };
    guard("outbound", create);
    expect(create.params).toEqual({ cwd: "/w", _meta: { rules: "Follow the task.", modelId: "grok-4.7" } });
    for (const method of ["session/load", "session/resume"]) {
      const reopen = { method, params: { sessionId: "s", _meta: { kept: true } } };
      guard("outbound", reopen);
      expect(reopen.params._meta).toEqual({ kept: true, modelId: "grok-4.7" });
    }
    const prompt = { method: "session/prompt", params: { sessionId: "s" } };
    guard("outbound", prompt);
    expect(prompt.params).toEqual({ sessionId: "s" });
    const inbound = { method: "session/new", params: {} };
    guard("inbound", inbound);
    expect(inbound.params).toEqual({});
  });
});
