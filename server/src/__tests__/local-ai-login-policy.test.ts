import { describe, expect, it } from "vitest";
import { supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
describe("server-host subscription login policy", () => {
  it("permits private self-hosted instances and explicit trusted hosts", () => {
    expect(supportsLocalAiLogin({ deploymentMode: "local_trusted", deploymentExposure: "private" })).toBe(true);
    expect(supportsLocalAiLogin({ deploymentMode: "authenticated", deploymentExposure: "private" })).toBe(true);
    expect(supportsLocalAiLogin({ deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "trusted-host" })).toBe(true);
    expect(supportsLocalAiLogin({ deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "" })).toBe(false);
  });
});
