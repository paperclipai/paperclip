import { describe, expect, it } from "vitest";
import { aiBindingForAuthRecovery, isAiAuthenticationBlocked, isAiAuthenticationRepairable } from "../services/ai-auth-failure.js";
import { classifyRunLiveness } from "../services/run-liveness.js";

const missingClaudeKey = {
  bindingType: "user_secret_ref", envKey: "ANTHROPIC_API_KEY",
  configPath: "env.ANTHROPIC_API_KEY", errorCode: "user_secret_missing",
  consumerType: "agent", consumerId: "failed-agent", responsibleUserId: "new-teammate",
};
const failure = (missingBindings: unknown, reason = "secret_binding_missing") => ({
  errorCode: "configuration_incomplete",
  resultJson: { configurationIncomplete: { reason, agentId: "failed-agent", missingBindings } },
});

describe("personal AI credential preflight recovery", () => {
  it.each(["startup", "turn"])("routes a typed %s authentication failure through the persisted reconnect request", phase => {
    const run = { errorCode: "native_session_interrupted", resultJson: { providerFailure: {
      schema: "paperclip.provider-failure.v1", provider: "openai", phase,
      category: "authentication", message: "Invalid API key", retryability: "requires_action",
    } } };
    expect(isAiAuthenticationRepairable(run)).toBe(true);
    expect(aiBindingForAuthRecovery("paperclip_runner", { provider: "codex" }, run))
      .toMatchObject({ provider: "openai" });
    expect(aiBindingForAuthRecovery("claude_local", {}, run)).toBeUndefined();
    expect(isAiAuthenticationBlocked({ ...run, livenessState: "failed" })).toBe(false);
    expect(classifyRunLiveness({ ...run, runStatus: "failed", issue: null, authenticationRepairRequested: true }))
      .toMatchObject({ livenessState: "blocked", nextAction: "Complete the connection request to continue this task" });
  });

  it.each(["quota_exhausted", "permission", "rate_limit"])("does not reconnect for typed %s failures", category => {
    expect(isAiAuthenticationRepairable({ errorCode: "native_session_interrupted", resultJson: { providerFailure: {
      schema: "paperclip.provider-failure.v1", provider: "openai", phase: "turn",
      category, message: "Provider refused the request", retryability: "requires_action",
    } } })).toBe(false);
  });

  it("does not offer model sign-in for sandbox authentication", () => {
    expect(isAiAuthenticationRepairable({ resultJson: { providerFailure: {
      schema: "paperclip.provider-failure.v1", provider: "sandbox", phase: "startup",
      category: "authentication", message: "Sandbox credentials rejected", retryability: "requires_action",
    } } })).toBe(false);
  });

  it.each(["user_secret_missing", "secret_inactive"])("offers Claude setup for %s without adopting another provider", errorCode => {
    const run = failure([{ ...missingClaudeKey, errorCode }]);
    expect(isAiAuthenticationRepairable(run)).toBe(true);
    expect(aiBindingForAuthRecovery("claude_local", {}, run)).toEqual({
      provider: "anthropic", method: "subscription", mode: "responsible_user",
    });
    expect(aiBindingForAuthRecovery("codex_local", {}, run)).toBeUndefined();
    expect(isAiAuthenticationBlocked({ ...run, livenessState: "failed" })).toBe(false);
    expect(isAiAuthenticationBlocked({ ...run, livenessState: "blocked" })).toBe(true);
  });

  it.each<[string, unknown]>([
    ["tool credential", [{ ...missingClaudeKey, envKey: "GITHUB_TOKEN", configPath: "env.GITHUB_TOKEN" }]],
    ["company secret", [{ ...missingClaudeKey, bindingType: "secret_ref" }]],
    ["unknown error", [{ ...missingClaudeKey, errorCode: "user_secret_definition_missing" }]],
    ["adapter field", [{ ...missingClaudeKey, configPath: "apiKey" }]],
    ...["project", "environment", "routine", "plugin"].map((consumerType): [string, unknown] => [
      `${consumerType} binding`, [{ ...missingClaudeKey, consumerType }],
    ]),
    ["different agent", [{ ...missingClaudeKey, consumerId: "another-agent" }]],
    ["missing consumer", [{ ...missingClaudeKey, consumerType: undefined, consumerId: undefined }]],
    ["additional tool blocker", [missingClaudeKey, { ...missingClaudeKey, envKey: "GITHUB_TOKEN", configPath: "env.GITHUB_TOKEN" }]],
    ["different providers", [missingClaudeKey, { ...missingClaudeKey, envKey: "OPENAI_API_KEY", configPath: "env.OPENAI_API_KEY" }]],
    ["empty evidence", []], ["malformed evidence", [null]], ["missing evidence", null],
  ])("keeps %s on the existing configuration recovery path", (_name, bindings) => {
    expect(isAiAuthenticationRepairable(failure(bindings))).toBe(false);
    expect(isAiAuthenticationBlocked({ ...failure(bindings), livenessState: "blocked" })).toBe(false);
    expect(aiBindingForAuthRecovery("claude_local", {}, failure(bindings))).toBeUndefined();
  });

  it("only classifies a failed preflight as an inline wait after the card is persisted", () => {
    const input = { ...failure([missingClaudeKey]), runStatus: "failed", issue: { status: "blocked", title: "Blocked task", description: null },
      stdoutExcerpt: null, stderrExcerpt: null, error: null, continuationAttempt: 0, evidence: null };
    expect(classifyRunLiveness(input).livenessState).toBe("failed");
    expect(classifyRunLiveness({ ...input, authenticationRepairRequested: true })).toMatchObject({
      livenessState: "blocked", nextAction: "Complete the connection request to continue this task",
    });
    expect(classifyRunLiveness({ ...input, ...failure([]), authenticationRepairRequested: true }).livenessState).toBe("failed");
  });
});
