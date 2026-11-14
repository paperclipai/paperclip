import type { IncomingHttpHeaders } from "node:http";
import { Router, type Request, type Response } from "express";
import {
  LOCAL_OPERATOR_COOKIE_NAME,
  LOCAL_OPERATOR_CREDENTIAL_ENV,
  LOCAL_OPERATOR_SIGN_IN_TTL_MS,
  createLocalOperatorSignInLink,
  ensureLocalOperatorKey,
  localOperatorCookieValue,
  localOperatorSignInUrl,
  parseLocalOperatorCredentialMode,
  resolveLocalOperatorKeyPath,
  verifyLocalOperatorCookieValue,
  verifyLocalOperatorSignInLink,
  type LocalOperatorCredentialMode,
} from "@paperclipai/shared/local-operator-credential";
import { logger } from "./logger.js";

const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const DEFAULT_MODE: LocalOperatorCredentialMode = "off";

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
  return value;
}

export interface LocalOperatorCredentialOptions {
  mode?: LocalOperatorCredentialMode;
  keyPath?: string;
  key?: Buffer;
}

export function createLocalOperatorCredential(options: LocalOperatorCredentialOptions = {}) {
  const configured = parseLocalOperatorCredentialMode(process.env[LOCAL_OPERATOR_CREDENTIAL_ENV]);
  const mode = options.mode ?? configured ?? DEFAULT_MODE;
  let key = options.key ?? null;
  const usedNonces = new Map<string, number>();

  function operatorKey(): Buffer {
    key ??= ensureLocalOperatorKey(options.keyPath ?? resolveLocalOperatorKeyPath());
    return key;
  }

  function hasOperatorCookie(headers: IncomingHttpHeaders): boolean {
    const value = readCookie(headers, LOCAL_OPERATOR_COOKIE_NAME);
    if (!value) return false;
    try {
      return verifyLocalOperatorCookieValue(operatorKey(), value);
    } catch (err) {
      logger.warn({ err }, "Could not read the local operator key; refusing the operator browser credential");
      return false;
    }
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

  function signInRoutes() {
    const router = Router();
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
      res.cookie(LOCAL_OPERATOR_COOKIE_NAME, localOperatorCookieValue(operatorKey()), {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
      });
      res.redirect(303, safeNextPath(req.query.next));
    });
    return router;
  }

  return {
    mode,
    required: mode === "required",
    hasOperatorCookie,
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
