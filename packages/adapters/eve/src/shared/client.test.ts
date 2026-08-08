import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EveStaleSessionError, fetchInfo, sendFollowUp, startSession, streamSession } from "./client.js";
import type { EveStreamEvent } from "./events.js";

function chunkedStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamSession", () => {
  it("parses an event split across chunk boundaries", async () => {
    const eventA = JSON.stringify({ type: "message.appended", data: { text: "hel" } });
    const eventB = JSON.stringify({ type: "message.completed", data: { text: "hello world" } });
    // Split eventB in the middle across two chunks.
    const full = `${eventA}\n${eventB}\n`;
    const splitAt = eventA.length + 10;
    fetchMock.mockResolvedValue(chunkedStreamResponse([full.slice(0, splitAt), full.slice(splitAt)]));

    const events: EveStreamEvent[] = [];
    const result = await streamSession({
      baseUrl: "http://127.0.0.1:3000/",
      headers: {},
      sessionId: "sess-1",
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
    });

    expect(events.map((event) => event.type)).toEqual(["message.appended", "message.completed"]);
    expect(events[1]?.data).toEqual({ text: "hello world" });
    expect(result.skippedLines).toBe(0);
    // Trailing slash on baseUrl is normalized away.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/eve/v1/session/sess-1/stream");
  });

  it("skips unparseable lines without throwing", async () => {
    const good = JSON.stringify({ type: "session.waiting", data: {} });
    fetchMock.mockResolvedValue(chunkedStreamResponse([`not json at all\n${good}\n{broken\n`]));

    const events: EveStreamEvent[] = [];
    const result = await streamSession({
      baseUrl: "http://127.0.0.1:3000",
      headers: {},
      sessionId: "sess-1",
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
    });

    expect(events.map((event) => event.type)).toEqual(["session.waiting"]);
    expect(result.skippedLines).toBe(2);
  });

  it("passes startIndex as a query parameter", async () => {
    fetchMock.mockResolvedValue(chunkedStreamResponse([]));
    await streamSession({
      baseUrl: "http://127.0.0.1:3000",
      headers: {},
      sessionId: "sess-1",
      startIndex: 12,
      signal: new AbortController().signal,
      onEvent: async () => {},
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/stream?startIndex=12");
  });
});

describe("content-type handling", () => {
  it("sends content-type on POSTs but not on GETs", async () => {
    // POST: startSession
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: "s", continuationToken: "t" }), { status: 200 }),
    );
    await startSession({
      baseUrl: "http://127.0.0.1:3000",
      headers: { "x-extra": "1" },
      message: "hi",
      timeoutMs: 5000,
    });
    const postHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(postHeaders["content-type"]).toBe("application/json");
    expect(postHeaders["x-extra"]).toBe("1");

    // GET: streamSession
    fetchMock.mockResolvedValueOnce(chunkedStreamResponse([]));
    await streamSession({
      baseUrl: "http://127.0.0.1:3000",
      headers: { "x-extra": "1" },
      sessionId: "s",
      signal: new AbortController().signal,
      onEvent: async () => {},
    });
    const streamHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(streamHeaders).not.toHaveProperty("content-type");
    expect(streamHeaders["x-extra"]).toBe("1");

    // GET: fetchInfo
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "a" }), { status: 200 }));
    await fetchInfo({ baseUrl: "http://127.0.0.1:3000", headers: {}, timeoutMs: 5000 });
    const infoHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(infoHeaders).not.toHaveProperty("content-type");
  });
});

describe("startSession", () => {
  it("falls back to the x-eve-session-id header when the body has no sessionId", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ continuationToken: "tok" }), {
        status: 200,
        headers: { "x-eve-session-id": "sess-from-header" },
      }),
    );
    const result = await startSession({
      baseUrl: "http://127.0.0.1:3000",
      headers: {},
      message: "hi",
      timeoutMs: 5000,
    });
    expect(result).toEqual({ sessionId: "sess-from-header", continuationToken: "tok" });
  });

  it("throws with status and truncated body on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(1000), { status: 500 }));
    await expect(
      startSession({ baseUrl: "http://127.0.0.1:3000", headers: {}, message: "hi", timeoutMs: 5000 }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("sendFollowUp", () => {
  it("throws EveStaleSessionError on a stale continuation rejection", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "continuation token is stale" }), { status: 400 }),
    );
    await expect(
      sendFollowUp({
        baseUrl: "http://127.0.0.1:3000",
        headers: {},
        sessionId: "sess-1",
        continuationToken: "tok-old",
        message: "hi",
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(EveStaleSessionError);
  });

  it("throws a plain Error on other 4xx failures", async () => {
    fetchMock.mockResolvedValue(new Response("bad request payload", { status: 400 }));
    const promise = sendFollowUp({
      baseUrl: "http://127.0.0.1:3000",
      headers: {},
      sessionId: "sess-1",
      continuationToken: "tok",
      message: "hi",
      timeoutMs: 5000,
    });
    await expect(promise).rejects.toThrow(/HTTP 400/);
    await expect(promise).rejects.not.toBeInstanceOf(EveStaleSessionError);
  });
});
