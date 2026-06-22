import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyOllamaModels,
  atomicWriteWithBackup,
  computeDrift,
  fetchOllamaModels,
  resolveConfigPath,
  resolveOllamaUrl,
  stripJsonc,
  syncOllamaModels,
  type FetchLike,
} from "./ollama-models.js";

const ENV_KEYS = ["PAPERCLIP_OLLAMA_URL", "PAPERCLIP_OPENCODE_CONFIG", "XDG_CONFIG_HOME"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

const tempDirs: string[] = [];

function writeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev653-ollama-"));
  tempDirs.push(dir);
  const file = path.join(dir, "opencode.json");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function fakeFetch(
  payload: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
): FetchLike {
  return async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => payload,
  });
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("resolveOllamaUrl", () => {
  it("prefers a non-empty argument and trims it", () => {
    expect(resolveOllamaUrl("  http://host:1234  ")).toBe("http://host:1234");
  });

  it("falls back to PAPERCLIP_OLLAMA_URL when the argument is blank", () => {
    process.env.PAPERCLIP_OLLAMA_URL = "http://env-host:9999";
    expect(resolveOllamaUrl("   ")).toBe("http://env-host:9999");
  });

  it("falls back to the default when neither argument nor env is set", () => {
    delete process.env.PAPERCLIP_OLLAMA_URL;
    expect(resolveOllamaUrl(undefined)).toBe("http://127.0.0.1:11434");
  });
});

describe("resolveConfigPath", () => {
  it("prefers a non-empty argument and trims it", () => {
    expect(resolveConfigPath("  /custom/opencode.json  ")).toBe("/custom/opencode.json");
  });

  it("falls back to PAPERCLIP_OPENCODE_CONFIG", () => {
    delete process.env.XDG_CONFIG_HOME;
    process.env.PAPERCLIP_OPENCODE_CONFIG = "/env/opencode.json";
    expect(resolveConfigPath(undefined)).toBe("/env/opencode.json");
  });

  it("falls back to XDG_CONFIG_HOME", () => {
    delete process.env.PAPERCLIP_OPENCODE_CONFIG;
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(resolveConfigPath(undefined)).toBe(path.join("/xdg", "opencode", "opencode.json"));
  });

  it("falls back to ~/.config when nothing else is set", () => {
    delete process.env.PAPERCLIP_OPENCODE_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
    expect(resolveConfigPath(undefined)).toBe(
      path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    );
  });
});

describe("fetchOllamaModels", () => {
  it("returns a sorted, de-duplicated model list", async () => {
    const fetchImpl = fakeFetch({
      models: [{ name: "qwen3.6:35b" }, { name: "gemma4:31b" }, { name: "gemma4:31b" }, { name: " qwen3.5:4b " }],
    });
    await expect(fetchOllamaModels("http://x", { fetchImpl })).resolves.toEqual([
      "gemma4:31b",
      "qwen3.5:4b",
      "qwen3.6:35b",
    ]);
  });

  it("uses the `model` field when `name` is missing", async () => {
    const fetchImpl = fakeFetch({ models: [{ model: "nemotron3:33b" }] });
    await expect(fetchOllamaModels("http://x", { fetchImpl })).resolves.toEqual(["nemotron3:33b"]);
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 503, statusText: "Service Unavailable" });
    await expect(fetchOllamaModels("http://x", { fetchImpl })).rejects.toThrow("503");
  });

  it("throws when the server returns zero models (never clobbers config)", async () => {
    const fetchImpl = fakeFetch({ models: [] });
    await expect(fetchOllamaModels("http://x", { fetchImpl })).rejects.toThrow("zero models");
  });
});

describe("computeDrift", () => {
  it("classifies added, removed, and unchanged models", () => {
    expect(computeDrift(["a", "b"], ["b", "c"])).toEqual({
      added: ["c"],
      removed: ["a"],
      unchanged: ["b"],
      serverCount: 2,
    });
  });
});

describe("stripJsonc", () => {
  it("passes valid JSON through unchanged", () => {
    expect(stripJsonc('{"a":1,"b":[2,3]}')).toBe('{"a":1,"b":[2,3]}');
  });

  it("strips line comments", () => {
    expect(JSON.parse(stripJsonc('{"a":1 // keep a\n}'))).toEqual({ a: 1 });
  });

  it("strips block comments", () => {
    expect(JSON.parse(stripJsonc('{"a":1 /* drop me */}'))).toEqual({ a: 1 });
  });

  it("removes trailing commas in objects and arrays", () => {
    expect(JSON.parse(stripJsonc('{"a":1,"b":[2,3,],}'))).toEqual({ a: 1, b: [2, 3] });
  });

  it("never corrupts characters inside string literals", () => {
    const input = '{"url":"http://127.0.0.1:11434/v1","weird":"a,}"}';
    const parsed = JSON.parse(stripJsonc(input)) as { url: string; weird: string };
    expect(parsed.url).toBe("http://127.0.0.1:11434/v1");
    expect(parsed.weird).toBe("a,}");
  });
});

describe("applyOllamaModels", () => {
  function baseConfig(): Record<string, unknown> {
    return {
      provider: {
        dev: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1", timeout: 60000 },
          models: { "old:1b": { name: "old:1b" }, "keep:7b": { name: "Custom Label" } },
        },
        other: { key: "value" },
      },
    };
  }

  it("replaces the models block while preserving options, labels, and other providers", () => {
    const config = baseConfig();
    const { changed, drift } = applyOllamaModels(config, ["keep:7b", "new:9b"]);

    expect(changed).toBe(true);
    expect(drift.added).toEqual(["new:9b"]);
    expect(drift.removed).toEqual(["old:1b"]);

    const dev = (config.provider as Record<string, Record<string, unknown>>).dev;
    expect(Object.keys(dev.models as Record<string, unknown>)).toEqual(["keep:7b", "new:9b"]);
    // existing label is preserved, new model gets a default label
    expect((dev.models as Record<string, { name: string }>)["keep:7b"].name).toBe("Custom Label");
    expect((dev.models as Record<string, { name: string }>)["new:9b"].name).toBe("new:9b");
    // untouched siblings
    expect(dev.options).toEqual({ baseURL: "http://127.0.0.1:11434/v1", timeout: 60000 });
    expect((config.provider as Record<string, unknown>).other).toEqual({ key: "value" });
  });

  it("reports no change when the config already matches the server", () => {
    const config = baseConfig();
    const { changed } = applyOllamaModels(config, ["keep:7b", "old:1b"]);
    expect(changed).toBe(false);
  });

  it("throws when provider or provider.dev is missing", () => {
    expect(() => applyOllamaModels({}, ["a"])).toThrow('"provider"');
    expect(() => applyOllamaModels({ provider: {} }, ["a"])).toThrow('"provider.dev"');
  });
});

describe("atomicWriteWithBackup", () => {
  it("writes new content and backs up the prior file", () => {
    const file = writeTempConfig("original\n");
    const backup = atomicWriteWithBackup(file, "updated\n");
    expect(fs.readFileSync(file, "utf8")).toBe("updated\n");
    expect(backup).not.toBeNull();
    expect(fs.readFileSync(backup as string, "utf8")).toBe("original\n");
  });
});

describe("syncOllamaModels", () => {
  const configText = JSON.stringify(
    {
      provider: {
        dev: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "old:1b": { name: "old:1b" } },
        },
        other: { key: "value" },
      },
    },
    null,
    2,
  );

  it("rewrites the config when the model set drifts and preserves the rest", async () => {
    const file = writeTempConfig(configText);
    const result = await syncOllamaModels({
      configPath: file,
      ollamaUrl: "http://x",
      fetchImpl: fakeFetch({ models: [{ name: "qwen3.6:35b" }, { name: "gemma4:31b" }] }),
    });

    expect(result.status).toBe("updated");
    expect(result.changed).toBe(true);
    expect(result.drift?.added).toEqual(["gemma4:31b", "qwen3.6:35b"]);
    expect(result.drift?.removed).toEqual(["old:1b"]);
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath as string)).toBe(true);

    const written = JSON.parse(fs.readFileSync(file, "utf8")) as {
      provider: { dev: { options: { baseURL: string }; models: Record<string, unknown> }; other: unknown };
    };
    expect(Object.keys(written.provider.dev.models)).toEqual(["gemma4:31b", "qwen3.6:35b"]);
    expect(written.provider.dev.options.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(written.provider.other).toEqual({ key: "value" });
  });

  it("is a no-op when the config already matches the server", async () => {
    const file = writeTempConfig(configText);
    const before = fs.readFileSync(file, "utf8");
    const result = await syncOllamaModels({
      configPath: file,
      ollamaUrl: "http://x",
      fetchImpl: fakeFetch({ models: [{ name: "old:1b" }] }),
    });
    expect(result.status).toBe("unchanged");
    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("parses JSONC (comments + trailing commas) and writes valid JSON", async () => {
    const jsonc = `{
  // local dev provider
  "provider": {
    "dev": {
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": {
        "old:1b": { "name": "old:1b" },
      },
    },
  },
}`;
    const file = writeTempConfig(jsonc);
    const result = await syncOllamaModels({
      configPath: file,
      ollamaUrl: "http://x",
      fetchImpl: fakeFetch({ models: [{ name: "fresh:8b" }] }),
    });
    expect(result.status).toBe("updated");
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as {
      provider: { dev: { options: { baseURL: string }; models: Record<string, unknown> } };
    };
    expect(written.provider.dev.options.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(Object.keys(written.provider.dev.models)).toEqual(["fresh:8b"]);
  });

  it("fails safe and leaves the file untouched on unparseable config", async () => {
    const file = writeTempConfig("this is not json {{{");
    const before = fs.readFileSync(file, "utf8");
    const result = await syncOllamaModels({
      configPath: file,
      ollamaUrl: "http://x",
      fetchImpl: fakeFetch({ models: [{ name: "fresh:8b" }] }),
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("cannot parse config");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("fails safe and leaves the file untouched when the Ollama fetch fails", async () => {
    const file = writeTempConfig(configText);
    const before = fs.readFileSync(file, "utf8");
    const result = await syncOllamaModels({
      configPath: file,
      ollamaUrl: "http://x",
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("Ollama fetch failed");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
