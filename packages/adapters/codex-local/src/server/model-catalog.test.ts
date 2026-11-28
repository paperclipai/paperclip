import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_MODEL_CATALOG_URL, fetchCodexModelCatalog, parseCodexModelCatalog } from "./model-catalog.js";

// The shape of `$CODEX_HOME/models_cache.json` and of the backend answer it
// caches, trimmed to the fields Paperclip reads.
const catalog = {
  models: [
    { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list", priority: 3 },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", priority: 1 },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 4 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", priority: 4 },
  ],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("parseCodexModelCatalog", () => {
  it("keeps listed models in the backend's priority order", () => {
    expect(parseCodexModelCatalog(catalog)).toEqual([
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
      { id: "gpt-6-sol", label: "GPT-6-Sol" },
      { id: "gpt-6-luna", label: "GPT-6-Luna" },
    ]);
  });

  it("drops entries without a plain slug and labels unnamed models by slug", () => {
    expect(parseCodexModelCatalog({
      models: [
        null,
        { slug: "gpt-x", visibility: "list", priority: 1 },
        { slug: "../escape", display_name: "Bad", visibility: "list", priority: 2 },
        { slug: 42, visibility: "list", priority: 3 },
        { slug: "gpt-x", display_name: "Duplicate", visibility: "list", priority: 9 },
      ],
    })).toEqual([{ id: "gpt-x", label: "gpt-x" }]);
  });

  it("rejects an answer without a model list", () => {
    expect(() => parseCodexModelCatalog({ detail: "challenge" })).toThrow("no model list");
  });
});

describe("fetchCodexModelCatalog", () => {
  it("asks for the catalog as the installed Codex CLI does", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog)));
    vi.stubGlobal("fetch", fetch);
    const models = await fetchCodexModelCatalog({ accessToken: "access", accountId: "account", clientVersion: "0.161.0" });
    expect(models.map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${CODEX_MODEL_CATALOG_URL}?client_version=0.161.0`);
    expect(init.headers).toEqual({
      Authorization: "Bearer access",
      "ChatGPT-Account-Id": "account",
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.161.0",
    });
    expect(init.redirect).toBe("error");
  });

  it("names the HTTP status so a caller can refresh an expired token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("expired", { status: 401 })));
    await expect(fetchCodexModelCatalog({ accessToken: "old", accountId: null, clientVersion: "0.161.0" }))
      .rejects.toThrow(/\b401\b/);
  });

  it("refuses a prerelease or malformed client version before any request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchCodexModelCatalog({ accessToken: "access", accountId: null, clientVersion: "0.162.0-alpha.1" }))
      .rejects.toThrow("stable Codex CLI version");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the deadline through a body that stalls after the headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      // Like a real fetch body, the stream fails when the request signal aborts.
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"models": ['));
        init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    }))));
    await expect(fetchCodexModelCatalog({ accessToken: "access", accountId: null, clientVersion: "0.161.0", timeoutMs: 50 }))
      .rejects.toThrow();
  });

  it("stops reading a body that grows past the size limit", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(controller) { sent += 1; controller.enqueue(chunk); },
      cancel,
    }))));
    await expect(fetchCodexModelCatalog({ accessToken: "access", accountId: null, clientVersion: "0.161.0" }))
      .rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalled();
    expect(sent).toBeLessThanOrEqual(6);
  });
});
