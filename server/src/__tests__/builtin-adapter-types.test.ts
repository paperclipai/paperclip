import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";

describe("BUILTIN_ADAPTER_TYPES", () => {
  it("is a Set", () => {
    expect(BUILTIN_ADAPTER_TYPES).toBeInstanceOf(Set);
  });

  it("contains claude_local", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("claude_local")).toBe(true);
  });

  it("contains codex_local", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("codex_local")).toBe(true);
  });

  it("contains cursor", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("cursor")).toBe(true);
  });

  it("contains gemini_local", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("gemini_local")).toBe(true);
  });

  it("contains openclaw_gateway", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("openclaw_gateway")).toBe(true);
  });

  it("contains opencode_local", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("opencode_local")).toBe(true);
  });

  it("contains pi_local", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("pi_local")).toBe(true);
  });

  it("contains hermes_local", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("hermes_local")).toBe(true);
  });

  it("contains process", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("process")).toBe(true);
  });

  it("contains http", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("http")).toBe(true);
  });

  it("does not contain unknown adapter types", () => {
    expect(BUILTIN_ADAPTER_TYPES.has("external_plugin")).toBe(false);
    expect(BUILTIN_ADAPTER_TYPES.has("")).toBe(false);
    expect(BUILTIN_ADAPTER_TYPES.has("CLAUDE_LOCAL")).toBe(false);
  });

  it("has exactly 10 entries", () => {
    expect(BUILTIN_ADAPTER_TYPES.size).toBe(10);
  });
});
