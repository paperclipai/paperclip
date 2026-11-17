import { describe, expect, it } from "vitest";
import { createKimiInstructionAdmission, kimiInstructionBinding } from "./kimi-instructions.js";
import { kimiManagedConfiguration, kimiReadOnlyPermissionAllowed } from "./kimi-config.js";

function acknowledgment(content: string, sessionId = "native-1") {
  return { schema: "paperclip.kimi.instructions.v1", ...kimiInstructionBinding(content), sessionId,
    effectiveDigest: `sha256:${"a".repeat(64)}`, effectiveByteLength: 500 };
}

describe("Kimi native instruction admission", () => {
  it("keeps human questions and plans on the qualified semantic tool path", () => {
    const config = kimiManagedConfiguration("caller-model");
    for (const name of ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Agent", "AgentSwarm"]) {
      expect(config).toContain(JSON.stringify(name));
    }
  });
  it("admits exact UTF-8 instructions only after the correlated native reply, including ID zero", () => {
    const content = "Follow café instructions 🥔\n";
    const admission = createKimiInstructionAdmission(content);
    const guard = admission.createGuard();
    guard("outbound", { id: 0, method: "session/new", params: {} });
    guard("inbound", { id: 4, result: { sessionId: "native-1", _meta: { paperclipKimiInstructions: acknowledgment(content) } } });
    expect(admission.assertReady).toThrow("did not acknowledge");
    guard("inbound", { id: 0, result: { sessionId: "native-1", _meta: { paperclipKimiInstructions: acknowledgment(content) } } });
    expect(admission.assertReady).not.toThrow();
    guard("outbound", { id: 1, method: "session/prompt", params: { sessionId: "native-1" } });
  });

  it.each(["missing", "content", "session", "length", "effective"])("rejects %s proof before a prompt", kind => {
    const admission = createKimiInstructionAdmission("rules");
    const guard = admission.createGuard();
    guard("outbound", { id: "load", method: "session/load", params: { sessionId: "native-1" } });
    const ack = acknowledgment("rules");
    if (kind === "content") ack.digest = kimiInstructionBinding("different").digest;
    if (kind === "session") ack.sessionId = "other";
    if (kind === "length") ack.byteLength += 1;
    if (kind === "effective") ack.effectiveDigest = "unknown";
    expect(() => guard("inbound", { id: "load", result: { _meta: kind === "missing" ? {} : { paperclipKimiInstructions: ack } } })).toThrow("mismatched");
    expect(() => guard("outbound", { id: 2, method: "session/prompt", params: { sessionId: "native-1" } })).toThrow();
  });

  it("revokes the old connection and requires proof again after load", () => {
    const admission = createKimiInstructionAdmission("");
    const old = admission.createGuard();
    old("outbound", { id: 1, method: "session/new", params: {} });
    old("inbound", { id: 1, result: { sessionId: "native-1", _meta: { paperclipKimiInstructions: acknowledgment("") } } });
    const current = admission.createGuard();
    expect(() => old("outbound", { method: "session/prompt" })).toThrow("replaced");
    current("outbound", { id: 2, method: "session/load", params: { sessionId: "native-1" } });
    expect(admission.assertReady).toThrow();
    current("inbound", { id: 2, result: { _meta: { paperclipKimiInstructions: acknowledgment("") } } });
    expect(admission.assertReady).not.toThrow();
    expect(() => current("outbound", { method: "session/prompt", params: { sessionId: "other" } })).toThrow("unacknowledged");
  });

  it("bounds exact byte content rather than JavaScript character count", () => {
    expect(() => kimiInstructionBinding("🧪".repeat(8193))).toThrow("bounded");
    expect(() => kimiInstructionBinding("bad\0input")).toThrow("NUL");
  });

  it("keeps read-only authority separate from native tool labels and auto-approval", () => {
    const owned = new Set(["paperclip"]);
    for (const title of ["Write", "Edit", "Bash", "Read", "mcp__other__read", "mcp__paperclip__"]) {
      expect(kimiReadOnlyPermissionAllowed({ inferredKind: "read", raw: { toolCall: { title, rawInput: {} } } }, owned)).toBe(false);
    }
    expect(kimiReadOnlyPermissionAllowed({ raw: { toolCall: { title: "mcp__paperclip__get_task_context", rawInput: {} } } }, owned)).toBe(true);
    expect(kimiReadOnlyPermissionAllowed({ raw: { toolCall: { title: "mcp__paperclip__get_task_context" } } }, owned)).toBe(false);
    expect(kimiReadOnlyPermissionAllowed({ raw: { toolCall: { title: "mcp__paperclip__get_task_context", rawInput: [] } } }, owned)).toBe(false);
  });
});
