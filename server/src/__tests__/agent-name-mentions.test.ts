import { describe, expect, it } from "vitest";
import { bodyIncludesAgentNameMention } from "../services/issues.ts";

describe("bodyIncludesAgentNameMention", () => {
  it("matches plain-text mentions for multi-word agent names", () => {
    expect(bodyIncludesAgentNameMention("@QA Engineer can you take a look?", "QA Engineer")).toBe(true);
  });

  it("matches multi-word mentions followed by punctuation", () => {
    expect(bodyIncludesAgentNameMention("Please review this, @Staff Engineer.", "Staff Engineer")).toBe(true);
  });

  it("does not treat partial names as valid mentions", () => {
    expect(bodyIncludesAgentNameMention("@QA can you take a look?", "QA Engineer")).toBe(false);
  });

  it("does not match when the @ marker is embedded in another token", () => {
    expect(bodyIncludesAgentNameMention("email@QA Engineer", "QA Engineer")).toBe(false);
  });

  it("only handles multi-word names in the fallback matcher", () => {
    expect(bodyIncludesAgentNameMention("@CEO please review", "CEO")).toBe(false);
  });
});
