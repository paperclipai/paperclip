import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  authUsers,
  boardApiKeys,
  cliAuthChallenges,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

export const BOARD_API_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CLI_AUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const BOARD_API_KEY_TOUCH_DEBOUNCE_MS = 60_000;
const BOARD_API_KEY_TOUCH_CACHE_MAX = 1_000;

export type CliAuthChallengeStatus = "pending" | "approved" | "cancelled" | "expired";

export function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createBoardApiToken() {
  return `pcp_board_${randomBytes(24).toString("hex")}`;
}

export function createCliAuthSecret() {
  return `pcp_cli_auth_${randomBytes(24).toString("hex")}`;
}

export function boardApiKeyExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + BOARD_API_KEY_TTL_MS);
}

export function cliAuthChallengeExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + CLI_AUTH_CHALLENGE_TTL_MS);
}

function challengeStatusForRow(row: typeof cliAuthChallenges.$inferSelect): CliAuthChallengeStatus {
  if (row.cancelledAt) return "cancelled";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  if (row.approvedAt && row.boardApiKeyId) return "approved";
  return "pending";
}

export function boardAuthService(db: Db) {
  const touchedBoardApiKeys = new Map<string, { completedAt: number | null; inFlight: Promise<void> | null }>();

  function pruneTouchedBoardApiKeys(nowMs: number) {
    for (const [id, entry] of touchedBoardApiKeys) {
      if (!entry.inFlight && entry.completedAt !== null && entry.completedAt <= nowMs - BOARD_API_KEY_TOUCH_DEBOUNCE_MS) {
        touchedBoardApiKeys.delete(id);
      }
    }
    while (touchedBoardApiKeys.size > BOARD_API_KEY_TOUCH_CACHE_MAX) {
      const oldestId = touchedBoardApiKeys.keys().next().value;
      if (!oldestId) break;
      touchedBoardApiKeys.delete(oldestId);
    }
  }
  async function resolveBoardAccess(userId: string, authorityDb: Pick<Db, "select"> = db) {
    const [user, memberships, adminRole] = await Promise.all([
      authorityDb
        .select({
          id: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
        })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      authorityDb
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
        )
        .then((rows) => rows),
      authorityDb
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
    ]);

    return {
      user,
      companyIds: memberships.map((row) => row.companyId),
      memberships,
      isInstanceAdmin: Boolean(adminRole),
    };
  }

  async function activityCompanyIdsForAccess(
    access: Awaited<ReturnType<typeof resolveBoardAccess>>,
    requestedCompanyId: string | null | undefined,
    authorityDb: Pick<Db, "select"> = db,
  ) {
    const companyIds = new Set(access.companyIds);
    const requested = requestedCompanyId?.trim();
    if (requested && (access.isInstanceAdmin || access.companyIds.includes(requested))) companyIds.add(requested);
    if (companyIds.size === 0 && access.isInstanceAdmin) {
      const allCompanyIds = await authorityDb.select({ id: companies.id }).from(companies);
      for (const company of allCompanyIds) companyIds.add(company.id);
    }
    return Array.from(companyIds);
  }

  async function resolveBoardActivityCompanyIds(input: {
    userId: string;
    requestedCompanyId?: string | null;
    boardApiKeyId?: string | null;
  }) {
    return activityCompanyIdsForAccess(await resolveBoardAccess(input.userId), input.requestedCompanyId);
  }

  async function findBoardApiKeyByToken(token: string) {
    const tokenHash = hashBearerToken(token);
    const now = new Date();
    return db
      .select()
      .from(boardApiKeys)
      .where(
        and(
          eq(boardApiKeys.keyHash, tokenHash),
          isNull(boardApiKeys.revokedAt),
        ),
      )
      .then((rows) => rows.find((row) => !row.expiresAt || row.expiresAt.getTime() > now.getTime()) ?? null);
  }

  async function touchBoardApiKey(id: string) {
    const nowMs = Date.now();
    pruneTouchedBoardApiKeys(nowMs);
    const cached = touchedBoardApiKeys.get(id);
    if (cached?.inFlight) return cached.inFlight;
    if (cached?.completedAt !== null && cached?.completedAt !== undefined
      && cached.completedAt > nowMs - BOARD_API_KEY_TOUCH_DEBOUNCE_MS) return;

    const inFlight = db
      .update(boardApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(boardApiKeys.id, id))
      .then(() => {
        touchedBoardApiKeys.delete(id);
        touchedBoardApiKeys.set(id, { completedAt: Date.now(), inFlight: null });
        pruneTouchedBoardApiKeys(Date.now());
      })
      .catch((error) => {
        if (touchedBoardApiKeys.get(id)?.inFlight === inFlight) touchedBoardApiKeys.delete(id);
        throw error;
      });
    touchedBoardApiKeys.set(id, { completedAt: null, inFlight });
    return inFlight;
  }

  async function revokeBoardApiKey(id: string, input: {
    userId: string;
    revokedVia: "cli_auth_logout" | "board_api_key_lifecycle";
  }) {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select ${boardApiKeys.id} from ${boardApiKeys}
        where ${boardApiKeys.id} = ${id} and ${boardApiKeys.userId} = ${input.userId} for update`);
      const [key] = await tx.select().from(boardApiKeys).where(and(eq(boardApiKeys.id, id), eq(boardApiKeys.userId, input.userId)));
      if (!key || key.revokedAt) return null;
      const access = await resolveBoardAccess(key.userId, tx);
      const companyIds = new Set(await activityCompanyIdsForAccess(access, null, tx));
      const created = await tx.select({ companyId: activityLog.companyId }).from(activityLog)
        .innerJoin(companies, eq(companies.id, activityLog.companyId))
        .where(and(eq(activityLog.actorType, "user"), eq(activityLog.actorId, key.userId),
          eq(activityLog.responsibleUserId, key.userId), eq(activityLog.entityType, "user"), eq(activityLog.entityId, key.userId),
          eq(activityLog.action, "board_api_key.created"), sql`${activityLog.details}->>'boardApiKeyId' = ${key.id}`));
      for (const row of created) companyIds.add(row.companyId);
      const approved = await tx.select({ companyId: cliAuthChallenges.requestedCompanyId }).from(cliAuthChallenges)
        .innerJoin(companies, eq(companies.id, cliAuthChallenges.requestedCompanyId))
        .where(and(eq(cliAuthChallenges.boardApiKeyId, key.id), eq(cliAuthChallenges.approvedByUserId, key.userId),
          sql`${cliAuthChallenges.approvedAt} is not null`));
      for (const row of approved) if (row.companyId) companyIds.add(row.companyId);
      const now = new Date();
      const [revoked] = await tx.update(boardApiKeys).set({ revokedAt: now, lastUsedAt: now })
        .where(and(eq(boardApiKeys.id, key.id), eq(boardApiKeys.userId, input.userId), isNull(boardApiKeys.revokedAt))).returning();
      if (!revoked) return null;
      for (const companyId of companyIds) {
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: key.userId, action: "board_api_key.revoked", entityType: "user", entityId: key.userId,
          details: { boardApiKeyId: key.id, revokedVia: input.revokedVia,
            ...(input.revokedVia === "board_api_key_lifecycle" ? { name: key.name } : {}) },
        }, publications);
      }
      return revoked;
    });
    for (const publication of publications) {
      try { publishActivity(publication); }
      catch (err) { logger.warn({ err }, "Failed to publish committed Board key revocation activity"); }
    }
    return result;
  }

  async function createNamedBoardApiKey(input: {
    userId: string;
    name: string;
    expiresAt?: Date | null;
  }) {
    const token = createBoardApiToken();
    const created = await db
      .insert(boardApiKeys)
      .values({
        userId: input.userId,
        name: input.name.trim(),
        keyHash: hashBearerToken(token),
        expiresAt: input.expiresAt === undefined ? boardApiKeyExpiresAt() : input.expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);

    return {
      id: created.id,
      name: created.name,
      token,
      createdAt: created.createdAt,
      lastUsedAt: created.lastUsedAt,
      revokedAt: created.revokedAt,
      expiresAt: created.expiresAt,
    };
  }

  async function listBoardApiKeys(
    userId: string,
    opts: { includeInactive?: boolean } = {},
  ) {
    const conditions = [eq(boardApiKeys.userId, userId)];
    if (!opts.includeInactive) {
      const activeExpirationCondition = or(
        isNull(boardApiKeys.expiresAt),
        gt(boardApiKeys.expiresAt, new Date()),
      );
      conditions.push(
        isNull(boardApiKeys.revokedAt),
      );
      if (activeExpirationCondition) conditions.push(activeExpirationCondition);
    }
    return db
      .select({
        id: boardApiKeys.id,
        name: boardApiKeys.name,
        createdAt: boardApiKeys.createdAt,
        lastUsedAt: boardApiKeys.lastUsedAt,
        revokedAt: boardApiKeys.revokedAt,
        expiresAt: boardApiKeys.expiresAt,
      })
      .from(boardApiKeys)
      .where(and(...conditions))
      .orderBy(sql`${boardApiKeys.createdAt} desc`);
  }

  async function getBoardApiKeyForUser(keyId: string, userId: string) {
    return db
      .select({
        id: boardApiKeys.id,
        userId: boardApiKeys.userId,
        name: boardApiKeys.name,
        createdAt: boardApiKeys.createdAt,
        lastUsedAt: boardApiKeys.lastUsedAt,
        revokedAt: boardApiKeys.revokedAt,
        expiresAt: boardApiKeys.expiresAt,
      })
      .from(boardApiKeys)
      .where(and(eq(boardApiKeys.id, keyId), eq(boardApiKeys.userId, userId)))
      .then((rows) => rows[0] ?? null);
  }

  async function createCliAuthChallenge(input: {
    command: string;
    clientName?: string | null;
    requestedAccess: "board" | "instance_admin_required";
    requestedCompanyId?: string | null;
  }) {
    const challengeSecret = createCliAuthSecret();
    const pendingBoardToken = createBoardApiToken();
    const expiresAt = cliAuthChallengeExpiresAt();
    const labelBase = input.clientName?.trim() || "paperclipai cli";
    const pendingKeyName =
      input.requestedAccess === "instance_admin_required"
        ? `${labelBase} (instance admin)`
        : `${labelBase} (board)`;

    const created = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(challengeSecret),
        command: input.command.trim(),
        clientName: input.clientName?.trim() || null,
        requestedAccess: input.requestedAccess,
        requestedCompanyId: input.requestedCompanyId?.trim() || null,
        pendingKeyHash: hashBearerToken(pendingBoardToken),
        pendingKeyName,
        expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);

    return {
      challenge: created,
      challengeSecret,
      pendingBoardToken,
    };
  }

  async function getCliAuthChallenge(id: string) {
    return db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getCliAuthChallengeBySecret(id: string, token: string) {
    const challenge = await getCliAuthChallenge(id);
    if (!challenge) return null;
    if (!tokenHashesMatch(challenge.secretHash, hashBearerToken(token))) return null;
    return challenge;
  }

  async function describeCliAuthChallenge(id: string, token: string, options: { viewerUserId?: string } = {}) {
    const challenge = await getCliAuthChallengeBySecret(id, token);
    if (!challenge) return null;

    const access = options.viewerUserId ? await resolveBoardAccess(options.viewerUserId) : null;
    const canReadCompany = challenge.requestedCompanyId && access
      && (access.isInstanceAdmin || access.companyIds.includes(challenge.requestedCompanyId));
    const company = canReadCompany
      ? await db.select({ name: companies.name }).from(companies)
          .where(eq(companies.id, challenge.requestedCompanyId!)).then(rows => rows[0] ?? null)
      : null;

    return {
      id: challenge.id,
      status: challengeStatusForRow(challenge),
      command: challenge.command,
      clientName: challenge.clientName ?? null,
      requestedAccess: challenge.requestedAccess as "board" | "instance_admin_required",
      requestedCompanyId: challenge.requestedCompanyId ?? null,
      requestedCompanyName: company?.name ?? null,
      approvedAt: challenge.approvedAt?.toISOString() ?? null,
      cancelledAt: challenge.cancelledAt?.toISOString() ?? null,
      expiresAt: challenge.expiresAt.toISOString(),
      approvedByUser: null,
    };
  }

  async function approveCliAuthChallenge(id: string, token: string, userId: string) {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${cliAuthChallenges.id} from ${cliAuthChallenges} where ${cliAuthChallenges.id} = ${id} for update`,
      );

      const challenge = await tx
        .select()
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.id, id))
        .then((rows) => rows[0] ?? null);
      if (!challenge || !tokenHashesMatch(challenge.secretHash, hashBearerToken(token))) {
        throw notFound("CLI auth challenge not found");
      }

      const status = challengeStatusForRow(challenge);
      if (status === "expired") return { status, challenge };
      if (status === "cancelled") return { status, challenge };

      if (status === "approved") {
        if (challenge.approvedByUserId !== userId) {
          throw conflict("CLI auth challenge was approved by another user");
        }
        return { status, challenge, created: false };
      }

      const access = await resolveBoardAccess(userId, tx);
      if (!access.user) throw forbidden("Board user required");
      if (challenge.requestedCompanyId && !access.isInstanceAdmin
        && !access.companyIds.includes(challenge.requestedCompanyId)) {
        throw forbidden("Access to the requested organization is required");
      }

      if (challenge.requestedAccess === "instance_admin_required" && !access.isInstanceAdmin) {
        throw forbidden("Instance admin required");
      }

      let boardKeyId = challenge.boardApiKeyId;
      if (!boardKeyId) {
        const createdKey = await tx
          .insert(boardApiKeys)
          .values({
            userId,
            name: challenge.pendingKeyName,
            keyHash: challenge.pendingKeyHash,
            expiresAt: boardApiKeyExpiresAt(),
          })
          .returning()
          .then((rows) => rows[0]);
        boardKeyId = createdKey.id;
      }

      const approvedAt = challenge.approvedAt ?? new Date();
      const updated = await tx
        .update(cliAuthChallenges)
        .set({
          approvedByUserId: userId,
          boardApiKeyId: boardKeyId,
          approvedAt,
          updatedAt: new Date(),
        })
        .where(eq(cliAuthChallenges.id, challenge.id))
        .returning()
        .then((rows) => rows[0] ?? challenge);

      const companyIds = await activityCompanyIdsForAccess(access, challenge.requestedCompanyId, tx);
      for (const companyId of companyIds) {
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId,
          action: "board_api_key.created", entityType: "user", entityId: userId,
          details: {
            boardApiKeyId: updated.boardApiKeyId,
            requestedAccess: updated.requestedAccess,
            requestedCompanyId: updated.requestedCompanyId,
            challengeId: updated.id,
          },
        }, publications);
      }
      return { status: "approved" as const, challenge: updated, created: true };
    });
    for (const publication of publications) {
      try { publishActivity(publication); }
      catch (err) { logger.warn({ err }, "Failed to publish committed CLI approval activity"); }
    }
    return result;
  }

  async function cancelCliAuthChallenge(id: string, token: string) {
    return db.transaction(async tx => {
      await tx.execute(sql`select ${cliAuthChallenges.id} from ${cliAuthChallenges} where ${cliAuthChallenges.id} = ${id} for update`);
      const challenge = await tx.select().from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.id, id)).then(rows => rows[0] ?? null);
      if (!challenge || !tokenHashesMatch(challenge.secretHash, hashBearerToken(token))) {
        throw notFound("CLI auth challenge not found");
      }
      const status = challengeStatusForRow(challenge);
      if (status !== "pending") return { status, challenge };
      const updated = await tx.update(cliAuthChallenges)
        .set({ cancelledAt: new Date(), updatedAt: new Date() })
        .where(eq(cliAuthChallenges.id, challenge.id)).returning()
        .then(rows => rows[0] ?? challenge);
      return { status: "cancelled" as const, challenge: updated };
    });
  }

  async function assertCurrentBoardKey(keyId: string | undefined, userId: string | undefined) {
    if (!keyId || !userId) throw conflict("Board API key context is required");
    const key = await db
      .select()
      .from(boardApiKeys)
      .where(and(eq(boardApiKeys.id, keyId), eq(boardApiKeys.userId, userId)))
      .then((rows) => rows[0] ?? null);
    if (!key || key.revokedAt) throw notFound("Board API key not found");
    return key;
  }

  return {
    resolveBoardAccess,
    findBoardApiKeyByToken,
    touchBoardApiKey,
    revokeBoardApiKey,
    createNamedBoardApiKey,
    listBoardApiKeys,
    getBoardApiKeyForUser,
    createCliAuthChallenge,
    getCliAuthChallengeBySecret,
    describeCliAuthChallenge,
    approveCliAuthChallenge,
    cancelCliAuthChallenge,
    assertCurrentBoardKey,
    resolveBoardActivityCompanyIds,
  };
}
