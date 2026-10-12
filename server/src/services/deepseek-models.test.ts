import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("lists DeepSeek models with the connection's own key and caches them", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
    { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
    { id: 7 },
    { id: "  " },
  ] }) });
  vi.stubGlobal("fetch", fetch);
  const { listDeepSeekModels } = await import("./deepseek-models.js");
  expect(await listDeepSeekModels("secret-key")).toEqual([
    { id: "deepseek-flash", label: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
  ]);
  await listDeepSeekModels("secret-key");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("https://api.deepseek.com/models", {
    headers: { Authorization: "Bearer secret-key" }, redirect: "error", signal: expect.any(AbortSignal),
  });
});

it("allows retry after a DeepSeek catalog failure without caching the error", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: false, body: { cancel: async () => undefined } })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: "deepseek-flash" }] }) });
  vi.stubGlobal("fetch", fetch);
  const { listDeepSeekModels } = await import("./deepseek-models.js");
  await expect(listDeepSeekModels("key")).rejects.toThrow("Retry or enter a model ID manually");
  await expect(listDeepSeekModels("key")).resolves.toEqual([{ id: "deepseek-flash", label: "deepseek-flash" }]);
});

it("keys in-flight DeepSeek catalog requests by credential", async () => {
  const models: Record<string, string> = { "key-a": "deepseek-a", "key-b": "deepseek-b" };
  const fetch = vi.fn(async (_url: string, init?: { headers?: { Authorization?: string } }) => {
    const credential = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, json: async () => ({ data: [{ id: models[credential] }] }) };
  });
  vi.stubGlobal("fetch", fetch);
  const { listDeepSeekModels } = await import("./deepseek-models.js");
  const [first, second] = await Promise.all([listDeepSeekModels("key-a"), listDeepSeekModels("key-b")]);
  expect(first).toEqual([{ id: "deepseek-a", label: "deepseek-a" }]);
  expect(second).toEqual([{ id: "deepseek-b", label: "deepseek-b" }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
