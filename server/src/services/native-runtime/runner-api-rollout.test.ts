import { describe, expect, it } from "vitest";
import { runnerApiToolsEnabled } from "./runner-api-rollout.js";

describe("runner API rollout", () => {
  it("enables API tools without operator configuration", () => {
    expect(runnerApiToolsEnabled("company", undefined, {})).toBe(true);
    expect(runnerApiToolsEnabled("company", true, {})).toBe(true);
    expect(runnerApiToolsEnabled("company", false, {})).toBe(false);
  });
  it("fails closed for explicit disabled or invalid settings", () => {
    for (const value of ["false", "", "TRUE", "1", "invalid"]) {
      for (const binding of [undefined, false, true]) expect(runnerApiToolsEnabled("company", binding, { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: value })).toBe(false);
    }
    expect(runnerApiToolsEnabled("company", undefined, { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true" })).toBe(true);
  });
  it.each([undefined, "true"])("restricts enabled tools to exact company IDs (flag: %s)", (enabled) => {
    const env = { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: enabled, PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS: " alpha, beta " };
    expect(runnerApiToolsEnabled("alpha", undefined, env)).toBe(true);
    expect(runnerApiToolsEnabled("alph", undefined, env)).toBe(false);
    expect(runnerApiToolsEnabled("foreign", true, env)).toBe(false);
    expect(runnerApiToolsEnabled("alpha", undefined, { ...env, PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS: "" })).toBe(false);
  });
  it("keeps baseline tools disabled and honors an operator stop over explicit bindings", () => {
    expect(runnerApiToolsEnabled("company", false, { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true" })).toBe(false);
    expect(runnerApiToolsEnabled("company", false, {})).toBe(false);
    expect(runnerApiToolsEnabled("company", true, { PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "false" })).toBe(false);
  });
});
