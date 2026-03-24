import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai_dld/db";
import { companies, companyMemberships, instanceUserRoles } from "@paperclipai_dld/db";
import type { DeploymentMode } from "@paperclipai_dld/shared";

const LOCAL_BOARD_USER_ID = "local-board";
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
  if (status !== "available") return { status };

  await db.transaction(async (tx) => {
    const existingTargetAdmin = await tx
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, opts.userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (!existingTargetAdmin) {
      await tx.insert(instanceUserRoles).values({
        userId: opts.userId,
        role: "instance_admin",
      });
    }

    await tx
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")));

    const allCompanies = await tx.select({ id: companies.id }).from(companies);
    for (const company of allCompanies) {
      const existing = await tx
        .select({ id: companyMemberships.id, status: companyMemberships.status })
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
        continue;
      }

      if (existing.status !== "active") {
        await tx
          .update(companyMemberships)
          .set({ status: "active", membershipRole: "owner", updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id));
      }
    }
  });

  if (activeChallenge && activeChallenge.token === opts.token) {
    activeChallenge.claimedAt = new Date();
    activeChallenge.claimedByUserId = opts.userId;
  }

  return { status: "claimed", claimedByUserId: opts.userId };
}
