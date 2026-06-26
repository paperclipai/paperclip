import { describe, expect, it } from "vitest";
import { buildAgentOnboardingPrompt } from "./agent-onboarding-prompt";

describe("buildAgentOnboardingPrompt", () => {
  it("includes Hermes Gateway setup guidance for external agents", () => {
    const prompt = buildAgentOnboardingPrompt({
      onboardingTextUrl: "http://localhost:3100/api/invites/token-123/onboarding.txt",
      connectionCandidates: ["http://192.168.1.10:3100"],
    });

    expect(prompt).toContain('adapterType: "hermes_gateway"');
    expect(prompt).toContain("API_SERVER_ENABLED=true");
    expect(prompt).toContain("API_SERVER_KEY");
    expect(prompt).toContain("hermes gateway run --replace --accept-hooks");
    expect(prompt).toContain("default Hermes API server port is `8642`");
    expect(prompt).toContain("agentDefaultsPayload.apiBaseUrl");
    expect(prompt).toContain("agentDefaultsPayload.paperclipApiUrl");
    expect(prompt).toContain("http://127.0.0.1:8642");
    expect(prompt).toContain("http://<private-ip>:8642");
    expect(prompt).toContain("http://<tailnet-host>:8642");
    expect(prompt).toContain("http://host.docker.internal:8642");
    expect(prompt).toContain("https://hermes-gateway.example");
    expect(prompt).toContain("`hermes_local` runs Hermes on the Paperclip host");
    expect(prompt).toContain("Hermes-originated Paperclip API calls");
  });
});
