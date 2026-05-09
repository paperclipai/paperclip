import { describe, expect, it } from "vitest";
import { DEFAULT_QWEN_LOCAL_MODEL } from "../index.js";
import {
  prepareQwenRuntimeConfig,
  QwenAdapterConfigError,
  resolveQwenConfig,
} from "./runtime-config.js";

describe("resolveQwenConfig", () => {
  it("throws when baseUrl is missing", () => {
    expect(() => resolveQwenConfig({ apiKey: "sk-x" })).toThrow(QwenAdapterConfigError);
  });

  it("throws when apiKey is missing", () => {
    expect(() => resolveQwenConfig({ baseUrl: "http://dgx:8000/v1" })).toThrow(QwenAdapterConfigError);
  });

  it("trims and defaults the model", () => {
    const r = resolveQwenConfig({ baseUrl: "  http://dgx:8000/v1 ", apiKey: " sk-9999 " });
    expect(r).toEqual({
      baseUrl: "http://dgx:8000/v1",
      apiKey: "sk-9999",
      model: DEFAULT_QWEN_LOCAL_MODEL,
    });
  });

  it("respects an explicit model id", () => {
    const r = resolveQwenConfig({
      baseUrl: "http://dgx:8000/v1",
      apiKey: "sk-9999",
      model: "Qwen/Qwen3.6-7B",
    });
    expect(r.model).toBe("Qwen/Qwen3.6-7B");
  });
});

describe("prepareQwenRuntimeConfig", () => {
  it("injects all three OPENAI_* env vars and preserves caller env", async () => {
    const prepared = await prepareQwenRuntimeConfig({
      env: { PATH: "/usr/bin", FOO: "bar" },
      config: { baseUrl: "http://dgx:8000/v1", apiKey: "sk-9999", model: "Qwen/test" },
    });
    expect(prepared.env.OPENAI_BASE_URL).toBe("http://dgx:8000/v1");
    expect(prepared.env.OPENAI_API_KEY).toBe("sk-9999");
    expect(prepared.env.OPENAI_MODEL).toBe("Qwen/test");
    expect(prepared.env.PATH).toBe("/usr/bin");
    expect(prepared.env.FOO).toBe("bar");
  });

  it("never leaks the apiKey into notes", async () => {
    const prepared = await prepareQwenRuntimeConfig({
      env: {},
      config: { baseUrl: "http://dgx:8000/v1", apiKey: "sk-secret-9999" },
    });
    for (const note of prepared.notes) {
      expect(note).not.toContain("sk-secret-9999");
    }
  });

  it("cleanup is a no-op", async () => {
    const prepared = await prepareQwenRuntimeConfig({
      env: {},
      config: { baseUrl: "http://dgx:8000/v1", apiKey: "sk-9999" },
    });
    await expect(prepared.cleanup()).resolves.toBeUndefined();
  });
});
