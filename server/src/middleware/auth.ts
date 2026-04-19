import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companyMemberships, heartbeatRuns, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode, HeartbeatRunStatus } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

type ResolvedAgentRunContext = {
  runId?: string;
  runStatus?: HeartbeatRunStatus;
  rejectedRequestedRunId?: string;
  rejectionReason?: "missing" | "company_mismatch" | "agent_mismatch";
};

async function resolveAgentRunContext(
  db: Db,
  input: { agentId: string; companyId: string; requestedRunId?: string | null },
): Promise<ResolvedAgentRunContext> {
  const requestedRunId = input.requestedRunId?.trim();
  if (!requestedRunId) return {};

  const run = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, requestedRunId))
    .then((rows) => rows[0] ?? null);

  if (!run) {
    return {
      rejectedRequestedRunId: requestedRunId,
      rejectionReason: "missing",
    };
  }
  if (run.companyId !== input.companyId) {
    return {
      rejectedRequestedRunId: requestedRunId,
      rejectionReason: "company_mismatch",
    };
  }
  if (run.agentId !== input.agentId) {
    return {
      rejectedRequestedRunId: requestedRunId,
      rejectionReason: "agent_mismatch",
    };
  }

  return {
    runId: run.id,
    runStatus: run.status as HeartbeatRunStatus,
  };
}

function logRejectedAgentRunId(input: {
  requestedRunId: string;
  rejectionReason: NonNullable<ResolvedAgentRunContext["rejectionReason"]>;
  agentId: string;
  companyId: string;
  source: "agent_key" | "agent_jwt";
}) {
  logger.warn(
    {
      requestedRunId: input.requestedRunId,
      rejectionReason: input.rejectionReason,
      agentId: input.agentId,
      companyId: input.companyId,
      source: input.source,
    },
    "Ignoring invalid agent run id from request",
  );
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

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

      const runContext = await resolveAgentRunContext(db, {
        agentId: claims.sub,
        companyId: claims.company_id,
        requestedRunId: runIdHeader || claims.run_id || undefined,
      });
      if (runContext.rejectedRequestedRunId && runContext.rejectionReason) {
        logRejectedAgentRunId({
          requestedRunId: runContext.rejectedRequestedRunId,
          rejectionReason: runContext.rejectionReason,
          agentId: claims.sub,
          companyId: claims.company_id,
          source: "agent_jwt",
        });
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runContext.runId,
        runStatus: runContext.runStatus,
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

    const runContext = await resolveAgentRunContext(db, {
      agentId: key.agentId,
      companyId: key.companyId,
      requestedRunId: runIdHeader || undefined,
    });
    if (runContext.rejectedRequestedRunId && runContext.rejectionReason) {
      logRejectedAgentRunId({
        requestedRunId: runContext.rejectedRequestedRunId,
        rejectionReason: runContext.rejectionReason,
        agentId: key.agentId,
        companyId: key.companyId,
        source: "agent_key",
      });
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runContext.runId,
      runStatus: runContext.runStatus,
      source: "agent_key",
    };

    next();
  };
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
