import http from "node:http";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  execute as executeClaude,
  readClaudeAuthStatus,
} from "@paperclipai/adapter-claude-local/server";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntime,
  AdapterAgent,
} from "@paperclipai/adapter-utils";

type JsonRpcId = string | number;

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type ClaudeSdkServerOptions = {
  listenUrl: string;
  bearerToken?: string | null;
  executor?: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
  healthCheck?: () => Promise<Record<string, unknown>>;
  serverVersion?: string;
};

type ListenResult = {
  url: string;
  port: number;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseListenUrl(raw: string): URL {
  const parsed = new URL(raw);
  if (parsed.protocol !== "ws:") {
    throw new Error("Claude SDK bridge server currently listens with ws:// only. Terminate TLS in front of it if you need wss://.");
  }
  return parsed;
}

function authHeaderMatches(req: http.IncomingMessage, expectedBearerToken: string | null): boolean {
  if (!expectedBearerToken) return true;
  const authorization = req.headers.authorization;
  return typeof authorization === "string" && authorization === `Bearer ${expectedBearerToken}`;
}

function createJsonRpcError(id: JsonRpcId | null, message: string, code = -32000) {
  return JSON.stringify({
    jsonrpc: "2.0",
    ...(id !== null ? { id } : {}),
    error: { code, message },
  });
}

function createJsonRpcResult(id: JsonRpcId, result: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendNotification(ws: WebSocket, method: string, params: unknown) {
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }),
  );
}

async function defaultHealthCheck() {
  const authStatus = await readClaudeAuthStatus();
  const authConfigured =
    Boolean(nonEmpty(process.env.ANTHROPIC_API_KEY)) ||
    Boolean(nonEmpty(process.env.ANTHROPIC_BEDROCK_BASE_URL)) ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    authStatus?.loggedIn === true;

  return {
    bridge: "paperclip-claude-sdk-server",
    authConfigured,
    authMethod: authStatus?.authMethod ?? null,
    subscriptionType: authStatus?.subscriptionType ?? null,
  };
}

function parseAgent(value: unknown): AdapterAgent {
  const record = asRecord(value) ?? {};
  return {
    id: nonEmpty(record.id) ?? "",
    companyId: nonEmpty(record.companyId) ?? "",
    name: nonEmpty(record.name) ?? "Claude Bridge Agent",
    adapterType: nonEmpty(record.adapterType) ?? "claude_local",
    adapterConfig: asRecord(record.adapterConfig) ?? {},
  };
}

function parseRuntime(value: unknown): AdapterRuntime {
  const record = asRecord(value) ?? {};
  return {
    sessionId: nonEmpty(record.sessionId),
    sessionParams: asRecord(record.sessionParams),
    sessionDisplayId: nonEmpty(record.sessionDisplayId),
    taskKey: nonEmpty(record.taskKey),
  };
}

export function createClaudeSdkServer(options: ClaudeSdkServerOptions) {
  const listenUrl = parseListenUrl(options.listenUrl);
  const expectedPath = listenUrl.pathname === "/" ? null : listenUrl.pathname;
  const expectedBearerToken = nonEmpty(options.bearerToken);
  const executor = options.executor ?? executeClaude;
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  const serverVersion = nonEmpty(options.serverVersion) ?? "0.1.0";

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      void healthCheck()
        .then((result) => {
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "health check failed" }));
        });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url ? new URL(req.url, "ws://localhost") : null;
    if (expectedPath && requestUrl?.pathname !== expectedPath) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!authHeaderMatches(req, expectedBearerToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      void handleMessage(ws, raw.toString("utf8"));
    });
  });

  async function handleMessage(ws: WebSocket, raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ws.send(createJsonRpcError(null, "Invalid JSON"));
      return;
    }

    const request = asRecord(parsed) as JsonRpcRequest | null;
    if (!request || request.id === undefined || typeof request.method !== "string") return;

    try {
      switch (request.method) {
        case "initialize":
          ws.send(
            createJsonRpcResult(request.id, {
              serverInfo: {
                name: "paperclip-claude-sdk-server",
                version: serverVersion,
              },
            }),
          );
          return;
        case "health/check": {
          const result = await healthCheck();
          ws.send(createJsonRpcResult(request.id, result));
          return;
        }
        case "run/execute": {
          const params = asRecord(request.params) ?? {};
          const ctx: AdapterExecutionContext = {
            runId: nonEmpty(params.runId) ?? "",
            agent: parseAgent(params.agent),
            runtime: parseRuntime(params.runtime),
            config: asRecord(params.config) ?? {},
            context: asRecord(params.context) ?? {},
            authToken: nonEmpty(params.authToken) ?? undefined,
            onLog: async (stream, chunk) => {
              sendNotification(ws, "run/log", {
                runId: nonEmpty(params.runId),
                stream,
                chunk,
              });
            },
            onSpawn: async (meta) => {
              sendNotification(ws, "run/spawn", {
                runId: nonEmpty(params.runId),
                ...meta,
              });
            },
          };
          const result = await executor(ctx);
          ws.send(createJsonRpcResult(request.id, result));
          return;
        }
        default:
          ws.send(createJsonRpcError(request.id, `Unsupported method: ${request.method}`, -32601));
      }
    } catch (err) {
      ws.send(createJsonRpcError(request.id, err instanceof Error ? err.message : "request failed"));
    }
  }

  async function listen(): Promise<ListenResult> {
    const hostname = listenUrl.hostname || "127.0.0.1";
    const port = listenUrl.port ? Number.parseInt(listenUrl.port, 10) : 0;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, hostname, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const actualUrl = new URL(options.listenUrl);
    actualUrl.hostname = hostname;
    actualUrl.port = String(address.port);
    return { url: actualUrl.toString(), port: address.port };
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    server,
    wss,
    listen,
    close,
  };
}

export async function readBearerTokenFromFile(pathname: string): Promise<string> {
  const token = (await fs.readFile(pathname, "utf8")).trim();
  if (!token) throw new Error(`Token file ${pathname} is empty`);
  return token;
}
