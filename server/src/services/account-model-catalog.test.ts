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

  it("does not present a truncated catalog as complete", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [], has_more: true }), { status: 200 }));
    await expect(fetchAccountModels("anthropic", "api_key", "key")).rejects.toThrow("Could not load models for this account");
  });

  it("reports provider failure instead of returning another account's catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 401 }));
    await expect(fetchAccountModels("openai", "api_key", "invalid")).rejects.toThrow("Could not load models for this account");
  });
});
