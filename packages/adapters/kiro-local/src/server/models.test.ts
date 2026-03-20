import { describe, expect, it } from "vitest";
import { KIRO_MODELS, listKiroModels } from "./models.js";

describe("KIRO_MODELS", () => {
  it("contains all 8 expected models", () => {
    expect(KIRO_MODELS).toHaveLength(8);
  });

  it("contains auto model", () => {
    const auto = KIRO_MODELS.find((m) => m.id === "auto");
    expect(auto).toEqual({ id: "auto", label: "auto" });
  });

  it("contains claude-sonnet-4.5 model", () => {
    const model = KIRO_MODELS.find((m) => m.id === "claude-sonnet-4.5");
    expect(model).toEqual({ id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" });
  });

  it("contains claude-sonnet-4 model", () => {
    const model = KIRO_MODELS.find((m) => m.id === "claude-sonnet-4");
    expect(model).toEqual({ id: "claude-sonnet-4", label: "Claude Sonnet 4" });
  });

  it("contains claude-haiku-4.5 model", () => {
    const model = KIRO_MODELS.find((m) => m.id === "claude-haiku-4.5");
    expect(model).toEqual({ id: "claude-haiku-4.5", label: "Claude Haiku 4.5" });
  });

  it("contains deepseek-3.2 model", () => {
    const model = KIRO_MODELS.find((m) => m.id === "deepseek-3.2");
    expect(model).toEqual({ id: "deepseek-3.2", label: "DeepSeek 3.2" });
  });

  it("contains minimax-m2.1 model", () => {
    const model = KIRO_MODELS.find((m) => m.id === "minimax-m2.1");
    expect(model).toEqual({ id: "minimax-m2.1", label: "MiniMax M2.1" });
  });

  it("contains minimax-m2.5 model", () => {
    const model = KIRO_MODELS.find((m) => m.id === "minimax-m2.5");
    expect(model).toEqual({ id: "minimax-m2.5", label: "MiniMax M2.5" });
  });

  it("contains qwen3-coder-next model", () => {
    const model = KIRO_MODELS.find((m) => m.id === "qwen3-coder-next");
    expect(model).toEqual({ id: "qwen3-coder-next", label: "Qwen 3 Coder Next" });
  });

  it("all models have id and label properties", () => {
    KIRO_MODELS.forEach((model) => {
      expect(model).toHaveProperty("id");
      expect(model).toHaveProperty("label");
      expect(typeof model.id).toBe("string");
      expect(typeof model.label).toBe("string");
    });
  });

  it("all model ids are unique", () => {
    const ids = KIRO_MODELS.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

describe("listKiroModels", () => {
  it("returns all models", async () => {
    const models = await listKiroModels();
    expect(models).toEqual(KIRO_MODELS);
  });

  it("returns 8 models", async () => {
    const models = await listKiroModels();
    expect(models).toHaveLength(8);
  });

  it("returns models in expected order", async () => {
    const models = await listKiroModels();
    expect(models[0].id).toBe("auto");
    expect(models[1].id).toBe("claude-sonnet-4.5");
    expect(models[2].id).toBe("claude-sonnet-4");
    expect(models[3].id).toBe("claude-haiku-4.5");
    expect(models[4].id).toBe("deepseek-3.2");
    expect(models[5].id).toBe("minimax-m2.1");
    expect(models[6].id).toBe("minimax-m2.5");
    expect(models[7].id).toBe("qwen3-coder-next");
  });
});
