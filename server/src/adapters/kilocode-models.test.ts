import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listKilocodeModels,
  refreshKilocodeModels,
  resetKilocodeModelsCacheForTests,
  KILO_MODELS_ENDPOINT,
} from "./kilocode-models.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal("fetch", fetchMock);

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetKilocodeModelsCacheForTests();
});

afterEach(() => {
  resetKilocodeModelsCacheForTests();
});

describe("listKilocodeModels", () => {
  it("fetches from KILO_MODELS_ENDPOINT", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        data: [
          { id: "anthropic/claude-opus-4", name: "Claude Opus 4" },
          { id: "openai/gpt-4o", name: "GPT-4o" },
        ],
      }),
    );

    const models = await listKilocodeModels();
    expect(fetchMock).toHaveBeenCalledWith(KILO_MODELS_ENDPOINT, expect.any(Object));
    expect(models.some((m) => m.id === "anthropic/claude-opus-4")).toBe(true);
    expect(models.some((m) => m.id === "openai/gpt-4o")).toBe(true);
  });

  it("falls back to static models on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const models = await listKilocodeModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "anthropic/claude-sonnet-4.5")).toBe(true);
  });

  it("falls back to static models on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ error: "not found" }, 404));

    const models = await listKilocodeModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it("uses cache on second call within TTL", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ data: [{ id: "anthropic/claude-sonnet-4.5", name: "Sonnet" }] }),
    );

    await listKilocodeModels();
    await listKilocodeModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates models from remote and fallback", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        data: [
          { id: "anthropic/claude-sonnet-4.5", name: "Sonnet from remote" },
          { id: "anthropic/claude-sonnet-4.5", name: "Duplicate" },
        ],
      }),
    );

    const models = await listKilocodeModels();
    const count = models.filter((m) => m.id === "anthropic/claude-sonnet-4.5").length;
    expect(count).toBe(1);
  });
});

describe("refreshKilocodeModels", () => {
  it("bypasses cache and re-fetches", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ data: [{ id: "anthropic/claude-opus-4", name: "Opus" }] }),
    );

    await listKilocodeModels();
    await refreshKilocodeModels();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
