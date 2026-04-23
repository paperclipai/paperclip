import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCodexModels, resetCodexModelsCacheForTests } from "./codex-models.js";

// Mock readConfigFile so tests don't touch the filesystem
vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn(() => null),
}));

import { readConfigFile } from "../config-file.js";
const mockReadConfigFile = vi.mocked(readConfigFile);

// ============================================================================
// listCodexModels — no API key path
// ============================================================================

describe("listCodexModels — no API key", () => {
  beforeEach(() => {
    resetCodexModelsCacheForTests();
    vi.stubEnv("OPENAI_API_KEY", "");
    mockReadConfigFile.mockReturnValue(null);
  });

  afterEach(() => {
    resetCodexModelsCacheForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns fallback models when no API key is set", async () => {
    const models = await listCodexModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it("returns deduplicated fallback models", async () => {
    const models = await listCodexModels();
    const ids = models.map((m) => m.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it("every returned model has a non-empty id", async () => {
    const models = await listCodexModels();
    for (const model of models) {
      expect(model.id.trim().length).toBeGreaterThan(0);
    }
  });

  it("includes known fallback model IDs like o3 and o4-mini", async () => {
    const models = await listCodexModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("o3");
    expect(ids).toContain("o4-mini");
  });

  it("does not make a fetch call when no API key is available", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    await listCodexModels();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// listCodexModels — with API key, fetch succeeds
// ============================================================================

describe("listCodexModels — API key present, fetch succeeds", () => {
  beforeEach(() => {
    resetCodexModelsCacheForTests();
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key-1234567890");
    mockReadConfigFile.mockReturnValue(null);
  });

  afterEach(() => {
    resetCodexModelsCacheForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("calls the OpenAI models endpoint with bearer auth", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await listCodexModels();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("api.openai.com");
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: expect.stringContaining("Bearer"),
    });
  });

  it("includes API-fetched models in the result", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-unique-test-model" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const models = await listCodexModels();
    expect(models.map((m) => m.id)).toContain("gpt-unique-test-model");
  });

  it("merges fetched models with fallback models", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-unique-test-model-2" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const models = await listCodexModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("gpt-unique-test-model-2");
    // Also includes fallback models
    expect(ids).toContain("o3");
  });

  it("deduplicates models from API and fallback", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "o3" }, { id: "o4-mini" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const models = await listCodexModels();
    const ids = models.map((m) => m.id);
    expect(ids.filter((id) => id === "o3")).toHaveLength(1);
  });

  it("caches result and does not call fetch on second invocation", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "cached-model" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await listCodexModels();
    await listCodexModels();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// listCodexModels — with API key, fetch fails
// ============================================================================

describe("listCodexModels — API key present, fetch fails", () => {
  beforeEach(() => {
    resetCodexModelsCacheForTests();
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key-fails");
    mockReadConfigFile.mockReturnValue(null);
  });

  afterEach(() => {
    resetCodexModelsCacheForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns fallback models when fetch throws a network error", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network error"));
    const models = await listCodexModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain("o3");
  });

  it("returns fallback models when fetch returns non-OK status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("", { status: 401 }),
    );
    const models = await listCodexModels();
    expect(models.map((m) => m.id)).toContain("o3");
  });

  it("returns fallback models when API response has empty data array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const models = await listCodexModels();
    expect(models.map((m) => m.id)).toContain("o3");
  });
});

// ============================================================================
// resetCodexModelsCacheForTests
// ============================================================================

describe("resetCodexModelsCacheForTests", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-reset-cache");
    mockReadConfigFile.mockReturnValue(null);
  });

  afterEach(() => {
    resetCodexModelsCacheForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("clears cache so fetch is called again on next invocation", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "m" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await listCodexModels();
    resetCodexModelsCacheForTests();
    await listCodexModels();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
