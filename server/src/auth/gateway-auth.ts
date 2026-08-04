import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import type { GatewayAuthConfig } from "../config.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { logger } from "../middleware/logger.js";

export function isGatewayHumanAuthEnabled(): boolean {
  return process.env.PAPERCLIP_HUMAN_AUTH_PROVIDER?.trim().toLowerCase() === "gateway";
}

export function assertGatewayAuthStartupConfig(gatewayAuth: GatewayAuthConfig | null): void {
  if (!gatewayAuth) return;
  if (!gatewayAuth.secret) {
    throw new Error(
      "PAPERCLIP_GATEWAY_AUTH_SECRET is required when PAPERCLIP_HUMAN_AUTH_PROVIDER=gateway",
    );
  }
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseGroupsHeader(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function roleSetMatches(groups: string[], allowedRoles: string[]): boolean {
  const allowed = new Set(allowedRoles.map((role) => role.trim()).filter(Boolean));
  return groups.some((group) => allowed.has(group));
}

function gatewayUserIdFromEmail(email: string): string {
  const bytes = createHash("sha256").update(`paperclip-gateway-user:${email.toLowerCase()}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function gatewayDefaultCompanyId(input: { companyName: string; fixedId?: string }): string {
  if (input.fixedId?.trim()) return input.fixedId.trim();
  const bytes = createHash("sha256")
    .update(`paperclip-gateway-company:${input.companyName.trim().toLowerCase()}`)
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function issuePrefixForGatewayCompany(companyName: string): string {
  const hash = createHash("sha256").update(companyName).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

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

export async function resolveGatewayAuthActor(
  db: Db,
  req: Request,
  gatewayAuth: GatewayAuthConfig,
): Promise<Express.Request["actor"] | null> {
  const token = req.header(gatewayAuth.headerToken)?.trim();
  if (!token || !constantTimeStringEqual(token, gatewayAuth.secret)) {
    return null;
  }

  const email = req.header(gatewayAuth.headerEmail)?.trim().toLowerCase();
  if (!email) return null;

  const groups = parseGroupsHeader(req.header(gatewayAuth.headerGroups));
  const isAdmin = roleSetMatches(groups, gatewayAuth.adminRoles);
  const isMember = roleSetMatches(groups, gatewayAuth.memberRoles);
  if (!isAdmin && !isMember) return null;

  const userName = req.header(gatewayAuth.headerUser)?.trim() || email;
  const companyId = gatewayDefaultCompanyId({
    companyName: gatewayAuth.defaultCompanyName,
    fixedId: gatewayAuth.defaultCompanyId,
  });
  const companyName = gatewayAuth.defaultCompanyName;
  const now = new Date();

  const existingUser = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, email))
    .then((rows) => rows[0] ?? null);
  const userId = existingUser?.id ?? gatewayUserIdFromEmail(email);

  await db
    .insert(authUsers)
    .values({
      id: userId,
      name: userName,
      email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authUsers.id,
      set: {
        name: userName,
        email,
        emailVerified: true,
        updatedAt: now,
      },
    });

  await db
    .insert(companies)
    .values({
      id: companyId,
      name: companyName,
      description: `Default company for gateway-authenticated users (${companyName}).`,
      status: "active",
      issuePrefix: issuePrefixForGatewayCompany(companyName),
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: companies.id,
    });

  const membershipRole = isAdmin ? "owner" : "operator";
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

  await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: membership.membershipRole,
    grantedByUserId: null,
  });

  if (isAdmin) {
    await db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .onConflictDoNothing();
  } else {
    await db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
  }

  const roleRow = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);

  let additionalMemberships: { companyId: string; membershipRole: string | null; status: string }[] = [];
  try {
    additionalMemberships = (await loadActiveUserCompanyMemberships(db, userId)).filter(
      (row) => row.companyId !== companyId,
    );
  } catch (err) {
    logger.warn(
      { err, userId, email },
      "Failed to load gateway user's company memberships; scoping actor to the default company",
    );
  }

  return {
    type: "board",
    userId,
    userName,
    userEmail: email,
    companyIds: [companyId, ...additionalMemberships.map((row) => row.companyId)],
    memberships: [
      {
        companyId,
        membershipRole: membership.membershipRole,
        status: membership.status,
      },
      ...additionalMemberships,
    ],
    isInstanceAdmin: Boolean(roleRow),
    source: "gateway",
  };
}
