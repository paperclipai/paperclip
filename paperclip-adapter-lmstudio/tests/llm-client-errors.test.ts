import { describe, it, expect, vi, beforeEach } from "vitest";
import { callChatCompletion, LlmClientError } from "../src/server/llm-client.js";

describe("LlmClientError classification", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("classifies connection refused as 'network'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    ));

    await expect(
      callChatCompletion({
        url: "http://localhost:9999",
        model: "m",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("classifies AbortError as 'timeout'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    ));

    await expect(
      callChatCompletion({
        url: "http://localhost:1234",
        model: "m",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("classifies HTTP 404 model-not-found as 'model'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "model 'foo' not found",
    }));

    await expect(
      callChatCompletion({
        url: "http://localhost:1234",
        model: "foo",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "model" });
  });

  it("classifies HTTP 500 as 'unknown'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "oops",
    }));

    await expect(
      callChatCompletion({
        url: "http://localhost:1234",
        model: "foo",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "unknown" });
  });

  it("classifies plain HTTP 404 without model body as 'unknown'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "route not found",
    }));

    await expect(
      callChatCompletion({
        url: "http://localhost:1234",
        model: "foo",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "unknown" });
  });

  it("exposes LlmClientError with message including reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }),
    ));

    const promise = callChatCompletion({
      url: "http://localhost:9999",
      model: "m",
      messages: [],
      tools: [],
      timeoutMs: 1000,
    });

    await expect(promise).rejects.toBeInstanceOf(LlmClientError);
    await expect(promise).rejects.toMatchObject({
      kind: "network",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });
});
