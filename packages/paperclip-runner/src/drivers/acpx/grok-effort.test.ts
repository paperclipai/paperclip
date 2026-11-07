import { describe, expect, it } from "vitest";
import { admittedGrokEffort, createGrokEffortAdmission, resolveGrokEffort } from "./grok-effort.js";

function response(value: string, sessionId?: string) {
  return { ...(sessionId ? { sessionId } : {}), models: { currentModelId: "grok-4.7" },
    _meta: { "x.ai/sessionConfig": { options: [
      { id: "grok-4.7", category: "model", selected: true },
      { id: value, category: "mode", selected: true },
    ] } } };
}
function loaded(method = "session/new", expected: "low" | "high" = "high") {
  const admission = createGrokEffortAdmission(expected, "grok-4.7");
  const guard = admission.createGuard();
  guard("outbound", { id: 1, method, params: { sessionId: "s" } });
  guard("inbound", { id: 1, result: response(expected, method === "session/new" ? "s" : undefined) });
  return { admission, guard };
}

describe("Grok effort admission", () => {
  it.each(["session/new", "session/load", "session/resume"])("admits the pinned Grok native metadata after %s", method => {
    const { admission, guard } = loaded(method);
    expect(admission.isReady()).toBe(true);
    expect(() => guard("outbound", { id: 2, method: "session/prompt", params: { sessionId: "s" } })).not.toThrow();
  });
  it.each(["session/new", "session/load", "session/resume"])("binds native model and effort without replacing instructions on %s", method => {
    const admission = createGrokEffortAdmission("low", "grok-4.7"), guard = admission.createGuard();
    const request = { id: 1, method, params: { sessionId: "s", _meta: { rules: "Bound task instructions" } } };
    guard("outbound", request);
    expect(request.params._meta).toEqual({ rules: "Bound task instructions", modelId: "grok-4.7", reasoningEffort: "low" });
  });
  it.each([{ modelId: "other-model" }, { reasoningEffort: "high" }])("rejects conflicting native request configuration", meta => {
    const admission = createGrokEffortAdmission("low", "grok-4.7"), guard = admission.createGuard();
    expect(() => guard("outbound", { id: 1, method: "session/new", params: { _meta: meta } })).toThrow("request conflicts");
  });
  it.each(["minimal", "low", "medium", "high", "xhigh"] as const)("accepts exact %s without aliases", value => {
    expect(resolveGrokEffort("grok", value)).toBe(value);
    expect(admittedGrokEffort("grok", value, { grokEffort: value }, { grokEffort: value })).toBe(value);
  });
  it("rejects unsupported, foreign and conflicting effort", () => {
    for (const value of ["ultra", "off", null, 2]) expect(() => resolveGrokEffort("grok", value)).toThrow();
    expect(() => resolveGrokEffort("pi", "high")).toThrow("only supported");
    expect(() => admittedGrokEffort("grok", "high", { grokEffort: "high" }, { grokEffort: "medium" })).toThrow("differs");
  });
  it("requires the native acknowledgement on each cold connection", () => {
    const { admission, guard } = loaded();
    const cold = admission.createGuard();
    expect(() => guard("inbound", { id: 1, result: response("high", "s") })).toThrow("authority was replaced");
    expect(() => cold("outbound", { id: 2, method: "session/prompt", params: { sessionId: "s" } })).toThrow("does not acknowledge");
    const resumed = admission.createGuard();
    resumed("outbound", { id: 3, method: "session/load", params: { sessionId: "s" } });
    resumed("inbound", { id: 3, result: response("high") });
    expect(() => resumed("outbound", { id: 4, method: "session/prompt", params: { sessionId: "s" } })).not.toThrow();
  });
  it("rejects a restored provider default that differs from the bound effort", () => {
    const admission = createGrokEffortAdmission("low", "grok-4.7");
    const guard = admission.createGuard();
    guard("outbound", { id: 1, method: "session/load", params: { sessionId: "s" } });
    expect(() => guard("inbound", { id: 1, result: response("high") })).toThrow("differs");
    expect(() => admission.assertReady()).toThrow("differs");
  });
  it.each([{}, { configOptions: [{ id: "reasoning_effort", currentValue: "high" }] },
    { _meta: { "x.ai/sessionConfig": { options: [{ id: "high", category: "mode", selected: false }] } } }])("rejects missing native effort acknowledgement", result => {
    const admission = createGrokEffortAdmission("high", "grok-4.7"), guard = admission.createGuard();
    guard("outbound", { id: 1, method: "session/load", params: { sessionId: "s" } });
    expect(() => guard("inbound", { id: 1, result })).toThrow("missing or ambiguous");
  });
  it("rejects ambiguous native effort selections", () => {
    const admission = createGrokEffortAdmission("high", "grok-4.7"), guard = admission.createGuard();
    const result = response("high", "s");
    result._meta["x.ai/sessionConfig"].options.push({ id: "low", category: "mode", selected: true });
    guard("outbound", { id: 1, method: "session/new", params: {} });
    expect(() => guard("inbound", { id: 1, result })).toThrow("missing or ambiguous");
  });
  it("rejects an effort acknowledgement for a different effective model", () => {
    const admission = createGrokEffortAdmission("high", "grok-4.7"), guard = admission.createGuard();
    const result = response("high", "s"); result.models.currentModelId = "grok-4.6";
    guard("outbound", { id: 1, method: "session/new", params: {} });
    expect(() => guard("inbound", { id: 1, result })).toThrow("model acknowledgement conflicts");
  });
  it("does not admit an uncorrelated or failed response", () => {
    const admission = createGrokEffortAdmission("high", "grok-4.7"), guard = admission.createGuard();
    guard("outbound", { id: 1, method: "session/new", params: {} });
    guard("inbound", { id: 2, result: response("high", "s") });
    expect(admission.isReady()).toBe(false);
    guard("inbound", { id: 1, error: { code: -32603 } });
    expect(admission.isReady()).toBe(false);
  });
  it.each(["response", "detail"])("rejects a conflicting native %s session identity", field => {
    const admission = createGrokEffortAdmission("high", "grok-4.7"), guard = admission.createGuard();
    const result = { ...response("high"), ...(field === "response" ? { sessionId: "other" } : {}),
      _meta: { ...response("high")._meta, ...(field === "detail" ? { "x.ai/sessionDetail": { sessionId: "other" } } : {}) } };
    guard("outbound", { id: 1, method: "session/load", params: { sessionId: "s" } });
    expect(() => guard("inbound", { id: 1, result })).toThrow("different session");
  });
  it.each(["session/set_config_option", "session/set_model"])("rejects unsupported late %s controls", method => {
    const { guard } = loaded();
    expect(() => guard("outbound", { id: 2, method, params: { sessionId: "s" } })).toThrow("when the native session opens");
  });
  it("rejects a prompt for another session", () => {
    const { guard } = loaded();
    expect(() => guard("outbound", { id: 2, method: "session/prompt", params: { sessionId: "other" } })).toThrow("different session");
  });
  it.each([
    { sessionId: "s", model_id: "grok-4.7", reasoning_effort: "low" },
    { sessionId: "other", model_id: "grok-4.7", reasoning_effort: "high" },
    { sessionId: "s", model_id: "grok-4.6", reasoning_effort: "high" },
  ])("rejects native model or effort drift", update => {
    const { guard } = loaded();
    expect(() => guard("inbound", { method: "_x.ai/session_notification", params: { sessionId: update.sessionId,
      update: { sessionUpdate: "model_changed", model_id: update.model_id, reasoning_effort: update.reasoning_effort } } })).toThrow("drifted");
  });
});
