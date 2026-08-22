import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
} from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { isUuidLike, normalizeAgentApiKeyScope, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";

const CLOUD_TENANT_WRITE_DEBOUNCE_MS = 5_000;
const CLOUD_TENANT_WRITE_DEBOUNCE_MAX = 1_000;
const cloudTenantWriteDebounces = new WeakMap<Db, Map<string, { fingerprint: string; syncedAt: number }>>();

function cloudTenantWriteDebounceFor(db: Db) {
  let debounce = cloudTenantWriteDebounces.get(db);
  if (!debounce) {
    debounce = new Map();
    cloudTenantWriteDebounces.set(db, debounce);
  }
  return debounce;
}

function pruneCloudTenantWriteDebounce(
  debounce: Map<string, { fingerprint: string; syncedAt: number }>,
  nowMs: number,
) {
  for (const [subject, entry] of debounce) {
    if (entry.syncedAt <= nowMs - CLOUD_TENANT_WRITE_DEBOUNCE_MS) debounce.delete(subject);
  }
  while (debounce.size > CLOUD_TENANT_WRITE_DEBOUNCE_MAX) {
    const oldestSubject = debounce.keys().next().value;
    if (!oldestSubject) break;
    debounce.delete(oldestSubject);
  }
}
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { forbidden, unauthorized, unprocessable } from "../errors.js";

export { isCloudManagedInstance } from "../services/cloud-instance.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeOptionalString(value: string | null | undefined) {
  return value?.trim() || null;
}

function invalidAgentTokenMessage(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) {
      return "Expired agent token; obtain fresh credentials and retry";
    }
  } catch {
    // Malformed and incorrectly signed tokens share the generic failure below.
  }
  return "Agent token did not verify; obtain fresh credentials and retry";
}

async function resolveLegacyRunResponsibleUserId(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
) {
  if (!isUuidLike(input.runId)) return null;
  const run = await db
    .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return normalizeOptionalString(run?.responsibleUserId);
}

async function loadResponsibleUserMemberships(
  db: Db,
  input: { companyId: string; userId: string | null },
) {
  if (!input.userId) return [];
  const [user, memberships] = await Promise.all([
    db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, input.userId))
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
          eq(companyMemberships.companyId, input.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.userId),
          eq(companyMemberships.status, "active"),
        ),
      ),
  ]);
  return user ? memberships : [];
}

/**
 * The user's own active company memberships — the exact company scope a
 * locally authenticated session actor carries. Shared by the session path
 * and the Cloud trusted-header path so both resolve the same access set.
 */
async function loadActiveUserCompanyMemberships(db: Db, userId: string) {
  return db
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
    );
}

async function auditAgentJwtRunHeaderMismatch(
  db: Db,
  input: { companyId: string; agentId: string; claimRunId: string; headerRunId: string; method: string; url: string },
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: input.claimRunId,
      ...(isUuidLike(input.agentId) ? { agentId: input.agentId } : {}),
      ...(isUuidLike(input.claimRunId) ? { runId: input.claimRunId } : {}),
      details: {
        claimRunId: input.claimRunId,
        headerRunId: input.headerRunId,
        method: input.method,
        url: input.url,
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, claimRunId: input.claimRunId },
      "Failed to audit rejected agent JWT run header mismatch",
    );
  }
}

async function auditAgentKeyMissingResponsibleUser(
  db: Db,
  input: { companyId: string; agentId: string; keyId: string; method: string; url: string },
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: "auth.agent_key_missing_responsible_user",
      entityType: "agent_api_key",
      entityId: input.keyId,
      ...(isUuidLike(input.agentId) ? { agentId: input.agentId } : {}),
      details: {
        method: input.method,
        url: input.url,
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, keyId: input.keyId },
      "Failed to audit rejected agent key without responsible user binding",
    );
  }
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
    const hasBearerCredentials = /^bearer(?:\s|$)/i.test(authHeader ?? "");
    if (!hasBearerCredentials) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        const cloudTenantActor = await resolveCloudTenantActor(db, req);
        if (cloudTenantActor) {
          req.actor = {
            ...cloudTenantActor,
            runId: runIdHeader ?? undefined,
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
        if (session?.user?.id && session.session?.id) {
          const userId = session.user.id;
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            loadActiveUserCompanyMemberships(db, userId),
          ]);
          req.actor = {
            type: "board",
            userId,
            sessionId: session.session.id,
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

    const token = authHeader!.slice("bearer".length).trim();
    if (!token) {
      next(unauthorized("Empty bearer token; provide valid agent credentials and retry"));
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
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
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
        next(unauthorized(invalidAgentTokenMessage(token)));
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next(unauthorized("Agent record is missing or belongs to another company; obtain fresh credentials and retry"));
        return;
      }

      if (agentRecord.status === "terminated") {
        next(unauthorized("Agent is terminated and cannot authenticate"));
        return;
      }
      if (agentRecord.status === "pending_approval") {
        next(unauthorized("Agent is pending approval and cannot authenticate"));
        return;
      }

      const normalizedRunIdHeader = normalizeOptionalString(runIdHeader);
      if (normalizedRunIdHeader && normalizedRunIdHeader !== claims.run_id) {
        await auditAgentJwtRunHeaderMismatch(db, {
          companyId: claims.company_id,
          agentId: claims.sub,
          claimRunId: claims.run_id,
          headerRunId: normalizedRunIdHeader,
          method: req.method,
          url: req.originalUrl,
        });
        next(
          unprocessable("X-Paperclip-Run-Id does not match signed agent JWT run_id", {
            code: "agent_jwt_run_id_mismatch",
            claimRunId: claims.run_id,
            headerRunId: normalizedRunIdHeader,
          }),
        );
        return;
      }

      const onBehalfOfUserId = claims.responsible_user_id !== undefined
        ? normalizeOptionalString(claims.responsible_user_id)
        : await resolveLegacyRunResponsibleUserId(db, {
            companyId: claims.company_id,
            agentId: claims.sub,
            runId: claims.run_id,
          });
      const onBehalfOfMemberships = await loadResponsibleUserMemberships(db, {
        companyId: claims.company_id,
        userId: onBehalfOfUserId,
      });

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        keyScope: normalizeAgentApiKeyScope(claims.key_scope),
        runId: claims.run_id,
        onBehalfOfUserId,
        onBehalfOfMemberships,
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

    if (!agentRecord || agentRecord.companyId !== key.companyId) {
      next(unauthorized("Agent record is missing or belongs to another company; obtain fresh credentials and retry"));
      return;
    }
    if (agentRecord.status === "terminated") {
      next(unauthorized("Agent is terminated and cannot authenticate"));
      return;
    }
    if (agentRecord.status === "pending_approval") {
      next(unauthorized("Agent is pending approval and cannot authenticate"));
      return;
    }

    const responsibleUserId = normalizeOptionalString(key.responsibleUserId);
    if (!responsibleUserId) {
      await auditAgentKeyMissingResponsibleUser(db, {
        companyId: key.companyId,
        agentId: key.agentId,
        keyId: key.id,
        method: req.method,
        url: req.originalUrl,
      });
      next(forbidden("Responsible user is unavailable for this agent key", {
        code: "RESPONSIBLE_USER_UNAVAILABLE",
      }));
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      keyScope: normalizeAgentApiKeyScope(key.scopeConfig),
      onBehalfOfUserId: responsibleUserId,
      onBehalfOfMemberships: await loadResponsibleUserMemberships(db, {
        companyId: key.companyId,
        userId: responsibleUserId,
      }),
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

/**
 * Whether the trusted-header actor being resolved should carry computed
 * instance-admin elevation: only the stack `owner` role elevates, and only
 * while `enableOwnerInstanceAdmin` is enabled. The flag is resolved through
 * the instance-settings service so the cloud managed-config overlay applies
 * (the harness can turn elevation off fleet-wide without touching tenant
 * DBs). Fails closed: a settings read error means no elevation.
 */
async function resolveOwnerInstanceAdmin(
  db: Db,
  stackRole: "owner" | "admin" | "member" | "support",
): Promise<boolean> {
  if (stackRole !== "owner") return false;
  try {
    const experimental = await instanceSettingsService(db).getExperimental();
    return experimental.enableOwnerInstanceAdmin === true;
  } catch (err) {
    logger.warn(
      { err },
      "Failed to resolve enableOwnerInstanceAdmin for cloud tenant owner; treating elevation as disabled",
    );
    return false;
  }
}

/**
 * Minimal header accessor `resolveCloudTenantActor` needs. Express `Request`
 * satisfies it directly; websocket upgrade paths adapt a raw
 * `IncomingMessage` with {@link cloudActorHeaderSourceFromHeaders} since
 * trusted-header authentication must work identically for upgrades — a
 * cloud-proxied browser has no local Better Auth session to fall back on.
 */
export interface CloudActorHeaderSource {
  header(name: string): string | undefined;
}

/** Adapts a raw header map (e.g. `IncomingMessage.headers`) to {@link CloudActorHeaderSource}. */
export function cloudActorHeaderSourceFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): CloudActorHeaderSource {
  return {
    header(name: string) {
      const value = headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
}

export async function resolveCloudTenantActor(
  db: Db,
  req: CloudActorHeaderSource,
): Promise<Express.Request["actor"] | null> {
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
  const paperclipCompanyName = req
    .header("x-paperclip-cloud-paperclip-company-name")
    ?.trim();
  const companyId = cloudTenantCompanyId(stackId);
  const companyName = paperclipCompanyName || humanizeCloudStackSlug(stackId);
  const now = new Date();
  const membershipRole = stackRole === "owner" || stackRole === "admin" ? "owner" : stackRole;
  const syncFingerprint = [userEmail, userName, stackId, stackRole, paperclipCompanyId ?? ""].join(":");
  const cloudTenantWriteDebounce = cloudTenantWriteDebounceFor(db);
  pruneCloudTenantWriteDebounce(cloudTenantWriteDebounce, now.getTime());
  const previousSync = cloudTenantWriteDebounce.get(userId);
  const shouldSync = previousSync?.fingerprint !== syncFingerprint
    || previousSync.syncedAt <= now.getTime() - CLOUD_TENANT_WRITE_DEBOUNCE_MS;
  let effectiveMembership: { companyId: string; membershipRole: string | null; status: string } = {
    companyId,
    membershipRole,
    status: "active",
  };

  if (shouldSync) await db
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

  if (shouldSync) await db
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

  if (shouldSync && paperclipCompanyName) {
    await repairCloudTenantCompanyName(db, {
      companyId,
      paperclipCompanyId,
      paperclipCompanyName,
      now,
    });
  }

  effectiveMembership = shouldSync ? await db
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
    }) : { companyId, membershipRole, status: "active" as const };

  // Without instance-admin elevation, cloud tenant users are authorized purely
  // through company-scoped permission grants — seed the same role defaults the
  // regular membership flows create.
  if (shouldSync) await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: effectiveMembership.membershipRole ?? membershipRole,
    grantedByUserId: null,
  });
  if (shouldSync) {
    cloudTenantWriteDebounce.delete(userId);
    cloudTenantWriteDebounce.set(userId, { fingerprint: syncFingerprint, syncedAt: Date.now() });
    pruneCloudTenantWriteDebounce(cloudTenantWriteDebounce, Date.now());
  }

  // The stack's seeded company is only where Cloud provisioned this user.
  // Companies created afterwards on the instance (imports, in-app company
  // creation) attach real membership rows for the user, so union those with
  // the pinned primary — the same active-membership scope a locally
  // authenticated session actor carries. Strictly this user's own rows; the
  // membership-creating flows seed their own permission grants, so nothing
  // needs seeding per request here. A read failure degrades to the pinned
  // primary instead of blocking authentication, mirroring the fail-closed
  // owner-elevation resolution below.
  let additionalMemberships: { companyId: string; membershipRole: string | null; status: string }[] =
    [];
  try {
    additionalMemberships = (await loadActiveUserCompanyMemberships(db, userId)).filter(
      (row) => row.companyId !== companyId,
    );
  } catch (err) {
    logger.warn(
      { err, userId, stackId },
      "Failed to load cloud tenant user's company memberships; scoping actor to the stack's primary company",
    );
  }

  return {
    type: "board",
    userId,
    userName,
    userEmail,
    companyIds: [companyId, ...additionalMemberships.map((row) => row.companyId)],
    memberships: [
      {
        companyId,
        membershipRole: effectiveMembership.membershipRole ?? membershipRole,
        status: effectiveMembership.status,
      },
      ...additionalMemberships,
    ],
    // Computed per request, never persisted: the stack owner is elevated to
    // instance admin of their own dedicated instance only while the
    // `enableOwnerInstanceAdmin` flag is on. Non-owner stack roles stay
    // company-scoped. Turning the flag off de-elevates on the next request —
    // there is no role row to clean up.
    isInstanceAdmin: await resolveOwnerInstanceAdmin(db, stackRole),
    source: "cloud_tenant",
  };
}

function requiredCloudHeader(req: CloudActorHeaderSource, name: string): string {
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

export function humanizeCloudStackSlug(stackId: string): string {
  const slug = stackId
    .trim()
    .replace(/^paperclip-stack-/i, "")
    .replace(/^stack-/i, "");
  const displayName = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return displayName || "Workspace";
}

export function isKnownBadCloudCompanyName(
  name: string,
  ids: { companyId: string; paperclipCompanyId?: string },
): boolean {
  const normalized = name.trim();
  return (
    /^paperclip-stack-.+/i.test(normalized) ||
    /^stack-.+\s+paperclip$/i.test(normalized) ||
    normalized === ids.companyId ||
    (ids.paperclipCompanyId !== undefined &&
      normalized === ids.paperclipCompanyId)
  );
}

async function repairCloudTenantCompanyName(
  db: Db,
  input: {
    companyId: string;
    paperclipCompanyId?: string;
    paperclipCompanyName: string;
    now: Date;
  },
): Promise<void> {
  try {
    const existing = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .then((rows) => rows[0]);
    if (
      !existing ||
      !isKnownBadCloudCompanyName(existing.name, {
        companyId: input.companyId,
        paperclipCompanyId: input.paperclipCompanyId,
      })
    ) {
      return;
    }
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(companies)
        .set({ name: input.paperclipCompanyName, updatedAt: input.now })
        .where(
          and(
            eq(companies.id, input.companyId),
            // A user may rename the company between the read above and this
            // repair. Match the exact observed machine name so that concurrent
            // genuine renames always win.
            eq(companies.name, existing.name),
          ),
        )
        .returning({ id: companies.id });
      if (!updated) return;

      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "cloud-tenant-auth",
        action: "company.updated",
        entityType: "company",
        entityId: input.companyId,
        details: {
          source: "cloud_tenant_auth",
          reason: "legacy_machine_name_repair",
          previousName: existing.name,
          name: input.paperclipCompanyName,
        },
      });
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId },
      "Failed to repair legacy Cloud tenant company name",
    );
  }
}

function issuePrefixForCloudStack(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
