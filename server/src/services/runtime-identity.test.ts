import { describe, expect, it } from "vitest";
import { configuredRuntimeIdentityReply } from "./runtime-identity.js";

describe("configuredRuntimeIdentityReply", () => {
  it("answers an explicit model-identity question from the issue override without a provider guess", () => {
    expect(
      configuredRuntimeIdentityReply({
        body: "What model you are?",
        adapterType: "codex_local",
        agentAdapterConfig: { model: "gpt-5.6" },
        issueAssigneeAdapterOverrides: { adapterConfig: { model: "gpt-5.6-terra" } },
      }),
    ).toContain("`gpt-5.6-terra`");
  });

  it("does not intercept ordinary chat", () => {
    expect(
      configuredRuntimeIdentityReply({
        body: "Please investigate the authentication regression",
        adapterType: "codex_local",
        agentAdapterConfig: { model: "gpt-5.6" },
        issueAssigneeAdapterOverrides: null,
      }),
    ).toBeNull();
  });
});
