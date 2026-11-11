import { readFile, access } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { OPENROUTER_ATTRIBUTION_HEADERS } from "@paperclipai/adapter-utils/openrouter-attribution";
import { piOpenRouterExtensionSource, preparePiOpenRouterExtension } from "./openrouter-extension.js";

async function loadExtension() {
  const module = await import(`data:text/javascript;base64,${Buffer.from(piOpenRouterExtensionSource()).toString("base64")}`);
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  module.default({ on: (event: string, handler: (event: unknown, context: unknown) => void) => handlers.set(event, handler) });
  return (registry: unknown, event = "session_start") => handlers.get(event)!({}, { modelRegistry: registry });
}

describe("legacy Pi OpenRouter attribution extension", () => {
  it("attributes default and custom endpoints after resolving credentials and model headers", async () => {
    const apply = await loadExtension();
    const result = { ok: true, apiKey: "credential", headers: { "http-referer": "https://pi.dev", "x-title": "Pi", "X-Route": "tenant", "X-OpenRouter-App-Visibility": "hidden" } };
    const resolve = vi.fn(async (_model: unknown) => result);
    const registry = { getApiKeyAndHeaders: resolve };
    apply(registry);
    apply(registry, "before_agent_start");
    for (const host of ["openrouter.ai", "eu.openrouter.ai", "us.openrouter.ai"]) {
      expect(await registry.getApiKeyAndHeaders({ provider: "alias", baseUrl: `https://${host}/api/v1` })).toEqual({
        ...result, headers: { ...OPENROUTER_ATTRIBUTION_HEADERS, "X-Route": "tenant", "X-OpenRouter-App-Visibility": "hidden" },
      });
    }
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(result.headers["http-referer"]).toBe("https://pi.dev");
  });

  it("leaves other endpoints and failed authentication intact", async () => {
    const apply = await loadExtension();
    const result = { ok: true, headers: { "X-Title": "Other" } };
    const registry = { getApiKeyAndHeaders: vi.fn(async (_model: unknown) => result) };
    apply(registry);
    for (const baseUrl of ["https://other.example", "https://openrouter.ai.other.example", "http://openrouter.ai", "https://key@openrouter.ai"]) {
      expect(await registry.getApiKeyAndHeaders({ provider: "openrouter", baseUrl })).toBe(result);
    }
    const failed = { ok: false, error: "credential unavailable" };
    const unavailable = { getApiKeyAndHeaders: vi.fn(async (_model: unknown) => failed) };
    apply(unavailable);
    expect(await unavailable.getApiKeyAndHeaders({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(failed);
  });

  it("wraps modern Pi provider dispatch without changing routing, auth, or other model requests", async () => {
    const apply = await loadExtension();
    const model = { id: "model", provider: "alias", baseUrl: "https://openrouter.ai/api/v1" };
    const other = { ...model, baseUrl: "https://gateway.example/v1" };
    const stream = vi.fn((_model: unknown, _input: unknown, _options: unknown) => "stream");
    const auth = { apiKey: {} };
    let provider = { id: "alias", auth, getModels: () => [model, other], stream, streamSimple: stream };
    let registered: typeof provider | undefined;
    const registry = {
      getAll: () => [model], getProvider: () => ({ ...provider }),
      getRegisteredNativeProvider: () => registered,
      registerProvider: vi.fn((wrapped) => { provider = wrapped; registered = wrapped; }),
    };
    apply(registry);
    apply(registry, "model_select");
    expect(registry.registerProvider).toHaveBeenCalledTimes(1);
    expect(provider.auth).toBe(auth);
    const options = { apiKey: "credential", headers: { "x-title": "Pi", "X-Route": "tenant" }, signal: new AbortController().signal };
    expect(provider.streamSimple(model, {}, options)).toBe("stream");
    expect(stream).toHaveBeenLastCalledWith(model, {}, { ...options, headers: { ...OPENROUTER_ATTRIBUTION_HEADERS, "X-Route": "tenant" } });
    provider.stream(other, {}, options);
    expect(stream).toHaveBeenLastCalledWith(other, {}, options);
  });

  it("writes a self-contained extension and removes its temporary directory", async () => {
    const extension = await preparePiOpenRouterExtension();
    try {
      expect(await readFile(extension.extensionPath, "utf8")).toBe(piOpenRouterExtensionSource());
    } finally { await extension.cleanup(); }
    await expect(access(extension.directory)).rejects.toThrow();
  });
});
