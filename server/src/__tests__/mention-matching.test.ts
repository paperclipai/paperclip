import { describe, expect, it } from "vitest";
import { bodyContainsMention } from "../services/issues.ts";

describe("bodyContainsMention", () => {
  // --- basic matches ---
  it("matches @Name at start of string", () => {
    expect(bodyContainsMention("@Alice hello", "Alice")).toBe(true);
  });

  it("matches @Name at end of string", () => {
    expect(bodyContainsMention("hello @Alice", "Alice")).toBe(true);
  });

  it("matches @Name after whitespace", () => {
    expect(bodyContainsMention("hey @Alice how are you", "Alice")).toBe(true);
  });

  it("matches @Name followed by punctuation", () => {
    expect(bodyContainsMention("hey @Alice, how are you", "Alice")).toBe(true);
    expect(bodyContainsMention("ask @Alice.", "Alice")).toBe(true);
    expect(bodyContainsMention("ask @Alice!", "Alice")).toBe(true);
    expect(bodyContainsMention("ask @Alice?", "Alice")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(bodyContainsMention("@alice", "Alice")).toBe(true);
    expect(bodyContainsMention("@ALICE", "Alice")).toBe(true);
    expect(bodyContainsMention("@Alice", "alice")).toBe(true);
  });

  // --- multi-word agent names ---
  it("matches multi-word agent names", () => {
    expect(bodyContainsMention("contact @Research Agent for details", "Research Agent")).toBe(true);
  });

  it("matches multi-word name at start of string", () => {
    expect(bodyContainsMention("@Research Agent is great", "Research Agent")).toBe(true);
  });

  it("matches multi-word name at end of string", () => {
    expect(bodyContainsMention("talk to @Research Agent", "Research Agent")).toBe(true);
  });

  it("matches multi-word name followed by punctuation", () => {
    expect(bodyContainsMention("ask @Research Agent, he knows", "Research Agent")).toBe(true);
  });

  // --- should NOT match ---
  it("does not match email-style @ (preceded by word char)", () => {
    expect(bodyContainsMention("user@Alice.com", "Alice")).toBe(false);
  });

  it("does not match when name is a prefix of a longer word", () => {
    expect(bodyContainsMention("@Alicex", "Alice")).toBe(false);
    expect(bodyContainsMention("@Bobby", "Bob")).toBe(false);
  });

  it("does not match partial multi-word name", () => {
    // "Research" alone should not match agent named "Research Agent"
    expect(bodyContainsMention("@Research is cool", "Research Agent")).toBe(false);
  });

  it("does not match when @ is in the middle of a word", () => {
    expect(bodyContainsMention("test@Alice", "Alice")).toBe(false);
  });

  // --- no @ at all ---
  it("returns false when body has no @", () => {
    expect(bodyContainsMention("hello world", "Alice")).toBe(false);
  });

  // --- multiple mentions ---
  it("matches when multiple agents are mentioned", () => {
    expect(bodyContainsMention("@Alice and @Bob", "Alice")).toBe(true);
    expect(bodyContainsMention("@Alice and @Bob", "Bob")).toBe(true);
  });

  // --- with newlines ---
  it("matches @Name followed by newline", () => {
    expect(bodyContainsMention("@Alice\nnext line", "Alice")).toBe(true);
  });

  it("matches @Name after newline", () => {
    expect(bodyContainsMention("first line\n@Alice", "Alice")).toBe(true);
  });

  // --- markdown formatting contexts ---
  it("matches @Name in blockquote", () => {
    expect(bodyContainsMention(">@Alice said something", "Alice")).toBe(true);
    expect(bodyContainsMention("> @Alice said something", "Alice")).toBe(true);
  });

  it("matches @Name in parentheses", () => {
    expect(bodyContainsMention("(cc @Alice)", "Alice")).toBe(true);
    expect(bodyContainsMention("(@Alice)", "Alice")).toBe(true);
  });

  it("matches @Name after bold/italic markers", () => {
    expect(bodyContainsMention("**@Alice** is great", "Alice")).toBe(true);
    expect(bodyContainsMention("_@Alice_ is great", "Alice")).toBe(true);
    expect(bodyContainsMention("*@Alice*", "Alice")).toBe(true);
  });

  it("matches @Name after list marker", () => {
    expect(bodyContainsMention("- @Alice", "Alice")).toBe(true);
  });

  it("does not match when name is part of a hyphenated name", () => {
    expect(bodyContainsMention("@Alice-bot", "Alice")).toBe(false);
  });

  // --- edge: same-name prefix agents ---
  it("distinguishes between 'Al' and 'Alice'", () => {
    expect(bodyContainsMention("@Alice", "Al")).toBe(false);
    expect(bodyContainsMention("@Al ", "Al")).toBe(true);
    expect(bodyContainsMention("@Alice", "Alice")).toBe(true);
  });
});
