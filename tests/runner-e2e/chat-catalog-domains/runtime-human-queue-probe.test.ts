import { expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { probeConsumedHumanQueue } from "./runtime-queue-controls.js";
function fixture(method: "PATCH" | "DELETE", status = 409) {
  const origin = "http://127.0.0.1:4567", user = { user: { id: "human" } };
  const fetch = vi.fn(async (_url, options) => ({ status: () => options.headers.Origin === origin ? status : 403 }));
  const browserGet = vi.fn(async () => ({ status: () => 200, json: async () => user }));
  const ctx = { scenario: { id: method === "PATCH" ? "steering.edit-queued-message" : "steering.discard-queued-message" },
    input: { api: { baseURL: origin, get: vi.fn(async () => user) }, page: { url: () => `${origin}/RUN/issues/RUN-1`, request: { get: browserGet, fetch } } } } as unknown as ChatCatalogContext;
  return { ctx, fetch, browserGet, origin };
}
it.each(["PATCH", "DELETE"] as const)("preserves the same browser human, trusted Origin and exact stale %s response", async method => {
  const f = fixture(method), data = { queueId: "queue", revision: 3 };
  expect(await probeConsumedHumanQueue(f.ctx, "human", "/api/issues/task/queued-comments/comment", method, data)).toBe(409);
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(`${f.origin}/api/issues/task/queued-comments/comment`, { method, data, headers: { Origin: f.origin }, maxRedirects: 0, timeout: 15_000 });
  expect(f.browserGet).toHaveBeenCalledExactlyOnceWith(`${f.origin}/api/auth/get-session`, { maxRedirects: 0 });
});
it("never substitutes a changed human, other origin, other endpoint or undeclared scenario", async () => {
  for (const change of [ (f: ReturnType<typeof fixture>) => { f.ctx.input.api.get = vi.fn(async () => ({ user: { id: "other" } })) as never; },
    (f: ReturnType<typeof fixture>) => { f.browserGet.mockResolvedValue({ status: () => 200, json: async () => ({ user: { id: "other" } }) }); },
    (f: ReturnType<typeof fixture>) => { f.ctx.scenario.id = "steering.queue-follow-up"; } ]) {
    const f = fixture("PATCH"); change(f);
    await expect(probeConsumedHumanQueue(f.ctx, "human", "/api/issues/task/queued-comments/comment", "PATCH", {})).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled();
  }
  for (const endpoint of ["https://foreign.test/api/issues/task/queued-comments/comment", "/api/instance/settings", "/api/issues/task/queued-comments/comment?redirect=1"]) {
    const f = fixture("DELETE"); await expect(probeConsumedHumanQueue(f.ctx, "human", endpoint, "DELETE", {})).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled();
  }
});
it.each([200, 403, 500])("retains actual non-conflict %s instead of manufacturing 409", async status => {
  const f = fixture("DELETE", status); expect(await probeConsumedHumanQueue(f.ctx, "human", "/api/issues/task/queued-comments/comment", "DELETE", {})).toBe(status);
});
