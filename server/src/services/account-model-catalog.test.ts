import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAccountModels } from "./account-model-catalog.js";

afterEach(() => vi.restoreAllMocks());

describe("account model discovery", () => {
  it("loads Anthropic models using the selected key", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "claude-haiku-5-5", display_name: "Haiku 5.5" }], has_more: false }), { status: 200 }));
    expect(await fetchAccountModels("anthropic", "api_key", "test-key")).toEqual([{ id: "claude-haiku-5-5", label: "Haiku 5.5" }]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-api-key": "test-key" });
  });

  it("loads the selected Codex subscription catalog and excludes hidden models", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-6.1-terra", display_name: "Terra", visibility: "list" }, { slug: "private", visibility: "hide" }] }), { status: 200 }));
    expect(await fetchAccountModels("openai", "subscription", JSON.stringify({ tokens: { access_token: "token", account_id: "account" } }))).toEqual([{ id: "gpt-6.1-terra", label: "Terra" }]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer token", "ChatGPT-Account-Id": "account" });
  });

  it("uses the selected Claude subscription token", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }] }), { status: 200 }));
    expect(await fetchAccountModels("anthropic", "subscription", "oauth-token")).toEqual([{ id: "claude-haiku-5-5", label: "claude-haiku-5-5" }]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer oauth-token", "anthropic-beta": "oauth-2025-04-20" });
  });

  it("uses the selected OpenAI API key", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "gpt-6.1-terra" }] }), { status: 200 }));
    expect(await fetchAccountModels("openai", "api_key", "openai-key")).toEqual([{ id: "gpt-6.1-terra", label: "gpt-6.1-terra" }]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer openai-key" });
  });

  it("refreshes an expired Codex token once and retries the same account catalog", async () => {
    const original = JSON.stringify({ tokens: { access_token: "expired", account_id: "selected-account" } });
    const replacement = JSON.stringify({ tokens: { access_token: "fresh", account_id: "selected-account" } });
    const refreshCredential = vi.fn().mockResolvedValue(replacement);
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ models: [{ slug: "gpt-6.1-terra", visibility: "list" }] }));
    expect(await fetchAccountModels("openai", "subscription", original, { refreshCredential }))
      .toEqual([{ id: "gpt-6.1-terra", label: "gpt-6.1-terra" }]);
    expect(refreshCredential).toHaveBeenCalledExactlyOnceWith(original, expect.any(AbortSignal));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer fresh", "ChatGPT-Account-Id": "selected-account" });
  });

  it.each([403, 429, 500, 503])("does not rotate a Codex credential after HTTP %s", async status => {
    const refreshCredential = vi.fn();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status }));
    await expect(fetchAccountModels("openai", "subscription", JSON.stringify({ tokens: { access_token: "token", account_id: "selected-account" } }), { refreshCredential }))
      .rejects.toThrow("Could not load models for this account");
    expect(refreshCredential).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([["openai", "api_key"], ["anthropic", "subscription"]] as const)("does not use Codex refresh for %s %s", async (provider, method) => {
    const refreshCredential = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 401 }));
    await expect(fetchAccountModels(provider, method, "selected-credential", { refreshCredential })).rejects.toThrow("Could not load models for this account");
    expect(refreshCredential).not.toHaveBeenCalled();
  });

  it("does not fetch another account after a concurrent reconnect", async () => {
    const refreshCredential = vi.fn().mockResolvedValue(JSON.stringify({ tokens: { access_token: "new-owner-token", account_id: "another-account" } }));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("expired", { status: 401 }));
    await expect(fetchAccountModels("openai", "subscription", JSON.stringify({ tokens: { access_token: "expired", account_id: "selected-account" } }), { refreshCredential }))
      .rejects.toThrow("Could not load models for this account");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(refreshCredential).toHaveBeenCalledOnce();
  });

  it("does not repeat a failed refresh or expose its private error", async () => {
    const refreshCredential = vi.fn().mockRejectedValue(new Error("private refresh credential"));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("expired", { status: 401 }));
    const failure = await fetchAccountModels("openai", "subscription", JSON.stringify({ tokens: { access_token: "expired", account_id: "selected-account" } }), { refreshCredential }).catch(error => error);
    expect(failure).toMatchObject({ status: 422, message: "Could not load models for this account. Check its connection and try again." });
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stops after one refresh if the new Codex token is also rejected", async () => {
    const refreshCredential = vi.fn().mockResolvedValue(JSON.stringify({ tokens: { access_token: "fresh", account_id: "selected-account" } }));
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("denied", { status: 401 }));
    await expect(fetchAccountModels("openai", "subscription", JSON.stringify({ tokens: { access_token: "expired", account_id: "selected-account" } }), { refreshCredential }))
      .rejects.toThrow("Could not load models for this account");
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not present a truncated catalog as complete", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [], has_more: true }), { status: 200 }));
    await expect(fetchAccountModels("anthropic", "api_key", "key")).rejects.toThrow("Could not load models for this account");
  });

  it("reports provider failure instead of returning another account's catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 401 }));
    await expect(fetchAccountModels("openai", "api_key", "invalid")).rejects.toThrow("Could not load models for this account");
  });
});
