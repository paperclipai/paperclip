import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, heartbeatRuns, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeRunId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !UUID_RE.test(trimmed)) return undefined;
  return trimmed;
}

async function resolveRunAttribution(
  db: Db,
  rawRunId: string | null | undefined,
  constraints: { agentId?: string; companyId?: string } = {},
): Promise<{ id: string; agentId: string; companyId: string } | null> {
  const runId = normalizeRunId(rawRunId);
  if (!runId) return null;

  const run = await db
    .select({
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run) return null;

  if (constraints.agentId && run.agentId !== constraints.agentId) return null;
  if (constraints.companyId && run.companyId !== constraints.companyId) return null;

  return { id: runId, agentId: run.agentId, companyId: run.companyId };
}

function isLockTimeoutError(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const candidates = [error, cause];
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const err = candidate as { code?: unknown; message?: unknown };
    return err.code === "55P03" || (typeof err.message === "string" && err.message.includes("lock timeout"));
  });
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
  /**
   * Random per-process token. When set, requests that arrive on loopback with
   * `x-paperclip-internal-bootstrap: <token>` are treated as instance admin
   * regardless of deploymentMode. This is the channel index.ts uses to
   * auto-install bundled plugins by hitting its own /api/plugins/install route
   * before the auth bootstrap completes — without it, the loopback POST 403s.
   */
  internalBootstrapToken?: string;
}

function isLoopback(req: Request): boolean {
  const ip = req.ip ?? req.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    if (
      opts.internalBootstrapToken &&
      isLoopback(req) &&
      req.header("x-paperclip-internal-bootstrap") === opts.internalBootstrapToken
    ) {
      req.actor = {
        type: "board",
        userId: "internal-bootstrap",
        userName: "Internal Bootstrap",
        userEmail: null,
        isInstanceAdmin: true,
        source: "local_implicit",
      };
      next();
      return;
    }
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? {
            type: "board",
            userId: "local-board",
            userName: "Local Board",
            userEmail: null,
            isInstanceAdmin: true,
            source: "local_implicit",
          }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        const cloudTenantActor = await resolveCloudTenantActor(db, req);
        if (cloudTenantActor) {
          const runAttribution = await resolveRunAttribution(db, runIdHeader);
          req.actor = {
            ...cloudTenantActor,
            runId: runAttribution?.id,
          };
          next();
          return;
        }

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
              .select({
                companyId: companyMemberships.companyId,
                membershipRole: companyMemberships.membershipRole,
                status: companyMemberships.status,
              })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ),
          ]);
          const runAttribution = await resolveRunAttribution(db, runIdHeader);
          req.actor = {
            type: "board",
            userId,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
            isInstanceAdmin: Boolean(roleRow),
            runId: runAttribution?.id,
            source: "session",
          };
          next();
          return;
        }
      }
      // When no bearer token is present in local_trusted mode, try to derive
      // agent identity from the run-ID header.  This fixes the audit-trail bug
      // where agents making API calls without an explicit Authorization header
      // (e.g. plain curl inside a heartbeat when JWT secret is not configured)
      // appear as the board actor rather than the originating agent.
      //
      // IMPORTANT: This block MUST only run in local_trusted mode.  In
      // authenticated mode a valid run-ID alone must not grant agent-level
      // access — that would bypass authentication entirely.
      if (runIdHeader && opts.deploymentMode === "local_trusted") {
        const run = await resolveRunAttribution(db, runIdHeader);

        if (run) {
          const agentRecord = await db
            .select()
            .from(agents)
            .where(eq(agents.id, run.agentId))
            .then((rows) => rows[0] ?? null);

          if (
            agentRecord &&
            agentRecord.companyId === run.companyId &&
            agentRecord.status !== "terminated" &&
            agentRecord.status !== "pending_approval"
          ) {
            req.actor = {
              type: "agent",
              agentId: run.agentId,
              companyId: run.companyId,
              keyId: undefined,
              runId: run.id,
              source: "run_id",
            };
            next();
            return;
          }
        }
      }
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
        const runAttribution = await resolveRunAttribution(db, runIdHeader);
        try {
          await boardAuth.touchBoardApiKey(boardKey.id);
        } catch (error) {
          if (!isLockTimeoutError(error)) throw error;
          logger.warn({ err: error, boardKeyId: boardKey.id }, "board API key touch skipped after lock timeout");
        }
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runAttribution?.id,
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

      const jwtRunId = normalizeRunId(runIdHeader) ?? normalizeRunId(claims.run_id);
      const runAttribution = await resolveRunAttribution(db, jwtRunId, {
        agentId: claims.sub,
        companyId: claims.company_id,
      });
      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runAttribution?.id,
        source: "agent_jwt",
      };
      next();
      return;
    }

    try {
      await db
        .update(agentApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentApiKeys.id, key.id));
    } catch (error) {
      if (!isLockTimeoutError(error)) throw error;
      logger.warn({ err: error, agentKeyId: key.id }, "agent API key touch skipped after lock timeout");
    }

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    const runAttribution = await resolveRunAttribution(db, runIdHeader, {
      agentId: key.agentId,
      companyId: key.companyId,
    });
    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runAttribution?.id,
      source: "agent_key",
    };

    next();
  };
}

export async function resolveCloudTenantActor(db: Db, req: Request): Promise<Express.Request["actor"] | null> {
  const expectedToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (!expectedToken) return null;

  const token = req.header("x-paperclip-cloud-tenant-token")?.trim();
  if (!token || !constantTimeStringEqual(token, expectedToken)) return null;

  const userId = requiredCloudHeader(req, "x-paperclip-cloud-user-id");
  const userEmail = requiredCloudHeader(req, "x-paperclip-cloud-user-email").toLowerCase();
  const stackId = requiredCloudHeader(req, "x-paperclip-cloud-stack-id");
  const stackRole = stackMembershipRole(req.header("x-paperclip-cloud-stack-role"));
  const userName = req.header("x-paperclip-cloud-user-name")?.trim() || userEmail;
  const paperclipCompanyId = req.header("x-paperclip-cloud-paperclip-company-id")?.trim();
  const companyId = cloudTenantCompanyId(stackId);
  const companyName = paperclipCompanyId || `${stackId} Paperclip`;
  const now = new Date();

  await db
    .insert(authUsers)
    .values({
      id: userId,
      name: userName,
      email: userEmail,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authUsers.id,
      set: {
        name: userName,
        email: userEmail,
        emailVerified: true,
        updatedAt: now,
      },
    });

  // Earlier cloud_tenant builds granted every tenant user `instance_admin`.
  // Stale rows from those deployments would still elevate this user through
  // the BetterAuth session path, board API keys, and the authorization
  // service's own instanceUserRoles lookup — so actively purge them on every
  // trusted-header authentication instead of merely no longer inserting them.
  await db
    .delete(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));

  await db
    .insert(companies)
    .values({
      id: companyId,
      name: companyName,
      description: `Provisioned by Paperclip Cloud for stack ${stackId}.`,
      status: "active",
      issuePrefix: issuePrefixForCloudStack(stackId),
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: companies.id,
    });

  const membershipRole = stackRole === "owner" || stackRole === "admin" ? "owner" : stackRole;
  const membership = await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        companyMemberships.companyId,
        companyMemberships.principalType,
        companyMemberships.principalId,
      ],
      set: {
        status: "active",
        membershipRole,
        updatedAt: now,
      },
    })
    .returning()
    .then((rows) => rows[0] ?? {
      companyId,
      membershipRole,
      status: "active",
    });

  // Without instance-admin elevation, cloud tenant users are authorized purely
  // through company-scoped permission grants — seed the same role defaults the
  // regular membership flows create.
  await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: membership.membershipRole,
    grantedByUserId: null,
  });

  return {
    type: "board",
    userId,
    userName,
    userEmail,
    companyIds: [companyId],
    memberships: [{
      companyId,
      membershipRole: membership.membershipRole,
      status: membership.status,
    }],
    isInstanceAdmin: false,
    source: "cloud_tenant",
  };
}

function requiredCloudHeader(req: Request, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) {
    throw new Error(`Missing trusted Cloud tenant header ${name}`);
  }
  return value;
}

function stackMembershipRole(value: string | undefined): "owner" | "admin" | "member" | "support" {
  if (value === "owner" || value === "admin" || value === "member" || value === "support") {
    return value;
  }
  throw new Error("Invalid trusted Cloud tenant stack role");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cloudTenantCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`paperclip-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function issuePrefixForCloudStack(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
