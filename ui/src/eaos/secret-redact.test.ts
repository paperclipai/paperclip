import { describe, expect, it } from "vitest";
import { redactSecretLikeText, safeDisplayText, truncateText } from "./secret-redact";

describe("redactSecretLikeText (LET-467)", () => {
  it("masks bearer tokens", () => {
    const out = redactSecretLikeText("Authorization: Bearer abc123def456ghi789");
    expect(out).not.toContain("abc123def456ghi789");
    expect(out).toContain("[REDACTED]");
  });

  it("masks credential-style assignments", () => {
    const out = redactSecretLikeText('api_key="aaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(out).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).toContain("[REDACTED]");
  });

  it("masks Telegram bot tokens", () => {
    const out = redactSecretLikeText("delivery destination bot1234567:abc_DEF_xyz failed");
    expect(out).not.toContain("bot1234567:abc_DEF_xyz");
    expect(out).toContain("bot[REDACTED]");
  });

  it("masks Anthropic and OpenAI keys", () => {
    expect(redactSecretLikeText("key=sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa")).toContain("sk-[REDACTED]");
    expect(redactSecretLikeText("OPENAI=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toContain("sk-[REDACTED]");
  });

  it("masks GitHub and Slack tokens", () => {
    expect(redactSecretLikeText("ghp_aaaaaaaaaaaaaaaaaaaaaaaa")).toContain("gh_[REDACTED]");
    expect(redactSecretLikeText("xoxb-1234567890-abcdefghij")).toContain("xox-[REDACTED]");
  });
});

describe("truncateText / safeDisplayText", () => {
  it("truncates over the cap", () => {
    expect(truncateText("abcdef", 3)).toBe("ab…");
  });

  it("returns null for empty/null/undefined", () => {
    expect(safeDisplayText(null)).toBeNull();
    expect(safeDisplayText("")).toBeNull();
    expect(safeDisplayText(undefined)).toBeNull();
  });

  it("redacts then truncates", () => {
    const long = "Bearer abc123def456ghi789jkl0mno1pqr2 trailing payload that should be cut";
    const out = safeDisplayText(long, 40);
    expect(out).not.toBeNull();
    expect(out).not.toContain("abc123def456ghi789jkl0mno1pqr2");
    expect((out ?? "").length).toBeLessThanOrEqual(40);
  });
});
