import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { aiProviderRoutingSchema, type AiProviderRouting } from "@paperclipai/shared";
import {
  AI_ROUTING_MODELS_PROBE_LIMIT,
  AI_ROUTING_MODELS_PROBE_MAX_BYTES,
  assertProbeDestinationAllowed,
  parseModelsResponse,
  probeAiRoutingModels,
  probeModelsUrl,
  readBodyWithLimit,
} from "./ai-routing-models-probe.js";

function route(input: Record<string, unknown>): AiProviderRouting {
  return aiProviderRoutingSchema.parse(input);
}

describe("parseModelsResponse", () => {
  it("sorts, dedupes, and keeps valid OpenAI-style entries", () => {
    expect(
      parseModelsResponse({
        object: "list",
        data: [
          { id: "qwen3-coder:30b", object: "model" },
          { id: "llama3.2:latest", object: "model" },
          { id: "qwen3-coder:30b" },
          { id: "  " },
          { object: "model" },
          "not-an-object",
        ],
      }),
    ).toEqual([
      { id: "llama3.2:latest", label: "llama3.2:latest" },
      { id: "qwen3-coder:30b", label: "qwen3-coder:30b" },
    ]);
  });

  it("caps the list at the routing schema's model limit without collecting more", () => {
    const data = Array.from({ length: AI_ROUTING_MODELS_PROBE_LIMIT + 50 }, (_, i) => ({
      id: `model-${String(i).padStart(4, "0")}`,
    }));
    const parsed = parseModelsResponse({ data });
    expect(parsed).toHaveLength(AI_ROUTING_MODELS_PROBE_LIMIT);
    expect(parsed[0]?.id).toBe("model-0000");
  });

  it("returns an empty list for payloads without a data array", () => {
    expect(parseModelsResponse({ error: { message: "nope" } })).toEqual([]);
    expect(parseModelsResponse(null)).toEqual([]);
  });
});

describe("probeModelsUrl", () => {
  it("trims trailing slashes from the configured base URL", () => {
    expect(
      probeModelsUrl(route({ kind: "local", protocol: "chat", baseUrl: "http://localhost:11434/v1///", auth: "none" })),
    ).toBe("http://localhost:11434/v1/models");
  });

  it("uses OpenRouter's official endpoint", () => {
    expect(probeModelsUrl(route({ kind: "openrouter", protocol: "chat" }))).toBe(
      "https://openrouter.ai/api/v1/models",
    );
  });
});

describe("assertProbeDestinationAllowed", () => {
  it("allows local routes only for the local operator", async () => {
    const localRoute = route({ kind: "local", protocol: "chat", baseUrl: "http://localhost:11434/v1", auth: "none" });
    await expect(assertProbeDestinationAllowed(localRoute, false)).rejects.toMatchObject({
      status: 422,
      details: { code: "ai_routing_models_probe_local_operator_only" },
    });
    await expect(assertProbeDestinationAllowed(localRoute, true)).resolves.toBeUndefined();
  });

  it("rejects gateway URLs that are or resolve to private addresses", async () => {
    for (const hostname of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "169.254.169.254", "172.20.0.5", "[::1]", "[fe80::1]"]) {
      await expect(
        assertProbeDestinationAllowed(route({ kind: "gateway", protocol: "chat", baseUrl: `https://${hostname}/v1`, auth: "none" }), true),
      ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_private_target" } });
    }
    await expect(
      assertProbeDestinationAllowed(
        route({ kind: "gateway", protocol: "chat", baseUrl: "https://internal.example.test/v1", auth: "none" }),
        true,
        async () => ["10.0.0.9"],
      ),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_private_target" } });
  });

  it("accepts public IPv6 gateway literals and maps DNS failures to unreachable", async () => {
    await expect(
      assertProbeDestinationAllowed(
        route({ kind: "gateway", protocol: "chat", baseUrl: "https://[2606:2800:220:1:248:1893:25c8:1946]/v1", auth: "none" }),
        true,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertProbeDestinationAllowed(
        route({ kind: "gateway", protocol: "chat", baseUrl: "https://typo.example.invalid/v1", auth: "none" }),
        true,
        async () => {
          throw new Error("getaddrinfo ENOTFOUND typo.example.invalid");
        },
      ),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_unreachable" } });
  });

  it("allows public gateway targets and the fixed OpenRouter endpoint", async () => {
    await expect(
      assertProbeDestinationAllowed(
        route({ kind: "gateway", protocol: "chat", baseUrl: "https://gw.example.com/v1", auth: "none" }),
        false,
        async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertProbeDestinationAllowed(route({ kind: "openrouter", protocol: "chat" }), false),
    ).resolves.toBeUndefined();
  });
});

describe("readBodyWithLimit", () => {
  it("reads normal bodies", async () => {
    expect(await readBodyWithLimit(new Response('{"data":[]}'))).toBe('{"data":[]}');
  });

  it("cancels and fails when the body exceeds the byte cap", async () => {
    const big = new Response("x".repeat(AI_ROUTING_MODELS_PROBE_MAX_BYTES + 1));
    await expect(readBodyWithLimit(big)).rejects.toMatchObject({
      status: 422,
      details: { code: "ai_routing_models_probe_too_large" },
    });
  });
});

function captureRequest() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ object: "list", data: [{ id: "m" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { request, calls };
}

const publicGateway = { kind: "gateway", protocol: "chat", baseUrl: "https://gw.example.com/v1", auth: "bearer" } as const;
const localChat = { kind: "local", protocol: "chat", baseUrl: "http://localhost:11434/v1", auth: "none" } as const;
/** The fake-fetch tests use a non-resolvable hostname; resolve it to a public address. */
const publicLookup = async () => ["93.184.216.34"];

describe("probeAiRoutingModels request shape", () => {
  it("sends a bearer token, no-redirect, and a timeout signal", async () => {
    const { request, calls } = captureRequest();
    const models = await probeAiRoutingModels(route(publicGateway), "gateway-key", {
      request: request as unknown as typeof fetch,
      isLocalOperator: true,
      lookup: publicLookup,
    });
    expect(models).toEqual([{ id: "m", label: "m" }]);
    expect(calls[0]?.url).toBe("https://gw.example.com/v1/models");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init.headers).toEqual({ Authorization: "Bearer gateway-key" });
  });

  it("uses x-api-key with the Anthropic version header for messages endpoints", async () => {
    const { request, calls } = captureRequest();
    await probeAiRoutingModels(
      route({ kind: "gateway", protocol: "messages", baseUrl: "https://gw.example.com", auth: "api_key" }),
      "gateway-key",
      { request: request as unknown as typeof fetch, isLocalOperator: true, lookup: publicLookup },
    );
    expect(calls[0]?.init.headers).toEqual({
      "x-api-key": "gateway-key",
      "anthropic-version": "2023-06-01",
    });
  });

  it("sends no credentials for unauthenticated local endpoints", async () => {
    const { request, calls } = captureRequest();
    await probeAiRoutingModels(route(localChat), "", {
      request: request as unknown as typeof fetch,
      isLocalOperator: true,
    });
    expect(calls[0]?.init.headers).toEqual({});
  });

  it("blocks a non-operator member from probing a loopback endpoint before any request", async () => {
    const { request, calls } = captureRequest();
    await expect(
      probeAiRoutingModels(route(localChat), "", {
        request: request as unknown as typeof fetch,
        isLocalOperator: false,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_local_operator_only" } });
    expect(calls).toHaveLength(0);
  });

  it("rejects Bedrock routing with an actionable error", async () => {
    await expect(
      probeAiRoutingModels(route({ kind: "bedrock", protocol: "bedrock", auth: "bearer", region: "us-east-1" }), "key"),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_unsupported" } });
  });

  it("maps endpoint rejection and transport failure to distinct codes", async () => {
    await expect(
      probeAiRoutingModels(route(publicGateway), "key", {
        request: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
        isLocalOperator: true,
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_unauthorized" } });
    await expect(
      probeAiRoutingModels(route(publicGateway), "key", {
        request: (async () => {
          throw new Error("connection refused");
        }) as unknown as typeof fetch,
        isLocalOperator: true,
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_unreachable" } });
  });

  it("rejects non-JSON responses", async () => {
    await expect(
      probeAiRoutingModels(route(localChat), "", {
        request: (async () => new Response("<html>login</html>", { status: 200 })) as unknown as typeof fetch,
        isLocalOperator: true,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_invalid" } });
  });

  it("fails with the too-large code when the endpoint streams an oversized list", async () => {
    await expect(
      probeAiRoutingModels(route(localChat), "", {
        request: (async () =>
          new Response("x".repeat(AI_ROUTING_MODELS_PROBE_MAX_BYTES + 1), { status: 200 })) as unknown as typeof fetch,
        isLocalOperator: true,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_too_large" } });
  });
});

// The probe runs against operator-supplied model servers, so the real fetch
// path (socket, streaming body decode, abort-on-timeout) is exercised against
// a local HTTP server rather than only the mocked transport above.
describe("probeAiRoutingModels against a real endpoint", () => {
  const servers: http.Server[] = [];

  function listen(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}/v1`);
      });
    });
  }

  afterAll(async () => {
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("lists models from an Ollama-style endpoint over the real transport", async () => {
    const baseUrl = await listen((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3-coder:30b" }, { id: "llama3.2:latest" }] }));
        return;
      }
      res.writeHead(404); res.end();
    });
    const models = await probeAiRoutingModels(route({ ...localChat, baseUrl }), "", { isLocalOperator: true });
    expect(models.map((m) => m.id)).toEqual(["llama3.2:latest", "qwen3-coder:30b"]);
  });

  it("maps a real 401 to the unauthorized code", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(401); res.end();
    });
    await expect(
      probeAiRoutingModels(route({ ...localChat, baseUrl, auth: "bearer" }), "key", { isLocalOperator: true }),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_unauthorized" } });
  });

  it("aborts a hanging endpoint while the request is in flight", async () => {
    const baseUrl = await listen(() => {});
    await expect(
      probeAiRoutingModels(route({ ...localChat, baseUrl }), "", { isLocalOperator: true, timeoutMs: 50 }),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_unreachable" } });
  });

  it("stops reading a streaming endpoint that exceeds the byte cap", async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "y".repeat(64 * 1024);
      for (let i = 0; i < 40; i++) res.write(chunk);
      res.end();
    });
    await expect(
      probeAiRoutingModels(route({ ...localChat, baseUrl }), "", { isLocalOperator: true }),
    ).rejects.toMatchObject({ status: 422, details: { code: "ai_routing_models_probe_too_large" } });
  });
});
