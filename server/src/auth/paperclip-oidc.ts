import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { authAccounts, authUsers, authVerifications, companyMemberships, type Db } from "@paperclipai/db";
import * as oidc from "openid-client";
import { z } from "zod";
import { logActivity } from "../services/activity-log.js";

const PROVIDER_ID = "paperclip-id";
const STATE_COOKIE_PREFIX = "paperclip_oidc_state_";
const STATE_TTL_MS = 10 * 60 * 1000;
const LINK_INTENT_PREFIX = "paperclip-oidc-link:";

export type PaperclipOidcConfig = { issuer: string; clientId: string; clientSecret: string; scopes: string[] };
type OidcState = { state: string; nonce: string; codeVerifier: string; callbackURL: string; errorCallbackURL: string; linkIntent?: string; expiresAt: number };
type LinkIntentBinding = { userId: string; sessionId: string };
type OidcLinkEvent =
  | "auth.oidc_link_intent_created"
  | "auth.oidc_link_intent_denied"
  | "auth.oidc_account_linked"
  | "auth.oidc_account_link_denied";

export const paperclipOidcSignInBodySchema = z.object({
  callbackURL: z.string().optional(),
  errorCallbackURL: z.string().optional(),
}).strict();

export const paperclipOidcLinkBodySchema = paperclipOidcSignInBodySchema.extend({
  password: z.string().min(1),
}).strict();

export function readPaperclipOidcConfig(env: NodeJS.ProcessEnv = process.env): PaperclipOidcConfig | null {
  const issuer = env.PAPERCLIP_OIDC_ISSUER?.trim();
  const clientId = env.PAPERCLIP_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.PAPERCLIP_OIDC_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  const scopes = (env.PAPERCLIP_OIDC_SCOPES ?? "openid profile email").split(/[\s,]+/).filter(Boolean);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  try {
    return { issuer: new URL(issuer).toString().replace(/\/$/, ""), clientId, clientSecret, scopes };
  } catch {
    return null;
  }
}

export function paperclipOidcRedirectPath(value: string | undefined, fallback: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}

export function paperclipOidcStateCookieName(state: string) {
  return `${STATE_COOKIE_PREFIX}${state}`;
}

function signature(value: string, secret: string) {
  return createHmac("sha256", createHash("sha256").update(secret).digest()).update(value).digest("base64url");
}

export function sealOidcState(state: OidcState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function unsealOidcState(value: string | undefined, secret: string, now = Date.now()): OidcState | null {
  if (!value) return null;
  const [payload, actual] = value.split(".");
  if (!payload || !actual) return null;
  const expected = signature(payload, secret);
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcState;
    return state.expiresAt > now ? state : null;
  } catch {
    return null;
  }
}

export function validatePaperclipOidcClaims(claims: Record<string, unknown>) {
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const emailVerified = claims.email_verified === true;
  if (!subject || !email || !emailVerified) throw new Error("Paperclip ID must return a verified email and subject");
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email;
  return { subject, email, name };
}

function linkIntentId(token: string) {
  return `${LINK_INTENT_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

function linkIntentValue(binding: LinkIntentBinding) {
  return JSON.stringify(binding);
}

export async function createPaperclipOidcLinkIntent(db: Db, binding: LinkIntentBinding, now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(authVerifications).values({
    id: linkIntentId(token),
    identifier: LINK_INTENT_PREFIX,
    value: linkIntentValue(binding),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    createdAt: now,
    updatedAt: now,
  });
  return token;
}

export async function consumePaperclipOidcLinkIntent(db: Db, token: string, binding: LinkIntentBinding, now = new Date()) {
  const [consumed] = await db.delete(authVerifications)
    .where(and(
      eq(authVerifications.id, linkIntentId(token)),
      eq(authVerifications.identifier, LINK_INTENT_PREFIX),
      eq(authVerifications.value, linkIntentValue(binding)),
      gt(authVerifications.expiresAt, now),
    ))
    .returning({ id: authVerifications.id });
  return Boolean(consumed);
}

export async function logPaperclipOidcLinkEvent(
  db: Db,
  userId: string,
  action: OidcLinkEvent,
  details: { reason?: string; providerId?: string } = {},
) {
  const memberships = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ));
  await Promise.all(memberships.map(({ companyId }) => logActivity(db, {
    companyId,
    actorType: "user",
    actorId: userId,
    action,
    entityType: "user",
    entityId: userId,
    details,
  })));
}

export async function consumePaperclipOidcLinkIntentForCallback(
  db: Db,
  token: string,
  binding: LinkIntentBinding,
  providerId: string,
  now = new Date(),
) {
  const consumed = await consumePaperclipOidcLinkIntent(db, token, binding, now);
  if (!consumed) {
    const [intent] = await db
      .select({ value: authVerifications.value, expiresAt: authVerifications.expiresAt })
      .from(authVerifications)
      .where(and(
        eq(authVerifications.id, linkIntentId(token)),
        eq(authVerifications.identifier, LINK_INTENT_PREFIX),
      ))
      .limit(1);
    const reason = !intent
      ? "replayed_or_stale_intent"
      : intent.expiresAt <= now
        ? "expired_intent"
        : intent.value !== linkIntentValue(binding)
          ? "cross_session_intent"
          : "invalid_link_intent";
    await logPaperclipOidcLinkEvent(db, binding.userId, "auth.oidc_account_link_denied", {
      reason,
      providerId,
    });
  }
  return consumed;
}

export async function validatePaperclipOidcLinkEmailForCallback(
  db: Db,
  user: { id: string; email: string },
  identityEmail: string,
  providerId: string,
) {
  if (user.email.toLowerCase() === identityEmail) return true;
  await logPaperclipOidcLinkEvent(db, user.id, "auth.oidc_account_link_denied", {
    reason: "email_mismatch",
    providerId,
  });
  return false;
}

export function paperclipOidcStateCookieOptions(baseURL: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/api/auth",
    maxAge: STATE_TTL_MS / 1000,
    secure: new URL(baseURL).protocol === "https:",
  };
}

export async function verifyPaperclipOidcLinkPassword(
  accounts: Array<{ providerId: string; password?: string | null }>,
  password: string,
  verify: (input: { hash: string; password: string }) => Promise<boolean>,
) {
  const credentialAccount = accounts.find((account) => account.providerId === "credential" && account.password);
  return credentialAccount?.password
    ? verify({ hash: credentialAccount.password, password })
    : false;
}

export async function authorizePaperclipOidcLinkIntent(
  db: Db,
  input: {
    userId: string;
    sessionId: string;
    accounts: Array<{ providerId: string; password?: string | null }>;
    password: string;
    verify: (input: { hash: string; password: string }) => Promise<boolean>;
  },
  now = new Date(),
) {
  if (!input.accounts.some((account) => account.providerId === "credential" && account.password)) {
    await logPaperclipOidcLinkEvent(db, input.userId, "auth.oidc_link_intent_denied", {
      reason: "local_password_unavailable",
    });
    return { ok: false as const, reason: "local_password_unavailable" as const };
  }
  if (!await verifyPaperclipOidcLinkPassword(input.accounts, input.password, input.verify)) {
    await logPaperclipOidcLinkEvent(db, input.userId, "auth.oidc_link_intent_denied", {
      reason: "wrong_password",
    });
    return { ok: false as const, reason: "wrong_password" as const };
  }
  const linkIntent = await createPaperclipOidcLinkIntent(db, {
    userId: input.userId,
    sessionId: input.sessionId,
  }, now);
  await logPaperclipOidcLinkEvent(db, input.userId, "auth.oidc_link_intent_created");
  return { ok: true as const, linkIntent };
}

export async function bindPaperclipOidcAccount(
  db: Db,
  input: {
    userId: string;
    providerId: string;
    accountId: string;
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    scope?: string;
  },
  now = new Date(),
) {
  await db.insert(authAccounts).values({
    id: randomUUID(),
    userId: input.userId,
    providerId: input.providerId,
    accountId: input.accountId,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken: input.idToken,
    scope: input.scope,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: [authAccounts.providerId, authAccounts.accountId] });
  const [account] = await db.select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(and(eq(authAccounts.providerId, input.providerId), eq(authAccounts.accountId, input.accountId)))
    .limit(1);
  if (!account) throw new Error("OIDC account binding was not persisted");
  return account.userId === input.userId;
}

export async function bindPaperclipOidcAccountForCallback(
  db: Db,
  input: Parameters<typeof bindPaperclipOidcAccount>[1],
  now = new Date(),
) {
  const bound = await bindPaperclipOidcAccount(db, input, now);
  await logPaperclipOidcLinkEvent(
    db,
    input.userId,
    bound ? "auth.oidc_account_linked" : "auth.oidc_account_link_denied",
    bound
      ? { providerId: input.providerId }
      : { reason: "issuer_subject_conflict", providerId: input.providerId },
  );
  return bound;
}

export function paperclipOidc(config: PaperclipOidcConfig, secret: string, db: Db): BetterAuthPlugin {
  let discovered: Promise<oidc.Configuration> | undefined;
  const getConfiguration = () => discovered ??= oidc.discovery(new URL(config.issuer), config.clientId, config.clientSecret);

  return {
    id: "paperclip-oidc",
    endpoints: {
      paperclipOidcSignIn: createAuthEndpoint("/sign-in/paperclip-id", {
        method: "POST",
        body: paperclipOidcSignInBodySchema,
      }, async (ctx) => {
        const state: OidcState = {
          state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier: oidc.randomPKCECodeVerifier(),
          callbackURL: paperclipOidcRedirectPath(ctx.body.callbackURL, "/"), errorCallbackURL: paperclipOidcRedirectPath(ctx.body.errorCallbackURL, "/auth"),
          expiresAt: Date.now() + STATE_TTL_MS,
        };
        const authorizationURL = oidc.buildAuthorizationUrl(await getConfiguration(), {
          redirect_uri: `${ctx.context.baseURL}/oauth2/callback/${PROVIDER_ID}`,
          response_type: "code", scope: config.scopes.join(" "), state: state.state, nonce: state.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(state.codeVerifier), code_challenge_method: "S256",
        });
        ctx.setCookie(paperclipOidcStateCookieName(state.state), sealOidcState(state, secret), paperclipOidcStateCookieOptions(ctx.context.baseURL));
        return ctx.json({ url: authorizationURL.toString(), redirect: true });
      }),
      paperclipOidcLink: createAuthEndpoint("/link/paperclip-id", {
        method: "POST",
        body: paperclipOidcLinkBodySchema,
      }, async (ctx) => {
        const activeSession = await getSessionFromCtx(ctx);
        if (!activeSession) throw ctx.error("UNAUTHORIZED", { message: "A local session is required to link Paperclip ID" });
        const accounts = await ctx.context.internalAdapter.findAccounts(activeSession.user.id);
        const authorization = await authorizePaperclipOidcLinkIntent(db, {
          userId: activeSession.user.id,
          sessionId: activeSession.session.id,
          accounts,
          password: ctx.body.password,
          verify: ctx.context.password.verify,
        });
        if (!authorization.ok && authorization.reason === "local_password_unavailable") {
          throw ctx.error("BAD_REQUEST", { message: "A local password is required to link Paperclip ID" });
        }
        if (!authorization.ok) {
          throw ctx.error("UNAUTHORIZED", { message: "Invalid local password" });
        }
        const state: OidcState = {
          state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier: oidc.randomPKCECodeVerifier(),
          callbackURL: paperclipOidcRedirectPath(ctx.body.callbackURL, "/"), errorCallbackURL: paperclipOidcRedirectPath(ctx.body.errorCallbackURL, "/auth"),
          linkIntent: authorization.linkIntent, expiresAt: Date.now() + STATE_TTL_MS,
        };
        const authorizationURL = oidc.buildAuthorizationUrl(await getConfiguration(), {
          redirect_uri: `${ctx.context.baseURL}/oauth2/callback/${PROVIDER_ID}`,
          response_type: "code", scope: config.scopes.join(" "), state: state.state, nonce: state.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(state.codeVerifier), code_challenge_method: "S256",
        });
        ctx.setCookie(paperclipOidcStateCookieName(state.state), sealOidcState(state, secret), paperclipOidcStateCookieOptions(ctx.context.baseURL));
        return ctx.json({ url: authorizationURL.toString(), redirect: true });
      }),
      paperclipOidcCallback: createAuthEndpoint("/oauth2/callback/paperclip-id", {
        method: "GET",
        query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }),
      }, async (ctx) => {
        const stateCookieName = ctx.query.state ? paperclipOidcStateCookieName(ctx.query.state) : undefined;
        const state = unsealOidcState(stateCookieName ? ctx.getCookie(stateCookieName) ?? undefined : undefined, secret);
        if (stateCookieName) ctx.setCookie(stateCookieName, "", { ...paperclipOidcStateCookieOptions(ctx.context.baseURL), maxAge: 0 });
        const fail = (code: string): never => { throw ctx.redirect(`${state?.errorCallbackURL || "/auth"}${(state?.errorCallbackURL || "/auth").includes("?") ? "&" : "?"}oidcError=${encodeURIComponent(code)}`); };
        if (!state || ctx.query.error || !ctx.query.code || ctx.query.state !== state.state || !ctx.request) return fail("invalid_state");
        const validState = state;
        const tokens = await oidc.authorizationCodeGrant(await getConfiguration(), new URL(ctx.request.url), {
          expectedState: validState.state, expectedNonce: validState.nonce, pkceCodeVerifier: validState.codeVerifier,
        });
        const claims = tokens.claims();
        if (!claims) fail("missing_id_token");
        let identity: ReturnType<typeof validatePaperclipOidcClaims>;
        try { identity = validatePaperclipOidcClaims(claims as Record<string, unknown>); } catch { return fail("unverified_email"); }
        const providerId = `${PROVIDER_ID}:${config.issuer}`;
        const existingAccount = await ctx.context.internalAdapter.findAccountByProviderId(identity.subject, providerId);
        let user;
        if (existingAccount) {
          user = await ctx.context.internalAdapter.findUserById(existingAccount.userId);
          if (!user) return fail("user_not_found");
        } else if (validState.linkIntent) {
          const activeSession = await getSessionFromCtx(ctx);
          if (!activeSession) return fail("link_session_expired");
          if (!await consumePaperclipOidcLinkIntentForCallback(db, validState.linkIntent, {
            userId: activeSession.user.id,
            sessionId: activeSession.session.id,
          }, providerId)) return fail("link_session_expired");
          if (!await validatePaperclipOidcLinkEmailForCallback(db, activeSession.user, identity.email, providerId)) return fail("email_mismatch");
          user = activeSession.user;
          if (!await bindPaperclipOidcAccountForCallback(db, { userId: user.id, providerId, accountId: identity.subject, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, scope: tokens.scope })) return fail("account_already_linked");
        } else {
          if (await ctx.context.internalAdapter.findUserByEmail(identity.email)) return fail("account_not_linked");
          user = await ctx.context.internalAdapter.createUser({ email: identity.email, emailVerified: true, name: identity.name });
          if (!await bindPaperclipOidcAccount(db, { userId: user.id, providerId, accountId: identity.subject, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, scope: tokens.scope })) {
            await db.delete(authUsers).where(eq(authUsers.id, user.id));
            return fail("account_already_linked");
          }
        }
        if (validState.linkIntent && existingAccount) {
          const activeSession = await getSessionFromCtx(ctx);
          if (!activeSession) return fail("link_session_expired");
          if (existingAccount.userId !== activeSession.user.id) {
            await logPaperclipOidcLinkEvent(db, activeSession.user.id, "auth.oidc_account_link_denied", {
              reason: "issuer_subject_conflict",
              providerId,
            });
            return fail("account_already_linked");
          }
          if (!await consumePaperclipOidcLinkIntentForCallback(db, validState.linkIntent, {
            userId: activeSession.user.id,
            sessionId: activeSession.session.id,
          }, providerId)) return fail("link_session_expired");
        }
        if (!user) return fail("user_not_found");
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) fail("session_failed");
        await setSessionCookie(ctx, { session, user });
        throw ctx.redirect(validState.callbackURL);
      }),
    },
  };
}
