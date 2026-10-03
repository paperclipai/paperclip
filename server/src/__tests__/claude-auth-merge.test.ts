import { describe, expect, it } from "vitest";
import {
  IMPLAUSIBLE_EXPIRY,
  KEEP_DESTINATION,
  MAX_PLAUSIBLE_EXPIRY_MS,
  UNREADABLE_EXPIRY,
  USE_SOURCE,
  decideClaudeAuthMerge,
  isRefreshableClaudeDocument,
} from "../services/claude-credential-document.js";

// The predicate returns the decision codes the Codex and Grok predicates
// return: 10 writes the refreshed credential back, 20 keeps the stored one,
// 21 keeps it because an expiry is unreadable, 22 keeps it because the
// refreshed expiry is implausibly far ahead. Claude Code rewrites
// `.credentials.json` whenever it refreshes, and two runs of the same account
// can finish out of order, so the newest expiry has to win rather than the
// last writer.
const NOW = Date.UTC(2026, 8, 27, 12);
const HOUR = 3_600_000;

type Oauth = Record<string, unknown>;
const document = (oauth: Oauth = {}, root: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...root,
    claudeAiOauth: { accessToken: "token", refreshToken: "refresh", expiresAt: NOW, ...oauth },
  });
const decide = (refreshed: string, stored: string) => decideClaudeAuthMerge(refreshed, stored, NOW);

describe("isRefreshableClaudeDocument", () => {
  it("requires an access token, a refresh token and a readable expiry", () => {
    expect(isRefreshableClaudeDocument(document())).toBe(true);
    // A `claude setup-token` credential: long-lived, nothing to refresh.
    expect(isRefreshableClaudeDocument(document({ refreshToken: undefined }))).toBe(false);
    expect(isRefreshableClaudeDocument(document({ refreshToken: " " }))).toBe(false);
    expect(isRefreshableClaudeDocument(document({ accessToken: "" }))).toBe(false);
    // Without a readable expiry the write-back can never prove a refreshed
    // copy newer, so the document would freeze at sign-in.
    expect(isRefreshableClaudeDocument(document({ expiresAt: undefined }))).toBe(false);
    expect(isRefreshableClaudeDocument(document({ expiresAt: "tomorrow" }))).toBe(false);
    expect(isRefreshableClaudeDocument(document({ expiresAt: new Date(NOW).toISOString() }))).toBe(true);
    expect(isRefreshableClaudeDocument(document({ expiresAt: NOW / 1000 }))).toBe(true);
  });

  it("rejects a bare token and malformed input", () => {
    for (const value of ["bare-token", "not json", "[]", "{}", JSON.stringify({ claudeAiOauth: [] })])
      expect(isRefreshableClaudeDocument(value)).toBe(false);
  });
});

describe("decideClaudeAuthMerge", () => {
  it("writes back a credential that expires later than the stored one", () => {
    expect(decide(document({ expiresAt: NOW + 8 * HOUR }), document())).toBe(USE_SOURCE);
  });

  it("keeps the stored credential when the refreshed one is equal or older", () => {
    // A slower concurrent run must not overwrite a newer credential. This is
    // the ordinary no-write case, so it is 20, never the 22 of a bad expiry.
    expect(decide(document(), document())).toBe(KEEP_DESTINATION);
    expect(decide(document(), document({ expiresAt: NOW + HOUR }))).toBe(KEEP_DESTINATION);
  });

  it("keeps the stored credential when either side is not a refreshable document", () => {
    const newer = document({ expiresAt: NOW + HOUR });
    for (const refreshed of ["not json", "[]", "{}", document({ accessToken: undefined }), document({ refreshToken: undefined })])
      expect(decide(refreshed, document())).toBe(KEEP_DESTINATION);
    expect(decide(newer, "bare-token")).toBe(KEEP_DESTINATION);
    expect(decide(newer, document({ refreshToken: undefined }))).toBe(KEEP_DESTINATION);
  });

  describe("identity", () => {
    const later = NOW + 8 * HOUR;

    it("refuses a document for a different subscription type", () => {
      expect(decide(document({ expiresAt: later, subscriptionType: "pro" }), document({ subscriptionType: "max" }))).toBe(KEEP_DESTINATION);
    });

    it("refuses a document for a different account", () => {
      expect(decide(document({ expiresAt: later }, { account: { uuid: "b" } }), document({}, { account: { uuid: "a" } }))).toBe(KEEP_DESTINATION);
    });

    it("accepts a document that repeats every identity field of the stored one", () => {
      expect(decide(document({ expiresAt: later, subscriptionType: "max" }, { account: { uuid: "a" } }), document({ subscriptionType: "max" }, { account: { uuid: "a" } }))).toBe(USE_SOURCE);
      // A field the stored document does not carry is not required.
      expect(decide(document({ expiresAt: later, subscriptionType: "max" }), document())).toBe(USE_SOURCE);
    });

    it("refuses a document that leaves out an identity field of the stored one", () => {
      // The agent process can write the refreshed copy, so omitting a field
      // must not pass as a match.
      expect(decide(document({ expiresAt: later }), document({}, { account: { uuid: "a" } }))).toBe(KEEP_DESTINATION);
      expect(decide(document({ expiresAt: later }), document({ subscriptionType: "max" }))).toBe(KEEP_DESTINATION);
      expect(decide(document({ expiresAt: later, subscriptionType: "" }), document({ subscriptionType: "max" }))).toBe(KEEP_DESTINATION);
    });
  });

  describe("expiry", () => {
    it("keeps the stored credential when either expiry is absent", () => {
      expect(decide(document({ expiresAt: undefined }), document())).toBe(KEEP_DESTINATION);
      expect(decide(document({ expiresAt: NOW + HOUR }), document({ expiresAt: undefined }))).toBe(KEEP_DESTINATION);
      expect(decide(document({ expiresAt: NOW + HOUR }), document({ expiresAt: null }))).toBe(KEEP_DESTINATION);
    });

    it("accepts ISO-8601, epoch seconds and epoch milliseconds", () => {
      const iso = new Date(NOW + HOUR).toISOString();
      expect(decide(document({ expiresAt: iso }), document())).toBe(USE_SOURCE);
      expect(decide(document({ expiresAt: (NOW + HOUR) / 1000 }), document())).toBe(USE_SOURCE);
      expect(decide(document({ expiresAt: NOW + HOUR }), document({ expiresAt: NOW / 1000 }))).toBe(USE_SOURCE);
      expect(decide(document({ expiresAt: NOW / 1000 }), document({ expiresAt: iso }))).toBe(KEEP_DESTINATION);
    });

    it("reports an expiry that is present but unreadable", () => {
      for (const expiresAt of ["2000", "tomorrow", true, {}])
        expect(decide(document({ expiresAt }), document())).toBe(UNREADABLE_EXPIRY);
      expect(decide(document({ expiresAt: NOW + HOUR }), document({ expiresAt: "tomorrow" }))).toBe(UNREADABLE_EXPIRY);
    });

    it("refuses a refreshed expiry past the plausible bound against the server clock", () => {
      expect(decide(document({ expiresAt: NOW + MAX_PLAUSIBLE_EXPIRY_MS }), document())).toBe(USE_SOURCE);
      expect(decide(document({ expiresAt: NOW + MAX_PLAUSIBLE_EXPIRY_MS + 1 }), document())).toBe(IMPLAUSIBLE_EXPIRY);
      expect(decide(document({ expiresAt: NOW + 10 * 365 * 24 * HOUR }), document())).toBe(IMPLAUSIBLE_EXPIRY);
    });
  });
});
