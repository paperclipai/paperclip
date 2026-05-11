import { describe, it, expect } from "vitest";
import { findMentionedUsers, commentMentionsUser } from "../src/mentions.js";

const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";

describe("findMentionedUsers", () => {
  it("returns empty set on empty body", () => {
    expect(findMentionedUsers("")).toEqual(new Set());
  });

  it("returns empty set on body without mentions", () => {
    expect(findMentionedUsers("Just a comment, no pings.")).toEqual(new Set());
  });

  it("extracts a single mention", () => {
    const body = `Hey [@Walter](user://${WALTER}), please review.`;
    expect(findMentionedUsers(body)).toEqual(new Set([WALTER]));
  });

  it("extracts multiple distinct mentions", () => {
    const body = `[@A](user://aaa) and [@B](user://bbb)`;
    expect(findMentionedUsers(body)).toEqual(new Set(["aaa", "bbb"]));
  });

  it("deduplicates the same user mentioned twice", () => {
    const body = `[@A](user://aaa) and [@A again](user://aaa)`;
    expect(findMentionedUsers(body)).toEqual(new Set(["aaa"]));
  });

  it("ignores bare @-mentions without the markdown link", () => {
    expect(findMentionedUsers("Hey @Walter, no link")).toEqual(new Set());
  });
});

describe("commentMentionsUser", () => {
  it("returns true when the user is mentioned", () => {
    const body = `[@Walter](user://${WALTER}) review please`;
    expect(commentMentionsUser(body, WALTER)).toBe(true);
  });

  it("returns false when the user is not mentioned", () => {
    const body = `[@Other](user://other-id) review please`;
    expect(commentMentionsUser(body, WALTER)).toBe(false);
  });
});
