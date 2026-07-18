import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createKvDemoMcpServer } from "./index.js";
import { renderStatePage } from "./render.js";
import { KvStore, type KvStateSnapshot } from "./store.js";

export interface KvDemoHttpOptions {
  store?: KvStore;
  /** Optional shared secret required on every route when provided. */
  token?: string | null;
}

export interface KvDemoHttpServer {
  server: Server;
  store: KvStore;
  /** Resolves to the bound port once listening. */
  listen: (port: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
}

const MCP_PATH = "/mcp";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: KvStore,
): Promise<void> {
  // Stateless: a fresh MCP server + transport per request. The shared store is
  // what carries state between calls, so no session bookkeeping is needed.
  let parsedBody: unknown;
  try {
    parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
  } catch (error) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: error instanceof Error ? error.message : "Parse error" },
      id: null,
    });
    return;
  }

  const { server } = createKvDemoMcpServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export function createKvDemoHttpServer(options: KvDemoHttpOptions = {}): KvDemoHttpServer {
  const store = options.store ?? new KvStore();
  const requiredToken = options.token?.trim() || null;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          const snapshot = requiredToken
            ? { entries: [], count: 0, revision: 0 }
            : store.snapshot();
          sendHtml(res, 200, renderStatePage(snapshot, { tokenRequired: Boolean(requiredToken) }));
          return;
        }

        if (requiredToken && presentedToken(req) !== requiredToken) {
          sendJson(res, 401, { error: "Unauthorized. Provide the KV_DEMO_TOKEN." });
          return;
        }

        if (url.pathname === MCP_PATH) {
          await handleMcp(req, res, store);
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/state") {
          const snapshot: KvStateSnapshot = store.snapshot();
          sendJson(res, 200, snapshot);
          return;
        }

        sendJson(res, 404, { error: "Not found." });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal error." });
        } else {
          res.end();
        }
      }
    })();
  });

  return {
    server,
    store,
    listen: (port, host = "127.0.0.1") =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
