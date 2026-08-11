import { createHmac, timingSafeEqual } from "node:crypto";
import { unprocessable } from "../../errors.js";

/**
 * Signed, expiring connection state for provider install/callback flows.
 *
 * The state is an HMAC-SHA256 signed, base64url-encoded payload bound to the
 * company and user that initiated the connection. It carries an expiry and a
 * nonce so a callback cannot be replayed after it lapses or be forged without
 * the app's state secret. The secret never leaves the server and is never
 * persisted on any connection/repository row.
 */

export interface ConnectionStatePayload {
  companyId: string;
  userId: string;
  provider: string;
  /** Optional app-relative return path. */
  redirectPath?: string | null;
  /** Random per-request nonce. */
  nonce: string;
  /** Issued-at epoch ms. */
  iat: number;
  /** Expiry epoch ms. */
  exp: number;
}

export interface SignConnectionStateInput {
  companyId: string;
  userId: string;
  provider: string;
  redirectPath?: string | null;
  secret: string;
  ttlMs: number;
  nonce: string;
  now?: Date;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signConnectionState(input: SignConnectionStateInput): { state: string; payload: ConnectionStatePayload } {
  if (!input.secret) throw unprocessable("Provider state secret is not configured");
  const iat = (input.now ?? new Date()).getTime();
  const payload: ConnectionStatePayload = {
    companyId: input.companyId,
    userId: input.userId,
    provider: input.provider,
    redirectPath: input.redirectPath ?? null,
    nonce: input.nonce,
    iat,
    exp: iat + Math.max(1, input.ttlMs),
  };
  const body = base64url(JSON.stringify(payload));
  const signature = sign(input.secret, body);
  return { state: `${body}.${signature}`, payload };
}

export interface VerifyConnectionStateInput {
  state: string;
  provider: string;
  secret: string;
  now?: Date;
}

export function verifyConnectionState(input: VerifyConnectionStateInput): ConnectionStatePayload {
  if (!input.secret) throw unprocessable("Provider state secret is not configured");
  const parts = input.state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw unprocessable("Connection state is malformed");
  const [body, signature] = parts;
  const expected = sign(input.secret, body);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw unprocessable("Connection state signature is invalid");
  }

  let payload: ConnectionStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConnectionStatePayload;
  } catch {
    throw unprocessable("Connection state payload is invalid");
  }

  if (payload.provider !== input.provider) throw unprocessable("Connection state is for a different provider");
  const now = (input.now ?? new Date()).getTime();
  if (typeof payload.exp !== "number" || now > payload.exp) throw unprocessable("Connection state has expired");
  if (!payload.companyId || !payload.userId) throw unprocessable("Connection state is missing its subject binding");
  return payload;
}
