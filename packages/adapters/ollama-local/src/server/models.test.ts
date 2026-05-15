import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listOllamaModels, resolveOllamaHost } from "./models.js";

describe("resolveOllamaHost", () => {
  const originalEnv = process.env.OLLAMA_HOST;
  beforeEach(() => {
    delete process.env.OLLAMA_HOST;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalEnv;
  });

  it("falls back to localhost when nothing is set", () => {
    expect(resolveOllamaHost()).toBe("http://localhost:11434");
  });

  it("prefers an explicit argument over env", () => {
    process.env.OLLAMA_HOST = "http://env-host:11434";
    expect(resolveOllamaHost("http://explicit:9999")).toBe("http://explicit:9999");
  });

  it("normalizes a scheme-less env value", () => {
    process.env.OLLAMA_HOST = "remote:11434";
    expect(resolveOllamaHost()).toBe("http://remote:11434");
  });

  it("strips trailing slashes", () => {
    expect(resolveOllamaHost("http://localhost:11434/")).toBe("http://localhost:11434");
  });
});

describe("listOllamaModels", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns [] when /api/tags is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await listOllamaModels("http://localhost:11434");
    expect(result).toEqual([]);
  });

  it("maps the /api/tags response into AdapterModel entries", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          models: [
            { name: "qwen2.5-coder:14b", details: { parameter_size: "14B" } },
            { name: "llama3.2:latest" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await listOllamaModels("http://localhost:11434");
    expect(result).toEqual([
      { id: "llama3.2:latest", label: "llama3.2:latest" },
      { id: "qwen2.5-coder:14b", label: "qwen2.5-coder:14b (14B)" },
    ]);
  });

  it("dedupes and ignores empty entries", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          models: [
            { name: "x" },
            { name: "x" },
            { name: "" },
            { model: "y" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await listOllamaModels("http://localhost:11434");
    expect(result).toEqual([
      { id: "x", label: "x" },
      { id: "y", label: "y" },
    ]);
  });
});
