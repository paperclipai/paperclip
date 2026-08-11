import { once } from "node:events";
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

class RequestBodyTooLargeError extends Error {}

export interface OpenCodeRuntimeMcpRelay {
  name: string;
  connectionId: string;
  url: string;
  stop(): Promise<void>;
}

export type OpenCodeRuntimeMcpRelayStarter = (
  server: AdapterRuntimeMcpServer,
) => Promise<OpenCodeRuntimeMcpRelay>;

function validateRuntimeMcpServer(server: AdapterRuntimeMcpServer): void {
  const upstream = new URL(server.url);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`Runtime MCP server "${server.name}" must use HTTP or HTTPS.`);
  }
  if (!server.token.trim()) {
    throw new Error(`Runtime MCP server "${server.name}" is missing its run token.`);
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const method = request.method?.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "DELETE") return undefined;

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function buildUpstreamHeaders(request: IncomingMessage, token: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      STRIPPED_REQUEST_HEADERS.has(normalizedName) ||
      normalizedName === "forwarded" ||
      normalizedName.startsWith("x-forwarded-") ||
      normalizedName.startsWith("x-paperclip-") ||
      value === undefined
    ) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function forwardResponseHeaders(upstream: Response, response: ServerResponse): void {
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
  });
}

async function proxyRuntimeMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamUrl: URL,
  token: string,
  relayPath: string,
  signal: AbortSignal,
): Promise<void> {
  const callerAbortController = new AbortController();
  const abortOnDisconnect = () => callerAbortController.abort();
  request.once("aborted", abortOnDisconnect);
  response.once("close", abortOnDisconnect);
  try {
    const localUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (localUrl.pathname !== relayPath) {
      response.writeHead(404).end();
      return;
    }

    const method = request.method?.toUpperCase() ?? "GET";
    if (!new Set(["GET", "POST", "DELETE"]).has(method)) {
      response.writeHead(405, { allow: "GET, POST, DELETE" }).end();
      return;
    }

    const target = new URL(upstreamUrl);
    localUrl.searchParams.forEach((value, name) => target.searchParams.append(name, value));
    const body = await readRequestBody(request);
    const upstream = await fetch(target, {
      method,
      headers: buildUpstreamHeaders(request, token),
      body: body ? Uint8Array.from(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.any([signal, callerAbortController.signal]),
    });
    response.statusCode = upstream.status;
    forwardResponseHeaders(upstream, response);
    if (!upstream.body) {
      response.end();
      return;
    }
    for await (const chunk of upstream.body) {
      if (response.destroyed) break;
      if (!response.write(Buffer.from(chunk)) && !response.destroyed) {
        await once(response, "drain");
      }
    }
    if (!response.destroyed) response.end();
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof RequestBodyTooLargeError) {
      response.writeHead(413).end();
      return;
    }
    response.writeHead(502).end();
  } finally {
    request.off("aborted", abortOnDisconnect);
    response.off("close", abortOnDisconnect);
  }
}

export async function startOpenCodeRuntimeMcpRelay(
  runtimeServer: AdapterRuntimeMcpServer,
): Promise<OpenCodeRuntimeMcpRelay> {
  validateRuntimeMcpServer(runtimeServer);
  const upstreamUrl = new URL(runtimeServer.url);
  const relayPath = `/mcp/${randomBytes(24).toString("base64url")}`;
  const abortController = new AbortController();
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    void proxyRuntimeMcpRequest(
      request,
      response,
      upstreamUrl,
      runtimeServer.token,
      relayPath,
      abortController.signal,
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new Error(`Failed to start runtime MCP relay for "${runtimeServer.name}".`));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error(`Failed to resolve runtime MCP relay address for "${runtimeServer.name}".`);
  }

  let stopped = false;
  return {
    name: runtimeServer.name,
    connectionId: runtimeServer.connectionId,
    url: `http://127.0.0.1:${address.port}${relayPath}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      abortController.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

export async function startOpenCodeRuntimeMcpRelays(
  runtimeServers: AdapterRuntimeMcpServer[],
  startRelay: OpenCodeRuntimeMcpRelayStarter = startOpenCodeRuntimeMcpRelay,
): Promise<OpenCodeRuntimeMcpRelay[]> {
  for (const server of runtimeServers) validateRuntimeMcpServer(server);
  const relays: OpenCodeRuntimeMcpRelay[] = [];
  try {
    for (const server of runtimeServers) relays.push(await startRelay(server));
    return relays;
  } catch (error) {
    await Promise.allSettled(relays.map((relay) => relay.stop()));
    throw error;
  }
}
