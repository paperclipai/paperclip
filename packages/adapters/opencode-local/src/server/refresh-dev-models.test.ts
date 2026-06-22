import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyDevModelRefresh,
  buildDevModelsBlock,
  computeModelDrift,
  deriveOllamaBaseUrl,
  extractOllamaModelNames,
  fetchOllamaModelNames,
  parseJsonc,
  refreshDevModels,
  RefreshDevModelsError,
  stripJsonc,
} from "./refresh-dev-models.js";

// A realistic source config mirroring ~/.config/opencode/opencode.json.
function sampleConfig(models: Record<string, { name: string }>) {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      // A non-dev provider that must always be preserved untouched.
      anthropic: { npm: "@ai-sdk/anthropic", models: { "claude-x": { name: "Claude X" } } },
      dev: {
        npm: "@ai-sdk/openai-compatible",
        name: "dev",
        options: {
          baseURL: "http://localhost:11434/v1",
          timeout: 60000000,
          apiKey: "yoursecretkeyhere",
        },
        models,
      },
    },
  };
}

function fakeFetch(names: string[] | { models: unknown }): typeof fetch {
  const body = Array.isArray(names) ? { models: names.map((name) => ({ name })) } : names;
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("stripJsonc / parseJsonc", () => {
  it("strips line and block comments and trailing commas", () => {
    const src = `{
      // line comment
      "a": 1, /* inline */
      "b": [1, 2,],
    }`;
    expect(parseJsonc(src)).toEqual({ a: 1, b: [1, 2] });
  });

  it("never corrupts a URL containing // inside a string value", () => {
    const src = `{ "baseURL": "http://host:11434/v1" }`;
    expect(stripJsonc(src)).toContain("http://host:11434/v1");
    expect(parseJsonc(src)).toEqual({ baseURL: "http://host:11434/v1" });
  });

  it("parses strict JSON unchanged", () => {
    expect(parseJsonc('{"x":true}')).toEqual({ x: true });
  });
});

describe("extractOllamaModelNames", () => {
  it("returns sorted, de-duplicated, non-empty names", () => {
    const names = extractOllamaModelNames({
      models: [{ name: "b:1" }, { name: "a:1" }, { name: "a:1" }, { name: " " }, {}],
    });
    expect(names).toEqual(["a:1", "b:1"]);
  });

  it("throws fail-safe when the models array is missing", () => {
    expect(() => extractOllamaModelNames({})).toThrow(RefreshDevModelsError);
  });

  it("throws fail-safe when zero usable models are returned", () => {
    expect(() => extractOllamaModelNames({ models: [] })).toThrow(/zero models/);
  });
});

describe("buildDevModelsBlock", () => {
  it("preserves an existing human label and defaults new ones to the tag", () => {
    const block = buildDevModelsBlock(["qwen3.6:35b", "gemma4:31b"], {
      "qwen3.6:35b": { name: "Qwen Big" },
    });
    expect(block).toEqual({
      "qwen3.6:35b": { name: "Qwen Big" },
      "gemma4:31b": { name: "gemma4:31b" },
    });
  });
});

describe("deriveOllamaBaseUrl", () => {
  it("prefers an explicit override", () => {
    expect(deriveOllamaBaseUrl({}, { explicit: "http://x:1/" })).toBe("http://x:1");
  });
  it("falls back to OLLAMA_URL env", () => {
    expect(deriveOllamaBaseUrl({}, { env: { OLLAMA_URL: "http://env:2" } })).toBe("http://env:2");
  });
  it("derives from provider.dev.options.baseURL and strips /v1", () => {
    const cfg = sampleConfig({});
    expect(deriveOllamaBaseUrl(cfg, { env: {} })).toBe("http://localhost:11434");
  });
});

describe("applyDevModelRefresh", () => {
  it("adds a newly-discovered model (drift add)", () => {
    const cfg = sampleConfig({ "gemma4:31b": { name: "gemma4:31b" } });
    const { nextConfig, drift } = applyDevModelRefresh(cfg, ["gemma4:31b", "qwen3.6:35b"]);
    expect(drift.changed).toBe(true);
    expect(drift.added).toEqual(["qwen3.6:35b"]);
    expect(drift.removed).toEqual([]);
    const dev = (nextConfig.provider as any).dev;
    expect(Object.keys(dev.models)).toEqual(["gemma4:31b", "qwen3.6:35b"]);
  });

  it("removes a phantom model (drift remove)", () => {
    const cfg = sampleConfig({
      "gemma4:31b": { name: "gemma4:31b" },
      "phantom:latest": { name: "phantom" },
    });
    const { nextConfig, drift } = applyDevModelRefresh(cfg, ["gemma4:31b"]);
    expect(drift.removed).toEqual(["phantom:latest"]);
    expect((nextConfig.provider as any).dev.models["phantom:latest"]).toBeUndefined();
  });

  it("preserves provider.dev.options and all non-dev providers + top-level keys", () => {
    const cfg = sampleConfig({ "gemma4:31b": { name: "gemma4:31b" } });
    const { nextConfig } = applyDevModelRefresh(cfg, ["qwen3.6:35b"]);
    expect((nextConfig.provider as any).dev.options).toEqual({
      baseURL: "http://localhost:11434/v1",
      timeout: 60000000,
      apiKey: "yoursecretkeyhere",
    });
    expect((nextConfig.provider as any).anthropic).toEqual({
      npm: "@ai-sdk/anthropic",
      models: { "claude-x": { name: "Claude X" } },
    });
    expect(nextConfig.$schema).toBe("https://opencode.ai/config.json");
  });

  it("resolves the phantom qwen3.6:latest -> real qwen3.6:35b drift", () => {
    const cfg = sampleConfig({ "qwen3.6:latest": { name: "qwen3.6:latest" } });
    const { drift } = applyDevModelRefresh(cfg, ["qwen3.6:35b"]);
    expect(drift.added).toEqual(["qwen3.6:35b"]);
    expect(drift.removed).toEqual(["qwen3.6:latest"]);
    expect(drift.changed).toBe(true);
  });

  it("reports changed=false when the live set already matches", () => {
    const cfg = sampleConfig({ "gemma4:31b": { name: "gemma4:31b" } });
    const { drift } = applyDevModelRefresh(cfg, ["gemma4:31b"]);
    expect(drift.changed).toBe(false);
    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual([]);
  });

  it("throws fail-safe when provider.dev is missing", () => {
    expect(() => applyDevModelRefresh({ provider: {} }, ["a:1"])).toThrow(RefreshDevModelsError);
  });
});

describe("computeModelDrift", () => {
  it("detects label-only changes as changed", () => {
    const drift = computeModelDrift({ "a:1": { name: "old" } }, { "a:1": { name: "new" } });
    expect(drift.changed).toBe(true);
    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual([]);
  });
});

describe("fetchOllamaModelNames", () => {
  it("returns names from a /api/tags style body", async () => {
    const names = await fetchOllamaModelNames("http://x:1", {
      fetchImpl: fakeFetch(["b:1", "a:1"]),
    });
    expect(names).toEqual(["a:1", "b:1"]);
  });

  it("throws fail-safe on a non-OK response", async () => {
    const failing = (async () => ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchOllamaModelNames("http://x:1", { fetchImpl: failing })).rejects.toThrow(
      RefreshDevModelsError,
    );
  });
});

describe("refreshDevModels (end-to-end, temp fs)", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "refresh-dev-models-test-"));
    configPath = path.join(dir, "opencode.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes a fresh config + timestamped backup on drift", async () => {
    await fs.writeFile(configPath, JSON.stringify(sampleConfig({ "old:1": { name: "old" } }), null, 2));
    const result = await refreshDevModels({
      configPath,
      fetchImpl: fakeFetch(["new:1"]),
      now: () => new Date(2026, 5, 22, 9, 0, 0),
      logger: () => {},
    });
    expect(result.changed).toBe(true);
    expect(result.added).toEqual(["new:1"]);
    expect(result.removed).toEqual(["old:1"]);
    expect(result.backupPath).toBe(`${configPath}.20260622-090000.bak`);

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(Object.keys(written.provider.dev.models)).toEqual(["new:1"]);
    // Backup preserves the ORIGINAL bytes.
    const backup = JSON.parse(await fs.readFile(result.backupPath!, "utf8"));
    expect(Object.keys(backup.provider.dev.models)).toEqual(["old:1"]);
  });

  it("is a no-op (no write, no backup) when already fresh", async () => {
    const original = JSON.stringify(sampleConfig({ "keep:1": { name: "keep" } }), null, 2);
    await fs.writeFile(configPath, original);
    const result = await refreshDevModels({
      configPath,
      fetchImpl: fakeFetch(["keep:1"]),
      logger: () => {},
    });
    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".bak"))).toEqual([]);
  });

  it("fails safe on a malformed source: throws and never writes/backs up", async () => {
    const garbage = "{ this is : not json ][";
    await fs.writeFile(configPath, garbage);
    await expect(
      refreshDevModels({ configPath, fetchImpl: fakeFetch(["a:1"]), logger: () => {} }),
    ).rejects.toThrow(RefreshDevModelsError);
    // Original (bad) file is left exactly as-is; no backup spawned.
    expect(await fs.readFile(configPath, "utf8")).toBe(garbage);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".bak"))).toEqual([]);
  });

  it("fails safe on an empty Ollama result: never clobbers a good config", async () => {
    const original = JSON.stringify(sampleConfig({ "keep:1": { name: "keep" } }), null, 2);
    await fs.writeFile(configPath, original);
    await expect(
      refreshDevModels({ configPath, fetchImpl: fakeFetch({ models: [] }), logger: () => {} }),
    ).rejects.toThrow(/zero models/);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });

  it("parses a JSONC source with comments + trailing commas", async () => {
    const jsonc = `{
      // dev provider config
      "provider": {
        "dev": {
          "options": { "baseURL": "http://localhost:11434/v1", },
          "models": { "old:1": { "name": "old" }, },
        },
      },
    }`;
    await fs.writeFile(configPath, jsonc);
    const result = await refreshDevModels({
      configPath,
      fetchImpl: fakeFetch(["new:1"]),
      logger: () => {},
    });
    expect(result.changed).toBe(true);
    expect(result.ollamaUrl).toBe("http://localhost:11434");
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(Object.keys(written.provider.dev.models)).toEqual(["new:1"]);
  });
});
