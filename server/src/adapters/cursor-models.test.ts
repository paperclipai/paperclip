import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listCursorModels,
  parseCursorModelsOutput,
  resetCursorModelsCacheForTests,
  setCursorModelsRunnerForTests,
} from "./cursor-models.js";

// ============================================================================
// parseCursorModelsOutput — empty / no input
// ============================================================================

describe("parseCursorModelsOutput — empty input", () => {
  it("returns empty array when both stdout and stderr are empty", () => {
    expect(parseCursorModelsOutput("", "")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseCursorModelsOutput("   ", "   ")).toEqual([]);
  });
});

// ============================================================================
// parseCursorModelsOutput — JSON stdout
// ============================================================================

describe("parseCursorModelsOutput — JSON stdout", () => {
  it("parses a JSON array of string model IDs", () => {
    const result = parseCursorModelsOutput('["gpt-4o","claude-3-5-sonnet"]', "");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("claude-3-5-sonnet");
  });

  it("parses a JSON array of objects with id field", () => {
    const stdout = JSON.stringify([{ id: "gpt-4o" }, { id: "gpt-4o-mini" }]);
    const result = parseCursorModelsOutput(stdout, "");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("gpt-4o-mini");
  });

  it("parses a JSON object with a models array", () => {
    const stdout = JSON.stringify({ models: ["gpt-4o", "o3-mini"] });
    const result = parseCursorModelsOutput(stdout, "");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("o3-mini");
  });

  it("parses a JSON object with a data array", () => {
    const stdout = JSON.stringify({ data: [{ id: "gpt-4o" }] });
    const result = parseCursorModelsOutput(stdout, "");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
  });

  it("ignores malformed JSON and falls through to plain-text parsing", () => {
    const result = parseCursorModelsOutput("{invalid json}", "");
    expect(Array.isArray(result)).toBe(true);
  });

  it("strips surrounding quotes from model IDs", () => {
    const stdout = JSON.stringify(['"gpt-4o"']);
    const result = parseCursorModelsOutput(stdout, "");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids.some((id) => id.startsWith('"'))).toBe(false);
  });

  it("strips parenthetical suffixes from model IDs", () => {
    const stdout = JSON.stringify(["gpt-4o (preview)"]);
    const result = parseCursorModelsOutput(stdout, "");
    // The trailing " (preview)" part should have been stripped via sanitizeModelId
    // "gpt-4o " → after trim → "gpt-4o", which passes isLikelyModelId
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
  });
});

// ============================================================================
// parseCursorModelsOutput — plain text formats
// ============================================================================

describe("parseCursorModelsOutput — plain text 'available models:' line", () => {
  it("parses comma-separated model list after 'available models:'", () => {
    const result = parseCursorModelsOutput("", "Available models: gpt-4o, o3-mini, claude-3");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("o3-mini");
    expect(ids).toContain("claude-3");
  });

  it("handles 'available model:' (singular) variant", () => {
    const result = parseCursorModelsOutput("available model: gpt-4o", "");
    expect(result.map((m) => m.id)).toContain("gpt-4o");
  });

  it("is case-insensitive for the prefix", () => {
    const result = parseCursorModelsOutput("AVAILABLE MODELS: gpt-4o", "");
    expect(result.map((m) => m.id)).toContain("gpt-4o");
  });
});

describe("parseCursorModelsOutput — bullet list format", () => {
  it("parses bullet lines prefixed with '-'", () => {
    const stdout = "Models:\n- gpt-4o\n- o3-mini";
    const result = parseCursorModelsOutput(stdout, "");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("o3-mini");
  });

  it("parses bullet lines prefixed with '*'", () => {
    const stdout = "* gpt-4o\n* claude-3-5-sonnet";
    const result = parseCursorModelsOutput(stdout, "");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("claude-3-5-sonnet");
  });

  it("ignores plain-text lines that contain spaces (not valid model IDs)", () => {
    const result = parseCursorModelsOutput("- not a model id", "");
    // "not a model id" contains spaces so it fails isLikelyModelId
    expect(result.map((m) => m.id)).not.toContain("not a model id");
  });
});

// ============================================================================
// parseCursorModelsOutput — deduplication
// ============================================================================

describe("parseCursorModelsOutput — deduplication", () => {
  it("deduplicates identical model IDs", () => {
    const stdout = JSON.stringify(["gpt-4o", "gpt-4o", "gpt-4o-mini"]);
    const result = parseCursorModelsOutput(stdout, "");
    const ids = result.map((m) => m.id);
    expect(ids.filter((id) => id === "gpt-4o")).toHaveLength(1);
  });

  it("uses model ID as label when no explicit label provided", () => {
    const result = parseCursorModelsOutput('["gpt-4o"]', "");
    const model = result.find((m) => m.id === "gpt-4o");
    expect(model).toBeDefined();
    expect(model?.label).toBe("gpt-4o");
  });
});

// ============================================================================
// parseCursorModelsOutput — isLikelyModelId filtering
// ============================================================================

describe("parseCursorModelsOutput — isLikelyModelId filtering", () => {
  it("accepts model IDs with dots and dashes", () => {
    const result = parseCursorModelsOutput('["claude-3.5-sonnet"]', "");
    expect(result.map((m) => m.id)).toContain("claude-3.5-sonnet");
  });

  it("accepts model IDs with slashes", () => {
    const result = parseCursorModelsOutput('["meta/llama-3"]', "");
    expect(result.map((m) => m.id)).toContain("meta/llama-3");
  });

  it("rejects empty strings", () => {
    const result = parseCursorModelsOutput('[""]', "");
    expect(result.every((m) => m.id.length > 0)).toBe(true);
  });
});

// ============================================================================
// parseCursorModelsOutput — stderr fallback
// ============================================================================

describe("parseCursorModelsOutput — stderr source", () => {
  it("parses model list from stderr when stdout is empty", () => {
    const result = parseCursorModelsOutput("", "available models: gpt-4o, o3");
    expect(result.map((m) => m.id)).toContain("gpt-4o");
  });

  it("combines stdout and stderr for plain-text extraction", () => {
    const result = parseCursorModelsOutput("available models: gpt-4o", "available models: o3-mini");
    const ids = result.map((m) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("o3-mini");
  });
});

// ============================================================================
// listCursorModels — cache and runner tests
// ============================================================================

describe("listCursorModels — runner injection and caching", () => {
  beforeEach(() => {
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
  });

  afterEach(() => {
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
  });

  it("uses injected runner result when runner succeeds with non-empty model list", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: 0,
      stdout: '["my-custom-model"]',
      stderr: "",
      hasError: false,
    }));
    const models = await listCursorModels();
    expect(models.some((m) => m.id === "my-custom-model")).toBe(true);
  });

  it("falls back to fallback models when runner returns error with empty output", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: 1,
      stdout: "",
      stderr: "",
      hasError: true,
    }));
    const models = await listCursorModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it("falls back to fallback models when runner returns non-zero status with no recognizable output", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: 1,
      stdout: "error: command not found",
      stderr: "error: command not found",
      hasError: false,
    }));
    const models = await listCursorModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it("caches result after first successful call", async () => {
    let callCount = 0;
    setCursorModelsRunnerForTests(() => {
      callCount++;
      return {
        status: 0,
        stdout: '["cached-model"]',
        stderr: "",
        hasError: false,
      };
    });

    await listCursorModels();
    await listCursorModels();
    expect(callCount).toBe(1);
  });

  it("merges discovered models with fallback models", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: 0,
      stdout: '["unique-discovered-model-xyz"]',
      stderr: "",
      hasError: false,
    }));
    const models = await listCursorModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("unique-discovered-model-xyz");
    // Also includes fallback models like "auto"
    expect(ids).toContain("auto");
  });

  it("resetCursorModelsCacheForTests clears cache so runner is called again", async () => {
    let callCount = 0;
    setCursorModelsRunnerForTests(() => {
      callCount++;
      return { status: 0, stdout: '["m"]', stderr: "", hasError: false };
    });

    await listCursorModels();
    resetCursorModelsCacheForTests();
    await listCursorModels();
    expect(callCount).toBe(2);
  });
});
