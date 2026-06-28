import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaperclipApiClient } from "./client.js";
import { createHeartbeatRunSubscriptions, type HeartbeatRunSnapshot } from "./resource-subscriptions.js";

const HEARTBEAT_RUN_SCHEME = "paperclip:";
const HEARTBEAT_RUN_HOST = "heartbeat-runs";
const DEFAULT_LOG_CHUNK_LIMIT_BYTES = 16_384;
const DEFAULT_EVENT_LIMIT = 200;

function jsonContents(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function parseHeartbeatRunUri(uri: string): { runId: string; suffix: string[]; url: URL } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== HEARTBEAT_RUN_SCHEME || url.hostname !== HEARTBEAT_RUN_HOST) return null;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [runId, ...suffix] = parts;
  if (!runId) return null;
  return { runId, suffix, url };
}

function clampPositiveInt(raw: string | null, fallback: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function clampOffset(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function heartbeatRunResourceUris(runId: string) {
  return {
    run: `paperclip://heartbeat-runs/${encodeURIComponent(runId)}`,
    log: `paperclip://heartbeat-runs/${encodeURIComponent(runId)}/log`,
    logChunks: (offset: number, limitBytes = DEFAULT_LOG_CHUNK_LIMIT_BYTES) =>
      `paperclip://heartbeat-runs/${encodeURIComponent(runId)}/log-chunks/${offset}?limitBytes=${limitBytes}`,
    events: (afterSeq = 0, limit = DEFAULT_EVENT_LIMIT) =>
      `paperclip://heartbeat-runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}&limit=${limit}`,
    issues: `paperclip://heartbeat-runs/${encodeURIComponent(runId)}/issues`,
  };
}

async function readHeartbeatRunResource(client: PaperclipApiClient, uri: string): Promise<unknown> {
  const parsed = parseHeartbeatRunUri(uri);
  if (!parsed) throw new Error(`Unsupported heartbeat run resource URI: ${uri}`);
  const runId = encodeURIComponent(parsed.runId);
  const [kind, arg] = parsed.suffix;

  if (!kind) {
    return client.requestJson("GET", `/heartbeat-runs/${runId}`);
  }
  if (kind === "log" && parsed.suffix.length === 1) {
    const run = await client.requestJson<HeartbeatRunSnapshot>("GET", `/heartbeat-runs/${runId}`);
    return {
      runId: parsed.runId,
      logBytes: run.logBytes ?? 0,
      lastOutputSeq: run.lastOutputSeq ?? null,
      lastOutputAt: run.lastOutputAt ?? null,
      status: run.status ?? null,
      chunks: heartbeatRunResourceUris(parsed.runId).logChunks(run.logBytes ?? 0),
    };
  }
  if (kind === "log-chunks" && arg !== undefined) {
    const offset = clampOffset(arg);
    const limitBytes = clampPositiveInt(parsed.url.searchParams.get("limitBytes"), DEFAULT_LOG_CHUNK_LIMIT_BYTES, 256_000);
    return client.requestJson("GET", `/heartbeat-runs/${runId}/log?offset=${offset}&limitBytes=${limitBytes}`);
  }
  if (kind === "events" && parsed.suffix.length === 1) {
    const afterSeq = clampOffset(parsed.url.searchParams.get("afterSeq") ?? "0");
    const limit = clampPositiveInt(parsed.url.searchParams.get("limit"), DEFAULT_EVENT_LIMIT, 1_000);
    return client.requestJson("GET", `/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`);
  }
  if (kind === "issues" && parsed.suffix.length === 1) {
    return client.requestJson("GET", `/heartbeat-runs/${runId}/issues`);
  }
  throw new Error(`Unsupported heartbeat run resource URI: ${uri}`);
}

async function readSubscriptionSnapshot(client: PaperclipApiClient, uri: string): Promise<HeartbeatRunSnapshot | null> {
  const parsed = parseHeartbeatRunUri(uri);
  if (!parsed) return null;
  return client.requestJson<HeartbeatRunSnapshot>("GET", `/heartbeat-runs/${encodeURIComponent(parsed.runId)}`);
}

export function registerHeartbeatRunResources(server: McpServer, client: PaperclipApiClient) {
  const subscriptions = createHeartbeatRunSubscriptions({
    server,
    readSnapshot: (uri) => readSubscriptionSnapshot(client, uri),
  });

  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    subscriptions.close();
    previousOnClose?.();
  };

  server.registerResource(
    "paperclip-heartbeat-run",
    new ResourceTemplate("paperclip://heartbeat-runs/{runId}", { list: undefined }),
    { title: "Paperclip heartbeat run metadata", mimeType: "application/json" },
    async (uri) => jsonContents(uri.toString(), await readHeartbeatRunResource(client, uri.toString())),
  );
  server.registerResource(
    "paperclip-heartbeat-run-log",
    new ResourceTemplate("paperclip://heartbeat-runs/{runId}/log", { list: undefined }),
    { title: "Paperclip heartbeat run log metadata", mimeType: "application/json" },
    async (uri) => jsonContents(uri.toString(), await readHeartbeatRunResource(client, uri.toString())),
  );
  server.registerResource(
    "paperclip-heartbeat-run-log-chunk",
    new ResourceTemplate("paperclip://heartbeat-runs/{runId}/log-chunks/{offset}{?limitBytes}", { list: undefined }),
    { title: "Paperclip heartbeat run log chunk", mimeType: "application/json" },
    async (uri) => jsonContents(uri.toString(), await readHeartbeatRunResource(client, uri.toString())),
  );
  server.registerResource(
    "paperclip-heartbeat-run-events",
    new ResourceTemplate("paperclip://heartbeat-runs/{runId}/events{?afterSeq,limit}", { list: undefined }),
    { title: "Paperclip heartbeat run events", mimeType: "application/json" },
    async (uri) => jsonContents(uri.toString(), await readHeartbeatRunResource(client, uri.toString())),
  );
  server.registerResource(
    "paperclip-heartbeat-run-issues",
    new ResourceTemplate("paperclip://heartbeat-runs/{runId}/issues", { list: undefined }),
    { title: "Paperclip issues touched by a heartbeat run", mimeType: "application/json" },
    async (uri) => jsonContents(uri.toString(), await readHeartbeatRunResource(client, uri.toString())),
  );

  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    await subscriptions.subscribe(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.unsubscribe(request.params.uri);
    return {};
  });
}
