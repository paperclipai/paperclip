import { describe, expect, it } from "vitest";
import { agentMatchesMentionTokens } from "../services/issues.ts";

describe("agentMatchesMentionTokens", () => {
  const agent = "David Okonkwo";

  it("matches full name (lowercase)", () => {
    const tokens = new Set(["david okonkwo"]);
    expect(agentMatchesMentionTokens(tokens, agent)).toBe(true);
  });

  it("matches first-name token", () => {
    const tokens = new Set(["david"]);
    expect(agentMatchesMentionTokens(tokens, agent)).toBe(true);
  });

  it("matches urlKey form", () => {
    const tokens = new Set(["david-okonkwo"]);
    expect(agentMatchesMentionTokens(tokens, agent)).toBe(true);
  });

  it("does not match last name alone", () => {
    const tokens = new Set(["okonkwo"]);
    expect(agentMatchesMentionTokens(tokens, agent)).toBe(false);
  });

  it("does not match partial first name", () => {
    const tokens = new Set(["dav"]);
    expect(agentMatchesMentionTokens(tokens, agent)).toBe(false);
  });

  it("does not match empty tokens", () => {
    const tokens = new Set<string>();
    expect(agentMatchesMentionTokens(tokens, agent)).toBe(false);
  });

  it("is case-insensitive (tokens are pre-lowercased by caller)", () => {
    const tokens = new Set(["david-okonkwo"]);
    expect(agentMatchesMentionTokens(tokens, "DAVID OKONKWO")).toBe(true);
  });

  it("matches single-word agent name as first name", () => {
    const tokens = new Set(["kai"]);
    expect(agentMatchesMentionTokens(tokens, "Kai")).toBe(true);
  });

  it("matches agent with hyphenated last name via urlKey", () => {
    const tokens = new Set(["anna-van-der-berg"]);
    expect(agentMatchesMentionTokens(tokens, "Anna Van Der Berg")).toBe(true);
  });

  it("matches agent with hyphenated last name via first name", () => {
    const tokens = new Set(["anna"]);
    expect(agentMatchesMentionTokens(tokens, "Anna Van Der Berg")).toBe(true);
  });

  it("does not match unrelated tokens", () => {
    const tokens = new Set(["marcus", "iris"]);
    expect(agentMatchesMentionTokens(tokens, agent)).toBe(false);
  });

  it("works with multiple tokens where one matches", () => {
    const tokens = new Set(["marcus", "david", "iris"]);
    expect(agentMatchesMentionTokens(tokens, agent)).toBe(true);
  });
});
