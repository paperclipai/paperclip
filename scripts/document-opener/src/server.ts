import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HelperConfig } from "./config.js";

export interface RunningServer {
  server: Server;
  close: () => Promise<void>;
}

export interface CreateServerOptions {
  config: HelperConfig | null;
  port: number;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // server-to-server, allow
  if (!allowedOrigins.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
}

function handlePreflight(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "origin not allowed" }));
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.writeHead(204);
  res.end();
}

function handleHealth(config: HelperConfig | null, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json");
  if (!config) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "not configured" }));
    return;
  }
  res.writeHead(200);
  res.end(JSON.stringify({
    ok: true,
    version: "1",
    roots: config.roots,
  }));
}

export async function createServer(options: CreateServerOptions): Promise<RunningServer> {
  const { config, port } = options;
  const allowedOrigins = config?.allowedOrigins ?? [];

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      handlePreflight(req, res, allowedOrigins);
      return;
    }

    // Apply CORS headers for non-preflight cross-origin responses
    if (!applyCorsHeaders(req, res, allowedOrigins)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "origin not allowed" }));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      handleHealth(config, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
