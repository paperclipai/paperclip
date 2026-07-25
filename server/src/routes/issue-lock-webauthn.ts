import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { webauthnCredentials } from "@paperclipai/db";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { logger } from "../middleware/logger.js";

/**
 * MAT-112 — issue-lock WebAuthn / Touch ID gate (variant A, interface-level).
 *
 * This is a UI-level lock: a board user registers a platform authenticator
 * (Touch ID) and must assert it to open a short-lived browser "unlock session".
 * While unlocked, the API returns full content for locked issues to that
 * browser. Agents (API-key actors) are intentionally NOT gated — they keep
 * reading locked issues via the API. The DB row stays unencrypted. This is not
 * variant B (full encryption); the UI states this clearly.
 */

const UNLOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const UNLOCK_COOKIE = "pc_issue_unlock";
// The unlock cookie is only ever read by API routes (issue reads + the
// webauthn endpoints), all mounted under /api. Scope it there instead of "/"
// so it is not attached to unrelated same-origin requests (static assets, etc.).
const UNLOCK_COOKIE_PATH = "/api";
const RP_NAME = "Paperclip";

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Whether to set the `Secure` flag on the unlock-session cookie.
 *
 * `req.protocol` is unreliable behind a TLS-terminating reverse proxy (it
 * reports "http" unless `trust proxy` is configured), so we drive this from
 * explicit configuration instead: an explicit override (`WEBAUTHN_COOKIE_SECURE`
 * / `COOKIE_SECURE`) wins, otherwise default to secure in production. In
 * development (localhost over http) this stays false so the cookie still works.
 */
export function resolveCookieSecure(): boolean {
  const explicit = process.env.WEBAUTHN_COOKIE_SECURE ?? process.env.COOKIE_SECURE;
  if (explicit !== undefined && explicit.trim() !== "") {
    return parseBooleanEnv(explicit);
  }
  return process.env.NODE_ENV === "production";
}

type PendingChallenge = { challenge: string; expiresAt: number };
type UnlockSession = { userId: string; expiresAt: number };

// In-memory stores. Registration credentials are persisted in the DB; only the
// ephemeral ceremony challenges and the short-lived unlock sessions live in
// memory. A server restart simply asks the user to tap Touch ID again — an
// acceptable trade-off for a local single-instance UI gate.
const registrationChallenges = new Map<string, PendingChallenge>();
const authenticationChallenges = new Map<string, PendingChallenge>();
const unlockSessions = new Map<string, UnlockSession>();

function now(): number {
  return Date.now();
}

function pruneExpired(): void {
  const t = now();
  for (const [k, v] of registrationChallenges) if (v.expiresAt <= t) registrationChallenges.delete(k);
  for (const [k, v] of authenticationChallenges) if (v.expiresAt <= t) authenticationChallenges.delete(k);
  for (const [k, v] of unlockSessions) if (v.expiresAt <= t) unlockSessions.delete(k);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/**
 * True when the current browser request carries a valid, unexpired unlock
 * session. Imported by the issue routes to decide whether to redact locked
 * content. Agent requests never carry this cookie, so they are unaffected.
 */
export function isIssueUnlockActive(req: Request): boolean {
  const token = readCookie(req, UNLOCK_COOKIE);
  if (!token) return false;
  const session = unlockSessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= now()) {
    unlockSessions.delete(token);
    return false;
  }
  return true;
}

function openUnlockSession(req: Request, res: Response, userId: string): number {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now() + UNLOCK_TTL_MS;
  unlockSessions.set(token, { userId, expiresAt });
  res.cookie(UNLOCK_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: resolveCookieSecure(),
    path: UNLOCK_COOKIE_PATH,
    maxAge: UNLOCK_TTL_MS,
  });
  return expiresAt;
}

function closeUnlockSession(req: Request, res: Response): void {
  const token = readCookie(req, UNLOCK_COOKIE);
  if (token) unlockSessions.delete(token);
  res.clearCookie(UNLOCK_COOKIE, { path: UNLOCK_COOKIE_PATH });
}

/**
 * Extract the hostname from a Host header value, dropping any port and handling
 * IPv6 literals. `"[::1]:51506"` -> `"::1"`, `"localhost:3000"` -> `"localhost"`,
 * `"example.com"` -> `"example.com"`.
 */
function hostnameFromHostHeader(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) return host.slice(1, end);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * WebAuthn relying-party config (RP ID + origin).
 *
 * These MUST NOT be taken from the request Host header / protocol at runtime:
 * those are client-controlled and using them undermines WebAuthn's phishing
 * resistance (SimpleWebAuthn explicitly warns against it). `WEBAUTHN_ORIGIN` is
 * authoritative — it is the exact origin used to verify ceremonies, and the RP
 * ID is derived from it when not set explicitly. Setting `WEBAUTHN_RP_ID` alone
 * (no origin) fails closed, because the origin cannot be reconstructed safely
 * for subdomains / non-default ports. The request-derived path is a localhost
 * development convenience ONLY: for any non-loopback host it fails closed rather
 * than trusting the client-supplied Host, so a supplied Host can never pick the
 * RP ID / origin used in a ceremony.
 */
export function resolveRp(req: Request): { rpID: string; origin: string } {
  const configuredRpID = process.env.WEBAUTHN_RP_ID?.trim() || undefined;
  const configuredOrigin = process.env.WEBAUTHN_ORIGIN?.trim() || undefined;

  if (configuredOrigin) {
    // Normalise to a bare origin (scheme + host + port). A browser's WebAuthn
    // response carries only the origin — if WEBAUTHN_ORIGIN has a path, query, or
    // fragment, passing the full URL as expectedOrigin would never match and
    // silently break every assertion. `URL.origin` strips all of that. A
    // malformed, scheme-less, or opaque value (URL.origin === "null") cannot be a
    // valid WebAuthn origin, so fail closed rather than returning garbage.
    let parsed: URL;
    try {
      parsed = new URL(configuredOrigin);
    } catch {
      throw new Error(
        `issue-lock WebAuthn is misconfigured: WEBAUTHN_ORIGIN is not a valid URL (${configuredOrigin}).`,
      );
    }
    if (parsed.origin === "null" || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new Error(
        `issue-lock WebAuthn is misconfigured: WEBAUTHN_ORIGIN must be an http(s) origin (got ${configuredOrigin}).`,
      );
    }
    const originHost = parsed.hostname;
    const isLoopbackOrigin =
      originHost === "localhost" || originHost === "127.0.0.1" || originHost === "::1";
    // WebAuthn requires a secure context: only https is allowed, except for
    // loopback where browsers permit http. An http origin on any other host
    // would be rejected by the authenticator, so fail closed with a clear error.
    if (parsed.protocol === "http:" && !isLoopbackOrigin) {
      throw new Error(
        `issue-lock WebAuthn is misconfigured: WEBAUTHN_ORIGIN must use https for non-loopback hosts (got ${configuredOrigin}).`,
      );
    }
    const rpID = configuredRpID ?? originHost;
    // The RP ID must be the origin's host or a registrable parent domain of it,
    // or the browser rejects the ceremony (SecurityError). Validate rather than
    // combining an incompatible RP ID + origin that silently fails at runtime.
    if (rpID !== originHost && !originHost.endsWith(`.${rpID}`)) {
      throw new Error(
        `issue-lock WebAuthn is misconfigured: WEBAUTHN_RP_ID (${rpID}) must equal the WEBAUTHN_ORIGIN host ` +
          `(${originHost}) or be a parent domain of it.`,
      );
    }
    // Reject a bare public-suffix / single-label RP ID (e.g. "com"): browsers
    // refuse an RP ID that is a public suffix, and a registrable domain always
    // has at least two labels. Loopback names ("localhost") are exempt. This is a
    // cheap defensive guard, not a full public-suffix-list check.
    const rpIsLoopback = rpID === "localhost" || rpID === "127.0.0.1" || rpID === "::1";
    if (!rpIsLoopback && !rpID.includes(".")) {
      throw new Error(
        `issue-lock WebAuthn is misconfigured: WEBAUTHN_RP_ID (${rpID}) looks like a public suffix / bare TLD; ` +
          `use a registrable domain such as example.com.`,
      );
    }
    return { rpID, origin: parsed.origin };
  }
  if (configuredRpID) {
    // RP ID set without an explicit origin: we cannot safely reconstruct the
    // expected origin. `https://<rpID>` is wrong whenever the app is served from
    // a subdomain or a non-default HTTPS port, and WebAuthn requires an EXACT
    // origin match — a mismatch silently breaks every assertion. Fail closed and
    // require WEBAUTHN_ORIGIN rather than guessing.
    throw new Error(
      "issue-lock WebAuthn is misconfigured: WEBAUTHN_RP_ID is set but WEBAUTHN_ORIGIN is not. " +
        "Set WEBAUTHN_ORIGIN to the exact origin (scheme + host + port) the app is served from; " +
        "the RP ID alone cannot be used to reconstruct it safely.",
    );
  }

  // Development fallback: derive from the request, but ONLY for loopback hosts.
  // For any non-loopback Host we must NOT trust the client-controlled header —
  // it would let a supplied Host choose the WebAuthn RP ID / origin and mis-bind
  // or break the ceremony. Fail closed and require explicit configuration.
  const host = req.get("host") ?? "localhost";
  const rpID = hostnameFromHostHeader(host);
  const isLoopback = rpID === "localhost" || rpID === "127.0.0.1" || rpID === "::1";
  if (!isLoopback) {
    throw new Error(
      "issue-lock WebAuthn RP is not configured: set WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN. " +
        "Refusing to derive the RP ID/origin from the client-controlled Host header for a non-loopback host.",
    );
  }
  const origin = `${req.protocol}://${host}`;
  return { rpID, origin };
}

/**
 * Only interactive board users may register / unlock. Agents get 403 (they do
 * not need to unlock — they always read the raw content). Returns the board
 * userId or null (after writing a 403).
 */
function requireBoardUser(req: Request, res: Response): string | null {
  if (req.actor.type !== "board" || !req.actor.userId) {
    res.status(403).json({ error: "Issue-lock WebAuthn is only available to board users" });
    return null;
  }
  return req.actor.userId;
}

function base64urlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(value, "base64url");
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

function uint8ArrayToBase64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function issueLockWebauthnRoutes(db: Db): Router {
  const router = Router();

  // Registered credentials + current unlock state for this browser/user.
  router.get("/webauthn/issue-lock/status", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    const creds = await db
      .select({ id: webauthnCredentials.id, deviceLabel: webauthnCredentials.deviceLabel })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
    res.json({
      registered: creds.length > 0,
      credentialCount: creds.length,
      unlocked: isIssueUnlockActive(req),
      unlockTtlSeconds: UNLOCK_TTL_MS / 1000,
      // Honesty note surfaced in the UI: interface-level lock only.
      protectionScope: "ui_only",
    });
  });

  // Step 1 of registration: creation options for navigator.credentials.create.
  router.post("/webauthn/issue-lock/register/options", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    const { rpID } = resolveRp(req);
    const existing = await db
      .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: req.actor.type === "board" ? (req.actor.userEmail ?? userId) : userId,
      userID: new Uint8Array(Buffer.from(userId)),
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: (c.transports ?? undefined) as ("internal" | "hybrid" | "usb" | "nfc" | "ble")[] | undefined,
      })),
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
    });
    registrationChallenges.set(userId, {
      challenge: options.challenge,
      expiresAt: now() + CHALLENGE_TTL_MS,
    });
    res.json(options);
  });

  // Step 2 of registration: verify the attestation and persist the credential.
  router.post("/webauthn/issue-lock/register/verify", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    pruneExpired();
    const pending = registrationChallenges.get(userId);
    if (!pending) {
      res.status(400).json({ error: "No pending registration. Request options first." });
      return;
    }
    const { rpID, origin } = resolveRp(req);
    const response = req.body?.response as RegistrationResponseJSON | undefined;
    const deviceLabel = typeof req.body?.deviceLabel === "string" ? req.body.deviceLabel.slice(0, 120) : null;
    if (!response) {
      res.status(400).json({ error: "Missing WebAuthn registration response" });
      return;
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      logger.warn({ err }, "issue-lock WebAuthn registration verification failed");
      res.status(400).json({ error: "Registration verification failed" });
      return;
    } finally {
      registrationChallenges.delete(userId);
    }
    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: "Registration could not be verified" });
      return;
    }
    const { credential } = verification.registrationInfo;
    await db.insert(webauthnCredentials).values({
      id: randomBytes(16).toString("hex"),
      userId,
      credentialId: credential.id,
      publicKey: uint8ArrayToBase64url(credential.publicKey),
      counter: credential.counter,
      transports: (credential.transports ?? null) as string[] | null,
      deviceLabel,
    });
    // Registering proves user verification just happened → open the session so
    // the user is not asked to tap twice in a row.
    const unlockExpiresAt = openUnlockSession(req, res, userId);
    res.json({ verified: true, unlocked: true, unlockExpiresAt });
  });

  // Step 1 of unlock: request options for navigator.credentials.get.
  router.post("/webauthn/issue-lock/unlock/options", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    const { rpID } = resolveRp(req);
    const creds = await db
      .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
    if (creds.length === 0) {
      res.status(409).json({ error: "No registered credential", code: "not_registered" });
      return;
    }
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials: creds.map((c) => ({
        id: c.credentialId,
        transports: (c.transports ?? undefined) as ("internal" | "hybrid" | "usb" | "nfc" | "ble")[] | undefined,
      })),
    });
    authenticationChallenges.set(userId, {
      challenge: options.challenge,
      expiresAt: now() + CHALLENGE_TTL_MS,
    });
    res.json(options);
  });

  // Step 2 of unlock: verify the assertion, open the unlock session.
  router.post("/webauthn/issue-lock/unlock/verify", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    pruneExpired();
    const pending = authenticationChallenges.get(userId);
    if (!pending) {
      res.status(400).json({ error: "No pending unlock. Request options first." });
      return;
    }
    const response = req.body?.response as AuthenticationResponseJSON | undefined;
    if (!response) {
      res.status(400).json({ error: "Missing WebAuthn authentication response" });
      return;
    }
    const stored = await db
      .select()
      .from(webauthnCredentials)
      .where(and(eq(webauthnCredentials.userId, userId), eq(webauthnCredentials.credentialId, response.id)));
    const record = stored[0];
    if (!record) {
      authenticationChallenges.delete(userId);
      res.status(400).json({ error: "Unknown credential" });
      return;
    }
    const { rpID, origin } = resolveRp(req);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: record.credentialId,
          publicKey: base64urlToUint8Array(record.publicKey),
          counter: record.counter,
          transports: (record.transports ?? undefined) as ("internal" | "hybrid" | "usb" | "nfc" | "ble")[] | undefined,
        },
      });
    } catch (err) {
      logger.warn({ err }, "issue-lock WebAuthn unlock verification failed");
      res.status(400).json({ error: "Unlock verification failed" });
      return;
    } finally {
      authenticationChallenges.delete(userId);
    }
    if (!verification.verified) {
      res.status(400).json({ error: "Unlock could not be verified" });
      return;
    }
    await db
      .update(webauthnCredentials)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(webauthnCredentials.id, record.id));
    const unlockExpiresAt = openUnlockSession(req, res, userId);
    res.json({ verified: true, unlocked: true, unlockExpiresAt });
  });

  // Immediately end the unlock session (re-lock this browser).
  router.post("/webauthn/issue-lock/relock", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    closeUnlockSession(req, res);
    res.json({ unlocked: false });
  });

  return router;
}
