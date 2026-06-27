import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPaperclipMcpServer } from "./index.js";

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function createConnectedClient() {
  const { server } = createPaperclipMcpServer({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "company-1",
    agentId: "agent-1",
    runId: "run-current",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("heartbeat run MCP resources", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads resumable heartbeat run log chunks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ runId: "run-1", offset: 12, nextOffset: 17, content: "hello" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.readResource({
        uri: "paperclip://heartbeat-runs/run-1/log-chunks/12?limitBytes=64",
      });
      const first = result.contents[0];
      if (!first || !("text" in first)) throw new Error("Expected text resource");

      expect(JSON.parse(first.text)).toEqual({ runId: "run-1", offset: 12, nextOffset: 17, content: "hello" });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toBe("http://localhost:3100/api/heartbeat-runs/run-1/log?offset=12&limitBytes=64");
      expect(init.method).toBe("GET");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reads run metadata, log metadata, events, and issues", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://localhost:3100/api/heartbeat-runs/run-1") {
        return Promise.resolve(mockJsonResponse({
          id: "run-1",
          status: "running",
          logBytes: 24,
          lastOutputSeq: 2,
          lastOutputAt: "2026-01-01T00:00:00.000Z",
        }));
      }
      if (url === "http://localhost:3100/api/heartbeat-runs/run-1/events?afterSeq=2&limit=3") {
        return Promise.resolve(mockJsonResponse([{ seq: 3, eventType: "lifecycle" }]));
      }
      if (url === "http://localhost:3100/api/heartbeat-runs/run-1/issues") {
        return Promise.resolve(mockJsonResponse([{ identifier: "PEN-1191" }]));
      }
      return Promise.resolve(mockJsonResponse({ error: `unexpected ${url}` }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await createConnectedClient();

    try {
      const run = await client.readResource({ uri: "paperclip://heartbeat-runs/run-1" });
      const log = await client.readResource({ uri: "paperclip://heartbeat-runs/run-1/log" });
      const events = await client.readResource({ uri: "paperclip://heartbeat-runs/run-1/events?afterSeq=2&limit=3" });
      const issues = await client.readResource({ uri: "paperclip://heartbeat-runs/run-1/issues" });

      const runText = run.contents[0];
      const logText = log.contents[0];
      const eventsText = events.contents[0];
      const issuesText = issues.contents[0];
      if (!runText || !("text" in runText) || !logText || !("text" in logText)) throw new Error("Expected text resources");
      if (!eventsText || !("text" in eventsText) || !issuesText || !("text" in issuesText)) throw new Error("Expected text resources");

      expect(JSON.parse(runText.text)).toMatchObject({ id: "run-1", logBytes: 24 });
      expect(JSON.parse(logText.text)).toMatchObject({
        runId: "run-1",
        logBytes: 24,
        chunks: "paperclip://heartbeat-runs/run-1/log-chunks/24?limitBytes=16384",
      });
      expect(JSON.parse(eventsText.text)).toEqual([{ seq: 3, eventType: "lifecycle" }]);
      expect(JSON.parse(issuesText.text)).toEqual([{ identifier: "PEN-1191" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("emits resource update notifications and cleans terminal subscriptions", async () => {
    vi.useFakeTimers();
    const snapshots = [
      { status: "running", logBytes: 0, lastOutputSeq: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      { status: "running", logBytes: 5, lastOutputSeq: 1, updatedAt: "2026-01-01T00:00:01.000Z" },
      { status: "succeeded", logBytes: 5, lastOutputSeq: 1, updatedAt: "2026-01-01T00:00:02.000Z" },
      { status: "succeeded", logBytes: 9, lastOutputSeq: 2, updatedAt: "2026-01-01T00:00:03.000Z" },
    ];
    const fetchMock = vi.fn().mockImplementation(() => mockJsonResponse(snapshots.shift() ?? snapshots[snapshots.length - 1]));
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await createConnectedClient();
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await client.subscribeResource({ uri: "paperclip://heartbeat-runs/run-1/log" });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(updates).toEqual([
        "paperclip://heartbeat-runs/run-1/log",
        "paperclip://heartbeat-runs/run-1/log",
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("stops sending notifications after unsubscribe", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({ status: "running", logBytes: 0, lastOutputSeq: 0 }))
      .mockResolvedValue(mockJsonResponse({ status: "running", logBytes: 10, lastOutputSeq: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await createConnectedClient();
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      const uri = "paperclip://heartbeat-runs/run-1/events?afterSeq=0&limit=10";
      await client.subscribeResource({ uri });
      await client.unsubscribeResource({ uri });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(updates).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
