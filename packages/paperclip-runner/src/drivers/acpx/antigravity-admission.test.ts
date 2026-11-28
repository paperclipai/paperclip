import { describe, expect, it } from "vitest";
import { ANTIGRAVITY_ADMISSION_SCHEMA, ANTIGRAVITY_SAVED_STATE_INCOMPATIBLE, AntigravityAdmissionError, AntigravitySavedStateIncompatibleError, createAntigravityAdmission } from "./antigravity-admission.js";

const content = "  Exact governance 🧷\n\n";
const model = "caller/model-not-in-catalog";
const initialize = { agentInfo: { name: "antigravity-acp", version: "1.5.2" }, agentCapabilities: { _meta: { antigravity: { paperclipAdmission: 1 } } } };
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
    } as Record<string, unknown> },
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

  it("rejects non-text prompts and arbitrary configuration", () => {
    for (const message of [
      { ...prompt(), params: { ...prompt().params, prompt: [{ type: "image", data: "unverified" }] } },
      { id: "control", method: "session/set_config_option", params: { sessionId: "native-session", configId: "mode", value: "yolo" } },
    ]) {
      const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
      expect(() => f.guard("outbound", message)).toThrow();
    }
  });

  const sendText = (...texts: string[]) => {
    const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
    const message = { ...prompt(), params: { ...prompt().params, prompt: texts.map(text => ({ type: "text", text })) } };
    f.guard("outbound", message);
    return message.params.prompt.map(block => block.text);
  };

  it.each([
    ["mid-line", "Read the doc; see /plan for details.", "Read the doc; see ⁠/plan for details."],
    ["inside the JSON task envelope", "{\"task\":\"Fix it. Then /plan the rollout\"}", "{\"task\":\"Fix it. Then ⁠/plan the rollout\"}"],
    ["after a newline", "line one\n/plan\nline three", "line one\n⁠/plan\nline three"],
    ["inside pasted quoted content", "> quoted: \" /plan \" end", "> quoted: \" ⁠/plan \" end"],
    ["after a tab", "tab\t/plan\there", "tab\t⁠/plan\there"],
    ["at the start", "/plan", "⁠/plan"],
    ["after Python-only whitespace", "x\u001c/plan\u0085y", "x\u001c⁠/plan\u0085y"],
  ])("keeps a native /plan %s as prose instead of switching the session to plan mode", (_label, text, sent) => {
    expect(sendText(text)).toEqual([sent]);
  });

  it.each([
    ["  /logout  ", "  ⁠/logout  "], ["\u001c/logout", "\u001c⁠/logout"],
    ["/USAGE", "⁠/USAGE"], ["\u0085/usage now", "\u0085⁠/usage now"],
  ])("keeps a whole-prompt native command %j as prose", (text, sent) => {
    expect(sendText(text)).toEqual([sent]);
  });

  it("keeps other text block fields when it rewrites a command", () => {
    const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
    const block = { type: "text", text: "see /plan", annotations: { priority: 1 } };
    const message = { ...prompt(), params: { ...prompt().params, prompt: [block] } };
    f.guard("outbound", message);
    expect(message.params.prompt).toEqual([{ type: "text", text: "see ⁠/plan", annotations: { priority: 1 } }]);
  });

  it("keeps a native command split across text blocks as prose", () => {
    expect(sendText(" ", "/log", "out")).toEqual([" ", "⁠/log", "out"]);
  });

  it.each([
    "/planning ahead", "a/plan b", "see https://example.test/plan for docs", "/plan/foo", "/PLAN now",
    "Do the task\n/logout", "{\"t\":\"x /logout\"}", "/usages", "text /usage", "Do the task\r\n  /model replace",
  ])("sends text the native runtime treats as prose unchanged: %j", text => {
    expect(sendText(text)).toEqual([text]);
  });

  it("fails closed when the runtime advertises a native command this guard does not know", () => {
    const f = fixture(); const sent = request(f); f.guard("inbound", response(sent));
    const advertise = (names: string[]) => ({ method: "session/update", params: { sessionId: "native-session", update: {
      sessionUpdate: "available_commands_update", availableCommands: names.map(name => ({ name, description: name })),
    } } });
    expect(() => f.guard("inbound", advertise(["plan", "logout", "usage"]))).not.toThrow();
    expect(() => f.guard("inbound", advertise(["plan", "logout", "usage", "goal"]))).toThrow("native command");
  });

  it.each([
    ["a mismatched model receipt", (sent: ReturnType<typeof request>) => response(sent, { model: "another-model" })],
    ["mismatched instruction bytes", (sent: ReturnType<typeof request>) => response(sent, { digest: `sha256:${"0".repeat(64)}` })],
    ["no receipt", (sent: ReturnType<typeof request>) => ({ id: sent.id, result: { sessionId: "native-session" } })],
    ["a managed-reload refusal", (sent: ReturnType<typeof request>) => ({ id: sent.id, error: { code: -32602,
      message: "Paperclip admission: managed reload requires a fresh exact content acknowledgment", data: { paperclipAdmission: "refused" } } })],
  ])("names %s on session/load as incompatible saved state", (_label, reply) => {
    for (const method of ["session/load", "session/resume"]) {
      const f = fixture(); const sent = request(f, method);
      expect(() => f.guard("inbound", reply(sent))).toThrow(AntigravitySavedStateIncompatibleError);
      expect(() => f.admission.assertReady()).toThrow(expect.objectContaining({ code: ANTIGRAVITY_SAVED_STATE_INCOMPATIBLE, retryable: false }));
      expect(() => f.guard("outbound", prompt())).toThrow();
    }
  });

  it("keeps fresh-session refusals and ordinary reload errors out of the saved-state class", () => {
    const fresh = fixture(); const sent = request(fresh);
    let thrown: unknown;
    try { fresh.guard("inbound", response(sent, { model: "another-model" })); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AntigravityAdmissionError);
    expect(thrown).not.toBeInstanceOf(AntigravitySavedStateIncompatibleError);
    // A transient provider error on reload keeps its own typed form.
    const reload = fixture(); const load = request(reload, "session/load");
    expect(() => reload.guard("inbound", { id: load.id, error: { code: -32603, message: "Internal error" } })).not.toThrow();
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
    sessionId: "native-session", toolCall: { toolCallId: "interaction_1a2b3c4d", title: "Choose a deployment" },
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
    const next = question(); next.params.sessionId = "new-native-session"; next.id = 1;
    expect(() => f.guard("inbound", next)).not.toThrow();
    expect(next.method).toBe("elicitation/create");
    expect(() => f.admission.assertReady()).not.toThrow();
    // An answer to the replaced question is stale and never reaches 1.5.2.
    const late = { id: 0, result: { action: "accept", content: { answer: "deny" } } };
    expect(() => f.guard("outbound", late)).toThrow("stale or duplicate");
  });

  it.each(["decline", "cancel"])("delivers %s as a native cancelled outcome, never a selected choice", action => {
    const f = admitted(); f.guard("inbound", question());
    const answer = { id: 0, result: { action } as Record<string, unknown> };
    f.guard("outbound", answer);
    expect(answer.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("settles a question that Stop answered with an error and rejects any later answer to it", () => {
    const f = admitted(); f.guard("inbound", question());
    const stopped = { id: 0, error: { code: -32800, message: "Request cancelled" } };
    f.guard("outbound", stopped);
    expect(stopped).toEqual({ id: 0, error: { code: -32800, message: "Request cancelled" } });
    expect(() => f.guard("outbound", { id: 0, result: { action: "accept", content: { answer: "deny" } } })).toThrow("stale or duplicate");
  });

  it("rejects a duplicate answer after the first one settled the question", () => {
    const f = admitted(); f.guard("inbound", question());
    f.guard("outbound", { id: 0, result: { action: "accept", content: { answer: "deny" } } });
    expect(() => f.guard("outbound", { id: 0, result: { action: "accept", content: { answer: "allow/weird:α" } } })).toThrow("stale or duplicate");
  });

  it("treats only 1.5.2's exact synthetic interaction identity as a question", () => {
    for (const toolCallId of ["interaction_", "interaction_123", "interaction_1A2B3C4D", "interaction_1a2b3c4d5", "xinteraction_1a2b3c4d"]) {
      const f = admitted(); const q = question(); q.params.toolCall.toolCallId = toolCallId;
      const before = structuredClone(q); f.guard("inbound", q); expect(q).toEqual(before);
    }
  });
});
