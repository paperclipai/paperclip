import { describe, expect, it } from "vitest";
import { admittedClaudeEffort, createClaudeEffortAdmission, resolveClaudeEffort } from "./claude-effort.js";

const response = (value: string, sessionId?: string) => ({ ...(sessionId ? { sessionId } : {}), configOptions: [{ id: "effort", currentValue: value }] });
function loaded(method = "session/new") {
  const admission = createClaudeEffortAdmission("high");
  const guard = admission.createGuard();
  guard("outbound", { id: 1, method, params: method === "session/new" ? {} : { sessionId: "s" } });
  guard("inbound", { id: 1, result: response("medium", method === "session/new" ? "s" : undefined) });
  return { admission, guard };
}
function select(guard: ReturnType<ReturnType<typeof createClaudeEffortAdmission>["createGuard"]>, acknowledged = "high") {
  guard("outbound", { id: 2, method: "session/set_config_option", params: { sessionId: "s", configId: "effort", value: "high" } });
  guard("inbound", { id: 2, result: response(acknowledged) });
}
describe("Claude effort admission", () => {
  it.each(["low", "medium", "high", "xhigh", "max"] as const)("accepts exact %s without aliases", value => {
    expect(resolveClaudeEffort("claude", value)).toBe(value);
    expect(admittedClaudeEffort("claude", value, { claudeEffort: value }, { claudeEffort: value })).toBe(value);
  });
  it("rejects unsupported, foreign and conflicting effort", () => {
    for (const value of ["ultra", "off", null, 2]) expect(() => resolveClaudeEffort("claude", value)).toThrow();
    expect(() => resolveClaudeEffort("pi", "high")).toThrow("only supported");
    expect(() => admittedClaudeEffort("claude", "high", { claudeEffort: "high" }, { claudeEffort: "medium" })).toThrow("differs");
  });
  it.each(["session/new", "session/load", "session/resume"])("requires acknowledged effort before prompting after %s", method => {
    const { admission, guard } = loaded(method);
    expect(admission.isReady()).toBe(false);
    select(guard);
    expect(admission.isReady()).toBe(true);
    expect(() => guard("outbound", { id: 3, method: "session/prompt", params: { sessionId: "s" } })).not.toThrow();
  });

  it("rejects a resumed session with missing effort configuration", () => {
    const admission = createClaudeEffortAdmission("high");
    const guard = admission.createGuard();
    guard("outbound", { id: 1, method: "session/resume", params: { sessionId: "s" } });
    expect(() => guard("inbound", { id: 1, result: {} })).toThrow("missing or ambiguous");
  });
  it("blocks a prompt based only on a restored default", () => {
    const { guard } = loaded("session/load");
    expect(() => guard("outbound", { id: 3, method: "session/prompt", params: { sessionId: "s" } })).toThrow("does not acknowledge");
  });

  it("requires the bound effort acknowledgement on each cold connection", () => {
    const { admission, guard } = loaded();
    select(guard);
    const resumed = admission.createGuard();
    resumed("outbound", { id: 4, method: "session/load", params: { sessionId: "s" } });
    expect(() => resumed("outbound", { id: 5, method: "session/prompt", params: { sessionId: "s" } })).toThrow("does not acknowledge");
    const fresh = loaded(); select(fresh.guard);
    const acknowledged = fresh.admission.createGuard();
    acknowledged("outbound", { id: 4, method: "session/load", params: { sessionId: "s" } });
    acknowledged("inbound", { id: 4, result: response("high") });
    expect(() => acknowledged("outbound", { id: 5, method: "session/prompt", params: { sessionId: "s" } })).not.toThrow();
  });
  it("rejects a provider that ignores the requested effort", () => {
    const { guard } = loaded();
    expect(() => select(guard, "medium")).toThrow("did not apply");
  });
  it("rejects drift and wrong-session prompts after admission", () => {
    const { guard } = loaded(); select(guard);
    expect(() => guard("inbound", { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "config_option_update", ...response("low") } } })).toThrow("drifted");
    const fresh = loaded(); select(fresh.guard);
    expect(() => fresh.guard("outbound", { id: 3, method: "session/prompt", params: { sessionId: "foreign" } })).toThrow("different session");
  });
});
