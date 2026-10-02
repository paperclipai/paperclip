import { resolvePaperclipRunnerNativeProviderInput } from "./native-runtime/provider-profile.js";
import { describe, expect, it } from "vitest";
import { assertOpenAiManagedQualification, computeQualifiedProfileRevision } from "./provider-profile-qualification.js";
describe("OpenAI qualification attestation", () => {
  const configuration = { defaultModel: "gpt-6-astra", environment: { type: "none" }, timeoutSeconds: 180 };
  const valid = { suite: "openai-managed-tools-v1", probedAt: "2026-09-30T12:00:00Z", paperclipSha: "a".repeat(40), evalsSha: "b".repeat(40), runnerSha256: `sha256:${"c".repeat(64)}`, configurationSha256: computeQualifiedProfileRevision(configuration), passedCases: 35, totalCases: 35 };
  it("requires full passing evidence bound to the selected environment and configuration", () => {
    expect(assertOpenAiManagedQualification(configuration, valid, { required: true })).toBe(true);
    for (const qualification of [{}, { ...valid, passedCases: 34 }, { ...valid, suite: "openai-managed-hosted-v1" }, { ...valid, evalsSha: "latest" }, { ...valid, runnerSha256: "unknown" }, { ...valid, hostedHarnessVersion: "pinned" }]) {
      expect(() => assertOpenAiManagedQualification(configuration, qualification, { required: true })).toThrow();
    }
    expect(() => assertOpenAiManagedQualification({ ...configuration, timeoutSeconds: 300 }, valid, { required: true })).toThrow();
  });
});

it("allows a stricter per-agent budget but rejects an increase beyond the company profile", () => {
  const stored = { id: "profile-id", profileKey: "openai", configuration: { defaultModel: "gpt-6-astra", apiRevision: "agents=v1", reasoningEffort: "medium", environment: { type: "none" }, timeoutSeconds: 180, maxEstimatedSessionCostUsd: 2 } };
  const adapterConfig = { provider: "openai_managed", openaiProfileId: "openai", openaiRetentionAcknowledged: true, maxEstimatedSessionCostUsd: 1 };
  expect(resolvePaperclipRunnerNativeProviderInput({ backend: "openai_agents_api", adapterConfig, openaiProfile: stored })).toMatchObject({ openaiProfile: { maxEstimatedSessionCostUsd: 1 } });
  expect(() => resolvePaperclipRunnerNativeProviderInput({ backend: "openai_agents_api", adapterConfig: { ...adapterConfig, maxEstimatedSessionCostUsd: 3 }, openaiProfile: stored })).toThrow("cannot exceed");
});
