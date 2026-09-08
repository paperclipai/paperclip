import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";

import { evalProviderTransportOptions } from "./eval-provider-runtime.js";

describe("direct eval provider runtime", () => {
  it("uses the installed pinned Codex dependency without requiring a global CLI", () => {
    const options = evalProviderTransportOptions("codex");
    expect(isAbsolute(options.codexCommand!)).toBe(true);
    expect(existsSync(options.codexCommand!)).toBe(true);
    expect(options.codexCommand).toMatch(/@openai\/codex\/bin\/codex\.js$/);
    expect(options.acpxPermissionMode).toBeUndefined();
  });

  it("uses explicit unattended permissions only for isolated local eval providers", () => {
    expect(evalProviderTransportOptions("acpx")).toEqual({
      acpxPermissionMode: "approve-all",
      acpxPermissionModePinned: true,
    });
    expect(evalProviderTransportOptions("opencode")).toEqual({});
    expect(evalProviderTransportOptions("claude_managed")).toEqual({});
  });

  it("bounds AgentCore admission by both the turn budget and delivery timeout", () => {
    expect(evalProviderTransportOptions("aws_agentcore", 180_000)).toEqual({ turnStartTimeoutMs: 125_000 });
    expect(evalProviderTransportOptions("aws_agentcore", 10_000)).toEqual({ turnStartTimeoutMs: 10_000 });
  });
});
