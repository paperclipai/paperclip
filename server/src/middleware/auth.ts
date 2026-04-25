import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService, normalizeV1CompanySlug } from "../services/board-auth.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function filterBoardAccessByAllowedSlugs(
  db: Db,
  access: Awaited<ReturnType<ReturnType<typeof boardAuthService>["resolveBoardAccess"]>>,
  allowedCompanySlugs: string[],
) {
  if (allowedCompanySlugs.length === 0) {
    return {
      companyIds: access.companyIds,
      memberships: access.memberships,
      credentialCompanySlugs: [],
    };
  }

  const allowed = new Set(allowedCompanySlugs);
  const companyRows = await db
    .select({ id: companies.id, issuePrefix: companies.issuePrefix })
    .from(companies);
  const allowedCompanyRows = companyRows.filter((company) =>
    allowed.has(normalizeV1CompanySlug(company.issuePrefix, company.id)),
  );
  const allowedCompanyIds = new Set(allowedCompanyRows.map((company) => company.id));
  const companyIds = access.isInstanceAdmin
    ? allowedCompanyRows.map((company) => company.id)
    : access.companyIds.filter((companyId) => allowedCompanyIds.has(companyId));

  return {
    companyIds,
    memberships: access.memberships.filter((membership) => allowedCompanyIds.has(membership.companyId)),
    credentialCompanySlugs: allowedCompanyRows
      .filter((company) => companyIds.includes(company.id))
      .map((company) => normalizeV1CompanySlug(company.issuePrefix, company.id)),
  };
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
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
          req.actor = {
            type: "board",
            userId,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
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
        const allowedCompanySlugs = boardKey.allowedCompanySlugs ?? [];
        const scopedAccess = await filterBoardAccessByAllowedSlugs(db, access, allowedCompanySlugs);
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: scopedAccess.companyIds,
          memberships: scopedAccess.memberships,
          allowedCompanySlugs,
          credentialCompanySlugs: scopedAccess.credentialCompanySlugs,
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

    const [agentRecord, companyRecord] = await Promise.all([
      db
        .select()
        .from(agents)
        .where(eq(agents.id, key.agentId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: companies.id, issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, key.companyId))
        .then((rows) => rows[0] ?? null),
    ]);

    if (
      !agentRecord ||
      !companyRecord ||
      agentRecord.status === "terminated" ||
      agentRecord.status === "pending_approval"
    ) {
      next();
      return;
    }

    const credentialCompanySlug = normalizeV1CompanySlug(companyRecord.issuePrefix, companyRecord.id);
    const allowedCompanySlugs = key.allowedCompanySlugs ?? [];
    if (allowedCompanySlugs.length > 0 && !allowedCompanySlugs.includes(credentialCompanySlug)) {
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      allowedCompanySlugs,
      credentialCompanySlugs: [credentialCompanySlug],
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
