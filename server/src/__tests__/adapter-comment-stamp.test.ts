import { describe, it, expect } from "vitest";
import { buildAdapterStamp, stampAdapterModel, hasAdapterStamp } from "../services/adapter-comment-stamp.js";

describe("adapter-comment-stamp", () => {
  describe("buildAdapterStamp", () => {
    it("builds a stamp with adapter type and model", () => {
      expect(buildAdapterStamp("claude_local", "claude-sonnet-4-20250514"))
        .toBe("[Adapter: claude_local | Model: claude-sonnet-4-20250514]");
    });

    it("uses 'default model' when model is null", () => {
      expect(buildAdapterStamp("hermes_local", null))
        .toBe("[Adapter: hermes_local | Model: default model]");
    });

    it("uses 'default model' when model is empty string", () => {
      expect(buildAdapterStamp("claude_local", ""))
        .toBe("[Adapter: claude_local | Model: default model]");
    });

    it("uses 'default model' when model is whitespace", () => {
      expect(buildAdapterStamp("claude_local", "   "))
        .toBe("[Adapter: claude_local | Model: default model]");
    });

    it("uses 'default model' when model is undefined", () => {
      expect(buildAdapterStamp("codex_local", undefined))
        .toBe("[Adapter: codex_local | Model: default model]");
    });

    it("trims whitespace from model name", () => {
      expect(buildAdapterStamp("claude_local", "  opus-4  "))
        .toBe("[Adapter: claude_local | Model: opus-4]");
    });
  });

  describe("stampAdapterModel", () => {
    it("prepends stamp to a body without existing stamp", () => {
      const result = stampAdapterModel("Hello world", "claude_local", "opus-4");
      expect(result).toBe("[Adapter: claude_local | Model: opus-4]\nHello world");
    });

    it("replaces model-supplied stamp with config-derived stamp", () => {
      const body = "[Adapter: wrong-adapter | Model: wrong-model]\nActual comment text";
      const result = stampAdapterModel(body, "claude_local", "claude-sonnet-4-20250514");
      expect(result).toBe("[Adapter: claude_local | Model: claude-sonnet-4-20250514]\nActual comment text");
    });

    it("replaces stamp even without newline after it", () => {
      const body = "[Adapter: x | Model: y]Actual comment text";
      const result = stampAdapterModel(body, "claude_local", "opus-4");
      expect(result).toBe("[Adapter: claude_local | Model: opus-4]\nActual comment text");
    });

    it("handles \\r\\n line endings in existing stamp", () => {
      const body = "[Adapter: x | Model: y]\r\nActual comment text";
      const result = stampAdapterModel(body, "claude_local", "opus-4");
      expect(result).toBe("[Adapter: claude_local | Model: opus-4]\nActual comment text");
    });

    it("only replaces stamp on the first line", () => {
      const body = "First line\n[Adapter: x | Model: y]\nThird line";
      const result = stampAdapterModel(body, "claude_local", "opus-4");
      expect(result).toBe("[Adapter: claude_local | Model: opus-4]\nFirst line\n[Adapter: x | Model: y]\nThird line");
    });

    it("preserves multiline body content", () => {
      const body = "Line 1\nLine 2\nLine 3";
      const result = stampAdapterModel(body, "codex_local", null);
      expect(result).toBe("[Adapter: codex_local | Model: default model]\nLine 1\nLine 2\nLine 3");
    });

    it("handles empty body", () => {
      const result = stampAdapterModel("", "claude_local", "opus-4");
      expect(result).toBe("[Adapter: claude_local | Model: opus-4]\n");
    });

    it("replaces exact-match existing stamp (no duplication)", () => {
      const body = "[Adapter: claude_local | Model: opus-4]\nComment body";
      const result = stampAdapterModel(body, "claude_local", "opus-4");
      expect(result).toBe("[Adapter: claude_local | Model: opus-4]\nComment body");
    });

    it("handles multi-line stamp-like text in body without touching it", () => {
      const body = "My adapter is [Adapter: something | Model: else] and here's why";
      const result = stampAdapterModel(body, "claude_local", "opus-4");
      expect(result).toBe("[Adapter: claude_local | Model: opus-4]\nMy adapter is [Adapter: something | Model: else] and here's why");
    });
  });

  describe("hasAdapterStamp", () => {
    it("returns true for body with stamp", () => {
      expect(hasAdapterStamp("[Adapter: x | Model: y]\nBody")).toBe(true);
    });

    it("returns false for body without stamp", () => {
      expect(hasAdapterStamp("Just a comment")).toBe(false);
    });

    it("returns false for stamp not at start", () => {
      expect(hasAdapterStamp("Text\n[Adapter: x | Model: y]\nMore")).toBe(false);
    });
  });
});
