import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_ADMISSION_SCHEMA, createAntigravityAdmission } from "./antigravity-admission.js";

const content = "  Exact governance 🧷\n\n";
const model = "caller/model-not-in-catalog";
const initialize = { agentInfo: { name: "antigravity-acp", version: "1.4.3" }, agentCapabilities: { _meta: { antigravity: { paperclipAdmission: 1 } } } };
function fixture() {
  const admission = createAntigravityAdmission(content, model);
  const guard = admission.createGuard();
  guard("outbound", { id: "init", method: "initialize", params: {} });
  guard("inbound", { id: "init", result: structuredClone(initialize) });
  return { admission, guard };
}
function request(f: ReturnType<typeof fixture>, method = "session/new", id: string | number = 0) {
  const message = { id, method, params: { ...(method === "session/new" ? {} : { sessionId: "native-session" }) } as Record<string, unknown> };
  f.guard("outbound", message);
  return message;
}
function response(message: ReturnType<typeof request>, changes: Record<string, unknown> = {}) {
  const meta = message.params._meta as { antigravity: { paperclipAdmission: Record<string, unknown> } };
  return { id: message.id, result: {
    sessionId: "native-session", models: { currentModelId: model }, modes: { currentModeId: "default" },
    _meta: { paperclipAntigravityAdmission: {
      ...meta.antigravity.paperclipAdmission, sessionId: "native-session", connectionId: "native-connection", ...changes,
    } },
  } };
}
const prompt = () => ({ id: "turn", method: "session/prompt", params: { sessionId: "native-session", prompt: [{ type: "text", text: "Do the task" }] } });

describe("Antigravity exact native admission", () => {
  it("preserves whitespace/Unicode and binds a native receipt to request ID zero", () => {
    const f = fixture(); const sent = request(f);
    const meta = sent.params._meta as { antigravity: Record<string, unknown> };
    expect(meta.antigravity.systemPrompt).toEqual({ append: content });
    expect(meta.antigravity.paperclipAdmission).toMatchObject({ schema: ANTIGRAVITY_ADMISSION_SCHEMA, model, byteLength: Buffer.byteLength(content) });
    f.guard("inbound", response(sent));
    expect(() => f.admission.assertReady()).not.toThrow();
    expect(() => f.guard("outbound", prompt())).not.toThrow();
  });

  it.each(["session/load", "session/resume"])("requires a new exact receipt on %s", method => {
    const f = fixture(); const first = request(f); f.guard("inbound", response(first));
    const load = request(f, method, "reloaded");
    expect(() => f.admission.assertReady()).toThrow("receipt is missing");
    const ack = response(load);
    expect(ack.result._meta.paperclipAntigravityAdmission.nonce).not.toBe(response(first).result._meta.paperclipAntigravityAdmission.nonce);
    f.guard("inbound", ack);
    expect(() => f.guard("outbound", prompt())).not.toThrow();
  });

  it.each([
    { digest: "sha256:wrong" }, { byteLength: 1 }, { nonce: "stale-request" },
    { sessionId: "other-session" }, { model: "fallback" }, { connectionId: "" }, { schema: "wrong" },
  ])("rejects a mismatched native receipt %j before prompting", mutation => {
    const f = fixture(); const sent = request(f);
    expect(() => f.guard("inbound", response(sent, mutation))).toThrow("receipt");
    expect(() => f.guard("outbound", prompt())).toThrow();
  });

  it("rejects an ordinary successful ACP response without native content proof", () => {
    const f = fixture(); const sent = request(f);
    expect(() => f.guard("inbound", { id: sent.id, result: { sessionId: "native-session" } })).toThrow("receipt");
  });

  it("does not inherit authority from a previous stdio connection", () => {
    const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
    const next = f.admission.createGuard();
    expect(() => f.guard("outbound", prompt())).toThrow("replaced");
    expect(() => next("outbound", prompt())).toThrow("unacknowledged");
  });

  it("preserves the provider's original session error and never admits a prompt", () => {
    const f = fixture(); const sent = request(f);
    expect(() => f.guard("inbound", { id: sent.id, error: { code: -32000, message: "Authentication required" } })).not.toThrow();
    expect(() => f.admission.assertReady()).toThrow("receipt is missing");
    expect(() => f.guard("outbound", prompt())).toThrow();
  });

  it("rejects native model replacement and permission-mode changes", () => {
    for (const update of [
      { sessionUpdate: "config_option_update", models: { currentModelId: "fallback" } },
      { sessionUpdate: "current_mode_update", currentModeId: "yolo" },
    ]) {
      const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
      expect(() => f.guard("inbound", { method: "session/update", params: { sessionId: "native-session", update } })).toThrow();
      expect(() => f.guard("outbound", prompt())).toThrow();
    }
  });

  it("requires a fresh configuration receipt after exact-model control", () => {
    const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
    const control = { id: "model-control", method: "session/set_config_option", params: { sessionId: "native-session", configId: "model", value: model } as Record<string, unknown> };
    f.guard("outbound", control);
    expect(() => f.admission.assertReady()).toThrow();
    f.guard("inbound", response(control));
    expect(() => f.admission.assertReady()).not.toThrow();
  });

  it("rejects native slash commands, non-text prompts, and arbitrary configuration", () => {
    for (const message of [
      { ...prompt(), params: { ...prompt().params, prompt: [{ type: "text", text: "  /logout" }] } },
      { ...prompt(), params: { ...prompt().params, prompt: [{ type: "image", data: "unverified" }] } },
      { id: "control", method: "session/set_config_option", params: { sessionId: "native-session", configId: "mode", value: "yolo" } },
    ]) {
      const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
      expect(() => f.guard("outbound", message)).toThrow();
    }
  });

  it.each(["Do the task\n/logout", "Do the task\r\n  /model replace", "Do the task\r /login"])("rejects a native slash command on any prompt line: %j", text => {
    const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
    expect(() => f.guard("outbound", { ...prompt(), params: { ...prompt().params, prompt: [{ type: "text", text }] } })).toThrow("slash commands");
  });

  it("rejects a native slash command in a later text block", () => {
    const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
    expect(() => f.guard("outbound", { ...prompt(), params: { ...prompt().params, prompt: [{ type: "text", text: "Do the task" }, { type: "text", text: "/logout" }] } })).toThrow("slash commands");
  });

  it("rejects unpatched native runtimes before creating a session", () => {
    const f = createAntigravityAdmission("", model); const guard = f.createGuard();
    guard("outbound", { id: 0, method: "initialize", params: {} });
    expect(() => guard("inbound", { id: 0, result: { agentInfo: initialize.agentInfo, agentCapabilities: {} } })).toThrow("patch");
  });
});

describe("Antigravity native questions", () => {
  function admitted() {
    const f = fixture(); const sent = request(f); f.guard("inbound", response(sent)); return f;
  }
  const question = () => ({ id: 0, method: "session/request_permission", params: {
    sessionId: "native-session", toolCall: { toolCallId: "interaction_123", title: "Choose a deployment" },
    options: [{ optionId: "allow/weird:α", name: "Deploy", kind: "allow_once" }, { optionId: "deny", name: "Keep it local", kind: "reject_once" }],
  } });

  it("converts permission-shaped choices into a form and preserves a deny choice as an answer", () => {
    const f = admitted(); const q = question(); f.guard("inbound", q);
    expect(q.method).toBe("elicitation/create");
    expect(q.params).toMatchObject({ mode: "form", requestedSchema: { required: ["answer"], properties: {
      answer: { oneOf: [{ const: "allow/weird:α", title: "Deploy" }, { const: "deny", title: "Keep it local" }] },
    } } });
    const answer = { id: 0, result: { action: "accept", content: { answer: "deny" } } as Record<string, unknown> };
    f.guard("outbound", answer);
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
  });

  it("passes ordinary tool permissions through unchanged", () => {
    const f = admitted(); const q = question(); q.params.toolCall.toolCallId = "command_123";
    const before = structuredClone(q); f.guard("inbound", q); expect(q).toEqual(before);
  });

  it.each(["forged", ["deny", "allow/weird:α"]])("rejects forged or multiple answers %j", answer => {
    const f = admitted(); const q = question(); f.guard("inbound", q);
    expect(() => f.guard("outbound", { id: 0, result: { action: "accept", content: { answer } } })).toThrow("offered choice");
  });

  it("maps explicit cancellation and rejects duplicate native request identities", () => {
    const f = admitted(); f.guard("inbound", question());
    const answer = { id: 0, result: { action: "cancel" } as Record<string, unknown> };
    f.guard("outbound", answer); expect(answer.result).toEqual({ outcome: { outcome: "cancelled" } });
    f.guard("inbound", question());
    expect(() => f.guard("inbound", question())).toThrow("identity");
  });

  it("retires old questions when a new native session replaces their authority", () => {
    const f = admitted(); f.guard("inbound", question());
    const sent = request(f, "session/new", "new-session-request"), ack = response(sent, { sessionId: "new-native-session" });
    ack.result.sessionId = "new-native-session"; f.guard("inbound", ack);
    const late = { id: 0, result: { action: "accept", content: { answer: "deny" } } };
    expect(() => f.guard("outbound", late)).not.toThrow();
    expect(late.result).toEqual({ action: "accept", content: { answer: "deny" } });
    const next = question(); next.params.sessionId = "new-native-session";
    expect(() => f.guard("inbound", next)).not.toThrow();
    expect(next.method).toBe("elicitation/create");
    expect(() => f.admission.assertReady()).not.toThrow();
  });
});
