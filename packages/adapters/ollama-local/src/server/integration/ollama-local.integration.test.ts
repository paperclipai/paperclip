/**
 * Integration suite for `@paperclipai/adapter-ollama-local`.
 *
 * Covers the M3 acceptance criteria from GEM-40:
 *   - happy path: heartbeat produces a valid AdapterExecutionResult with
 *     non-empty `summary` (what the server auto-posts as an issue comment)
 *   - NDJSON streaming: partial tokens forwarded through onLog in order
 *   - error modes: model 404, connection refused, context overflow, timeout
 *   - cancellation: parseOllamaChatStream responds to an already-aborted signal
 *   - non-streaming fallback:
 *       context.paperclipProxyMode === "openclaw_gateway"
 *       config.streamingDisabled === true
 *
 * The mock Ollama server speaks HTTP on an ephemeral loopback port and is
 * torn down between tests. No real Ollama install is required.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../execute.js";
import { parseOllamaChatStream } from "../parse.js";
import { closedLoopbackUrl } from "./closed-port.js";
import { startMockOllama, type MockOllamaServer, writeNdjsonFrames, writeSplitNdjsonFrame } from "./mock-ollama-server.js";
import { buildContext, happyPathFrames } from "./test-context.js";

let currentServer: MockOllamaServer | null = null;

afterEach(async () => {
  if (currentServer) {
    await currentServer.close();
    currentServer = null;
  }
});

describe("ollama_local execute() — happy path", () => {
  it("streams NDJSON frames end-to-end and returns a valid AdapterExecutionResult", async () => {
    currentServer = await startMockOllama({
      chat: async (_req, res, body) => {
        const parsed = body as { stream?: boolean };
        expect(parsed.stream).toBe(true);
        await writeNdjsonFrames(res, happyPathFrames({ pieces: ["Hi ", "there", "!"] }));
      },
    });
    const captured = buildContext({
      config: { baseUrl: currentServer.baseUrl, model: "llama3.1:8b", contextWindow: 8192 },
      runContext: { paperclipWake: { reason: "test" } },
    });

    const result = await execute(captured.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeFalsy();
    expect(result.summary).toBe("Hi there!");
    expect(result.provider).toBe("ollama");
    expect(result.biller).toBe("ollama");
    expect(result.model).toBe("llama3.1:8b");
    expect(result.billingType).toBe("subscription_included");
    expect(result.usage).toEqual({ inputTokens: 128, outputTokens: 24 });
    expect(result.resultJson?.frameCount).toBe(4);
    expect(result.resultJson?.doneReason).toBe("stop");
    expect(result.resultJson?.truncated).toBe(false);
    expect(captured.meta).toHaveLength(1);
    expect(captured.meta[0]?.adapterType).toBe("ollama_local");
    expect(captured.stdout()).toBe("Hi there!");
  });

  it("forwards each NDJSON delta through onLog in the order it arrived", async () => {
    currentServer = await startMockOllama({
      chat: async (_req, res) => {
        await writeNdjsonFrames(
          res,
          happyPathFrames({ pieces: ["alpha", "-", "beta", "-", "gamma"] }),
          { delayMs: 2 },
        );
      },
    });
    const captured = buildContext({
      config: { baseUrl: currentServer.baseUrl, model: "llama3.1:8b" },
    });
    await execute(captured.ctx);
    const stdoutChunks = captured.logs.filter((l) => l.stream === "stdout").map((l) => l.chunk);
    expect(stdoutChunks).toEqual(["alpha", "-", "beta", "-", "gamma"]);
  });

  it("parses streams whose JSON is split across TCP packets", async () => {
    currentServer = await startMockOllama({
      chat: async (_req, res) => {
        // deliberately fragment the single JSON line into tiny pieces
        await writeSplitNdjsonFrame(
          res,
          {
            model: "llama3.1:8b",
            message: { role: "assistant", content: "fragmented content" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 10,
            eval_count: 5,
          },
          16,
        );
      },
    });
    const captured = buildContext({
      config: { baseUrl: currentServer.baseUrl, model: "llama3.1:8b" },
    });
    const result = await execute(captured.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("fragmented content");
  });
});

describe("ollama_local execute() — error modes", () => {
  it("maps a 404 with 'model' wording to ollama_model_not_found + actionable `ollama pull` hint", async () => {
    currentServer = await startMockOllama({
      chat: (_req, res) => {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "model 'llama3.1:8b' not found, try pulling it first" }));
      },
    });
    const captured = buildContext({
      config: { baseUrl: currentServer.baseUrl, model: "llama3.1:8b" },
    });
    const result = await execute(captured.ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("ollama_model_not_found");
    expect(result.errorMessage ?? "").toMatch(/ollama pull llama3\.1:8b/);
  });

  it("surfaces connection refused against a closed port with the install-docs hint", async () => {
    const baseUrl = await closedLoopbackUrl();
    const captured = buildContext({
      config: { baseUrl, model: "llama3.1:8b", requestTimeoutSec: 5 },
    });
    const result = await execute(captured.ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("ollama_connection_refused");
    expect(result.errorMessage ?? "").toMatch(/ollama\.com\/download|ollama serve/);
  });

  it("emits a truncation warning + surfaces truncated=true in resultJson (no fail)", async () => {
    const contextWindow = 4096;
    currentServer = await startMockOllama({
      chat: async (_req, res) => {
        await writeNdjsonFrames(res, [
          { message: { role: "assistant", content: "trimmed output" }, done: false },
          {
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "length",
            prompt_eval_count: contextWindow,
            eval_count: 5,
          },
        ]);
      },
    });
    const captured = buildContext({
      config: { baseUrl: currentServer.baseUrl, model: "llama3.1:8b", contextWindow },
    });
    const result = await execute(captured.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.truncated).toBe(true);
    expect(captured.stderr()).toMatch(/context truncated/);
    expect(captured.stderr()).toMatch(new RegExp(`num_ctx=${contextWindow}`));
  });

  it("reports timeout when the server never sends a response (retriable failure)", async () => {
    currentServer = await startMockOllama({
      chat: async (_req, _res) => {
        await new Promise(() => {});
      },
    });
    const captured = buildContext({
      config: { baseUrl: currentServer.baseUrl, model: "llama3.1:8b", requestTimeoutSec: 1 },
    });
    const result = await execute(captured.ctx);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("ollama_timeout");
  });
});

describe("ollama_local execute() — non-streaming fallback", () => {
  it("sends stream:false when context.paperclipProxyMode === 'openclaw_gateway'", async () => {
    let recordedBody: unknown = null;
    currentServer = await startMockOllama({
      chat: (_req, res, body) => {
        recordedBody = body;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            model: "llama3.1:8b",
            message: { role: "assistant", content: "openclaw gateway reply" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 42,
            eval_count: 7,
          }),
        );
      },
    });
    const captured = buildContext({
      config: { baseUrl: currentServer.baseUrl, model: "llama3.1:8b" },
      runContext: { paperclipProxyMode: "openclaw_gateway" },
    });
    const result = await execute(captured.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("openclaw gateway reply");
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(result.resultJson?.frameCount).toBe(1);
    expect((recordedBody as { stream?: boolean }).stream).toBe(false);
  });

  it("sends stream:false when config.streamingDisabled === true", async () => {
    let recordedStream: unknown = null;
    currentServer = await startMockOllama({
      chat: (_req, res, body) => {
        recordedStream = (body as { stream?: unknown }).stream;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            message: { role: "assistant", content: "non-stream reply" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          }),
        );
      },
    });
    const captured = buildContext({
      config: { baseUrl: currentServer.baseUrl, model: "llama3.1:8b", streamingDisabled: true },
    });
    const result = await execute(captured.ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("non-stream reply");
    expect(recordedStream).toBe(false);
  });
});

describe("ollama_local cancellation", () => {
  it("parseOllamaChatStream stops early when the abort signal fires", async () => {
    const frames = happyPathFrames({ pieces: ["one ", "two ", "three"] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(f)}\n`));
        controller.close();
      },
    });
    const controller = new AbortController();
    controller.abort();
    const parsed = await parseOllamaChatStream(body, { signal: controller.signal });
    // With an already-aborted signal the generator yields zero frames.
    expect(parsed.frameCount).toBe(0);
    expect(parsed.assistantText).toBe("");
  });
});
