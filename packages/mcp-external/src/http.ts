#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.js";
import { readConfigFromEnv, normalizeApiUrl, type PaperclipExternalConfig } from "./config.js";
import { runWithBearer } from "./auth-context.js";

const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MCP_PORT ?? "9011");
const MCP_PATH = "/mcp";

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createHttpServer(config: PaperclipExternalConfig = readConfigFromEnv()) {
  // Idempotent: readConfigFromEnv() already normalizes, but direct/programmatic
  // callers (tests) may pass an unnormalized apiUrl — normalize here too.
  config = { ...config, apiUrl: normalizeApiUrl(config.apiUrl) };
  // One transport per active session id (stateful streamable-HTTP).
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    // Capture the inbound bearer for the WHOLE request lifecycle.
    const bearer = req.headers.authorization ?? null;
    await runWithBearer(bearer, async () => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      const body = req.method === "POST" ? await readBody(req) : undefined;

      if (!transport) {
        const isInit = req.method === "POST" && isInitializeRequest(body);
        if (!isInit) {
          // A request carrying a session id we don't recognize (e.g. after a
          // pod restart / rollout dropped the in-memory session) MUST get 404,
          // per the streamable-HTTP spec, so the MCP client starts a fresh
          // session by re-initializing. FastMCP (the Python server) does this;
          // returning 400 here wedged every pre-existing client across a flip.
          if (sessionId) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found; reinitialize." }, id: null }));
            return;
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first." }, id: null }));
          return;
        }
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string): void => { transports.set(sid, created); },
        });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        const { server } = createMcpServer(config);
        await server.connect(created);
        transport = created;
      }
      await transport!.handleRequest(req, res, body);
    });
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      console.error("mcp-external request error:", err);
      if (res.headersSent) return;
      const status: number = (err && typeof err === "object" && "status" in err && typeof (err as any).status === "number") ? (err as any).status : 500;
      const code = status === 413 ? -32000 : err instanceof SyntaxError ? -32700 : -32603;
      const message = status === 413 ? "Request body too large" : err instanceof SyntaxError ? "Parse error" : "internal error";
      res.writeHead(status === 500 && err instanceof SyntaxError ? 400 : status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createHttpServer();
  server.listen(PORT, HOST, () => {
    console.error(`paperclip mcp-external listening on http://${HOST}:${PORT}${MCP_PATH}`);
  });
}
