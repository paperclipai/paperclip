import { describe, expect, it } from "vitest";
import {
  BROWSER_CODE_MAX_LENGTH,
  browserCodeSchema,
  claudeSetupTokenCompletionResponseSchema,
  claudeSetupTokenSessionOwnerResponseSchema,
  isValidBrowserCode,
  startClaudeSetupTokenSessionRequestSchema,
  submitBrowserCodeRequestSchema,
} from "./claude-setup-token-session.js";
import { createAgentSchema, createAgentHireSchema } from "./agent.js";

const ENVIRONMENT_ID = "11111111-1111-4111-8111-111111111111";

describe("claude setup-token session start request", () => {
  it("accepts a company-and-environment request with no agent id", () => {
    const parsed = startClaudeSetupTokenSessionRequestSchema.parse({
      environmentId: ENVIRONMENT_ID,
      adapterType: "claude_local",
    });
    expect(parsed.environmentId).toBe(ENVIRONMENT_ID);
    expect(parsed.adapterType).toBe("claude_local");
  });

  it("rejects a legacy ttlSeconds: the runtime does not support it", () => {
    const result = startClaudeSetupTokenSessionRequestSchema.safeParse({
      environmentId: ENVIRONMENT_ID,
      adapterType: "claude_local",
      ttlSeconds: 300,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an agent id: the scope carries no agent id", () => {
    const result = startClaudeSetupTokenSessionRequestSchema.safeParse({
      environmentId: ENVIRONMENT_ID,
      adapterType: "claude_local",
      agentId: "22222222-2222-4222-8222-222222222222",
    });
    expect(result.success).toBe(false);
  });
});

describe("browser-code grammar", () => {
  it("accepts a conservative printable code", () => {
    const code = "ac_012-AZ_az.9#state";
    expect(browserCodeSchema.parse(code)).toBe(code);
    expect(isValidBrowserCode(code)).toBe(true);
  });

  it("rejects a carriage return, a line feed, a NUL, and a control byte", () => {
    for (const bad of ["ab\rcd", "ab\ncd", "ab\u0000cd", "ab\u0001cd", "ab\u007fcd", "ab cd", "ab\tcd"]) {
      expect(browserCodeSchema.safeParse(bad).success).toBe(false);
      expect(isValidBrowserCode(bad)).toBe(false);
    }
  });

  it("rejects a trailing newline that an anchored regex would let pass", () => {
    // The runtime `.refine()` is the authoritative guard. JavaScript `$`
    // matches before a final line feed, so an anchored printable-ASCII regex
    // accepts a trailing newline. The `.refine()` closes that trap.
    expect(browserCodeSchema.safeParse("abc\n").success).toBe(false);
    expect(isValidBrowserCode("abc\n")).toBe(false);
  });

  it("rejects a single control byte and accepts a printable code", () => {
    expect(browserCodeSchema.safeParse("abc").success).toBe(true);
    expect(browserCodeSchema.safeParse("valid-code_123").success).toBe(true);
  });

  it("rejects an empty code", () => {
    expect(browserCodeSchema.safeParse("").success).toBe(false);
    expect(isValidBrowserCode("")).toBe(false);
  });

  it("rejects an oversized code", () => {
    const oversized = "a".repeat(BROWSER_CODE_MAX_LENGTH + 1);
    expect(browserCodeSchema.safeParse(oversized).success).toBe(false);
    expect(isValidBrowserCode(oversized)).toBe(false);
    const atLimit = "a".repeat(BROWSER_CODE_MAX_LENGTH);
    expect(browserCodeSchema.parse(atLimit)).toBe(atLimit);
  });

  it("wraps the grammar in the submit-browser-code request and rejects an extra field", () => {
    expect(submitBrowserCodeRequestSchema.parse({ browserCode: "abc123" }).browserCode).toBe(
      "abc123",
    );
    expect(submitBrowserCodeRequestSchema.safeParse({ browserCode: "a\nb" }).success).toBe(false);
    expect(
      submitBrowserCodeRequestSchema.safeParse({ browserCode: "abc", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("claude setup-token owner response and completion response", () => {
  it("accepts an owner response with the submitted-browser-code panel mode and a prompt", () => {
    const parsed = claudeSetupTokenSessionOwnerResponseSchema.parse({
      sessionId: "opaque-base64url-session-id",
      environmentId: ENVIRONMENT_ID,
      status: "waiting_for_user",
      expiresAt: null,
      failure: null,
      panelMode: "submitted_browser_code",
      prompt: { authorizationUrl: "https://example.test/authorize" },
    });
    expect(parsed.panelMode).toBe("submitted_browser_code");
    expect(parsed.prompt?.authorizationUrl).toBe("https://example.test/authorize");
  });

  it("rejects a token on the completion response: the claim carries no token", () => {
    expect(
      claudeSetupTokenCompletionResponseSchema.parse({ storedSessionId: "session-claim" })
        .storedSessionId,
    ).toBe("session-claim");
    const withToken = claudeSetupTokenCompletionResponseSchema.safeParse({
      storedSessionId: "session-claim",
      token: "secret",
    });
    expect(withToken.success).toBe(false);
  });
});

describe("agent create and hire carry an optional stored-session claim", () => {
  const base = { name: "Claude Agent", adapterType: "claude_local" as const };

  it("accepts a create request without a stored-session claim", () => {
    expect(createAgentSchema.parse({ ...base }).storedSessionId).toBeUndefined();
  });

  it("accepts a create request with a stored-session claim", () => {
    expect(
      createAgentSchema.parse({ ...base, storedSessionId: "session-claim" }).storedSessionId,
    ).toBe("session-claim");
  });

  it("accepts a hire request with a stored-session claim", () => {
    expect(
      createAgentHireSchema.parse({ ...base, storedSessionId: "session-claim" }).storedSessionId,
    ).toBe("session-claim");
  });
});
