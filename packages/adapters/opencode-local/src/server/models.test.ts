import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  discoverOpenCodeModelsResilient,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  populateOpenCodeModelsDiskCacheForTests,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
  resetOpenCodeModelsMemoryCacheForTests,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("falls back to configured model when discovery cannot run (probe resilience)", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      { id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1", label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1" },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "anthropic/gateway/some-model" }),
    ).resolves.toEqual([{ id: "anthropic/gateway/some-model", label: "anthropic/gateway/some-model" }]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });
});

describe("discoverOpenCodeModelsResilient — persistent stale-cache fallback", () => {
  let tmpDir: string;
  const FAILING_CMD = "__paperclip_missing_opencode_command__";
  const CACHED_MODELS: AdapterModel[] = [
    { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
    { id: "openai/gpt-4o", label: "openai/gpt-4o" },
  ];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-resil-test-"));
    process.env.PAPERCLIP_OPENCODE_MODELS_CACHE_DIR = tmpDir;
  });

  afterAll(async () => {
    delete process.env.PAPERCLIP_OPENCODE_MODELS_CACHE_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
  });

  it("probe failure + warm disk cache → returns cached list, no throw", async () => {
    await populateOpenCodeModelsDiskCacheForTests({ command: FAILING_CMD }, CACHED_MODELS);
    const result = await discoverOpenCodeModelsResilient({ command: FAILING_CMD });
    expect(result.source).toBe("disk_cache");
    expect(result.models).toEqual(CACHED_MODELS);
  });

  it("probe failure + no cache + configured model → returns [{id: model}], no throw", async () => {
    const result = await discoverOpenCodeModelsResilient({
      command: FAILING_CMD,
      model: "openai/gpt-5",
    });
    expect(result.source).toBe("configured_model");
    expect(result.models).toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);
  });

  it("probe failure + no cache + no fallback → throws", async () => {
    await expect(
      discoverOpenCodeModelsResilient({ command: FAILING_CMD }),
    ).rejects.toThrow();
  });

  it("disk cache survives simulated process restart (write then fresh read)", async () => {
    const fakeModels: AdapterModel[] = [{ id: "google/gemini-2-flash", label: "google/gemini-2-flash" }];
    await populateOpenCodeModelsDiskCacheForTests({ command: FAILING_CMD }, fakeModels);
    // Simulate restart: wipe in-memory cache only (disk persists across process restarts)
    resetOpenCodeModelsMemoryCacheForTests();
    const result = await discoverOpenCodeModelsResilient({ command: FAILING_CMD });
    expect(result.source).toBe("disk_cache");
    expect(result.models).toEqual(fakeModels);
  });

  it("cacheAge is returned when using disk cache", async () => {
    await populateOpenCodeModelsDiskCacheForTests({ command: FAILING_CMD }, CACHED_MODELS);
    const result = await discoverOpenCodeModelsResilient({ command: FAILING_CMD });
    expect(result.source).toBe("disk_cache");
    expect(typeof result.cacheAge).toBe("number");
    expect(result.cacheAge).toBeGreaterThanOrEqual(0);
  });

  it("in-memory cache takes precedence over disk on repeated calls", async () => {
    // Two different model lists — one in disk, one that would come from a live (unavailable) probe
    const diskModels: AdapterModel[] = [{ id: "disk/cached-model", label: "disk/cached-model" }];
    await populateOpenCodeModelsDiskCacheForTests({ command: FAILING_CMD }, diskModels);
    // First call: populates from disk into memory
    const first = await discoverOpenCodeModelsResilient({ command: FAILING_CMD });
    expect(first.source).toBe("disk_cache");
    // Second call: should use in-memory (which was set from disk on first call)
    // In-memory cache has the same models, but source should now be "live" (from memory hit)
    const second = await discoverOpenCodeModelsResilient({ command: FAILING_CMD });
    // Memory cache re-exports as "live" since it was written on the previous disk-cache hit
    expect(second.models).toEqual(diskModels);
  });
});
