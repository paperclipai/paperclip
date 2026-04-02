import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";

/**
 * Computes a SHA-256 hexadecimal digest of the given token.
 *
 * @param token - The input token string to hash.
 * @returns The lowercase hexadecimal SHA-256 digest of `token`.
 */
function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// FleetOS API key validation cache (5-minute TTL)
// ---------------------------------------------------------------------------
interface FleetosValidationCacheEntry {
  tenantId: string;
  tenantName: string;
  companyId: string;
  expiresAt: number;
}

const fleetosValidationCache = new Map<string, FleetosValidationCacheEntry>();
const FLEETOS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;

/**
 * Retrieves a cached FleetOS validation entry for the given API key and refreshes its LRU position.
 *
 * @param apiKey - The FleetOS API key used as the cache lookup key
 * @returns The cached `FleetosValidationCacheEntry` for `apiKey`, or `null` if no entry exists or it has expired
 */
function getCachedFleetosValidation(apiKey: string): FleetosValidationCacheEntry | null {
  const entry = fleetosValidationCache.get(apiKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    fleetosValidationCache.delete(apiKey);
    return null;
  }
  // Move to end for LRU ordering (Map preserves insertion order)
  fleetosValidationCache.delete(apiKey);
  fleetosValidationCache.set(apiKey, entry);
  return entry;
}

/**
 * Stores validated FleetOS tenant/company metadata for an API key with a time-to-live and LRU-like eviction.
 *
 * If the cache has reached its maximum size, the oldest entry is evicted before inserting the new entry.
 *
 * @param apiKey - The FleetOS API key used as the cache key
 * @param data - Tenant and company metadata to cache; `tenantId`, `tenantName`, and `companyId` will be stored with an expiration timestamp
 */
function setCachedFleetosValidation(
  apiKey: string,
  data: { tenantId: string; tenantName: string; companyId: string },
): void {
  // Evict oldest entry if at capacity
  if (fleetosValidationCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = fleetosValidationCache.keys().next().value;
    if (oldestKey !== undefined) {
      fleetosValidationCache.delete(oldestKey);
    }
  }
  fleetosValidationCache.set(apiKey, {
    ...data,
    expiresAt: Date.now() + FLEETOS_CACHE_TTL_MS,
  });
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
  fleetosApiUrl?: string;
}

/**
 * Create an Express middleware that resolves and assigns `req.actor` based on the server's deployment and request credentials.
 *
 * The middleware populates `req.actor` for local implicit board access, FleetOS API key access (including cached validation and fail-closed rejection), session-based authenticated users, board API keys, and agent tokens (API key or local JWT). For requests that cannot be associated with an actor it leaves `req.actor` as a non-board placeholder and continues the request flow.
 *
 * @param db - Database handle used to look up keys, agents, roles, and memberships
 * @param opts - Middleware options controlling deployment mode, session resolution, and FleetOS configuration
 * @returns An Express request handler that sets `req.actor` according to resolved credentials and either calls `next()` or responds with 401 when a provided FleetOS API key fails validation
 */
export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

    // -----------------------------------------------------------------------
    // Path 4: FleetOS API key (X-API-Key header or fleetos_session cookie)
    // -----------------------------------------------------------------------
    if (opts.deploymentMode === "fleetos" && opts.fleetosApiUrl) {
      let fleetosApiKey: string | undefined = req.header("x-api-key");

      // Fall back to the httpOnly session cookie set by POST /api/fleetos/login
      if (!fleetosApiKey) {
        const cookieHeader = req.headers.cookie;
        if (cookieHeader) {
          const match = cookieHeader.match(/(?:^|;\s*)fleetos_session=([^;]+)/);
          if (match?.[1]) {
            try {
              const decoded = JSON.parse(
                Buffer.from(match[1], "base64").toString("utf-8"),
              ) as { apiKey?: string };
              fleetosApiKey = decoded.apiKey;
            } catch {
              // malformed cookie — ignore
            }
          }
        }
      }

      if (fleetosApiKey) {
        let tenant = getCachedFleetosValidation(fleetosApiKey);
        if (!tenant) {
          try {
            const res = await fetch(`${opts.fleetosApiUrl}/api/tenants`, {
              method: "GET",
              headers: { "X-API-Key": fleetosApiKey, Accept: "application/json" },
            });
            if (res.ok) {
              const data = (await res.json()) as {
                id?: string;
                tenant_id?: string;
                name?: string;
                tenant_name?: string;
                company_id?: string;
              };
              const tenantId = data.tenant_id ?? data.id;
              if (tenantId) {
                const tenantName = data.tenant_name ?? data.name ?? "FleetOS Tenant";
                const companyId = data.company_id ?? tenantId;
                const tenantData = { tenantId, tenantName, companyId };
                setCachedFleetosValidation(fleetosApiKey, tenantData);
                tenant = getCachedFleetosValidation(fleetosApiKey);
              }
            }
          } catch (err) {
            logger.warn({ err }, "FleetOS API key validation failed in middleware");
          }
        }

        if (tenant) {
          req.actor = {
            type: "board",
            userId: `fleetos:${tenant.tenantId}`,
            companyId: tenant.companyId,
            companyIds: [tenant.companyId],
            isInstanceAdmin: true,
            fleetosTenantId: tenant.tenantId,
            fleetosApiKey,
            runId: runIdHeader ?? undefined,
            source: "fleetos_api_key",
          };
          next();
          return;
        }

        // Fail-closed: API key was present but validation failed — reject immediately
        res.status(401).json({ error: "Invalid or expired FleetOS API key" });
        return;
      }
    }

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
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
          req.actor = {
            type: "board",
            userId,
            companyIds: memberships.map((row) => row.companyId),
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          companyIds: access.companyIds,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runIdHeader || claims.run_id || undefined,
        source: "agent_jwt",
      };
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
