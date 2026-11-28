import type { IncomingHttpHeaders } from "node:http";
import { Router, type Request, type Response } from "express";
import {
  LOCAL_OPERATOR_CREDENTIAL_ENV,
  LOCAL_OPERATOR_FRAGMENT_KEY,
  LOCAL_OPERATOR_HEADER,
  LOCAL_OPERATOR_SOCKET_PARAM,
  LOCAL_OPERATOR_SIGN_IN_TTL_MS,
  createLocalOperatorSignInLink,
  ensureLocalOperatorKey,
  localOperatorBrowserToken,
  localOperatorReadCookieName,
  localOperatorReadCookieValue,
  localOperatorSignInUrl,
  parseLocalOperatorCredentialMode,
  LOCAL_OPERATOR_READ_COOKIE_WINDOW_MS,
  resolveLocalOperatorKeyPathForConfig,
  verifyLocalOperatorBrowserToken,
  verifyLocalOperatorReadCookieValue,
  verifyLocalOperatorSignInLink,
  type LocalOperatorCredentialMode,
} from "@paperclipai/shared/local-operator-credential";
import { logger } from "./logger.js";
import { resolvePaperclipConfigPath } from "../paths.js";

const COOKIE_MAX_AGE_MS = 2 * LOCAL_OPERATOR_READ_COOKIE_WINDOW_MS;
const DEFAULT_MODE: LocalOperatorCredentialMode = "off";

/**
 * Requests the browser makes on its own, without the board page's script:
 * images and file links, and plugin event streams. Only these accept the
 * read-only cookie. Downloads the page starts with `fetch` carry the header
 * token instead and are not listed.
 */
export const DIRECT_BROWSER_READ_PATHS = [
  /^\/api\/attachments\/[^/]+\/content$/,
  /^\/api\/assets\/[^/]+\/content$/,
  /^\/api\/issues\/[^/]+\/file-resources\/content$/,
  /^\/api\/plugins\/[^/]+\/bridge\/stream\/[^/]+$/,
];

export function readCookie(headers: IncomingHttpHeaders, name: string): string | null {
  const header = headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value.split("#")[0]!;
}

export interface LocalOperatorCredentialOptions {
  mode?: LocalOperatorCredentialMode;
  keyPath?: string;
  key?: Buffer;
}

export function createLocalOperatorCredential(options: LocalOperatorCredentialOptions = {}) {
  const configured = options.mode ? null : parseLocalOperatorCredentialMode(process.env[LOCAL_OPERATOR_CREDENTIAL_ENV]);
  if (configured && !configured.recognized) {
    logger.warn(
      { value: process.env[LOCAL_OPERATOR_CREDENTIAL_ENV] },
      `${LOCAL_OPERATOR_CREDENTIAL_ENV} has an unrecognized value; requiring the operator credential. Use "required" or "off".`,
    );
  }
  const mode = options.mode ?? configured?.mode ?? DEFAULT_MODE;
  let key = options.key ?? null;
  const usedNonces = new Map<string, number>();

  function operatorKey(): Buffer {
    key ??= ensureLocalOperatorKey(
      options.keyPath ?? resolveLocalOperatorKeyPathForConfig(resolvePaperclipConfigPath()),
    );
    return key;
  }

  function safely(check: () => boolean): boolean {
    try {
      return check();
    } catch (err) {
      logger.warn({ err }, "Could not read the local operator key; refusing the operator browser credential");
      return false;
    }
  }

  /** The board page's own credential, sent as a header or a live-events socket parameter. */
  function hasBrowserToken(value: string | string[] | null | undefined): boolean {
    if (typeof value !== "string" || !value) return false;
    return safely(() => verifyLocalOperatorBrowserToken(operatorKey(), value));
  }

  function hasOperatorHeader(headers: IncomingHttpHeaders): boolean {
    return hasBrowserToken(headers[LOCAL_OPERATOR_HEADER]);
  }

  /**
   * A browser cannot set headers on a WebSocket, so the board page sends its
   * token as a query parameter, which is accepted on upgrade requests only.
   */
  function hasSocketToken(method: string, headers: IncomingHttpHeaders, query: Record<string, unknown>): boolean {
    if (method !== "GET" || headers.upgrade?.toLowerCase() !== "websocket") return false;
    const connection = headers.connection?.toLowerCase().split(",").map((part) => part.trim()) ?? [];
    if (!connection.includes("upgrade")) return false;
    return hasBrowserToken(query[LOCAL_OPERATOR_SOCKET_PARAM] as string | undefined);
  }

  /** The read-only cookie, accepted only for downloads the browser loads directly. */
  function hasDirectReadCookie(method: string, path: string, headers: IncomingHttpHeaders): boolean {
    if (method !== "GET" && method !== "HEAD") return false;
    if (!DIRECT_BROWSER_READ_PATHS.some((pattern) => pattern.test(path))) return false;
    if (!headers.cookie) return false;
    return safely(() => verifyLocalOperatorReadCookieValue(
      operatorKey(),
      readCookie(headers, localOperatorReadCookieName(operatorKey())),
    ));
  }

  function signInUrl(baseUrl: string, next = "/"): string {
    return localOperatorSignInUrl(baseUrl, createLocalOperatorSignInLink(operatorKey()), next);
  }

  function consumeSignIn(query: Record<string, unknown>, now = Date.now()): boolean {
    for (const [nonce, expiresAt] of usedNonces) if (expiresAt < now) usedNonces.delete(nonce);
    const link = { nonce: query.n, expiresAt: query.e, signature: query.s };
    if (!verifyLocalOperatorSignInLink(operatorKey(), link, now)) return false;
    const nonce = link.nonce as string;
    if (usedNonces.has(nonce)) return false;
    usedNonces.set(nonce, now + LOCAL_OPERATOR_SIGN_IN_TTL_MS);
    return true;
  }

  function setReadCookie(res: Response) {
    const operator = operatorKey();
    res.cookie(localOperatorReadCookieName(operator), localOperatorReadCookieValue(operator), {
      httpOnly: true,
      sameSite: "strict",
      path: "/api",
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }

  function signInRoutes() {
    const router = Router();
    // The board page renews its rotating read cookie with its header token.
    router.post("/local-operator/read-cookie", (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      if (!hasOperatorHeader(req.headers)) {
        res.status(403).json({ error: "Local operator sign-in required" });
        return;
      }
      setReadCookie(res);
      res.status(204).end();
    });
    router.get("/local-operator/sign-in", (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      let accepted = false;
      try {
        accepted = consumeSignIn(req.query as Record<string, unknown>);
      } catch (err) {
        logger.warn({ err }, "Could not read the local operator key during browser sign-in");
      }
      if (!accepted) {
        res.status(403).type("text/plain").send(
          "This sign-in link has expired or was already used. Run `paperclipai open` in your terminal to get a new one.",
        );
        return;
      }
      const operator = operatorKey();
      setReadCookie(res);
      // The fragment never reaches a server. The board page moves the token
      // into storage that only its own origin can read.
      const fragment = `${LOCAL_OPERATOR_FRAGMENT_KEY}=${encodeURIComponent(localOperatorBrowserToken(operator))}`;
      res.redirect(303, `${safeNextPath(req.query.next)}#${fragment}`);
    });
    return router;
  }

  return {
    mode,
    required: mode === "required",
    hasBrowserToken,
    hasOperatorHeader,
    hasSocketToken,
    hasDirectReadCookie,
    signInUrl,
    consumeSignIn,
    signInRoutes,
  };
}

export type LocalOperatorCredential = ReturnType<typeof createLocalOperatorCredential>;

let shared: LocalOperatorCredential | null = null;

export function localOperatorCredential(): LocalOperatorCredential {
  shared ??= createLocalOperatorCredential();
  return shared;
}
