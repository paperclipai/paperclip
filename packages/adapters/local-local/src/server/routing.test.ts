import { describe, expect, it } from "vitest";
import { isClaudeModel } from "../index.js";

describe("isClaudeModel", () => {
  it("returns true for Claude Opus", () => {
    expect(isClaudeModel("claude-opus-4-6")).toBe(true);
  });

  it("returns true for Claude Sonnet", () => {
    expect(isClaudeModel("claude-sonnet-4-6")).toBe(true);
  });

  it("returns true for Claude Haiku", () => {
    expect(isClaudeModel("claude-haiku-4-6")).toBe(true);
  });

  it("returns true for Claude Sonnet 4.5 with date suffix", () => {
    expect(isClaudeModel("claude-sonnet-4-5-20250929")).toBe(true);
  });

  it("returns true for claude/ prefixed models", () => {
    expect(isClaudeModel("claude/sonnet-4-6")).toBe(true);
  });

  it("returns false for qwen local models", () => {
    expect(isClaudeModel("qwen/qwen3.5-9b")).toBe(false);
  });

  it("returns false for qwen coder models", () => {
    expect(isClaudeModel("qwen2.5-coder:32b")).toBe(false);
  });

  it("returns false for deepseek models", () => {
    expect(isClaudeModel("deepseek-coder-v2:16b")).toBe(false);
  });

  it("returns false for deepseek-r1 models", () => {
    expect(isClaudeModel("deepseek-r1:8b")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isClaudeModel("")).toBe(false);
  });

  it("returns false for arbitrary model names", () => {
    expect(isClaudeModel("llama-3.1-70b")).toBe(false);
  });
});
