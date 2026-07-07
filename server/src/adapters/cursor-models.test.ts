import { describe, expect, it } from "vitest";
import { parseCursorModelsOutput } from "./cursor-models.js";

describe("parseCursorModelsOutput", () => {
  it("parses legacy comma-separated Available models line", () => {
    const models = parseCursorModelsOutput(
      "Available models: auto, composer-1.5, gpt-5.3-codex-high",
      "",
    );
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["auto", "composer-1.5", "gpt-5.3-codex-high"]),
    );
  });

  it("parses Cursor CLI labeled lines (id - label)", () => {
    const stdout = `Available models

auto - Auto
gpt-5.3-codex-low - Codex 5.3 Low
composer-2.5-fast - Composer 2.5 Fast (default)
claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking
glm-5.2-high - GLM 5.2

Tip: use --model <id> to switch.`;
    const models = parseCursorModelsOutput(stdout, "");
    expect(models).toEqual(
      expect.arrayContaining([
        { id: "auto", label: "Auto" },
        { id: "gpt-5.3-codex-low", label: "Codex 5.3 Low" },
        { id: "composer-2.5-fast", label: "Composer 2.5 Fast (default)" },
        { id: "claude-opus-4-8-thinking-high", label: "Opus 4.8 1M Thinking" },
        { id: "glm-5.2-high", label: "GLM 5.2" },
      ]),
    );
    expect(models.some((m) => m.id === "auto")).toBe(true);
    expect(models.some((m) => m.id === "composer-2.5-fast")).toBe(true);
  });

  it("parses bullet-only model ids without labels", () => {
    const models = parseCursorModelsOutput("auto\ncomposer-1.5\n", "");
    expect(models.map((m) => m.id)).toEqual(["auto", "composer-1.5"]);
  });

  it("dedupes repeated model ids", () => {
    const stdout = `auto - Auto
auto - Auto again`;
    const models = parseCursorModelsOutput(stdout, "");
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("auto");
  });
});
