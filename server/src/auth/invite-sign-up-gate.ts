/**
 * Invite-only sign-up (`auth.signUp: "invite"` / `PAPERCLIP_AUTH_SIGN_UP=invite`).
 *
 * Better Auth only knows "sign-up on" or "sign-up off". Invite mode keeps
 * Better Auth's sign-up on and requires every new account to carry a valid
 * invite token. The token travels in the `x-paperclip-invite-token` header so
 * it never collides with Better Auth's sign-up body schema.
 *
 * A token is valid for sign-up when the invite it names is the kind an
 * unauthenticated person could go on to accept: it exists (matched by the same
 * sha256 token hash the invite routes use), it is active (not revoked, not
 * accepted, not expired, per `inviteState`), and it allows human joins.
 * Accepted invites are rejected because `POST /api/invites/:token/accept` only
 * replays an accepted invite for the account that already accepted it, so a
 * brand-new account could never use one. Invites carry no email binding, so
 * any email may be used with a valid token.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { invites, type Db } from "@paperclipai/db";
import {
  AUTH_SIGN_UP_INVITE_TOKEN_HEADER,
  AUTH_SIGN_UP_REQUIRES_INVITE_CODE,
  type AuthSignUpMode,
} from "@paperclipai/shared";
import { inviteState } from "../lib/invite-state.js";

type InviteRow = typeof invites.$inferSelect;

/** Header that carries the invite token on a sign-up request. */
export const INVITE_SIGN_UP_TOKEN_HEADER = AUTH_SIGN_UP_INVITE_TOKEN_HEADER;

/** Stable error code for a sign-up that invite mode rejects. */
export const SIGN_UP_REQUIRES_INVITE_CODE = AUTH_SIGN_UP_REQUIRES_INVITE_CODE;

/**
 * One message for every rejection, so a response never tells the caller
 * whether the token it sent names a real invite.
 */
export const SIGN_UP_REQUIRES_INVITE_MESSAGE =
  "Sign-up on this instance is by invitation only. Open a valid invite link to create an account.";

export type InviteSignUpDecision =
  | { allowed: true; reason: "not_invite_mode" | "valid_invite" }
  | { allowed: false; reason: "missing_token" | "invalid_invite" };

export function hashInviteSignUpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeInviteSignUpToken(value: string | null | undefined): string | null {
  const token = value?.trim();
  return token ? token : null;
}

/** Pure decision: the caller resolves the invite row, this decides. */
export function evaluateInviteSignUp(input: {
  mode: AuthSignUpMode;
  token: string | null;
  invite: InviteRow | null;
  now?: number;
}): InviteSignUpDecision {
  if (input.mode !== "invite") return { allowed: true, reason: "not_invite_mode" };
  if (!normalizeInviteSignUpToken(input.token)) return { allowed: false, reason: "missing_token" };
  const invite = input.invite;
  if (
    !invite ||
    inviteState(invite, input.now ?? Date.now()) !== "active" ||
    invite.allowedJoinTypes === "agent"
  ) {
    return { allowed: false, reason: "invalid_invite" };
  }
  return { allowed: true, reason: "valid_invite" };
}

export async function loadInviteBySignUpToken(db: Db, token: string): Promise<InviteRow | null> {
  return db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashInviteSignUpToken(token)))
    .then((rows) => rows[0] ?? null);
}

/** Looks up the invite (only when needed) and returns the decision. */
export async function checkInviteSignUp(
  db: Db,
  input: { mode: AuthSignUpMode; token: string | null | undefined; now?: number },
): Promise<InviteSignUpDecision> {
  if (input.mode !== "invite") return { allowed: true, reason: "not_invite_mode" };
  const token = normalizeInviteSignUpToken(input.token);
  if (!token) return { allowed: false, reason: "missing_token" };
  const invite = await loadInviteBySignUpToken(db, token);
  return evaluateInviteSignUp({ mode: input.mode, token, invite, now: input.now });
}

export function inviteSignUpRejectedError() {
  return APIError.from("FORBIDDEN", {
    code: SIGN_UP_REQUIRES_INVITE_CODE,
    message: SIGN_UP_REQUIRES_INVITE_MESSAGE,
  });
}

/** Throws the 403 rejection unless the request carries a usable invite token. */
export async function assertInviteSignUpAllowed(
  db: Db,
  input: { mode: AuthSignUpMode; headers: Headers | null | undefined },
): Promise<void> {
  const decision = await checkInviteSignUp(db, {
    mode: input.mode,
    token: input.headers?.get(INVITE_SIGN_UP_TOKEN_HEADER),
  });
  if (!decision.allowed) throw inviteSignUpRejectedError();
}

/**
 * Better Auth options that enforce invite mode. Two layers, on purpose:
 *
 * - `hooks.before` rejects `/sign-up/email` before Better Auth looks up the
 *   email or hashes the password. Without it, a token-less sign-up for an
 *   existing email would get `USER_ALREADY_EXISTS` while a new email would get
 *   403, which tells a stranger which emails have accounts.
 * - `databaseHooks.user.create.before` runs for every user Better Auth
 *   creates, whatever endpoint or plugin creates it. It is the backstop that
 *   keeps any future sign-up path (social or SSO provider, plugin) gated too.
 *   With no request context (a direct server-side call), it fails closed.
 */
export function inviteSignUpAuthOptions(db: Db) {
  return {
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        await assertInviteSignUpAllowed(db, { mode: "invite", headers: ctx.headers });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (_user: unknown, ctx: { headers?: Headers } | null) => {
            await assertInviteSignUpAllowed(db, { mode: "invite", headers: ctx?.headers });
          },
        },
      },
    },
  };
}
