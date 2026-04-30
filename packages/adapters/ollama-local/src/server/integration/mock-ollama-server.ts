import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Minimal mock of the subset of the Ollama HTTP API that the adapter
 * exercises. Each handler receives the parsed JSON body (for POST routes)
 * and must finish the response itself. A test can register:
 *   - `version`: handler for `GET /api/version`
 *   - `tags`:    handler for `GET /api/tags`
 *   - `chat`:    handler for `POST /api/chat`
 *
 * Handlers that are not registered return HTTP 404 so tests surface
 * unexpected traffic rather than hanging.
 */
export interface MockHandlers {
  version?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  tags?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  chat?: (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>;
}

export interface MockOllamaServer {
  baseUrl: string;
  port: number;
  /** Requests observed during the server's lifetime (newest last). */
  requests: Array<{ method: string; url: string; body: unknown }>;
  /** Close the server and wait until all sockets are released. */
  close: () => Promise<void>;
}

/**
 * Boot a mock Ollama server on an ephemeral port.
 */
export async function startMockOllama(handlers: MockHandlers = {}): Promise<MockOllamaServer> {
  const requests: MockOllamaServer["requests"] = [];
  const sockets = new Set<import("node:net").Socket>();

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    await new Promise<void>((resolve) => req.on("end", () => resolve()));

    let body: unknown = null;
    if (chunks.length > 0) {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
    }
    requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });

    const url = req.url ?? "";
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && url.startsWith("/api/version") && handlers.version) {
        await handlers.version(req, res);
        return;
      }
      if (method === "GET" && url.startsWith("/api/tags") && handlers.tags) {
        await handlers.tags(req, res);
        return;
      }
      if (method === "POST" && url.startsWith("/api/chat") && handlers.chat) {
        await handlers.chat(req, res, body);
        return;
      }
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `mock: route ${method} ${url} not registered` }));
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const s of sockets) {
          try {
            s.destroy();
          } catch {
            // ignore
          }
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Write a sequence of NDJSON frames onto the response with small awaits
 * between chunks so tests can observe streaming behaviour on the client.
 * Defaults to a tiny delay to avoid making the socket flush pathologically
 * slow in CI.
 */
export async function writeNdjsonFrames(
  res: ServerResponse,
  frames: unknown[],
  options: { delayMs?: number; finalChunkSeparately?: boolean } = {},
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson");
  const delay = options.delayMs ?? 0;
  for (const frame of frames) {
    res.write(`${JSON.stringify(frame)}\n`);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  res.end();
}

/**
 * Write a single NDJSON line but split across multiple TCP writes so the
 * client parser must reassemble fragments.
 */
export async function writeSplitNdjsonFrame(
  res: ServerResponse,
  frame: unknown,
  pieces: number,
): Promise<void> {
  const line = `${JSON.stringify(frame)}\n`;
  const chunkSize = Math.max(1, Math.ceil(line.length / Math.max(1, pieces)));
  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson");
  for (let i = 0; i < line.length; i += chunkSize) {
    res.write(line.slice(i, i + chunkSize));
    await new Promise((r) => setImmediate(r));
  }
  res.end();
}
