import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "./home-paths.js";

/**
 * The local operator credential proves that a request to a `local_trusted`
 * instance comes from the human operator rather than from agent-run code on
 * the same machine. It is derived from a key file in the instance directory
 * that agent environments never receive.
 */
export {
  LOCAL_OPERATOR_FRAGMENT_KEY,
  LOCAL_OPERATOR_HEADER,
  LOCAL_OPERATOR_SOCKET_PARAM,
} from "./local-operator-constants.js";
export const LOCAL_OPERATOR_SIGN_IN_PATH = "/api/local-operator/sign-in";
export const LOCAL_OPERATOR_SIGN_IN_TTL_MS = 10 * 60 * 1000;
export const LOCAL_OPERATOR_CREDENTIAL_ENV = "PAPERCLIP_LOCAL_OPERATOR_CREDENTIAL";

const KEY_BYTES = 32;
const BROWSER_TOKEN_PURPOSE = "paperclip-local-operator-browser-v1";
const READ_COOKIE_PURPOSE = "paperclip-local-operator-read-cookie-v1";
const COOKIE_NAME_PURPOSE = "paperclip-local-operator-cookie-name-v1";

export function resolveLocalOperatorKeyPath(input: { homeDir?: string; instanceId?: string } = {}): string {
  return path.resolve(resolvePaperclipInstanceRoot(input), "secrets", "local-operator.key");
}

function sign(key: Buffer, purpose: string): string {
  return createHmac("sha256", key).update(purpose).digest("base64url");
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readLocalOperatorKey(keyPath: string): Buffer | null {
  try {
    const key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64url");
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/** Returns the operator key, creating it with owner-only permissions on first use. */
export function ensureLocalOperatorKey(keyPath: string): Buffer {
  const existing = readLocalOperatorKey(keyPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  try {
    fs.writeFileSync(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = readLocalOperatorKey(keyPath);
    if (!winner) throw new Error(`The local operator key at ${keyPath} is unreadable`);
    return winner;
  }
  return key;
}

/** The board page's credential. Browsers keep it in origin-scoped storage, never in a cookie. */
export function localOperatorBrowserToken(key: Buffer): string {
  return `v1.${sign(key, BROWSER_TOKEN_PURPOSE)}`;
}

export function verifyLocalOperatorBrowserToken(key: Buffer, value: string | null | undefined): boolean {
  return typeof value === "string" && sameValue(value, localOperatorBrowserToken(key));
}

/**
 * Cookies are not isolated by port, so any local server the browser visits
 * receives them. The cookie is therefore a separate, read-only credential for
 * the few downloads the browser loads directly. Its name is per instance so
 * two local boards do not sign each other out.
 */
export function localOperatorReadCookieName(key: Buffer): string {
  return `paperclip_local_operator_${sign(key, COOKIE_NAME_PURPOSE).replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`;
}

export function localOperatorReadCookieValue(key: Buffer): string {
  return `r1.${sign(key, READ_COOKIE_PURPOSE)}`;
}

export function verifyLocalOperatorReadCookieValue(key: Buffer, value: string | null | undefined): boolean {
  return typeof value === "string" && sameValue(value, localOperatorReadCookieValue(key));
}

export interface LocalOperatorSignInLink {
  nonce: string;
  expiresAt: number;
  signature: string;
}

export function createLocalOperatorSignInLink(key: Buffer, now = Date.now()): LocalOperatorSignInLink {
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = now + LOCAL_OPERATOR_SIGN_IN_TTL_MS;
  return { nonce, expiresAt, signature: sign(key, `sign-in:${nonce}:${expiresAt}`) };
}

export function localOperatorSignInUrl(baseUrl: string, link: LocalOperatorSignInLink, next = "/"): string {
  const url = new URL(LOCAL_OPERATOR_SIGN_IN_PATH, baseUrl);
  url.searchParams.set("n", link.nonce);
  url.searchParams.set("e", String(link.expiresAt));
  url.searchParams.set("s", link.signature);
  if (next !== "/") url.searchParams.set("next", next);
  return url.toString();
}

export function verifyLocalOperatorSignInLink(
  key: Buffer,
  link: { nonce: unknown; expiresAt: unknown; signature: unknown },
  now = Date.now(),
): boolean {
  const { nonce, signature } = link;
  const expiresAt = Number(link.expiresAt);
  if (typeof nonce !== "string" || typeof signature !== "string" || !Number.isSafeInteger(expiresAt)) return false;
  if (expiresAt < now || expiresAt > now + LOCAL_OPERATOR_SIGN_IN_TTL_MS) return false;
  return sameValue(signature, sign(key, `sign-in:${nonce}:${expiresAt}`));
}

export type LocalOperatorCredentialMode = "required" | "off";

export function parseLocalOperatorCredentialMode(value: string | undefined): LocalOperatorCredentialMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "required" || normalized === "on" || normalized === "true") return "required";
  if (normalized === "off" || normalized === "false") return "off";
  return null;
}
