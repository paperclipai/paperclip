import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, gt } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { userInvites, authUsers, companyMemberships } from "@ironworksai/db";
import type { MembershipRole } from "@ironworksai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

const USER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return `iw_userinv_${randomBytes(24).toString("hex")}`;
}

export function userInviteService(db: Db) {
  async function create(input: {
    companyId: string;
    email: string;
    role: MembershipRole;
    invitedByUserId: string | null;
  }) {
    // Check if there is already an active (non-expired, non-revoked, non-accepted) invite
    const existingActive = await db
      .select()
      .from(userInvites)
      .where(
        and(
          eq(userInvites.companyId, input.companyId),
          eq(userInvites.email, input.email.toLowerCase().trim()),
          isNull(userInvites.acceptedAt),
          isNull(userInvites.revokedAt),
          gt(userInvites.expiresAt, new Date()),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existingActive) {
      throw conflict("An active invite already exists for this email");
    }

    // Check if the user is already a member
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, input.email.toLowerCase().trim()))
      .then((rows) => rows[0] ?? null);

    if (existingUser) {
      const existingMembership = await db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, input.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, existingUser.id),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existingMembership) {
        throw conflict("This user is already a member of this company");
      }
    }

    const token = generateToken();
    const tokenHashValue = hashToken(token);
    const expiresAt = new Date(Date.now() + USER_INVITE_TTL_MS);

    const invite = await db
      .insert(userInvites)
      .values({
        companyId: input.companyId,
        email: input.email.toLowerCase().trim(),
        role: input.role,
        tokenHash: tokenHashValue,
        invitedByUserId: input.invitedByUserId,
        expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);

    return { invite, token };
  }

  async function getByToken(token: string) {
    const tokenHashValue = hashToken(token);
    const invite = await db
      .select()
      .from(userInvites)
      .where(eq(userInvites.tokenHash, tokenHashValue))
      .then((rows) => rows[0] ?? null);

    if (!invite) return null;
    if (invite.revokedAt) return null;
    if (invite.acceptedAt) return null;
    if (invite.expiresAt < new Date()) return null;

    return invite;
  }

  async function accept(
    token: string,
    input: {
      name: string;
      password: string;
      tosAccepted: boolean;
    },
    betterAuth: {
      signUpEmail: (data: { name: string; email: string; password: string }) => Promise<{ id: string }>;
    },
  ) {
    const invite = await getByToken(token);
    if (!invite) throw notFound("Invite not found or expired");

    if (!input.tosAccepted) {
      throw unprocessable("You must accept the Terms of Service");
    }

    // Check if user already exists
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, invite.email))
      .then((rows) => rows[0] ?? null);

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
    } else {
      // Create user via Better Auth
      const newUser = await betterAuth.signUpEmail({
        name: input.name,
        email: invite.email,
        password: input.password,
      });
      userId = newUser.id;
    }

    // Add membership
    const existingMembership = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, invite.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existingMembership) {
      await db
        .update(companyMemberships)
        .set({
          status: "active",
          membershipRole: invite.role,
          updatedAt: new Date(),
        })
        .where(eq(companyMemberships.id, existingMembership.id));
    } else {
      await db.insert(companyMemberships).values({
        companyId: invite.companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: invite.role,
      });
    }

    // Mark invite as accepted
    const now = new Date();
    await db
      .update(userInvites)
      .set({
        acceptedAt: now,
        tosAcceptedAt: input.tosAccepted ? now : null,
        updatedAt: now,
      })
      .where(eq(userInvites.id, invite.id));

    return { userId, companyId: invite.companyId };
  }

  async function listForCompany(companyId: string) {
    return db
      .select()
      .from(userInvites)
      .where(eq(userInvites.companyId, companyId))
      .orderBy(userInvites.createdAt);
  }

  async function revoke(inviteId: string, companyId: string) {
    const invite = await db
      .select()
      .from(userInvites)
      .where(and(eq(userInvites.id, inviteId), eq(userInvites.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.acceptedAt) throw unprocessable("Invite already accepted");

    await db
      .update(userInvites)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(userInvites.id, invite.id));

    return invite;
  }

  return {
    create,
    getByToken,
    accept,
    listForCompany,
    revoke,
  };
}
