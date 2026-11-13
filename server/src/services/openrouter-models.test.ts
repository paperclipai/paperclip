import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("lists and caches public OpenRouter models in popularity order without sending credentials", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
    { id: "z-ai/glm-5", name: "Z.AI GLM" },
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet" }, { id: 42 },
  ] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenRouterModels } = await import("./openrouter-models.js");
  expect(await listOpenRouterModels()).toEqual([
    { id: "openrouter/z-ai/glm-5", label: "Z.AI GLM" },
    { id: "openrouter/anthropic/claude-sonnet-4.5", label: "Claude Sonnet" },
  ]);
  await listOpenRouterModels();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models?sort=most-popular", { signal: expect.any(AbortSignal) });
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

it("offers advertised current MiniMax text models with Flash first while preserving other entries", async () => {
  const textModel = (id: string) => ({ id, name: id, architecture: { output_modalities: ["text"] } });
  const data = [
    textModel("example/first"),
    textModel("minimax/minimax-m3"),
    textModel("example/second"),
    textModel("minimax/minimax-m2.7"),
    textModel("minimax/minimax-m2.5"),
    textModel("minimax/minimax-m2-her"),
    textModel("minimax/minimax-m2.1"),
    textModel("minimax/minimax-m2"),
    textModel("minimax/minimax-m1"),
    textModel("minimax/minimax-01"),
    textModel("minimax/minimax-m3.1-flash:free"),
    { id: "minimax/media", architecture: { output_modalities: ["video"] } },
    { id: "minimax/mixed", architecture: { output_modalities: ["text", "audio"] } },
    { id: "minimax/unknown" },
    textModel("custom/minimax-m2.7"),
    { id: 42 },
  ];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }));
  const { listOpenRouterModels } = await import("./openrouter-models.js");
  expect((await listOpenRouterModels()).map(model => model.id)).toEqual([
    "openrouter/example/first",
    "openrouter/minimax/minimax-m3.1-flash:free",
    "openrouter/example/second",
    "openrouter/minimax/minimax-m3",
    "openrouter/minimax/media",
    "openrouter/minimax/mixed",
    "openrouter/minimax/unknown",
    "openrouter/custom/minimax-m2.7",
  ]);
  expect(data[1].id).toBe("minimax/minimax-m3");
});

it.each([
  { ids: ["minimax/minimax-m3"] },
  { ids: ["minimax/minimax-m3.1-flash:free"] },
  { ids: [] },
])("does not invent unavailable MiniMax routes: $ids", async ({ ids }) => {
  const data = ids.map(id => ({ id, architecture: { output_modalities: ["text"] } }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }));
  const { listOpenRouterModels } = await import("./openrouter-models.js");
  expect((await listOpenRouterModels()).map(model => model.id)).toEqual(ids.map(id => `openrouter/${id}`));
});
