import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";

/**
 * jade.computer → Paperclip SSO bridge.
 *
 * jade provisions this workspace and is the only party (besides this
 * container) that knows BETTER_AUTH_SECRET. At launch jade injects
 * PAPERCLIP_JADE_SSO_GRANT = base64url(JSON{email,name,iat}) + "." +
 * hex(HMAC_SHA256(payload, BETTER_AUTH_SECRET)). A valid grant proves
 * the bearer is the jade tenant owner, so we can sign them straight in
 * as the instance admin (CEO) — no CLI bootstrap, no second login.
 */

const LOCAL_BOARD_USER_ID = "local-board";

export interface JadeGrant {
  email: string;
  name: string;
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function ssoSecret(): string | null {
  const s =
    process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  return s && s.length > 0 ? s : null;
}

export function jadeGrantPresent(): boolean {
  return Boolean(process.env.PAPERCLIP_JADE_SSO_GRANT?.trim());
}

/** Parse + HMAC-verify the injected grant. Returns null if absent/invalid. */
export function parseJadeGrant(): JadeGrant | null {
  const raw = process.env.PAPERCLIP_JADE_SSO_GRANT?.trim();
  const secret = ssoSecret();
  if (!raw || !secret) return null;

  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = createHmac("sha256", secret)
    .update(payloadB64)
    .digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(b64urlDecode(payloadB64)) as {
      email?: unknown;
      name?: unknown;
    };
    const email =
      typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@")) return null;
    const name =
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim()
        : email.split("@")[0];
    return { email, name };
  } catch {
    return null;
  }
}

/**
 * Deterministic backend SSO password for an email, derived from the
 * shared secret. Never shown to anyone — it's the credential we use to
 * drive better-auth's own signUp/signIn so we don't forge cookies. The
 * same email always derives the same password, so returning SSO logins
 * work without storing anything.
 */
export function deriveJadeSsoPassword(email: string): string {
  const secret = ssoSecret();
  if (!secret) throw new Error("jade_sso_secret_missing");
  return createHmac("sha256", secret)
    .update(`pc-jade-sso:v1:${email.trim().toLowerCase()}`)
    .digest("hex");
}

/**
 * Promote a user to instance admin (CEO) the first time — mirrors the
 * bootstrap-ceo / board-claim grant: instance_admin role + owner
 * membership on every company, and retire the local-board placeholder.
 * No-op if a real (non-placeholder) admin already exists.
 */
export async function ensureJadeInstanceAdmin(
  db: Db,
  userId: string,
): Promise<void> {
  const admins = await db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"));

  const realAdmin = admins.find((a) => a.userId !== LOCAL_BOARD_USER_ID);
  if (realAdmin && realAdmin.userId !== userId) return; // already owned
  if (admins.some((a) => a.userId === userId)) return; // already admin

  await db.transaction(async (tx) => {
    await tx.insert(instanceUserRoles).values({
      userId,
      role: "instance_admin",
    });
    await tx
      .delete(instanceUserRoles)
      .where(
        and(
          eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),
          eq(instanceUserRoles.role, "instance_admin"),
        ),
      );
    const allCompanies = await tx.select({ id: companies.id }).from(companies);
    for (const company of allCompanies) {
      const existing = await tx
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        await tx.insert(companyMemberships).values({
          companyId: company.id,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "owner",
        });
      }
    }
  });
}

/** Look up an existing better-auth user id by email. */
export async function findAuthUserIdByEmail(
  db: Db,
  email: string,
): Promise<string | null> {
  const row = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, email))
    .then((rows) => rows[0] ?? null);
  return row?.id ?? null;
}
