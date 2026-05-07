import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, invites, joinRequests } from "@paperclipai/db";
import type {
  CompanyInviteListResponse,
  CompanyInviteRecord,
  CreateCompanyInvite,
  HumanCompanyMembershipRole,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { grantsForHumanRole, resolveHumanInviteRole } from "./company-member-roles.js";

const INVITE_TOKEN_PREFIX = "pcp_invite_";
const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const INVITE_TOKEN_SUFFIX_LENGTH = 8;
const INVITE_TOKEN_MAX_RETRIES = 5;
const COMPANY_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createInviteToken() {
  const bytes = randomBytes(INVITE_TOKEN_SUFFIX_LENGTH);
  let suffix = "";
  for (let index = 0; index < INVITE_TOKEN_SUFFIX_LENGTH; index += 1) {
    suffix += INVITE_TOKEN_ALPHABET[bytes[index]! % INVITE_TOKEN_ALPHABET.length];
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

function companyInviteExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + COMPANY_INVITE_TTL_MS);
}

function isInviteTokenHashCollisionError(error: unknown) {
  return error instanceof Error && /invite.*token.*unique|invites_token_hash/i.test(error.message);
}

function extractInviteMessage(invite: typeof invites.$inferSelect): string | null {
  const defaultsPayload = invite.defaultsPayload;
  if (!defaultsPayload || typeof defaultsPayload !== "object" || Array.isArray(defaultsPayload)) {
    return null;
  }
  const rawMessage = (defaultsPayload as Record<string, unknown>).agentMessage;
  if (typeof rawMessage !== "string") return null;
  const trimmed = rawMessage.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeInviteDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  agentMessage: string | null,
  humanRole: HumanCompanyMembershipRole | null,
) {
  const merged =
    defaultsPayload && typeof defaultsPayload === "object" ? { ...defaultsPayload } : {};
  if (humanRole) {
    const existingHuman =
      merged.human && typeof merged.human === "object" && !Array.isArray(merged.human)
        ? { ...(merged.human as Record<string, unknown>) }
        : {};
    merged.human = {
      ...existingHuman,
      role: humanRole,
      grants: grantsForHumanRole(humanRole),
    };
  }
  if (agentMessage) {
    merged.agentMessage = agentMessage;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function inviteExpired(invite: typeof invites.$inferSelect) {
  return invite.expiresAt.getTime() <= Date.now();
}

function inviteState(invite: typeof invites.$inferSelect) {
  if (invite.revokedAt) return "revoked" as const;
  if (invite.acceptedAt) return "accepted" as const;
  if (inviteExpired(invite)) return "expired" as const;
  return "active" as const;
}

function extractInviteHumanRole(invite: typeof invites.$inferSelect) {
  if (invite.allowedJoinTypes === "agent") return null;
  return resolveHumanInviteRole(
    invite.defaultsPayload as Record<string, unknown> | null | undefined,
  );
}

function inviteStateWhereClause(
  state: "active" | "accepted" | "expired" | "revoked" | undefined,
) {
  const now = new Date();
  switch (state) {
    case "active":
      return and(
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      );
    case "accepted":
      return isNotNull(invites.acceptedAt);
    case "expired":
      return and(
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        lte(invites.expiresAt, now),
      );
    case "revoked":
      return isNotNull(invites.revokedAt);
    default:
      return undefined;
  }
}

function toUserProfile(
  user:
    | {
        id: string;
        email: string | null;
        name: string | null;
        image: string | null;
      }
    | null
    | undefined,
) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  };
}

async function loadUsersById(db: Db, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, ReturnType<typeof toUserProfile>>();
  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(inArray(authUsers.id, userIds));
  return new Map(rows.map((row) => [row.id, toUserProfile(row)]));
}

export function inviteService(db: Db) {
  return {
    getById: (inviteId: string) =>
      db
        .select()
        .from(invites)
        .where(eq(invites.id, inviteId))
        .then((rows) => rows[0] ?? null),

    list: async (
      companyId: string,
      options: {
        state?: "active" | "accepted" | "expired" | "revoked";
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<CompanyInviteListResponse> => {
      const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
      const offset = Math.max(0, options.offset ?? 0);
      const whereClause = inviteStateWhereClause(options.state);
      const rows = await db
        .select()
        .from(invites)
        .where(
          whereClause
            ? and(eq(invites.companyId, companyId), whereClause)
            : eq(invites.companyId, companyId),
        )
        .orderBy(desc(invites.createdAt))
        .limit(limit + 1)
        .offset(offset);

      const hasMore = rows.length > limit;
      const visibleRows = hasMore ? rows.slice(0, limit) : rows;
      const userIds = [
        ...new Set(
          visibleRows
            .map((invite) => invite.invitedByUserId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];

      const [userMap, joinRows, companyName] = await Promise.all([
        loadUsersById(db, userIds),
        visibleRows.length > 0
          ? db
              .select({ id: joinRequests.id, inviteId: joinRequests.inviteId })
              .from(joinRequests)
              .where(
                and(
                  eq(joinRequests.companyId, companyId),
                  inArray(
                    joinRequests.inviteId,
                    visibleRows.map((invite) => invite.id),
                  ),
                ),
              )
          : Promise.resolve([]),
        db
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((companyRows) => companyRows[0]?.name ?? null),
      ]);

      const joinRequestIdByInviteId = new Map(
        joinRows.map((row) => [row.inviteId, row.id]),
      );

      return {
        invites: visibleRows.map(
          (invite): CompanyInviteRecord => ({
            ...invite,
            inviteType: invite.inviteType as CompanyInviteRecord["inviteType"],
            allowedJoinTypes: invite.allowedJoinTypes as CompanyInviteRecord["allowedJoinTypes"],
            companyName,
            humanRole: extractInviteHumanRole(invite),
            inviteMessage: extractInviteMessage(invite),
            state: inviteState(invite),
            invitedByUser: invite.invitedByUserId
              ? userMap.get(invite.invitedByUserId) ?? null
              : null,
            relatedJoinRequestId: joinRequestIdByInviteId.get(invite.id) ?? null,
          }),
        ),
        nextOffset: hasMore ? offset + limit : null,
      };
    },

    create: async (
      companyId: string,
      input: CreateCompanyInvite,
      actor: { userId: string | null },
    ) => {
      const normalizedAgentMessage =
        typeof input.agentMessage === "string" ? input.agentMessage.trim() || null : null;
      const effectiveHumanRole =
        input.allowedJoinTypes === "agent"
          ? null
          : (input.humanRole ?? "operator");
      const insertValues = {
        companyId,
        inviteType: "company_join" as const,
        allowedJoinTypes: input.allowedJoinTypes,
        defaultsPayload: mergeInviteDefaults(
          input.defaultsPayload ?? null,
          normalizedAgentMessage,
          effectiveHumanRole,
        ),
        expiresAt: companyInviteExpiresAt(),
        invitedByUserId: actor.userId,
      };

      let token: string | null = null;
      let created: typeof invites.$inferSelect | null = null;
      for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
        const candidateToken = createInviteToken();
        try {
          created = await db
            .insert(invites)
            .values({
              ...insertValues,
              tokenHash: hashToken(candidateToken),
            })
            .returning()
            .then((rows) => rows[0] ?? null);
          token = candidateToken;
          break;
        } catch (error) {
          if (!isInviteTokenHashCollisionError(error)) {
            throw error;
          }
        }
      }

      if (!token || !created) {
        throw conflict("Failed to generate a unique invite token. Please retry.");
      }

      return {
        invite: created,
        token,
        invitePath: `/invite/${token}`,
        inviteUrl: null as string | null,
        humanRole: extractInviteHumanRole(created),
        inviteMessage: extractInviteMessage(created),
      };
    },

    revoke: async (inviteId: string) => {
      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.id, inviteId))
        .then((rows) => rows[0] ?? null);
      if (!invite) throw notFound("Invite not found");
      if (invite.acceptedAt) throw conflict("Invite already consumed");
      if (invite.revokedAt) return invite;

      const revoked = await db
        .update(invites)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(invites.id, inviteId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!revoked) throw notFound("Invite not found");
      return revoked;
    },
  };
}
