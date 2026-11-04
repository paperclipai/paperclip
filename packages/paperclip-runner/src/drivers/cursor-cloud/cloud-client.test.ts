import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  CursorCloudClient,
  CursorCloudClientError,
  isCursorCloudUnsentRequestError,
  isCursorCloudRunActive,
} from "./cloud-client.js";

const AGENT = "bc-00000000-0000-0000-0000-000000000001";
const RUN = "run-00000000-0000-0000-0000-000000000001";
const OTHER_RUN = "run-00000000-0000-0000-0000-000000000002";
const API_KEY = "cursor-provider-secret-canary";
const TIME = "2026-10-28T16:00:00.000Z";
const agent = { id: AGENT, status: "ACTIVE", env: { type: "cloud" }, url: `https://cursor.com/agents/${AGENT}`, createdAt: TIME, updatedAt: TIME };
const run = { id: RUN, agentId: AGENT, status: "CREATING", createdAt: TIME, updatedAt: TIME };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe("Cursor Cloud v1 HTTP client", () => {
  it("uses authenticated native paths and preserves exact model, MCP, and run-scoped environment payloads", async () => {
    const requests: Array<{ path: string; method: string; authorization: string | undefined; key: string | undefined; body?: unknown }> = [];
    const baseUrl = await serve(async (request, response) => {
      const entry = {
        path: request.url!, method: request.method!, authorization: request.headers.authorization,
        key: request.headers["idempotency-key"] as string | undefined,
        ...(["POST"].includes(request.method!) && !request.url?.endsWith("/cancel") ? { body: await body(request) } : {}),
      };
      requests.push(entry);
      if (entry.path === "/v1/agents" && entry.method === "POST") return json(response, { agent, run }, 201);
      if (entry.path === `/v1/agents/${AGENT}/runs` && entry.method === "POST") return json(response, { run: { ...run, id: OTHER_RUN } }, 201);
      if (entry.path.endsWith("/cancel")) return json(response, { id: RUN });
      if (entry.path === `/v1/agents/${AGENT}` && entry.method === "DELETE") return json(response, { id: AGENT });
      if (entry.path === `/v1/agents/${AGENT}`) return json(response, agent);
      if (entry.path === `/v1/agents/${AGENT}/runs/${RUN}`) return json(response, { ...run, status: "WAITING_FOR_BACKGROUND_WORK" });
      if (entry.path === "/v1/models") return json(response, { items: [{ id: "future-model/exact", displayName: "Future model" }] });
      if (entry.path.endsWith("/artifacts")) return json(response, { items: [{ path: "proof.json", sizeBytes: 32, updatedAt: TIME }] });
      json(response, {}, 404);
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl });
    const model = { id: "future-model/exact", params: [{ id: "thinking", value: "high" }] };
    const mcpServers = [{ name: "paperclip", type: "http" as const, url: "https://tools.example.test/mcp", headers: { Authorization: "Bearer run-secret" } }];
    expect(await client.createAgent({ prompt: { text: "Create the proof" }, model, repos: [], mcpServers }, { idempotencyKey: "initial-receipt" })).toEqual({ agent, run });
    await client.createRun(AGENT, { prompt: { text: "Continue" }, model, envVars: { PAPERCLIP_RUN_ID: "new-run" }, mcpServers }, { idempotencyKey: "followup-receipt" });
    expect((await client.getRun(AGENT, RUN)).status).toBe("WAITING_FOR_BACKGROUND_WORK");
    expect(await client.getAgent(AGENT)).toEqual(agent);
    expect(await client.cancelRun(AGENT, RUN)).toEqual({ id: RUN });
    expect(await client.listModels()).toEqual({ items: [{ id: "future-model/exact", displayName: "Future model" }] });
    expect(await client.listArtifacts(AGENT)).toEqual({ items: [{ path: "proof.json", sizeBytes: 32, updatedAt: TIME }] });
    expect(await client.deleteAgent(AGENT)).toEqual({ id: AGENT });
    expect(requests.every(entry => entry.authorization === `Bearer ${API_KEY}`)).toBe(true);
    expect(requests[0]).toMatchObject({ path: "/v1/agents", method: "POST", key: "initial-receipt", body: { prompt: { text: "Create the proof" }, model, repos: [], mcpServers } });
    expect(requests[1]).toMatchObject({ path: `/v1/agents/${AGENT}/runs`, key: "followup-receipt", body: { envVars: { PAPERCLIP_RUN_ID: "new-run" }, model, mcpServers } });
    expect(isCursorCloudRunActive("WAITING_FOR_BACKGROUND_WORK")).toBe(true);
    expect(isCursorCloudRunActive("EXPIRED")).toBe(false);
  });

  it("retains safe HTTP metadata without echoing provider messages or retrying mutations", async () => {
    let calls = 0;
    const baseUrl = await serve((_request, response) => {
      calls += 1;
      response.setHeader("Retry-After", "2");
      json(response, { error: { code: "feature_unavailable", message: `Failure with ${API_KEY}`, token: API_KEY } }, 503);
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl });
    const error = await client.createAgent({ prompt: { text: "Do work" } }).catch(error => error);
    expect(error).toBeInstanceOf(CursorCloudClientError);
    expect(error).toMatchObject({ code: "http_error", status: 503, providerCode: "feature_unavailable", retryAfterMs: 2_000, retryable: true });
    expect(String(error)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(error.cause).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("scopes token usage to the exact run and obtains an artifact URL without forwarding credentials to it", async () => {
    const paths: string[] = [];
    const usage = { inputTokens: 3, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 1, totalTokens: 6 };
    const baseUrl = await serve((request, response) => {
      paths.push(request.url!);
      if (request.url?.includes("/usage?")) return json(response, { totalUsage: usage, runs: [{ id: RUN, usage }] });
      if (request.url?.includes("/artifacts/download?")) return json(response, { url: "https://artifacts.example.test/proof?signature=private", expiresAt: TIME });
      json(response, { ...agent, status: "IDLE" });
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl });
    expect(await client.getUsage(AGENT, { runId: RUN })).toEqual({ totalUsage: usage, runs: [{ id: RUN, usage }] });
    expect(await client.getArtifactDownloadUrl(AGENT, "artifacts/proof file.json")).toEqual({ url: "https://artifacts.example.test/proof?signature=private", expiresAt: TIME });
    expect((await client.getAgent(AGENT)).status).toBe("IDLE");
    expect(paths).toEqual([
      `/v1/agents/${AGENT}/usage?runId=${RUN}`,
      `/v1/agents/${AGENT}/artifacts/download?path=artifacts%2Fproof+file.json`,
      `/v1/agents/${AGENT}`,
    ]);
  });

  it("downloads only the qualified artifact host with no provider credentials and bounded binary bytes", async () => {
    const calls: Array<{ path: string; authorization?: string }> = [];
    const bytes = Buffer.from([0, 255, 0, 8, 127]);
    let host = "agent-stores.s3.us-east-1.amazonaws.com";
    const baseUrl = await serve((request, response) => {
      calls.push({ path: request.url!, authorization: request.headers.authorization });
      if (request.url?.includes("/artifacts/download?")) return json(response, { url: `https://${host}/proof?private-signature`, expiresAt: TIME });
      response.end(bytes);
    });
    const externalHeaders: HeadersInit[] = [];
    let unexpectedTargets = 0;
    const transport: typeof fetch = (input, init) => {
      const url = String(input);
      if (url.startsWith("https://agent-stores.s3.us-east-1.amazonaws.com/")) {
        externalHeaders.push(init?.headers ?? {});
        expect(init?.redirect).toBe("error");
        return fetch(`${baseUrl}/download`, init);
      }
      if (url.startsWith("https://")) { unexpectedTargets += 1; return Promise.reject(new TypeError("Unqualified test target")); }
      return fetch(input, init);
    };
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl, fetch: transport });
    expect(await client.downloadArtifact(AGENT, "proof.bin", { maxBytes: 5 })).toEqual(bytes);
    expect(externalHeaders).toEqual([{}]);
    expect(calls[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[1]?.authorization).toBeUndefined();
    const downloadError = await client.downloadArtifact(AGENT, "proof.bin", { maxBytes: 4 }).catch(error => error);
    expect(downloadError).toMatchObject({ code: "payload_too_large" });
    expect(isCursorCloudUnsentRequestError(downloadError)).toBe(false);
    const downloads = calls.filter(call => call.path === "/download").length;
    host = "cloud-agent-artifacts.s3.us-east-1.amazonaws.com";
    await expect(client.downloadArtifact(AGENT, "proof.bin")).rejects.toMatchObject({ code: "invalid_response" });
    host = "127.0.0.1";
    await expect(client.downloadArtifact(AGENT, "proof.bin")).rejects.toMatchObject({ code: "invalid_response" });
    expect(calls.filter(call => call.path === "/download")).toHaveLength(downloads);
    expect(unexpectedTargets).toBe(0);
    await expect(client.downloadArtifact(AGENT, "../../escape")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects conflicting identities, unknown statuses, and secret-shaped error codes", async () => {
    let attempt = 0;
    const baseUrl = await serve((_request, response) => {
      attempt += 1;
      if (attempt === 1) return json(response, { ...run, id: OTHER_RUN });
      if (attempt === 2) return json(response, { ...run, status: "UNRECOGNIZED" });
      json(response, { code: API_KEY, message: API_KEY }, 400);
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl });
    await expect(client.getRun(AGENT, RUN)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.getRun(AGENT, RUN)).rejects.toMatchObject({ code: "invalid_response" });
    const error = await client.getAgent(AGENT).catch(error => error);
    expect(error.providerCode).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it("bounds request and JSON response bytes before preserving their contents", async () => {
    let calls = 0;
    const baseUrl = await serve((_request, response) => { calls += 1; json(response, { items: ["x".repeat(1_024)] }); });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl, maxRequestBytes: 100, maxResponseBytes: 100 });
    const requestError = await client.createAgent({ prompt: { text: "x".repeat(200) } }).catch(error => error);
    expect(requestError).toMatchObject({ code: "payload_too_large" });
    expect(isCursorCloudUnsentRequestError(requestError)).toBe(true);
    expect(calls).toBe(0);
    const responseError = await client.listModels().catch(error => error);
    expect(responseError).toMatchObject({ code: "payload_too_large" });
    expect(isCursorCloudUnsentRequestError(responseError)).toBe(false);
    expect(isCursorCloudUnsentRequestError(new CursorCloudClientError("payload_too_large"))).toBe(false);
    expect(calls).toBe(1);
  });

  it("aborts actual HTTP work for deadlines and operator cancellation", async () => {
    let calls = 0;
    let signalReady: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { signalReady = resolve; });
    let signalClosed: (() => void) | undefined;
    const closed = new Promise<void>(resolve => { signalClosed = resolve; });
    const baseUrl = await serve((request, _response) => {
      calls += 1;
      if (calls === 2) {
        request.on("close", () => signalClosed?.());
        signalReady?.();
      }
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl, requestTimeoutMs: 35 });
    await expect(client.getAgent(AGENT)).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const pending = client.getAgent(AGENT, { signal: controller.signal, timeoutMs: 5_000 });
    await ready;
    controller.abort(new Error(`Do not retain ${API_KEY}`));
    const error = await pending.catch(error => error);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(String(error)).not.toContain(API_KEY);
    await closed;
    expect(calls).toBe(2);
  });

  it("rejects malformed IDs, credential URLs, header injection, and redirects before credential forwarding", async () => {
    let calls = 0;
    const baseUrl = await serve((_request, response) => { calls += 1; response.writeHead(307, { Location: "https://example.test/steal" }); response.end(); });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl });
    await expect(client.getAgent("bc-../../escape")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.createAgent({ prompt: { text: "task" } }, { idempotencyKey: "unsafe\r\nAuthorization: other" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toBe(0);
    await expect(client.getAgent(AGENT)).rejects.toBeInstanceOf(CursorCloudClientError);
    expect(calls).toBe(1);
    expect(() => new CursorCloudClient({ apiKey: API_KEY, baseUrl: "https://user:secret@example.test" })).toThrow(CursorCloudClientError);
    expect(() => new CursorCloudClient({ apiKey: API_KEY, baseUrl: "http://example.test" })).toThrow(CursorCloudClientError);
  });
});

describe("Cursor Cloud SSE wire protocol", () => {
  it("replays the opaque cursor and decodes fragmented UTF-8, CRLF, multiline data, and shared IDs", async () => {
    let replay: string | undefined;
    const baseUrl = await serve((request, response) => {
      replay = request.headers["last-event-id"] as string | undefined;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const bytes = Buffer.from(': heartbeat\r\nid: opaque/cursor-7\r\nevent: assistant\r\ndata: {"text":\r\ndata: "héllo 🌍"}\r\n\r\nid: opaque/cursor-7\nevent: interaction_update\ndata: {"type":"text-delta"}\n\nevent: done\ndata: {}\n\n');
      const split = bytes.indexOf(Buffer.from("🌍")) + 2;
      response.write(bytes.subarray(0, split));
      setImmediate(() => { response.write(bytes.subarray(split, split + 1)); setImmediate(() => response.end(bytes.subarray(split + 1))); });
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl });
    expect(await collect(client.streamRun(AGENT, RUN, { lastEventId: "previous-opaque" }))).toEqual([
      { event: "assistant", id: "opaque/cursor-7", data: { text: "héllo 🌍" } },
      { event: "interaction_update", id: "opaque/cursor-7", data: { type: "text-delta" } },
      { event: "done", data: {} },
    ]);
    expect(replay).toBe("previous-opaque");
  });

  it("cancels the wire reader when the consumer stops", async () => {
    let connectionClosed: (() => void) | undefined;
    const closed = new Promise<void>(resolve => { connectionClosed = resolve; });
    const baseUrl = await serve((request, response) => {
      request.once("close", () => connectionClosed?.());
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: status\ndata: {"status":"RUNNING"}\n\n');
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl });
    for await (const event of client.streamRun(AGENT, RUN)) { expect(event.event).toBe("status"); break; }
    await closed;
  });

  it("bounds an unterminated frame and settles an idle connection", async () => {
    let calls = 0;
    const baseUrl = await serve((_request, response) => {
      calls += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (calls === 1) response.end(`event: assistant\ndata: ${"x".repeat(200)}`);
      else response.flushHeaders();
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl, maxSseFrameBytes: 100 });
    const streamError = await collect(client.streamRun(AGENT, RUN)).catch(error => error);
    expect(streamError).toMatchObject({ code: "payload_too_large" });
    expect(isCursorCloudUnsentRequestError(streamError)).toBe(false);
    const idleClient = new CursorCloudClient({ apiKey: API_KEY, baseUrl, streamIdleTimeoutMs: 35 });
    await expect(collect(idleClient.streamRun(AGENT, RUN))).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects malformed JSON and preserves stream-expiry metadata without logging the body", async () => {
    let calls = 0;
    const baseUrl = await serve((_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`event: assistant\ndata: {${API_KEY}}\n\n`);
        return;
      }
      json(response, { error: { code: "stream_expired", message: API_KEY } }, 410);
    });
    const client = new CursorCloudClient({ apiKey: API_KEY, baseUrl });
    await expect(collect(client.streamRun(AGENT, RUN))).rejects.toMatchObject({ code: "invalid_response" });
    const error = await collect(client.streamRun(AGENT, RUN)).catch(error => error);
    expect(error).toMatchObject({ status: 410, providerCode: "stream_expired", retryable: false });
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });
});
