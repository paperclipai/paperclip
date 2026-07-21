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
  timeout: ReturnType<typeof setTimeout>;
  actorFingerprint: string;
};

export const MCP_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const MCP_MAX_SESSIONS = 100;

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
  sendJsonRpcError(res, 400, -32000, message);
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code,
      message,
    },
    id: null,
  });
}

function sendInternalError(res: Response, error: unknown) {
  if (res.headersSent) return;
  sendJsonRpcError(
    res,
    500,
    -32603,
    error instanceof Error ? error.message : "Internal server error",
  );
}

function actorFingerprint(actor: Request["actor"]): string {
  if (actor.type === "board") {
    return JSON.stringify({
      type: actor.type,
      userId: actor.userId ?? null,
      source: actor.source ?? null,
      keyId: actor.keyId ?? null,
    });
  }
  if (actor.type === "agent") {
    return JSON.stringify({
      type: actor.type,
      agentId: actor.agentId ?? null,
      companyId: actor.companyId ?? null,
      source: actor.source ?? null,
      keyId: actor.keyId ?? null,
    });
  }
  return JSON.stringify({ type: actor.type });
}

export function mcpRoutes(opts: {
  serverPort: number;
  bindHost: string;
  sessionIdleTimeoutMs?: number;
  maxSessions?: number;
}) {
  const router = Router();
  const sessions = new Map<string, McpSession>();
  const sessionIdleTimeoutMs = opts.sessionIdleTimeoutMs ?? MCP_SESSION_IDLE_TIMEOUT_MS;
  const maxSessions = opts.maxSessions ?? MCP_MAX_SESSIONS;

  function removeSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    clearTimeout(session.timeout);
    void session.server.close().catch(() => {});
  }

  function scheduleSessionTimeout(sessionId: string) {
    const timeout = setTimeout(() => {
      removeSession(sessionId);
    }, sessionIdleTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  function touchSession(sessionId: string, session: McpSession) {
    clearTimeout(session.timeout);
    session.timeout = scheduleSessionTimeout(sessionId);
    sessions.delete(sessionId);
    sessions.set(sessionId, session);
  }

  function enforceSessionLimit() {
    while (sessions.size >= maxSessions) {
      const oldestSessionId = sessions.keys().next().value as string | undefined;
      if (!oldestSessionId) break;
      removeSession(oldestSessionId);
    }
  }

  function lookupSession(req: Request, res: Response, sessionId: string): McpSession | null {
    const existing = sessions.get(sessionId);
    if (!existing) {
      sendBadRequest(res, "Bad Request: Invalid session ID");
      return null;
    }
    if (existing.actorFingerprint !== actorFingerprint(req.actor)) {
      sendJsonRpcError(res, 403, -32001, "Forbidden: MCP session belongs to a different actor");
      return null;
    }
    return existing;
  }

  async function createSession(req: Request) {
    const config = buildPaperclipMcpConfig(req, opts.serverPort, opts.bindHost);
    const { server } = createPaperclipMcpServer(config);
    const sessionActorFingerprint = actorFingerprint(req.actor);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          server,
          transport,
          timeout: scheduleSessionTimeout(sessionId),
          actorFingerprint: sessionActorFingerprint,
        });
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        removeSession(sessionId);
      }
    };

    enforceSessionLimit();
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
        const existing = lookupSession(req, res, sessionId);
        if (!existing) return;
        touchSession(sessionId, existing);
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
      sendInternalError(res, error);
    }
  });

  router.get("/", async (req, res) => {
    if (!(await ensureAuthenticated(req, res))) return;

    const sessionId = readSessionId(req);
    if (!sessionId) {
      sendBadRequest(res, "Bad Request: Missing session ID");
      return;
    }
    try {
      const existing = lookupSession(req, res, sessionId);
      if (!existing) return;
      touchSession(sessionId, existing);
      await existing.transport.handleRequest(req, res);
    } catch (error) {
      sendInternalError(res, error);
    }
  });

  router.delete("/", async (req, res) => {
    if (!(await ensureAuthenticated(req, res))) return;

    const sessionId = readSessionId(req);
    if (!sessionId) {
      sendBadRequest(res, "Bad Request: Missing session ID");
      return;
    }
    try {
      const existing = lookupSession(req, res, sessionId);
      if (!existing) return;
      await existing.transport.handleRequest(req, res);
      removeSession(sessionId);
    } catch (error) {
      sendInternalError(res, error);
    }
  });

  return router;
}
