import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  resolveIssueVisibility,
  assertIssueVisible,
  type IssueVisibility,
} from "../services/issue-visibility.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  /**
   * For the board (human) actor path: true if the upgrade was authorized via
   * the local_trusted implicit board fallback (no real authenticated user).
   * Local-implicit board users bypass issue-visibility scoping.
   */
  isLocalImplicit?: boolean;
  /**
   * For the board actor path: true if the resolved user has the
   * `instance_admin` role and therefore bypasses issue-visibility scoping.
   */
  isInstanceAdmin?: boolean;
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Adapts a WS UpgradeContext into the `Request["actor"]` shape that
 * `resolveIssueVisibility` consumes. The visibility resolver only inspects
 * `type`, `source`, `isInstanceAdmin`, and `userId`, so we just provide
 * those four fields.
 */
function buildActorForVisibility(context: {
  actorType: "board" | "agent";
  actorId: string;
  isLocalImplicit?: boolean;
  isInstanceAdmin?: boolean;
}): Parameters<typeof resolveIssueVisibility>[2] {
  if (context.actorType === "agent") {
    return {
      type: "agent",
      agentId: context.actorId,
      source: "agent_jwt",
    } as Parameters<typeof resolveIssueVisibility>[2];
  }
  return {
    type: "board",
    userId: context.actorId,
    source: context.isLocalImplicit ? "local_implicit" : "session",
    isInstanceAdmin: Boolean(context.isInstanceAdmin),
  } as Parameters<typeof resolveIssueVisibility>[2];
}

/**
 * Extracts an `issueId` from a live event payload when the event references
 * a specific issue. Returns `null` for events that aren't issue-scoped
 * (those are always delivered).
 */
function readIssueIdFromEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const payload = (event as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = (payload as { issueId?: unknown; entityId?: unknown; entityType?: unknown });
  if (typeof candidate.issueId === "string" && candidate.issueId.length > 0) {
    return candidate.issueId;
  }
  // For activity.logged-shaped events the issue id lives under entityId when
  // entityType === "issue".
  if (
    candidate.entityType === "issue"
    && typeof candidate.entityId === "string"
    && candidate.entityId.length > 0
  ) {
    return candidate.entityId;
  }
  return null;
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
        isLocalImplicit: true,
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    const hasCompanyMembership = memberships.some((row) => row.companyId === companyId);
    if (!roleRow && !hasCompanyMembership) return null;

    return {
      companyId,
      actorType: "board",
      actorId: userId,
      isInstanceAdmin: Boolean(roleRow),
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key || key.companyId !== companyId) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
  };
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30000);

  wss.on("connection", async (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const subscriberCompanyId = context.companyId;
    // Resolve the subscriber's issue visibility once per connection. Agents,
    // local-implicit board users, and instance admins all collapse to
    // {mode:"all"} and skip per-event filtering on the hot path.
    const subscriberVisibility: IssueVisibility = await resolveIssueVisibility(
      db,
      subscriberCompanyId,
      buildActorForVisibility(context),
    );
    const visibilityCache = new Map<string, { visible: boolean; expiresAt: number }>();
    const VISIBILITY_CACHE_TTL_MS = 30_000;
    const VISIBILITY_CACHE_MAX_ENTRIES = 500;

    async function shouldDeliverIssueEvent(issueId: string): Promise<boolean> {
      if (subscriberVisibility.mode === "all") return true;
      const cached = visibilityCache.get(issueId);
      const now = Date.now();
      if (cached && cached.expiresAt > now) return cached.visible;
      try {
        await assertIssueVisible(db, subscriberCompanyId, issueId, subscriberVisibility);
        visibilityCache.set(issueId, { visible: true, expiresAt: now + VISIBILITY_CACHE_TTL_MS });
        if (visibilityCache.size > VISIBILITY_CACHE_MAX_ENTRIES) {
          // Cheap LRU-ish prune: drop oldest 20% of entries by insertion order.
          const prune = Math.ceil(VISIBILITY_CACHE_MAX_ENTRIES * 0.2);
          let i = 0;
          for (const key of visibilityCache.keys()) {
            if (i++ >= prune) break;
            visibilityCache.delete(key);
          }
        }
        return true;
      } catch {
        visibilityCache.set(issueId, { visible: false, expiresAt: now + VISIBILITY_CACHE_TTL_MS });
        return false;
      }
    }

    const unsubscribe = subscribeCompanyLiveEvents(subscriberCompanyId, async (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (subscriberVisibility.mode === "scoped") {
        const issueId = readIssueIdFromEvent(event);
        if (issueId && !(await shouldDeliverIssueEvent(issueId))) return;
      }
      socket.send(JSON.stringify(event));
    });

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      socket.destroy();
      return;
    }

    void authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = context;

        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
