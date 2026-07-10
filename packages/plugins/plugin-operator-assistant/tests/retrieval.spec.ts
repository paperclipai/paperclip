import { describe, expect, it } from "vitest";
import {
  buildGroundedPrompt,
  extractIssueIdentifiers,
  extractSearchTerms,
  parseRequestedWindow,
  type AssistantEvidence,
} from "../src/retrieval.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");

describe("assistant retrieval planning", () => {
  it("parses the requested last-hour window", () => {
    const window = parseRequestedWindow("hey what did we work on in the last 1 hour?", NOW);
    expect(window.explicit).toBe(true);
    expect(window.from.toISOString()).toBe("2026-07-10T11:00:00.000Z");
    expect(window.to).toEqual(NOW);
  });

  it("supports natural singular time windows", () => {
    const window = parseRequestedWindow("show me the past week", NOW);
    expect(window.from.toISOString()).toBe("2026-07-03T12:00:00.000Z");
    expect(window.label).toBe("last week");
  });

  it("extracts exact issue references and useful historical terms", () => {
    expect(extractIssueIdentifiers("Compare elia-2296 with SIX-42 and ELIA-2296")).toEqual([
      "ELIA-2296",
      "SIX-42",
    ]);
    expect(extractSearchTerms("What happened with the Xero invoice mapping decision?")).toEqual([
      "happened",
      "xero",
      "invoice",
      "mapping",
      "decision",
    ]);
  });

  it("puts only retrieved evidence into the model prompt", () => {
    const evidence: AssistantEvidence = {
      company: { id: "company-1", name: "Acme", issuePrefix: "ACME" },
      retrievedAt: NOW.toISOString(),
      window: {
        from: "2026-07-10T11:00:00.000Z",
        to: NOW.toISOString(),
        label: "last 1 hour",
        explicit: true,
      },
      recentIssues: [],
      recentComments: [],
      recentRuns: [],
      historicalMatches: [],
      blockerEdges: [],
      sources: [],
    };
    const prompt = buildGroundedPrompt("What changed?", evidence);
    expect(prompt).toContain("What changed?");
    expect(prompt).toContain("last 1 hour");
    expect(prompt).toContain("If there is not enough evidence, say so");
  });
});
