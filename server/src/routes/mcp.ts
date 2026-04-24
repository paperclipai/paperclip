import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  StreamableHTTPServerTransport,
  createPaperclipMcpServer,
  isInitializeRequest,
  type PaperclipMcpConfig,
} from "@paperclipai/mcp-server";

type McpSession = {
  server: Awaited<ReturnType<typeof createPaperclipMcpServer>>["server"];
  transport: StreamableHTTPServerTransport;
};

function readOptionalHeader(req: Request, name: string): string | null {
  const value = req.header(name)?.trim();
  return value ? value : null;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function buildInternalApiUrl(serverPort: number, bindHost: string): string {
  const normalizedHost = bindHost.trim().toLowerCase();
  const internalHost =
    normalizedHost === "0.0.0.0"
      ? "127.0.0.1"
      : normalizedHost === "::"
        ? "::1"
        : bindHost.trim() || "127.0.0.1";
  return `http://${formatHostForUrl(internalHost)}:${serverPort}/api`;
}

export function buildPaperclipMcpConfig(req: Request, serverPort: number, bindHost: string): PaperclipMcpConfig {
  const cookie = readOptionalHeader(req, "cookie");
  const companyId =
    readOptionalHeader(req, "x-paperclip-company-id") ??
    (req.actor.type === "agent" ? req.actor.companyId ?? null : null);
  const agentId =
    readOptionalHeader(req, "x-paperclip-agent-id") ??
    (req.actor.type === "agent" ? req.actor.agentId ?? null : null);
  const runId = readOptionalHeader(req, "x-paperclip-run-id") ?? req.actor.runId ?? null;

  return {
    apiUrl: buildInternalApiUrl(serverPort, bindHost),
    apiKey: "",
    authHeader: readOptionalHeader(req, "authorization") ?? undefined,
    companyId,
    agentId,
    runId,
    requestHeaders: cookie ? { Cookie: cookie } : undefined,
  };
}

function readSessionId(req: Request): string | null {
  const sessionId = req.header("mcp-session-id")?.trim();
  return sessionId ? sessionId : null;
}

function sendBadRequest(res: Response, message: string) {
  res.status(400).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

export function mcpRoutes(opts: { serverPort: number; bindHost: string }) {
  const router = Router();
  const sessions = new Map<string, McpSession>();

  async function createSession(req: Request) {
    const config = buildPaperclipMcpConfig(req, opts.serverPort, opts.bindHost);
    const { server } = createPaperclipMcpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport });
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        sessions.delete(sessionId);
      }
      void server.close().catch(() => {});
    };

    await server.connect(transport);
    return { server, transport };
  }

  async function ensureAuthenticated(req: Request, res: Response): Promise<boolean> {
    if (req.actor.type !== "none") return true;
    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  router.post("/", async (req, res) => {
    if (!(await ensureAuthenticated(req, res))) return;

    const sessionId = readSessionId(req);
    try {
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          sendBadRequest(res, "Bad Request: Invalid session ID");
          return;
        }
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        sendBadRequest(res, "Bad Request: No valid session ID provided");
        return;
      }

      const created = await createSession(req);
      await created.transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  router.get("/", async (req, res) => {
    if (!(await ensureAuthenticated(req, res))) return;

    const sessionId = readSessionId(req);
    if (!sessionId) {
      sendBadRequest(res, "Bad Request: Missing session ID");
      return;
    }
    const existing = sessions.get(sessionId);
    if (!existing) {
      sendBadRequest(res, "Bad Request: Invalid session ID");
      return;
    }
    await existing.transport.handleRequest(req, res);
  });

  router.delete("/", async (req, res) => {
    if (!(await ensureAuthenticated(req, res))) return;

    const sessionId = readSessionId(req);
    if (!sessionId) {
      sendBadRequest(res, "Bad Request: Missing session ID");
      return;
    }
    const existing = sessions.get(sessionId);
    if (!existing) {
      sendBadRequest(res, "Bad Request: Invalid session ID");
      return;
    }
    await existing.transport.handleRequest(req, res);
  });

  return router;
}
