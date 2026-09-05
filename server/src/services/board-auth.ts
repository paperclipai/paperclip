import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  boardApiKeyScopeConfigSchema,
  deriveBoardApiKeyStatus,
  type BoardApiKeyScopeConfig,
} from "@paperclipai/shared";
import {
  authUsers,
  boardApiKeys,
  cliAuthChallenges,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";

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

export function boardApiKeyTokenPrefix(token: string) {
  return token.slice(0, "pcp_board_".length + 12);
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
  const touchedBoardApiKeys = new Map<
    string,
    { completedAt: number | null; inFlight: Promise<{ id: string } | null> | null }
  >();

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
  async function resolveBoardAccess(userId: string) {
    const [user, memberships, adminRole] = await Promise.all([
      db
        .select({
          id: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
        })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
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
        )
        .then((rows) => rows),
      db
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

  async function resolveBoardActivityCompanyIds(input: {
    userId: string;
    requestedCompanyId?: string | null;
    boardApiKeyId?: string | null;
  }) {
    const access = await resolveBoardAccess(input.userId);
    const companyIds = new Set(access.companyIds);

    if (companyIds.size === 0 && input.requestedCompanyId?.trim()) {
      companyIds.add(input.requestedCompanyId.trim());
    }

    if (companyIds.size === 0 && input.boardApiKeyId?.trim()) {
      const challengeCompanyIds = await db
        .select({ requestedCompanyId: cliAuthChallenges.requestedCompanyId })
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.boardApiKeyId, input.boardApiKeyId.trim()))
        .then((rows) =>
          rows
            .map((row) => row.requestedCompanyId?.trim() ?? null)
            .filter((value): value is string => Boolean(value)),
        );
      for (const companyId of challengeCompanyIds) {
        companyIds.add(companyId);
      }
    }

    if (companyIds.size === 0 && access.isInstanceAdmin) {
      const allCompanyIds = await db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id));
      for (const companyId of allCompanyIds) {
        companyIds.add(companyId);
      }
    }

    return Array.from(companyIds);
  }

  async function findBoardApiKeyByToken(token: string) {
    const tokenHash = hashBearerToken(token);
    return db
      .select()
      .from(boardApiKeys)
      .where(eq(boardApiKeys.keyHash, tokenHash))
      .then((rows) => rows[0] ?? null);
  }

  async function touchBoardApiKey(id: string, now: Date = new Date()) {
    const nowMs = now.getTime();
    pruneTouchedBoardApiKeys(nowMs);
    const cached = touchedBoardApiKeys.get(id);
    if (cached?.inFlight) return cached.inFlight;
    if (
      cached?.completedAt !== null
      && cached?.completedAt !== undefined
      && cached.completedAt > nowMs - BOARD_API_KEY_TOUCH_DEBOUNCE_MS
    ) {
      return { id };
    }

    const inFlight = db
      .update(boardApiKeys)
      .set({ lastUsedAt: now })
      .where(and(
        eq(boardApiKeys.id, id),
        isNull(boardApiKeys.revokedAt),
        or(isNull(boardApiKeys.expiresAt), gt(boardApiKeys.expiresAt, now)),
      ))
      .returning({ id: boardApiKeys.id })
      .then((rows) => {
        const touched = rows[0] ?? null;
        touchedBoardApiKeys.delete(id);
        if (touched) {
          touchedBoardApiKeys.set(id, { completedAt: Date.now(), inFlight: null });
          pruneTouchedBoardApiKeys(Date.now());
        }
        return touched;
      })
      .catch((error) => {
        if (touchedBoardApiKeys.get(id)?.inFlight === inFlight) touchedBoardApiKeys.delete(id);
        throw error;
      });
    touchedBoardApiKeys.set(id, { completedAt: null, inFlight });
    return inFlight;
  }

  async function authenticateBoardApiKey(token: string) {
    const key = await findBoardApiKeyByToken(token);
    if (!key) return { ok: false as const, reason: "unknown_key" as const, key: null };
    if (key.revokedAt) return { ok: false as const, reason: "revoked" as const, key };
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      return { ok: false as const, reason: "expired" as const, key };
    }

    let scopeConfig: BoardApiKeyScopeConfig | null;
    if (key.legacyUnrestricted === true && key.scopeConfig === null) {
      scopeConfig = null;
    } else if (key.legacyUnrestricted === false && key.scopeConfig !== null) {
      const parsed = boardApiKeyScopeConfigSchema.safeParse(key.scopeConfig);
      if (!parsed.success) return { ok: false as const, reason: "malformed_scope" as const, key };
      scopeConfig = parsed.data;
    } else {
      return { ok: false as const, reason: "malformed_scope" as const, key };
    }

    const access = await resolveBoardAccess(key.userId);
    if (!access.user) return { ok: false as const, reason: "owner_deleted" as const, key };

    // This conditional update is the final authentication commit point. A
    // concurrent revocation/expiry cannot be overwritten or authenticated.
    const touched = await touchBoardApiKey(key.id);
    if (!touched) return { ok: false as const, reason: "revoked" as const, key };

    return { ok: true as const, key, scopeConfig, access };
  }

  async function revokeBoardApiKey(id: string) {
    const now = new Date();
    return db
      .update(boardApiKeys)
      .set({ revokedAt: now })
      .where(and(eq(boardApiKeys.id, id), isNull(boardApiKeys.revokedAt)))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function createNamedBoardApiKey(input: {
    userId: string;
    name: string;
    expiresAt?: Date | null;
    scopeConfig: BoardApiKeyScopeConfig;
  }) {
    const token = createBoardApiToken();
    const scopeConfig = boardApiKeyScopeConfigSchema.parse(input.scopeConfig);
    const created = await db
      .insert(boardApiKeys)
      .values({
        userId: input.userId,
        name: input.name,
        keyHash: hashBearerToken(token),
        tokenPrefix: boardApiKeyTokenPrefix(token),
        scopeConfig,
        expiresAt: input.expiresAt === undefined ? boardApiKeyExpiresAt() : input.expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);

    return {
      id: created.id,
      name: created.name,
      token,
      tokenPrefix: created.tokenPrefix,
      scopeConfig,
      legacyUnrestricted: false,
      status: deriveBoardApiKeyStatus(created),
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
        tokenPrefix: boardApiKeys.tokenPrefix,
        scopeConfig: boardApiKeys.scopeConfig,
        legacyUnrestricted: boardApiKeys.legacyUnrestricted,
        createdAt: boardApiKeys.createdAt,
        lastUsedAt: boardApiKeys.lastUsedAt,
        revokedAt: boardApiKeys.revokedAt,
        expiresAt: boardApiKeys.expiresAt,
      })
      .from(boardApiKeys)
      .where(and(...conditions))
      .orderBy(sql`${boardApiKeys.createdAt} desc`)
      .then((rows) => rows.map((row) => ({ ...row, status: deriveBoardApiKeyStatus(row) })));
  }

  async function getBoardApiKeyForUser(keyId: string, userId: string) {
    return db
      .select({
        id: boardApiKeys.id,
        userId: boardApiKeys.userId,
        name: boardApiKeys.name,
        tokenPrefix: boardApiKeys.tokenPrefix,
        scopeConfig: boardApiKeys.scopeConfig,
        legacyUnrestricted: boardApiKeys.legacyUnrestricted,
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
    scopeConfig: BoardApiKeyScopeConfig;
  }) {
    const challengeSecret = createCliAuthSecret();
    const pendingBoardToken = createBoardApiToken();
    const scopeConfig = boardApiKeyScopeConfigSchema.parse(input.scopeConfig);
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
        requestedScopeConfig: scopeConfig,
        pendingKeyHash: hashBearerToken(pendingBoardToken),
        pendingKeyPrefix: boardApiKeyTokenPrefix(pendingBoardToken),
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

  async function describeCliAuthChallenge(id: string, token: string) {
    const challenge = await getCliAuthChallengeBySecret(id, token);
    if (!challenge) return null;
    const requestedScope = boardApiKeyScopeConfigSchema.safeParse(challenge.requestedScopeConfig);

    const [company, approvedBy] = await Promise.all([
      challenge.requestedCompanyId
        ? db
            .select({ id: companies.id, name: companies.name })
            .from(companies)
            .where(eq(companies.id, challenge.requestedCompanyId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      challenge.approvedByUserId
        ? db
            .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
            .from(authUsers)
            .where(eq(authUsers.id, challenge.approvedByUserId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    return {
      id: challenge.id,
      status: challengeStatusForRow(challenge),
      command: challenge.command,
      clientName: challenge.clientName ?? null,
      requestedAccess: challenge.requestedAccess as "board" | "instance_admin_required",
      requestedCompanyId: challenge.requestedCompanyId ?? null,
      requestedCompanyName: company?.name ?? null,
      requestedScopeConfig: requestedScope.success ? requestedScope.data : null,
      approvedAt: challenge.approvedAt?.toISOString() ?? null,
      cancelledAt: challenge.cancelledAt?.toISOString() ?? null,
      expiresAt: challenge.expiresAt.toISOString(),
      boardApiKeyId: challenge.boardApiKeyId ?? null,
      approvedByUser: approvedBy
        ? {
            id: approvedBy.id,
            name: approvedBy.name,
            email: approvedBy.email,
          }
        : null,
    };
  }

  async function approveCliAuthChallenge(id: string, token: string, userId: string) {
    const access = await resolveBoardAccess(userId);
    return db.transaction(async (tx) => {
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

      if (challenge.requestedAccess === "instance_admin_required" && !access.isInstanceAdmin) {
        throw forbidden("Instance admin required");
      }

      const requestedScope = boardApiKeyScopeConfigSchema.safeParse(challenge.requestedScopeConfig);
      if (!requestedScope.success || !challenge.pendingKeyPrefix) {
        throw conflict("CLI auth challenge must be recreated with an explicit board-key scope");
      }

      let boardKeyId = challenge.boardApiKeyId;
      if (!boardKeyId) {
        const createdKey = await tx
          .insert(boardApiKeys)
          .values({
            userId,
            name: challenge.pendingKeyName,
            keyHash: challenge.pendingKeyHash,
            tokenPrefix: challenge.pendingKeyPrefix,
            scopeConfig: requestedScope.data,
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

      return { status: "approved" as const, challenge: updated };
    });
  }

  async function cancelCliAuthChallenge(id: string, token: string) {
    const challenge = await getCliAuthChallengeBySecret(id, token);
    if (!challenge) throw notFound("CLI auth challenge not found");

    const status = challengeStatusForRow(challenge);
    if (status === "approved") return { status, challenge };
    if (status === "expired") return { status, challenge };
    if (status === "cancelled") return { status, challenge };

    const updated = await db
      .update(cliAuthChallenges)
      .set({
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(cliAuthChallenges.id, challenge.id))
      .returning()
      .then((rows) => rows[0] ?? challenge);

    return { status: "cancelled" as const, challenge: updated };
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
    authenticateBoardApiKey,
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
