import { afterEach, describe, expect, it } from "vitest";
import {
  joinUrl,
  ollamaGetJson,
  openOllamaChat,
  type OllamaHttpError,
} from "./http.js";
import { startMockOllama, type MockOllamaServer, writeNdjsonFrames } from "./integration/mock-ollama-server.js";
import { closedLoopbackUrl } from "./integration/closed-port.js";
import { happyPathFrames } from "./integration/test-context.js";

let currentServer: MockOllamaServer | null = null;

afterEach(async () => {
  if (currentServer) {
    await currentServer.close();
    currentServer = null;
  }
});

describe("joinUrl", () => {
  it("normalises trailing and leading slashes", () => {
    expect(joinUrl("http://host:1/", "/api/x")).toBe("http://host:1/api/x");
    expect(joinUrl("http://host:1", "api/x")).toBe("http://host:1/api/x");
    expect(joinUrl("http://host:1//", "/api/x")).toBe("http://host:1/api/x");
  });
});

describe("ollamaGetJson", () => {
  it("returns parsed JSON on 200", async () => {
    currentServer = await startMockOllama({
      version: (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ version: "0.10.0" }));
      },
    });
    const body = await ollamaGetJson<{ version: string }>(currentServer.baseUrl, "/api/version", 5);
    expect(body.version).toBe("0.10.0");
  });

  it("maps connection refused to a hinted OllamaHttpError", async () => {
    const baseUrl = await closedLoopbackUrl();
    let caught: OllamaHttpError | null = null;
    try {
      await ollamaGetJson(baseUrl, "/api/version", 5);
    } catch (err) {
      caught = err as OllamaHttpError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("connection_refused");
    expect(caught?.hint ?? "").toMatch(/ollama serve|install it from/i);
  });

  it("reports timeout when the server stalls longer than the budget", async () => {
    currentServer = await startMockOllama({
      version: async (_req, _res) => {
        // hang forever
        await new Promise(() => {});
      },
    });
    let caught: OllamaHttpError | null = null;
    try {
      await ollamaGetJson(currentServer.baseUrl, "/api/version", 1);
    } catch (err) {
      caught = err as OllamaHttpError;
    }
    expect(caught?.code).toBe("timeout");
  });
});

describe("openOllamaChat", () => {
  it("returns a streaming Response on success", async () => {
    currentServer = await startMockOllama({
      chat: async (_req, res) => {
        await writeNdjsonFrames(res, happyPathFrames());
      },
    });
    const opened = await openOllamaChat(
      currentServer.baseUrl,
      {
        model: "llama3.1:8b",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        keepAliveSec: 60,
        options: { num_ctx: 8192 },
      },
      5,
    );
    expect(opened.response.ok).toBe(true);
    const text = await opened.response.text();
    opened.cleanupTimer();
    expect(text).toContain('"done":true');
  });

  it("maps HTTP 404 with model wording to model_not_found + ollama pull hint", async () => {
    currentServer = await startMockOllama({
      chat: (_req, res) => {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "model 'llama3.1:8b' not found, try pulling it first" }));
      },
    });
    let caught: OllamaHttpError | null = null;
    try {
      await openOllamaChat(
        currentServer.baseUrl,
        {
          model: "llama3.1:8b",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          keepAliveSec: 60,
          options: { num_ctx: 8192 },
        },
        5,
      );
    } catch (err) {
      caught = err as OllamaHttpError;
    }
    expect(caught?.code).toBe("model_not_found");
    expect(caught?.hint ?? "").toMatch(/ollama pull llama3\.1:8b/);
  });

  it("aborts cleanly when an external signal is triggered before the response arrives", async () => {
    currentServer = await startMockOllama({
      chat: async (_req, _res) => {
        await new Promise(() => {});
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    let caught: OllamaHttpError | null = null;
    try {
      await openOllamaChat(
        currentServer.baseUrl,
        {
          model: "llama3.1:8b",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          keepAliveSec: 60,
          options: { num_ctx: 8192 },
        },
        30,
        controller.signal,
      );
    } catch (err) {
      caught = err as OllamaHttpError;
    }
    expect(caught).not.toBeNull();
    // Node's fetch surfaces an aborted request either as AbortError -> "aborted"
    // or as a network_error with the underlying cause — both are acceptable
    // provided no zombie Response is leaked.
    expect(["aborted", "network_error"]).toContain(caught?.code);
  });
});
