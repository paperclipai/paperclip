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

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleHealth(config: HelperConfig | null, res: ServerResponse) {
  if (!config) {
    send(res, 503, { error: "not configured" });
    return;
  }
  send(res, 200, {
    ok: true,
    version: "1",
    roots: config.roots,
  });
}

export async function createServer(options: CreateServerOptions): Promise<RunningServer> {
  const { config, port } = options;

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      handleHealth(config, res);
      return;
    }
    send(res, 404, { error: "not found" });
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
