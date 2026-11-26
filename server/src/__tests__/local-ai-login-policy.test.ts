import { describe, expect, it } from "vitest";
import { supportsHostedGoogleAiLogin, supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
describe("server-host subscription login policy", () => {
  it("permits private self-hosted instances and explicit trusted hosts", () => {
    expect(supportsLocalAiLogin({ deploymentMode: "local_trusted", deploymentExposure: "private" })).toBe(true);
    expect(supportsLocalAiLogin({ deploymentMode: "authenticated", deploymentExposure: "private" })).toBe(true);
    expect(supportsLocalAiLogin({ deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "trusted-host" })).toBe(true);
    expect(supportsLocalAiLogin({ deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "" })).toBe(false);
  });

  it("permits hosted Google Antigravity sign-in even on authenticated public deployments", () => {
    expect(supportsHostedGoogleAiLogin({ deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "" })).toBe(true);
    expect(supportsHostedGoogleAiLogin({ deploymentMode: "local_trusted", deploymentExposure: "private" })).toBe(true);
  });
});
