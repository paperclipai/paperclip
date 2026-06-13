import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { type Db, invites } from "@paperclipai/db";

/**
 * Invite-gated sign-up.
 *
 * Better Auth's native `emailAndPassword.disableSignUp` is a hard global on/off:
 * `true` rejects *every* sign-up, including the invited operators we actually want
 * to onboard (this is the bug that forced open sign-up in TWB-57). To close the
 * open-registration surface without breaking invite acceptance, we leave Better
 * Auth's `disableSignUp` off and instead enforce an invite check in a `before`
 * hook: when invite-only mode is active, a sign-up must carry a valid (unexpired,
 * unrevoked, human-eligible) invite token or it is rejected.
 *
 * The presented token is matched against `invites.token_hash` using the same
 * SHA-256 hashing the invite routes use, so a valid invite link unlocks sign-up
 * and nothing else does.
 */

/** Header the client uses to attach the invite token to a sign-up request. */
export const INVITE_SIGNUP_TOKEN_HEADER = "x-paperclip-invite-token";

/** Stable error code returned when an invite-only sign-up is rejected. */
export const SIGN_UP_REQUIRES_INVITE_CODE = "SIGN_UP_REQUIRES_INVITE";

type InviteRow = typeof invites.$inferSelect;

export type InviteSignUpGateReason =
  | "open_signup" // invite-only mode disabled — sign-up is open
  | "valid_invite" // a usable invite token was presented
  | "missing_token" // invite-only mode on, no token presented
  | "invalid_invite"; // token presented but invite is unknown/revoked/expired/agent-only

export type InviteSignUpGateDecision = {
  allowed: boolean;
  reason: InviteSignUpGateReason;
};

/** SHA-256 hex hash of an invite token (mirrors `hashToken` in routes/access.ts). */
export function hashInviteSignUpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function inviteAllowsHumanJoin(invite: InviteRow): boolean {
  return invite.allowedJoinTypes === "both" || invite.allowedJoinTypes === "human";
}

/**
 * Pure gate decision. Kept side-effect free so it can be unit-tested without a DB:
 * the caller resolves the invite row, this decides whether sign-up may proceed.
 */
export function evaluateInviteSignUpGate(input: {
  inviteOnly: boolean;
  token: string | null;
  invite: InviteRow | null;
  now?: number;
}): InviteSignUpGateDecision {
  if (!input.inviteOnly) {
    return { allowed: true, reason: "open_signup" };
  }
  const token = input.token?.trim();
  if (!token) {
    return { allowed: false, reason: "missing_token" };
  }
  const invite = input.invite;
  const now = input.now ?? Date.now();
  if (
    !invite ||
    invite.revokedAt ||
    invite.acceptedAt ||
    invite.expiresAt.getTime() <= now ||
    !inviteAllowsHumanJoin(invite)
  ) {
    return { allowed: false, reason: "invalid_invite" };
  }
  return { allowed: true, reason: "valid_invite" };
}

/** Loads an invite by its raw token, or null if none matches. */
export async function loadInviteByToken(db: Db, token: string): Promise<InviteRow | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  return db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashInviteSignUpToken(trimmed)))
    .then((rows) => rows[0] ?? null);
}

/**
 * Resolves whether a sign-up may proceed. Skips the DB lookup entirely when
 * invite-only mode is off or no token was presented.
 */
export async function evaluateSignUpRequest(
  db: Db,
  input: { inviteOnly: boolean; token: string | null; now?: number },
): Promise<InviteSignUpGateDecision> {
  if (!input.inviteOnly) {
    return { allowed: true, reason: "open_signup" };
  }
  const token = input.token?.trim() || null;
  if (!token) {
    return { allowed: false, reason: "missing_token" };
  }
  const invite = await loadInviteByToken(db, token);
  return evaluateInviteSignUpGate({ inviteOnly: true, token, invite, now: input.now });
}
