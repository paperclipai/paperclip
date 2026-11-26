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

/** A fetch that only settles when its signal fires, as a stalled upstream does. */
function stalledFetch() {
  return vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  }));
}

function shortCatalogDeadline() {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  return vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
}

it("answers its own catalog deadline as an unavailable provider, not a raw TimeoutError", async () => {
  const deadline = shortCatalogDeadline();
  vi.stubGlobal("fetch", stalledFetch());
  const { listOpenRouterModels, isOpenRouterCatalogUnavailable } = await import("./openrouter-models.js");
  const error = await listOpenRouterModels().catch((err: unknown) => err);
  deadline.mockRestore();
  expect(error).toMatchObject({ status: 503, message: "Could not load OpenRouter models. Retry or enter a model ID manually.",
    details: { code: "openrouter_catalog_unavailable" } });
  expect(isOpenRouterCatalogUnavailable(error)).toBe(true);
});

it.each([
  ["a DNS failure", () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND openrouter.ai"), { code: "ENOTFOUND" }) }))],
  ["a rate limit", () => Promise.resolve({ ok: false, status: 429 })],
  ["a provider server error", () => Promise.resolve({ ok: false, status: 503 })],
])("marks %s as an unavailable catalog", async (_label, response) => {
  vi.stubGlobal("fetch", vi.fn(response));
  const { listOpenRouterModels, isOpenRouterCatalogUnavailable } = await import("./openrouter-models.js");
  const error = await listOpenRouterModels().catch((err: unknown) => err);
  expect(error).toMatchObject({ status: 503, details: { code: "openrouter_catalog_unavailable" } });
  expect(isOpenRouterCatalogUnavailable(error)).toBe(true);
});

it("keeps contract failures and unrelated errors reportable", async () => {
  const { HttpError } = await import("../errors.js");
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 404 })
    .mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: null }) }));
  const { listOpenRouterModels, isOpenRouterCatalogUnavailable } = await import("./openrouter-models.js");
  const notFound = await listOpenRouterModels().catch((err: unknown) => err);
  expect(notFound).toMatchObject({ status: 502, details: { code: "openrouter_catalog_error", status: 404 } });
  expect(isOpenRouterCatalogUnavailable(notFound)).toBe(false);
  const malformed = await listOpenRouterModels().catch((err: unknown) => err);
  expect(malformed).toBeInstanceOf(SyntaxError);
  expect(isOpenRouterCatalogUnavailable(malformed)).toBe(false);
  await expect(listOpenRouterModels()).rejects.toThrow("OpenRouter returned an invalid model catalog.");
  expect(isOpenRouterCatalogUnavailable(new HttpError(503, "Could not load OpenRouter models. Retry or enter a model ID manually.", { code: "openrouter_catalog_unavailable" }))).toBe(false);
});
