import { describe, expect, it } from "vitest";
import { managedHermesConfigurationChanged } from "./hermes-gateway-binding.js";

describe("managed Hermes Gateway binding", () => {
  const bound = {
    managedProfile: true,
    apiBaseUrl: "https://hermes.example.test/p/paperclip-agent",
    expectedProfile: "paperclip-agent",
    apiKey: { type: "secret_ref", secretId: "saved-reference", version: "latest" },
  };

  it.each([
    { managedProfile: false },
    { apiBaseUrl: "https://hermes.example.test/p/decoy" },
    { expectedProfile: "decoy" },
    { token: "alternate-token" },
    { apiKey: { type: "secret_ref", secretId: "other-reference", version: "latest" } },
  ])("protects the saved connection from ordinary configuration edits", patch => {
    expect(managedHermesConfigurationChanged(bound, { ...bound, ...patch })).toBe(true);
  });

  it("allows regular options and manually configured connections", () => {
    expect(managedHermesConfigurationChanged(bound, { ...bound, timeoutSec: 60 })).toBe(false);
    expect(managedHermesConfigurationChanged({ apiBaseUrl: "https://example.test" }, {})).toBe(false);
  });
});
