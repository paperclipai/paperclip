import { describe, expect, it, vi } from "vitest";

import type { PrpEvent } from "../protocol/replay-contract.js";
import {
  createRunnerClient,
  RunnerClientError,
  type EventSourceLike,
} from "./client.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("public runner browser client", () => {
  it("uses an injected fetch transport and normalizes the base URL", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), ...(init === undefined ? {} : { init }) });
      return json({ manifests: [{ id: "completion" }] });
    }) as typeof fetch;
    const client = createRunnerClient({ baseUrl: "https://runner.test/api/", fetchImpl });

    await expect(client.fetchManifests()).resolves.toEqual([{ id: "completion" }]);
    expect(calls[0]?.input).toBe("https://runner.test/api/manifests");
  });

  it("preserves structured status and code on server errors", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "stale_turn", message: "Turn ended." }, 409)) as unknown as typeof fetch;
    const client = createRunnerClient({ fetchImpl });

    await expect(client.startTurn("session", "hello")).rejects.toEqual(
      expect.objectContaining<Partial<RunnerClientError>>({
        name: "RunnerClientError",
        status: 409,
        code: "stale_turn",
        message: "Turn ended.",
      }),
    );
  });

  it("injects EventSource without changing canonical events or reconnect cursor", () => {
    let url = "";
    let closed = false;
    const source: EventSourceLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      close: () => { closed = true; },
    };
    const client = createRunnerClient({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      eventSourceFactory: (nextUrl) => { url = nextUrl; return source; },
    });
    const event = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "event-9",
      sourceKind: "harness",
      sourceInstanceId: "driver",
      sourceSeq: 9,
      emittedAt: "2026-08-08T00:00:00.000Z",
      eventType: "item.delta",
      payload: { text: "exact" },
    } as PrpEvent;
    const onEvent = vi.fn();
    const onError = vi.fn();
    const handle = client.openEventStream("session/id", 8, { onEvent, onError });

    expect(url).toBe("/api/liveConsole/sessions/session%2Fid/stream?after=8");
    source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    expect(onEvent).toHaveBeenCalledWith(event);
    source.onmessage?.({ data: "not json" } as MessageEvent<string>);
    expect(onError).toHaveBeenCalledOnce();
    handle.close();
    expect(closed).toBe(true);
  });
});
