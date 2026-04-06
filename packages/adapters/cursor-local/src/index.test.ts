import { describe, expect, it } from "vitest";
import { models, normalizeCursorModelId } from "./index.js";

describe("cursor model normalization", () => {
  it("maps legacy anthropic model ids to current Cursor ids", () => {
    expect(normalizeCursorModelId("sonnet-4.6-thinking")).toBe("claude-4.6-sonnet-medium-thinking");
    expect(normalizeCursorModelId("sonnet-4.6")).toBe("claude-4.6-sonnet-medium");
    expect(normalizeCursorModelId("opus-4.6-thinking")).toBe("claude-4.6-opus-high-thinking");
    expect(normalizeCursorModelId("opus-4.5")).toBe("claude-4.5-opus-high");
  });

  it("maps other renamed model ids to currently available aliases", () => {
    expect(normalizeCursorModelId("composer-1")).toBe("composer-1.5");
    expect(normalizeCursorModelId("gemini-3-pro")).toBe("gemini-3.1-pro");
    expect(normalizeCursorModelId("grok")).toBe("grok-4-20");
  });

  it("publishes canonical model ids in the fallback list", () => {
    const modelIds = models.map((model) => model.id);
    expect(modelIds).toContain("claude-4.6-sonnet-medium-thinking");
    expect(modelIds).toContain("claude-4.6-opus-high");
    expect(modelIds).not.toContain("sonnet-4.6-thinking");
    expect(modelIds).not.toContain("opus-4.6");
  });
});
