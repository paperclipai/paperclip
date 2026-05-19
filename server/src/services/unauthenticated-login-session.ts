import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import {
  HUMAN_COMPANY_MEMBERSHIP_ROLES,
  type HumanCompanyMembershipRole,
  isExperimentalFeatureEnabled,
  isPaperclipExperimentalModeEnabled,
} from "@paperclipai/shared";
import { isDevelopmentEnvironment } from "../development-environment.js";
import { instanceSettingsService } from "./instance-settings.js";

export const UNAUTHENTICATED_LOGIN_SESSION_COOKIE = "paperclip_unauthenticated_login";

const LOCAL_BOARD_USER_ID = "local-board";
const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
const LOCAL_BOARD_USER_NAME = "Board";
const DEFAULT_UNAUTHENTICATED_LOGIN_ACCESS_LEVEL: HumanCompanyMembershipRole = "viewer";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

type SessionRecord = {
  companyId: string;
  expiresAt: number;
};

const sessions = new Map<string, SessionRecord>();

function cleanupExpiredSessions(now = Date.now()) {
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) continue;
    return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

export function serializeUnauthenticatedLoginCookie(token: string): string {
  return [
    `${UNAUTHENTICATED_LOGIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].join("; ");
}

export async function isUnauthenticatedLoginAvailable(db: Db, companyId: string): Promise<boolean> {
  if (!companyId) return false;

  const company = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!company) return false;

  const experimental = await instanceSettingsService(db).getExperimental();
  const companyExperimentalFeatures = experimental.companyExperimentalFeatures[companyId];
  return isExperimentalFeatureEnabled({
    feature: "unauthenticated_login",
    environmentExperimentalModeEnabled: isPaperclipExperimentalModeEnabled(process.env),
    isDevelopmentEnvironment: isDevelopmentEnvironment(),
    companyEnabledFeatures: companyExperimentalFeatures?.enabledFeatures,
  });
}

export async function resolveUnauthenticatedLoginCompanyId(db: Db): Promise<string | null> {
  const experimental = await instanceSettingsService(db).getExperimental();
  for (const companyId of Object.keys(experimental.companyExperimentalFeatures)) {
    if (await isUnauthenticatedLoginAvailable(db, companyId)) return companyId;
  }
  return null;
}

async function ensureLocalBoardUser(db: Db) {
  const now = new Date();
  await db
    .insert(authUsers)
    .values({
      id: LOCAL_BOARD_USER_ID,
      name: LOCAL_BOARD_USER_NAME,
      email: LOCAL_BOARD_USER_EMAIL,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: authUsers.id,
    });
}

async function ensureLocalBoardMembership(db: Db, companyId: string) {
  const accessLevel = await resolveUnauthenticatedLoginAccessLevel(db, companyId);
  await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: accessLevel,
    })
    .onConflictDoUpdate({
      target: [
        companyMemberships.companyId,
        companyMemberships.principalType,
        companyMemberships.principalId,
      ],
      set: {
        status: "active",
        membershipRole: accessLevel,
        updatedAt: new Date(),
      },
    });
}

async function resolveUnauthenticatedLoginAccessLevel(
  db: Db,
  companyId: string,
): Promise<HumanCompanyMembershipRole> {
  const experimental = await instanceSettingsService(db).getExperimental();
  const configuredAccessLevel =
    experimental.companyExperimentalFeatures[companyId]?.unauthenticatedLogin?.accessLevel;
  return configuredAccessLevel && HUMAN_COMPANY_MEMBERSHIP_ROLES.includes(configuredAccessLevel)
    ? configuredAccessLevel
    : DEFAULT_UNAUTHENTICATED_LOGIN_ACCESS_LEVEL;
}

async function isLocalBoardInstanceAdmin(db: Db): Promise<boolean> {
  const role = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  return Boolean(role);
}

export async function createUnauthenticatedLoginSession(db: Db, companyId: string): Promise<string | null> {
  if (!(await isUnauthenticatedLoginAvailable(db, companyId))) return null;

  await ensureLocalBoardUser(db);
  await ensureLocalBoardMembership(db, companyId);

  cleanupExpiredSessions();
  const token = randomUUID();
  sessions.set(token, {
    companyId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export async function resolveUnauthenticatedLoginSession(
  db: Db,
  cookieHeader: string | undefined,
): Promise<Express.Request["actor"] | null> {
  const token = parseCookieHeader(cookieHeader, UNAUTHENTICATED_LOGIN_SESSION_COOKIE);
  if (!token) return null;

  cleanupExpiredSessions();
  const session = sessions.get(token);
  if (!session) return null;
  if (!(await isUnauthenticatedLoginAvailable(db, session.companyId))) {
    sessions.delete(token);
    return null;
  }

  return {
    type: "board",
    userId: LOCAL_BOARD_USER_ID,
    userName: LOCAL_BOARD_USER_NAME,
    userEmail: LOCAL_BOARD_USER_EMAIL,
    companyIds: [session.companyId],
    memberships: [{
      companyId: session.companyId,
      membershipRole: await resolveUnauthenticatedLoginAccessLevel(db, session.companyId),
      status: "active",
    }],
    isInstanceAdmin: await isLocalBoardInstanceAdmin(db),
    source: "session",
  };
}
