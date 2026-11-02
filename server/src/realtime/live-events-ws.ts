import { createLiveEventDelivery } from "./live-event-delivery.js";
import { skillAccessService } from "../services/skill-access.js";
import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, companyMemberships, instanceUserRoles, heartbeatRuns, projects } from "@paperclipai/db";
import type { DeploymentMode, LiveEvent } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { activityToastIdentity } from "./activity-toast-identity.js";
import { taskToastEligible } from "./task-toast-eligibility.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { trackIdleWork } from "../services/task-admission.js";
import { createLiveRunEventRedactor } from "../services/live-run-event-redaction.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  bufferedAmount?: number;
  send(data: string, callback?: (error?: Error) => void): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  close(): void;
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
  WebSocketServer: new (opts: { noServer: boolean; maxPayload: number }) => WsServer;
};

import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { getHeartbeatRunReadDecisions } from "../services/heartbeat-run-privacy.js";
import { canActorReadCase } from "../services/case-access.js";

interface UpgradeContext {
  actor: AuthorizationActor;
  apiKeyId?: string;
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
}

/** Cloud-proxied browser identity resolved from trusted x-paperclip-cloud-* headers. */
export interface CloudUpgradeActor {
  userId: string;
  /** Companies this actor may subscribe to (primary stack company + real memberships). */
  companyIds: string[];
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isWritableUpgradeSocket(socket: Duplex) {
  const maybeWritableState = socket as Duplex & { writable?: boolean; writableEnded?: boolean; writableDestroyed?: boolean };
  return !socket.destroyed && maybeWritableState.writable !== false && !maybeWritableState.writableEnded && !maybeWritableState.writableDestroyed;
}

function closeUpgradeSocket(socket: Duplex) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  if (!isWritableUpgradeSocket(socket)) {
    closeUpgradeSocket(socket);
    return;
  }

  try {
    socket.once("finish", () => closeUpgradeSocket(socket));
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  } catch (err) {
    logger.warn({ err }, "failed to reject live websocket upgrade");
    closeUpgradeSocket(socket);
  }
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
    resolveCloudActor?: (req: IncomingMessage) => Promise<CloudUpgradeActor | null>;
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
        actor: { type: "board", userId: "local-board", source: "local_implicit" },
      };
    }

    // Cloud-managed deployments authenticate proxied browsers with trusted
    // x-paperclip-cloud-* headers, never a local Better Auth session — the
    // session fallback below can only 403 them, which left the live-events
    // socket permanently unreachable behind the Cloud front door. A resolved
    // cloud actor is authoritative: authorize against its membership scope.
    // Absent/invalid cloud headers fall through to the session path, so
    // self-hosted behavior is unchanged.
    if (opts.resolveCloudActor) {
      const cloudActor = await opts.resolveCloudActor(req);
      if (cloudActor) {
        if (!cloudActor.companyIds.includes(companyId)) return null;
        return {
          companyId,
          actorType: "board",
          actorId: cloudActor.userId,
          actor: { type: "board", userId: cloudActor.userId, source: "cloud_tenant", companyIds: cloudActor.companyIds },
        };
      }
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
      actor: { type: "board", userId, source: "session", companyIds: memberships.map(m => m.companyId) },
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key || key.companyId !== companyId || key.scopeConfig) {
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
    apiKeyId: key.id,
    actor: { type: "agent", agentId: key.agentId, companyId, source: "agent_key", onBehalfOfUserId: key.responsibleUserId },
  };
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    subscribeInvalidation?: (companyId: string, resync: () => void) => () => void;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    /**
     * Resolves a Cloud-proxied browser's identity from the trusted
     * x-paperclip-cloud-* headers on the upgrade request. Wired by managed
     * deployments; self-hosted instances leave it unset.
     */
    resolveCloudActor?: (req: IncomingMessage) => Promise<CloudUpgradeActor | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const redactRunEvent = createLiveRunEventRedactor(db);
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

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const access = authorizationService(db);
    async function visibleEvent(event: LiveEvent): Promise<LiveEvent | null> {
      if (event.payload.entityType === "case" && (typeof event.payload.entityId !== "string"
        || !(await canActorReadCase(db, context!.actor, { id: event.payload.entityId, companyId: event.companyId })))) return null;
      if (context!.actor.source === "local_implicit") {
        if (event.type === "activity.logged" && event.payload.entityType === "issue") {
          return { ...event, payload: { ...event.payload,
            ...await activityToastIdentity(db, event.companyId, event.payload) } };
        }
        return event;
      }
      if (context!.apiKeyId) {
        const active = await db.select({ id: agentApiKeys.id }).from(agentApiKeys)
          .where(and(eq(agentApiKeys.id, context!.apiKeyId), isNull(agentApiKeys.revokedAt))).limit(1);
        if (!active.length) return null;
      } else {
        const membership = await db.select({ id: companyMemberships.id }).from(companyMemberships)
          .where(and(eq(companyMemberships.companyId, context!.companyId), eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, context!.actorId), eq(companyMemberships.status, "active"))).limit(1);
        const admin = context!.actor.source !== "cloud_tenant" && await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
          .where(and(eq(instanceUserRoles.userId, context!.actorId), eq(instanceUserRoles.role, "instance_admin"))).limit(1).then(rows => rows.length > 0);
        if (!membership.length && !admin) return null;
      }
      const payload = event.payload;
      const issueId = typeof payload.issueId === "string" ? payload.issueId
        : payload.entityType === "issue" && typeof payload.entityId === "string" ? payload.entityId : null;
      const runId = typeof payload.runId === "string" ? payload.runId
        : payload.entityType === "heartbeat_run" && typeof payload.entityId === "string" ? payload.entityId : null;
      if (event.type === "heartbeat.run.event" || event.type === "heartbeat.run.log") {
        const decision = await access.decide({ actor: context!.actor, action: "company_scope:read",
          resource: { type: "company", companyId: event.companyId } });
        if (!decision.allowed) return null;
      }
      const readBindings: Parameters<typeof getHeartbeatRunReadDecisions>[3][number][] = [];
      if (issueId) {
        readBindings.push({ companyId: event.companyId, scopeKind: "issue", issueId });
      }
      if (runId) {
        const [run] = await db.select({
          companyId: heartbeatRuns.companyId,
          scopeKind: heartbeatRuns.scopeKind,
          issueId: heartbeatRuns.issueId,
        }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, event.companyId)));
        if (!run) return null;
        readBindings.push(run);
      }
      if ((await getHeartbeatRunReadDecisions(db, access, context!.actor, readBindings)).some(allowed => !allowed)) return null;
      if (["company_skill", "company_skill_source"].includes(String(payload.entityType)) && typeof payload.entityId === "string") {
        try {
          const skills = skillAccessService(db, context!.actor);
          if (payload.entityType === "company_skill") await skills.assertSkill(event.companyId, payload.entityId);
          else await skills.assertSource(event.companyId, payload.entityId);
        } catch { return null; }
      }
      if (payload.entityType === "project" && typeof payload.entityId === "string") {
        const [project] = await db.select({ id: projects.id }).from(projects)
          .where(and(eq(projects.id, payload.entityId), eq(projects.companyId, event.companyId))).limit(1);
        if (!project || !(await access.decide({ actor: context!.actor, action: "project:read",
          resource: { type: "project", companyId: event.companyId, projectId: project.id } })).allowed) return null;
      }
      if (event.type.startsWith("heartbeat.run.")) return runId ? event : null;
      if (event.type === "agent.session.goal.changed") return issueId ? event : null;
      // Company-wide invalidations carry no task-derived content. Authorized
      // clients obtain details through viewer-filtered HTTP reads.
      if (event.type === "activity.logged") return { ...event, payload: {
        action: payload.action, entityType: payload.entityType, entityId: payload.entityId,
        // A handoff can attach the first case to a task. Its already-authorized
        // task identity lets an empty cases panel refresh without exposing content.
        ...(payload.entityType === "case" && String(payload.action).startsWith("case.handoff_") && issueId ? { issueId } : {}),
        // The task read check above authorizes attribution, but not arbitrary details.
        ...(issueId ? await activityToastIdentity(db, event.companyId, payload) : {}),
      } };
      if (event.type === "agent.status") return { ...event, payload: { agentId: payload.agentId, status: payload.status } };
      if (event.type === "external_object.updated") return { ...event, payload: { externalObjectId: payload.externalObjectId } };
      if (event.type.startsWith("plugin.")) return event;
      return null;
    }
    const delivery = createLiveEventDelivery({ socket, authorize: async event => {
      const visible = await visibleEvent(event);
      if (!visible || visible.type !== "heartbeat.run.event") return visible;
      const payload = visible.payload.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("prpEvent" in payload)) return visible;
      return redactRunEvent(visible);
    },
      decorate: async visible => {
        let toastEligible = false;
        try {
          toastEligible = await taskToastEligible(db, visible,
            context.actor.type === "board" ? context.actor.userId ?? null : null);
        } catch (err) { logger.warn({ err, companyId: context.companyId }, "task toast eligibility failed"); }
        return { ...visible, toastEligible };
      },
      onError: err => logger.warn({ err, companyId: context.companyId }, "live event authorization failed"),
    });
    const unsubscribe = subscribeCompanyLiveEvents(context.companyId, event => delivery.enqueue(event));
    const unsubscribeInvalidation = opts.subscribeInvalidation?.(context.companyId, delivery.requestResync);
    socket.on("message", (data, isBinary) => {
      if (isBinary) { socket.close(1003, "text messages required"); return; }
      delivery.receive(data.toString());
    });
    cleanupByClient.set(socket, () => { unsubscribe(); unsubscribeInvalidation?.(); delivery.dispose(); });
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
    if ((req as IncomingMessageWithContext).paperclipWebSocketHandled) {
      return;
    }

    const onRawSocketError = (err: Error) => {
      logger.warn({ err, path: req.url }, "live websocket upgrade socket error");
    };
    const cleanupRawSocketListeners = () => {
      socket.off("error", onRawSocketError);
      socket.off("close", cleanupRawSocketListeners);
    };

    socket.on("error", onRawSocketError);
    socket.once("close", cleanupRawSocketListeners);

    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      closeUpgradeSocket(socket);
      return;
    }

    // Upgrade admission precedes this async authentication. An idle hold or
    // socket close must not make its accepted database writes disappear.
    void trackIdleWork(authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
      resolveCloudActor: opts.resolveCloudActor,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        if (!isWritableUpgradeSocket(socket)) {
          cleanupRawSocketListeners();
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = context;

        cleanupRawSocketListeners();
        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      }));
  });

  return wss;
}
