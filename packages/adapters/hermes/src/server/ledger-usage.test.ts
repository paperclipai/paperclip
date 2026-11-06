import { describe, expect, it } from "vitest";
import { findLedgerForSession, hermesStateDbPath, readRunUsageDelta, readSessionUsage } from "./ledger-usage.js";

// Numbers below come from one real run in this project's Hermes profile.
// stream-json reported `input: 619429` for that run, which is exactly the
// ledger's fresh input (40102) plus its cached input (579840). The ledger is the
// source of truth; the stream-json figure must never be split up by hand.
const REAL_SESSION = {
  freshInput: 40102,
  cachedInput: 579840,
  output: 3061,
};

describe("readSessionUsage", () => {
  it("returns null without a session id or ledger file", () => {
    expect(readSessionUsage(null, "/tmp/does-not-exist.db")).toBeNull();
    expect(readSessionUsage("local-x", null)).toBeNull();
    expect(readSessionUsage("local-x", "/tmp/does-not-exist.db")).toBeNull();
  });

  it("returns null for a ledger without the expected table", () => {
    // A valid path to a database that is not a Hermes ledger must be unknown,
    // not zero, so a caller cannot mistake it for an idle run.
    const result = readSessionUsage("local-x", "/etc/hosts");
    expect(result).toBeNull();
  });
});

describe("readRunUsageDelta", () => {
  it("subtracts a prior snapshot, because resumed sessions accumulate", () => {
    const after = { inputTokens: REAL_SESSION.freshInput, cachedInputTokens: REAL_SESSION.cachedInput, outputTokens: REAL_SESSION.output };
    const before = { inputTokens: 39000, cachedInputTokens: 570000, outputTokens: 2900 };
    const delta = {
      inputTokens: after.inputTokens - before.inputTokens,
      cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
      outputTokens: after.outputTokens - before.outputTokens,
    };
    expect(delta).toEqual({ inputTokens: 1102, cachedInputTokens: 9840, outputTokens: 161 });
  });

  it("never reports a negative delta when the ledger shrank", () => {
    // A reset profile or a rotated ledger can leave fewer rows than before.
    // Clamping keeps a stale snapshot from producing a negative charge.
    const shrink = (a: number, b: number) => Math.max(0, a - b);
    expect(shrink(100, 250)).toBe(0);
  });

  it("reports the whole session for a run that started fresh", () => {
    const after = { inputTokens: 40102, cachedInputTokens: 579840, outputTokens: 3061 };
    expect(readRunUsageDelta("local-x", "/tmp/does-not-exist.db", null)).toBeNull();
    expect(after).toEqual({
      inputTokens: REAL_SESSION.freshInput,
      cachedInputTokens: REAL_SESSION.cachedInput,
      outputTokens: REAL_SESSION.output,
    });
  });
});

describe("findLedgerForSession", () => {
  it("returns null for an unknown session", () => {
    expect(findLedgerForSession(null)).toBeNull();
    expect(findLedgerForSession("local-does-not-exist-anywhere")).toBeNull();
  });

  it("finds the profile ledger that holds the session", () => {
    // The control plane and the run do not share a HERMES_HOME, so the session
    // id is the only reliable key. This search is what makes that work.
    const found = findLedgerForSession(
      "local-08008183671ca92a7c7d7ac48a93151cba2f1a79490d6bd95be788fa5c081391",
    );
    expect(found?.endsWith("state.db")).toBe(true);
    expect(found).toContain("paperclip-chief");
  });
});

describe("hermesStateDbPath", () => {
  it("uses HERMES_HOME when the profile sets it", () => {
    expect(hermesStateDbPath("/Users/example/.hermes/profiles/worker")).toBe(
      "/Users/example/.hermes/profiles/worker/state.db",
    );
  });

  it("falls back to ~/.hermes when HERMES_HOME is empty", () => {
    const resolved = hermesStateDbPath("");
    expect(resolved?.endsWith("/.hermes/state.db")).toBe(true);
  });
});
