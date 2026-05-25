import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type RequestHandler, Router } from "express";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * jade.computer → Paperclip team sync.
 *
 * Replaces the previous "first user becomes admin" + open-signup model
 * with an authoritative push from jade.computer. The control plane
 * owns membership truth; this endpoint reconciles paperclip's
 * `companies` + `companyMemberships` + `instanceUserRoles` tables to
 * match.
 *
 * Auth: two signals required.
 *   1. Standard `X-Jade-Gate-Secret` header — already enforced by
 *      `jadeGateGuard` middleware, so this route only sees requests
 *      that came through the gate Worker.
 *   2. HMAC of the JSON body using `JADE_GATE_SIGNING_KEY`. Even if
 *      the gate secret leaks, an attacker can't replay/forge a sync
 *      without the signing key.
 *
 * Push is a *full replace*, not a delta:
 *   - members in the payload → upsert, set status='active'
 *   - members in DB but NOT in the payload → status='suspended'
 *   - never deletes (preserves audit trail / authored content).
 *
 * Jade-org id is mapped to a paperclip company id via the same
 * deterministic SHA-256 derivation used by the cloud-tenant actor
 * path, so a workspace's company id is stable across re-syncs.
 */

interface IncomingMember {
  userId: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
}

interface IncomingPayload {
  orgId: string;
  orgName: string;
  members: IncomingMember[];
  iat: number;
}

const MAX_PAYLOAD_AGE_SEC = 300;

function ssoSecret(): string | null {
  const s =
    process.env.JADE_GATE_SIGNING_KEY ?? process.env.BETTER_AUTH_SECRET;
  return s && s.length > 0 ? s : null;
}

function constantTimeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function jadeOrgCompanyId(orgId: string): string {
  // Matches `cloudTenantCompanyId` from middleware/auth.ts so the same
  // jade org always lands on the same paperclip company id.
  const bytes = createHash("sha256")
    .update(`paperclip-cloud-tenant-company:${orgId}`)
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function issuePrefixForOrg(orgId: string): string {
  const hash = createHash("sha256").update(orgId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

function mapRole(role: IncomingMember["role"]): "owner" | "admin" | "member" {
  // Paperclip's membership taxonomy is richer; map Jade roles into the
  // closest paperclip equivalent without inventing privileges Jade
  // didn't grant.
  if (role === "owner") return "owner";
  if (role === "admin") return "admin";
  return "member";
}

function isMember(value: unknown): value is IncomingMember {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.userId === "string" &&
    typeof m.email === "string" &&
    typeof m.name === "string" &&
    (m.role === "owner" || m.role === "admin" || m.role === "member")
  );
}

function isPayload(value: unknown): value is IncomingPayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.orgId === "string" &&
    typeof p.orgName === "string" &&
    typeof p.iat === "number" &&
    Array.isArray(p.members) &&
    p.members.every(isMember)
  );
}

function verifyBodyHmac(secret: string, iat: number, rawBody: string, sig: string): boolean {
  let provided: Buffer;
  try {
    // base64url decode
    const padded = sig + "=".repeat((4 - (sig.length % 4)) % 4);
    provided = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${iat}.${rawBody}`)
    .digest();
  return constantTimeEqualBytes(expected, provided);
}

export function jadeTeamSyncRoutes(db: Db): Router {
  const router = Router();

  const handler: RequestHandler = async (req, res) => {
    const secret = ssoSecret();
    if (!secret) {
      res.status(503).json({ ok: false, code: "signing_key_missing" });
      return;
    }
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!raw) {
      res.status(400).json({ ok: false, code: "raw_body_missing" });
      return;
    }
    const rawBody = raw.toString("utf8");

    const sigHeader = req.header("x-jade-team-sync-signature")?.trim();
    if (!sigHeader) {
      res.status(401).json({ ok: false, code: "signature_missing" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ ok: false, code: "bad_json" });
      return;
    }
    if (!isPayload(parsed)) {
      res.status(400).json({ ok: false, code: "bad_payload" });
      return;
    }
    const payload: IncomingPayload = parsed;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - payload.iat) > MAX_PAYLOAD_AGE_SEC) {
      res.status(401).json({ ok: false, code: "stale_payload" });
      return;
    }
    if (!verifyBodyHmac(secret, payload.iat, rawBody, sigHeader)) {
      res.status(401).json({ ok: false, code: "bad_signature" });
      return;
    }

    const companyId = jadeOrgCompanyId(payload.orgId);
    const updatedAt = new Date();

    try {
      await db.transaction(async (tx) => {
        await tx
          .insert(companies)
          .values({
            id: companyId,
            name: payload.orgName,
            description: `Synced from jade.computer org ${payload.orgId}.`,
            status: "active",
            issuePrefix: issuePrefixForOrg(payload.orgId),
            updatedAt,
          })
          .onConflictDoUpdate({
            target: companies.id,
            set: { name: payload.orgName, updatedAt },
          });

        // Resolve each incoming member to the *paperclip* user id, not
        // the jade user id. Paperclip may already have an account with
        // the same email (from the SSO-grant bootstrap, manual signup,
        // etc.); reusing that row keeps memberships + authored content
        // linked instead of forking a duplicate user.
        const resolvedPrincipalIds = new Set<string>();

        for (const m of payload.members) {
          const email = m.email.toLowerCase();

          // 1) Find or create the paperclip auth user by email.
          const existingByEmail = await tx
            .select({ id: authUsers.id })
            .from(authUsers)
            .where(eq(authUsers.email, email))
            .then((rows) => rows[0] ?? null);

          let principalId: string;
          if (existingByEmail) {
            principalId = existingByEmail.id;
            await tx
              .update(authUsers)
              .set({ name: m.name, emailVerified: true, updatedAt })
              .where(eq(authUsers.id, principalId));
          } else {
            // No paperclip account yet — mint one with jade's user.id so
            // a future lookup by jade id still resolves.
            principalId = m.userId;
            await tx.insert(authUsers).values({
              id: principalId,
              email,
              name: m.name,
              emailVerified: true,
              image: null,
              createdAt: updatedAt,
              updatedAt,
            });
          }
          resolvedPrincipalIds.add(principalId);

          // 2) Upsert membership for the resolved paperclip user id.
          await tx
            .insert(companyMemberships)
            .values({
              companyId,
              principalType: "user",
              principalId,
              status: "active",
              membershipRole: mapRole(m.role),
              updatedAt,
            })
            .onConflictDoUpdate({
              target: [
                companyMemberships.companyId,
                companyMemberships.principalType,
                companyMemberships.principalId,
              ],
              set: {
                status: "active",
                membershipRole: mapRole(m.role),
                updatedAt,
              },
            });

          // 3) Owners get instance_admin. Idempotent.
          if (m.role === "owner") {
            await tx
              .insert(instanceUserRoles)
              .values({
                userId: principalId,
                role: "instance_admin",
                updatedAt,
              })
              .onConflictDoNothing({
                target: [instanceUserRoles.userId, instanceUserRoles.role],
              });
          }
        }

        // Suspend (don't delete) members that exist in this company but
        // are no longer in the payload. Preserves authored content +
        // audit links.
        const existing = await tx
          .select({
            principalId: companyMemberships.principalId,
            status: companyMemberships.status,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
            ),
          );
        const toSuspend = existing
          .filter((r) => !resolvedPrincipalIds.has(r.principalId) && r.status === "active")
          .map((r) => r.principalId);
        if (toSuspend.length > 0) {
          await tx
            .update(companyMemberships)
            .set({ status: "suspended", updatedAt })
            .where(
              and(
                eq(companyMemberships.companyId, companyId),
                eq(companyMemberships.principalType, "user"),
                inArray(companyMemberships.principalId, toSuspend),
                ne(companyMemberships.status, "suspended"),
              ),
            );
          // Also strip instance_admin from any user being suspended out
          // of the org. Keeps the workspace closed on de-provision.
          await tx
            .delete(instanceUserRoles)
            .where(
              and(
                inArray(instanceUserRoles.userId, toSuspend),
                eq(instanceUserRoles.role, "instance_admin"),
              ),
            );
        }
      });
    } catch (err) {
      logger.error({ err }, "jade-team-sync: db error");
      res.status(500).json({ ok: false, code: "db_error" });
      return;
    }

    res.json({
      ok: true,
      orgId: payload.orgId,
      companyId,
      membersApplied: payload.members.length,
    });
  };

  router.post("/internal/jade-team-sync", handler);
  return router;
}
