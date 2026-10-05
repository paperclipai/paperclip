import { describe, expect, it } from "vitest";
import { decideClaudeAuthMerge } from "../services/ai-connection-runtime.js";

// The predicate returns the decision codes the Codex and Grok predicates
// return: 10 writes the refreshed credential back, anything else keeps the
// stored one. Claude Code rewrites `.credentials.json` whenever it refreshes,
// and two runs of the same account can finish out of order, so the newest
// expiry has to win rather than the last writer.
const WRITE_BACK = 10;

const document = (expiresAt: number | null, accessToken: string | null = "token") =>
  JSON.stringify({
    claudeAiOauth: {
      ...(accessToken === null ? {} : { accessToken }),
      ...(expiresAt === null ? {} : { expiresAt }),
      refreshToken: "refresh",
    },
  });

describe("decideClaudeAuthMerge", () => {
  it("writes back a credential that expires later than the stored one", () => {
    expect(decideClaudeAuthMerge(document(2000), document(1000))).toBe(WRITE_BACK);
  });

  it("writes back when the stored credential carries no usable expiry", () => {
    // A connection saved before the document format has no expiry to compare.
    // The refreshed document is the only rotatable copy, so it must win.
    expect(decideClaudeAuthMerge(document(2000), "bare-token")).toBe(WRITE_BACK);
    expect(decideClaudeAuthMerge(document(2000), document(null))).toBe(WRITE_BACK);
  });

  it("keeps the stored credential when the refreshed one is equal or older", () => {
    // A slower concurrent run must not overwrite a newer credential.
    expect(decideClaudeAuthMerge(document(1000), document(1000))).not.toBe(WRITE_BACK);
    expect(decideClaudeAuthMerge(document(1000), document(2000))).not.toBe(WRITE_BACK);
  });

  it("keeps the stored credential when the refreshed one is malformed", () => {
    expect(decideClaudeAuthMerge("not json", document(1000))).not.toBe(WRITE_BACK);
    expect(decideClaudeAuthMerge("[]", document(1000))).not.toBe(WRITE_BACK);
    expect(decideClaudeAuthMerge(JSON.stringify({}), document(1000))).not.toBe(WRITE_BACK);
  });

  it("keeps the stored credential when the refreshed one has no access token", () => {
    expect(decideClaudeAuthMerge(document(2000, null), document(1000))).not.toBe(WRITE_BACK);
    expect(decideClaudeAuthMerge(document(2000, ""), document(1000))).not.toBe(WRITE_BACK);
  });

  it("keeps the stored credential when the refreshed expiry is not a number", () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: "2000" } });
    expect(decideClaudeAuthMerge(text, document(1000))).not.toBe(WRITE_BACK);
  });
});
