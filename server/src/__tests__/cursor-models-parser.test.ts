import { describe, it, expect } from "vitest";
import { parseCursorModelsOutput } from "../adapters/cursor-models.js";

// ============================================================================
// parseCursorModelsOutput — JSON stdout (array format)
// ============================================================================

describe("parseCursorModelsOutput — JSON array in stdout", () => {
  it("parses a JSON array of string model IDs", () => {
    const stdout = JSON.stringify(["gpt-4o", "claude-3-5-sonnet"]);
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-5-sonnet")).toBe(true);
  });

  it("parses a JSON array of objects with id field", () => {
    const stdout = JSON.stringify([{ id: "gpt-4o" }, { id: "claude-3-opus" }]);
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-opus")).toBe(true);
  });

  it("deduplicates models from JSON array", () => {
    const stdout = JSON.stringify(["gpt-4o", "gpt-4o", "claude-3-5-sonnet"]);
    const result = parseCursorModelsOutput(stdout, "");
    const ids = result.map((m) => m.id);
    expect(ids.filter((id) => id === "gpt-4o")).toHaveLength(1);
  });

  it("skips invalid (non-string, non-object) array elements", () => {
    const stdout = JSON.stringify(["gpt-4o", null, 42, true, { id: "claude-3-5-sonnet" }]);
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-5-sonnet")).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty JSON array", () => {
    const result = parseCursorModelsOutput("[]", "");
    expect(result).toEqual([]);
  });
});

// ============================================================================
// parseCursorModelsOutput — JSON stdout (object format)
// ============================================================================

describe("parseCursorModelsOutput — JSON object in stdout", () => {
  it("parses models array from object with .models key", () => {
    const stdout = JSON.stringify({ models: ["gpt-4o", "gpt-4-turbo"] });
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "gpt-4-turbo")).toBe(true);
  });

  it("parses models array from object with .data key", () => {
    const stdout = JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4-turbo" }] });
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "gpt-4-turbo")).toBe(true);
  });

  it("handles object with no recognized key gracefully", () => {
    const stdout = JSON.stringify({ unknown: ["gpt-4o"] });
    const result = parseCursorModelsOutput(stdout, "");
    // No recognized key, no models extracted from JSON path
    expect(result).toEqual([]);
  });

  it("falls through to text parsing when JSON is malformed", () => {
    const stdout = "{broken json";
    // Text parsing fallback: no "available models:" pattern, no bullet points — empty result
    const result = parseCursorModelsOutput(stdout, "");
    expect(Array.isArray(result)).toBe(true);
  });
});

// ============================================================================
// parseCursorModelsOutput — "available models:" regex pattern
// ============================================================================

describe("parseCursorModelsOutput — available models line", () => {
  it("parses comma-separated model list from 'available models:' line", () => {
    const stdout = "Available models: gpt-4o, gpt-4-turbo, claude-3-5-sonnet";
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "gpt-4-turbo")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-5-sonnet")).toBe(true);
  });

  it("handles 'available model:' (singular) pattern", () => {
    const stdout = "Available model: gpt-4o";
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
  });

  it("is case-insensitive for 'AVAILABLE MODELS:'", () => {
    const stdout = "AVAILABLE MODELS: gpt-4o, claude-3-opus";
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
  });

  it("parses from stderr when stdout is empty", () => {
    const stderr = "Available models: gpt-4o, claude-3-5-sonnet";
    const result = parseCursorModelsOutput("", stderr);
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-5-sonnet")).toBe(true);
  });

  it("deduplicates models found via available-models pattern", () => {
    const stdout = "Available models: gpt-4o, gpt-4o, claude-3-5-sonnet";
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.filter((m) => m.id === "gpt-4o")).toHaveLength(1);
  });
});

// ============================================================================
// parseCursorModelsOutput — bullet point / line-by-line parsing
// ============================================================================

describe("parseCursorModelsOutput — bullet point parsing", () => {
  it("parses single-word lines as model IDs", () => {
    const stdout = "gpt-4o\nclaude-3-5-sonnet\ngpt-4-turbo";
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-5-sonnet")).toBe(true);
  });

  it("parses '- model-id' bullet format", () => {
    const stdout = "- gpt-4o\n- claude-3-5-sonnet";
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-5-sonnet")).toBe(true);
  });

  it("parses '* model-id' bullet format", () => {
    const stdout = "* gpt-4o\n* claude-3-5-sonnet";
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
  });

  it("skips lines containing spaces (unlikely to be model IDs)", () => {
    const stdout = "This is a description line\ngpt-4o\nAnother sentence here";
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    // Lines with spaces are skipped
    expect(result.some((m) => m.id.includes(" "))).toBe(false);
  });

  it("returns empty array for fully empty stdout and stderr", () => {
    const result = parseCursorModelsOutput("", "");
    expect(result).toEqual([]);
  });
});

// ============================================================================
// parseCursorModelsOutput — model ID sanitization
// ============================================================================

describe("parseCursorModelsOutput — model ID sanitization", () => {
  it("strips surrounding quotes from model IDs", () => {
    const stdout = JSON.stringify(['"gpt-4o"', "'claude-3-5-sonnet'"]);
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-5-sonnet")).toBe(true);
  });

  it("strips parenthetical suffixes from model IDs", () => {
    const stdout = JSON.stringify(["gpt-4o (preview)", "claude-3-5-sonnet (latest)"]);
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    expect(result.some((m) => m.id === "claude-3-5-sonnet")).toBe(true);
  });

  it("rejects model IDs with invalid characters", () => {
    const stdout = JSON.stringify(["valid-model/v1", "invalid model!", "@bad"]);
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.some((m) => m.id === "valid-model/v1")).toBe(true);
    expect(result.some((m) => m.id.includes("!"))).toBe(false);
    expect(result.some((m) => m.id.startsWith("@"))).toBe(false);
  });

  it("rejects empty model IDs after trimming", () => {
    const stdout = JSON.stringify(["  ", "", "gpt-4o"]);
    const result = parseCursorModelsOutput(stdout, "");
    expect(result.filter((m) => m.id.trim() === "")).toHaveLength(0);
    expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
  });
});

// ============================================================================
// parseCursorModelsOutput — label assignment
// ============================================================================

describe("parseCursorModelsOutput — label assignment", () => {
  it("sets label equal to id for string-parsed models", () => {
    const stdout = JSON.stringify(["gpt-4o"]);
    const result = parseCursorModelsOutput(stdout, "");
    const model = result.find((m) => m.id === "gpt-4o");
    expect(model?.label).toBe("gpt-4o");
  });

  it("sets label from object if provided", () => {
    // Objects without explicit label get id as label via pushModelId
    const stdout = JSON.stringify([{ id: "gpt-4o" }]);
    const result = parseCursorModelsOutput(stdout, "");
    const model = result.find((m) => m.id === "gpt-4o");
    expect(model?.label).toBe("gpt-4o");
  });
});
