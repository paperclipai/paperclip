import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COPILOT_LOCAL_MODEL, models as staticCopilotModels } from "../index.js";
import { labelForModelId, listCopilotModels, resetCopilotModelsCacheForTests } from "./models.js";

function sortedUniqueIds(models: { id: string }[]): string[] {
  return [...new Set(models.map((model) => model.id.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }),
  );
}

describe("copilot models", () => {
  const originalPath = process.env.PATH;
  const originalCommand = process.env.PAPERCLIP_COPILOT_COMMAND;

  afterEach(() => {
    if (typeof originalPath === "string") process.env.PATH = originalPath;
    else delete process.env.PATH;

    if (typeof originalCommand === "string") process.env.PAPERCLIP_COPILOT_COMMAND = originalCommand;
    else delete process.env.PAPERCLIP_COPILOT_COMMAND;

    resetCopilotModelsCacheForTests();
  });

  it("formats copilot model ids into readable labels", () => {
    expect(labelForModelId("claude-sonnet-4.6")).toBe("Claude Sonnet 4.6");
    expect(labelForModelId("claude-opus-4.6-1m")).toBe("Claude Opus 4.6 1M");
    expect(labelForModelId("gpt-5.5")).toBe("GPT-5.5");
    expect(labelForModelId("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(labelForModelId("auto")).toBe("Auto (default)");
  });

  it("falls back to static adapter models when runtime discovery is unavailable", async () => {
    process.env.PATH = "__paperclip_missing_path__";
    process.env.PAPERCLIP_COPILOT_COMMAND = "/__paperclip_missing_copilot_command__";

    const listed = await listCopilotModels();
    const expectedIds = sortedUniqueIds(staticCopilotModels);

    expect(listed.map((model) => model.id)).toEqual(expectedIds);
    expect(listed.find((model) => model.id === DEFAULT_COPILOT_LOCAL_MODEL)?.label).toBe("Claude Sonnet 4.6");
    expect(listed.some((model) => model.id === "auto")).toBe(true);
  });

  it("always returns unique, sorted models with stable defaults", async () => {
    const listed = await listCopilotModels();
    const ids = listed.map((model) => model.id);

    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(sortedUniqueIds(listed));
    expect(ids).toContain(DEFAULT_COPILOT_LOCAL_MODEL);
    expect(ids).toContain("auto");
  });
});
