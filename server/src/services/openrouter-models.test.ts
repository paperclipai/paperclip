import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("lists and caches public OpenRouter models without sending credentials", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet" }, { id: 42 },
  ] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenRouterModels } = await import("./openrouter-models.js");
  expect(await listOpenRouterModels()).toEqual([{ id: "openrouter/anthropic/claude-sonnet-4.5", label: "Claude Sonnet" }]);
  await listOpenRouterModels();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", { signal: expect.any(AbortSignal) });
  await listOpenRouterModels(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("allows retry after a public catalog failure", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenRouterModels } = await import("./openrouter-models.js");
  await expect(listOpenRouterModels()).rejects.toThrow("Retry or enter a model ID manually");
  await expect(listOpenRouterModels()).resolves.toEqual([]);
});
