import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { ensureHumanRoleDefaultGrants } from "./services/principal-access-compatibility.js";
import { LOCAL_BOARD_USER_ID, transferLocalBoardOwnership } from "./local-board-ownership.js";

const CLAIM_TTL_MS = 1000 * 60 * 60 * 24;

type ChallengeStatus = "available" | "claimed" | "expired" | "invalid";

type ClaimChallenge = {
  token: string;
  code: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  claimedByUserId: string | null;
};

let activeChallenge: ClaimChallenge | null = null;

function createChallenge(now = new Date()): ClaimChallenge {
  return {
    token: randomBytes(24).toString("hex"),
    code: randomBytes(12).toString("hex"),
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
    claimedAt: null,
    claimedByUserId: null,
  };
}

function getChallengeStatus(token: string, code: string | undefined): ChallengeStatus {
  if (!activeChallenge) return "invalid";
  if (activeChallenge.token !== token) return "invalid";
  if (activeChallenge.code !== (code ?? "")) return "invalid";
  if (activeChallenge.claimedAt) return "claimed";
  if (activeChallenge.expiresAt.getTime() <= Date.now()) return "expired";
  return "available";
}

export async function initializeBoardClaimChallenge(
  db: Db,
  opts: { deploymentMode: DeploymentMode },
): Promise<void> {
  if (opts.deploymentMode !== "authenticated") {
    activeChallenge = null;
    return;
  }

  const admins = await db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"));

  const onlyLocalBoardAdmin = admins.length === 1 && admins[0]?.userId === LOCAL_BOARD_USER_ID;
  if (!onlyLocalBoardAdmin) {
    activeChallenge = null;
    if (admins.length === 1 && admins[0]?.userId !== LOCAL_BOARD_USER_ID) {
      const userId = admins[0]!.userId;
      await db.transaction(async (tx) => {
        await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);
        const currentAdmins = await tx.select({ userId: instanceUserRoles.userId })
          .from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
        if (currentAdmins.length !== 1 || currentAdmins[0]?.userId !== userId) return;
        const ownedCompanies = await tx.select({ companyId: companyMemberships.companyId })
          .from(companyMemberships).innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId)).where(and(
            eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"), eq(companyMemberships.membershipRole, "owner"),
          ));
        for (const { companyId } of ownedCompanies) {
          await transferLocalBoardOwnership(tx, companyId, userId);
        }
      });
    }
    return;
  }

  if (!activeChallenge || activeChallenge.expiresAt.getTime() <= Date.now() || activeChallenge.claimedAt) {
    activeChallenge = createChallenge();
  }
}

export function getBoardClaimWarningUrl(host: string, port: number): string | null {
  if (!activeChallenge) return null;
  if (activeChallenge.claimedAt || activeChallenge.expiresAt.getTime() <= Date.now()) return null;
  const visibleHost = host === "0.0.0.0" ? "localhost" : host;
  return `http://${visibleHost}:${port}/board-claim/${activeChallenge.token}?code=${activeChallenge.code}`;
}

export function inspectBoardClaimChallenge(token: string, code: string | undefined) {
  const status = getChallengeStatus(token, code);
  return {
    status,
    requiresSignIn: true,
    expiresAt: activeChallenge?.expiresAt?.toISOString() ?? null,
    claimedByUserId: activeChallenge?.claimedByUserId ?? null,
  };
}

export async function claimBoardOwnership(
  db: Db,
  opts: { token: string; code: string | undefined; userId: string },
): Promise<{ status: ChallengeStatus; claimedByUserId?: string }> {
  const status = getChallengeStatus(opts.token, opts.code);
  if (status === "claimed" && activeChallenge?.claimedByUserId) {
    return { status, claimedByUserId: activeChallenge.claimedByUserId };
  }
  if (status !== "available") return { status };
  if (opts.userId === LOCAL_BOARD_USER_ID) return { status: "invalid" };

  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);
    const admins = await tx.select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
    if (admins.length !== 1 || admins[0]?.userId !== LOCAL_BOARD_USER_ID) return false;
    await tx.insert(instanceUserRoles).values({ userId: opts.userId, role: "instance_admin" });

    await tx
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")));

    const allCompanies = await tx.select({ id: companies.id }).from(companies);
    for (const company of allCompanies) {
      const existing = await tx
        .select({ id: companyMemberships.id, status: companyMemberships.status, membershipRole: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, opts.userId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) {
        await tx.insert(companyMemberships).values({
          companyId: company.id,
          principalType: "user",
          principalId: opts.userId,
          status: "active",
          membershipRole: "owner",
        });
      } else if (existing.status !== "active" || existing.membershipRole !== "owner") {
        await tx
          .update(companyMemberships)
          .set({ status: "active", membershipRole: "owner", updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id));
      }
      await transferLocalBoardOwnership(tx, company.id, opts.userId);
      await ensureHumanRoleDefaultGrants(tx as unknown as Db, {
        companyId: company.id,
        principalId: opts.userId,
        membershipRole: "owner",
        grantedByUserId: opts.userId,
      });
    }
    return true;
  });
  if (!claimed) return { status: "invalid" };

  if (activeChallenge && activeChallenge.token === opts.token) {
    activeChallenge.claimedAt = new Date();
    activeChallenge.claimedByUserId = opts.userId;
  }

  return { status: "claimed", claimedByUserId: opts.userId };
}
