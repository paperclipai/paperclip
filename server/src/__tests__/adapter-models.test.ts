import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { models as opencodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { listAdapterModels, listServerAdapters, refreshAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

describe("adapter model listing", () => {
  let emptyCodexHome: string;

  beforeEach(() => {
    emptyCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-no-cache-"));
    process.env.CODEX_HOME = emptyCodexHome;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    fs.rmSync(emptyCodexHome, { recursive: true, force: true });
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("uses provider-prefixed ACPX fallback model labels", () => {
    const adapter = listServerAdapters().find((candidate) => candidate.type === "acpx_local");

    expect(adapter?.models?.some((model) => model.label.startsWith("Claude: "))).toBe(true);
    expect(adapter?.models?.some((model) => model.label.startsWith("Codex: "))).toBe(true);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads codex models dynamically and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("refreshes cached codex models on demand", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5" }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "gpt-5.5" }],
        }),
      } as Response);

    const initial = await listAdapterModels("codex_local");
    const refreshed = await refreshAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(initial.some((model) => model.id === "gpt-5")).toBe(true);
    expect(refreshed.some((model) => model.id === "gpt-5.5")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
  });

  it("returns opencode fallback models including gpt-5.4", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");

    expect(models).toEqual(opencodeFallbackModels);
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAdapterModels("cursor");
    const second = await listAdapterModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
  });

});


describe("loadCodexModels — cache path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_HOME;
    resetCodexModelsCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads cache and filters out non-list visibility entries", async () => {
    process.env.CODEX_HOME = tmpDir;
    fs.writeFileSync(
      path.join(tmpDir, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "codex-cache-visible", display_name: "Visible Model", visibility: "list" },
          { slug: "codex-cache-hidden", display_name: "Hidden Model", visibility: "hidden" },
          { slug: "codex-cache-internal", display_name: "Internal Model", visibility: "internal" },
        ],
      }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(models.some((m) => m.id === "codex-cache-visible")).toBe(true);
    expect(models.some((m) => m.id === "codex-cache-hidden")).toBe(false);
    expect(models.some((m) => m.id === "codex-cache-internal")).toBe(false);
    // mergedWithFallback ensures static fallback ids are still present
    expect(models.some((m) => m.id === "codex-mini-latest")).toBe(true);
  });

  it("honors CODEX_HOME env var for cache lookup, not ~/.codex", async () => {
    process.env.CODEX_HOME = tmpDir;
    fs.writeFileSync(
      path.join(tmpDir, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "codex-from-env-dir", display_name: "From Env Dir", visibility: "list" },
        ],
      }),
    );

    const models = await listAdapterModels("codex_local");

    expect(models.some((m) => m.id === "codex-from-env-dir")).toBe(true);
  });

  it("re-reads codex cache on refresh instead of using stale file data", async () => {
    process.env.CODEX_HOME = tmpDir;
    const cacheFile = path.join(tmpDir, "models_cache.json");
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        models: [
          { slug: "codex-cache-before-refresh", display_name: "Before Refresh", visibility: "list" },
        ],
      }),
    );

    const initial = await listAdapterModels("codex_local");
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        models: [
          { slug: "codex-cache-after-refresh", display_name: "After Refresh", visibility: "list" },
        ],
      }),
    );

    const refreshed = await refreshAdapterModels("codex_local");

    expect(initial.some((m) => m.id === "codex-cache-before-refresh")).toBe(true);
    expect(refreshed.some((m) => m.id === "codex-cache-after-refresh")).toBe(true);
    expect(refreshed.some((m) => m.id === "codex-cache-before-refresh")).toBe(false);
  });

  it("returns static fallback models when cache file is missing, without throwing", async () => {
    // tmpDir has no models_cache.json — simulates missing cache
    process.env.CODEX_HOME = tmpDir;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(models).toEqual(codexFallbackModels);
  });

  it("returns static fallback models when cache file contains malformed JSON, without throwing", async () => {
    process.env.CODEX_HOME = tmpDir;
    fs.writeFileSync(path.join(tmpDir, "models_cache.json"), "{ not valid json ~~~");

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(models).toEqual(codexFallbackModels);
  });
});
