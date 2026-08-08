import { describe, it, expect } from "vitest";
import { resolveClaudeErrorCode } from "./execute.js";

// Regression coverage for JAC-3738: successful claude_local runs were terminally
// classified failed(claude_auth_required) because the auth branch was assigned
// from `requiresLogin` alone, without checking `failed`. detectClaudeLoginRequired
// scans the assistant's own result text + stdout/stderr, so any SUCCESSFUL run
// that merely mentions auth/login flipped requiresLogin=true and was misclassified.

const baseInputs = {
  requiresLogin: false,
  failed: false,
  modelNotFound: false,
  clearSessionForMaxTurns: false,
  poisonedPreviousMessageId: false,
  providerQuota: false,
  transientUpstream: false,
  claudeRefusal: false,
};

describe("resolveClaudeErrorCode", () => {
  it("does NOT classify a successful run as claude_auth_required even when its output mentions auth (JAC-3738 scenario A)", () => {
    // subtype=success / is_error=false / exitCode=0 => failed === false,
    // but the model's own result text tripped detectClaudeLoginRequired.
    expect(
      resolveClaudeErrorCode({
        ...baseInputs,
        requiresLogin: true,
        failed: false,
      }),
    ).toBeNull();
  });

  it("preserves genuine auth failures as claude_auth_required (JAC-3738 scenario B)", () => {
    // Real auth failure carries is_error=true or a non-zero exit => failed === true.
    expect(
      resolveClaudeErrorCode({
        ...baseInputs,
        requiresLogin: true,
        failed: true,
      }),
    ).toBe("claude_auth_required");
  });

  it("returns null for a clean successful run (scenario C)", () => {
    expect(resolveClaudeErrorCode({ ...baseInputs })).toBeNull();
  });

  it("classifies model-not-found failures", () => {
    expect(
      resolveClaudeErrorCode({ ...baseInputs, failed: true, modelNotFound: true }),
    ).toBe("model_not_found");
  });

  it("classifies max-turns-exhausted failures", () => {
    expect(
      resolveClaudeErrorCode({ ...baseInputs, failed: true, clearSessionForMaxTurns: true }),
    ).toBe("max_turns_exhausted");
  });

  it("classifies poisoned-previous-message-id failures", () => {
    expect(
      resolveClaudeErrorCode({ ...baseInputs, failed: true, poisonedPreviousMessageId: true }),
    ).toBe("claude_poisoned_previous_message_id");
  });

  it("classifies provider-quota failures", () => {
    expect(resolveClaudeErrorCode({ ...baseInputs, providerQuota: true })).toBe(
      "provider_quota",
    );
  });

  it("classifies transient-upstream failures", () => {
    expect(resolveClaudeErrorCode({ ...baseInputs, transientUpstream: true })).toBe(
      "claude_transient_upstream",
    );
  });

  it("classifies model refusals", () => {
    expect(resolveClaudeErrorCode({ ...baseInputs, claudeRefusal: true })).toBe(
      "claude_refusal",
    );
  });

  it("prefers auth over other failure codes when the run genuinely failed", () => {
    // The auth branch is first in the chain; a failed run flagged for both auth
    // and max-turns resolves to auth (unchanged precedence, now gated on failed).
    expect(
      resolveClaudeErrorCode({
        ...baseInputs,
        requiresLogin: true,
        failed: true,
        clearSessionForMaxTurns: true,
      }),
    ).toBe("claude_auth_required");
  });
});
