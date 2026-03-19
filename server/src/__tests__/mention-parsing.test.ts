import { describe, expect, it } from "vitest";
import { matchMentionedNames } from "../services/issues.js";

describe("matchMentionedNames", () => {
  const agents = ["CEO", "Software Agent 1", "CTO"];

  it("matches a single-word agent name", () => {
    const result = matchMentionedNames("Hello @CEO please review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("matches a multi-word agent name", () => {
    const result = matchMentionedNames("Hey @Software Agent 1 can you fix this?", agents);
    expect(result).toEqual(new Set(["software agent 1"]));
  });

  it("matches multiple agents in one body", () => {
    const result = matchMentionedNames("@CEO and @CTO please review", agents);
    expect(result).toEqual(new Set(["ceo", "cto"]));
  });

  it("matches agent at start of body", () => {
    const result = matchMentionedNames("@CEO fix this", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("matches agent at end of body", () => {
    const result = matchMentionedNames("Please review @CEO", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("is case-insensitive", () => {
    const result = matchMentionedNames("Hello @ceo and @software agent 1", agents);
    expect(result).toEqual(new Set(["ceo", "software agent 1"]));
  });

  it("does not match email-like patterns", () => {
    const result = matchMentionedNames("Send to admin@CEO.com", agents);
    expect(result).toEqual(new Set());
  });

  it("does not match partial name prefixes", () => {
    const result = matchMentionedNames("Hello @CEOx", agents);
    expect(result).toEqual(new Set());
  });

  it("returns empty set when no @ present", () => {
    const result = matchMentionedNames("No mentions here", agents);
    expect(result).toEqual(new Set());
  });

  // HTML entity decoding tests
  it("decodes &amp; in body before matching", () => {
    const result = matchMentionedNames("R&amp;D team: @CEO review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("decodes &#64; (@ as numeric entity) before matching", () => {
    const result = matchMentionedNames("Hello &#64;CEO please review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("decodes &#x40; (@ as hex entity) before matching", () => {
    const result = matchMentionedNames("Hello &#x40;CEO please review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("handles &nbsp; around mentions", () => {
    const result = matchMentionedNames("Hello&nbsp;@CEO&nbsp;review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("handles &lt; and &gt; around mentions", () => {
    const result = matchMentionedNames("&lt;@CEO&gt; review this", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("matches after newline", () => {
    const result = matchMentionedNames("Line 1\n@CEO please review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("matches after punctuation", () => {
    const result = matchMentionedNames("Done. @CEO please review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("matches mention followed by punctuation", () => {
    const result = matchMentionedNames("Hey @CEO, please review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("handles agent name containing HTML-encodable chars", () => {
    const result = matchMentionedNames(
      "Hey @R&amp;D Bot please check",
      ["R&D Bot", "CEO"],
    );
    expect(result).toEqual(new Set(["r&d bot"]));
  });

  // Double-encoded entity tests
  it("decodes double-encoded &amp;#64; (@ as double-encoded numeric entity)", () => {
    const result = matchMentionedNames("Hello &amp;#64;CEO please review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });

  it("decodes double-encoded &amp;#x40; (@ as double-encoded hex entity)", () => {
    const result = matchMentionedNames("Hello &amp;#x40;CEO please review", agents);
    expect(result).toEqual(new Set(["ceo"]));
  });
});
