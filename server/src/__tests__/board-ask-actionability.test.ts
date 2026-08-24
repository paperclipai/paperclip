import { describe, expect, it } from "vitest";
import { classifyBoardAsk } from "../services/board-ask-actionability.js";

describe("classifyBoardAsk (TSMC-21471)", () => {
  it("routes back the ceiling-guard templates that made up all 30 live board asks", () => {
    // Verbatim from production, 2026-08-24. 25 of 30 were the first string.
    const ceiling = classifyBoardAsk(
      "Record the business disposition, split the remaining work into bounded issues, "
      + "or approve a deterministic route before resuming generation.",
    );
    expect(ceiling.humanOnly).toBe(false);

    const tokenCap = classifyBoardAsk(
      "Review the token-cap partial work and approve a bounded split or deterministic route before explicitly resuming.",
    );
    expect(tokenCap.humanOnly).toBe(false);

    const aggregate = classifyBoardAsk(
      "Approve a split or deterministic route after the aggregate input ceiling, then explicitly resume the task.",
    );
    expect(aggregate.humanOnly).toBe(false);
  });

  it("does NOT mistake a token CAP for a credential token", () => {
    // The whole reason the human-only patterns are word-boundary anchored: a
    // naive /token/ match would send every ceiling stop to the operator, which is
    // the bug this class exists to fix, inverted.
    const capped = classifyBoardAsk("Review the token-cap partial work and approve a bounded split.");
    expect(capped.humanOnly).toBe(false);

    const credential = classifyBoardAsk("Rotate the access token for the Postiz integration and re-bind it.");
    expect(credential.humanOnly).toBe(true);
    expect(credential.category).toBe("credential");
  });

  it("keeps genuine human-only asks with the operator, by category", () => {
    const cases: Array<[string, string]> = [
      ["Provide the API key for the new Stripe account.", "credential"],
      ["Complete the OAuth consent screen for the LinkedIn app.", "oauth"],
      ["Approve the payment for the annual subscription.", "spend"],
      ["Countersign the contract with the accountant.", "identity"],
      ["Approve publishing the listing live to Etsy.", "g_class"],
    ];
    for (const [text, category] of cases) {
      const result = classifyBoardAsk(text);
      expect(result.humanOnly, text).toBe(true);
      expect(result.category, text).toBe(category);
    }
  });

  it("defaults to the operator when nothing matches — never routes on absence of evidence", () => {
    const unknown = classifyBoardAsk("Decide what we want to do about the Galway thing.");
    expect(unknown.humanOnly).toBe(true);
    expect(unknown.matched).toBeNull();

    const empty = classifyBoardAsk("");
    expect(empty.humanOnly).toBe(true);
  });

  it("lets a human-only signal win over an agent-actionable one in the same text", () => {
    // "re-run" is agent-actionable, "credentials" is not. Safety beats throughput.
    const mixed = classifyBoardAsk("Re-run the import once you have the database credentials.");
    expect(mixed.humanOnly).toBe(true);
    expect(mixed.category).toBe("credential");
  });

  it("always explains itself — the reason is safe to put straight in a comment", () => {
    for (const text of ["Provide the API key.", "Split the remaining work into bounded issues.", ""]) {
      expect(classifyBoardAsk(text).reason.length).toBeGreaterThan(20);
    }
  });
});
