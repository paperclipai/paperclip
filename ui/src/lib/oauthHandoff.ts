import type { ToolOAuthStartResult } from "@paperclipai/shared";
import { resolveAuthorizationTarget } from "./authorizationUrl";

const CLOUD_HANDOFF_PATH = "/cloud/connections/handoff";
const CLOUD_REAUTH_PATH = "/cloud/connections/reauth";
const PENDING_HANDOFF_KEY = "paperclip.cloud-oauth-handoff.v1";

export type PreparedOAuthNavigation = {
  kind: "authorization" | "reauthentication";
  url: string;
  host: string;
};

type PendingCloudHandoff = {
  version: 1;
  session: string;
  savedAt: number;
};

export class OAuthHandoffError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_handoff"
      | "expired"
      | "forbidden"
      | "unavailable",
  ) {
    super(message);
    this.name = "OAuthHandoffError";
  }
}

function parseHandoff(value: unknown): { kind: "paperclip_cloud"; session: string } | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthHandoffError("Paperclip Cloud returned an invalid sign-in handoff.", "invalid_handoff");
  }
  const handoff = value as Record<string, unknown>;
  if (
    handoff.kind !== "paperclip_cloud"
    || typeof handoff.session !== "string"
    || handoff.session.length < 16
    || handoff.session.length > 512
    || !/^[A-Za-z0-9_-]+$/.test(handoff.session)
  ) {
    throw new OAuthHandoffError("Paperclip Cloud returned an invalid sign-in handoff.", "invalid_handoff");
  }
  return { kind: "paperclip_cloud", session: handoff.session };
}

function handoffFailure(status: number, code: unknown): OAuthHandoffError {
  if (status === 404 || code === "SESSION_NOT_AVAILABLE") {
    return new OAuthHandoffError("This sign-in expired. Start the connection again.", "expired");
  }
  if (status === 401 || status === 403) {
    return new OAuthHandoffError("Paperclip Cloud could not authorize this connection for your account.", "forbidden");
  }
  return new OAuthHandoffError("Paperclip Cloud couldn’t prepare secure sign-in. Try again.", "unavailable");
}

async function postCloudHandoff(
  session: string,
  options: { signal?: AbortSignal; request?: typeof fetch },
): Promise<Response> {
  const request = options.request ?? fetch;
  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await request(CLOUD_HANDOFF_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({ session }),
        signal: options.signal,
      });
      if (response.status < 500 || attempt === 1) return response;
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      lastError = error;
      if (attempt === 1) break;
    }
  }
  if (response) return response;
  throw new OAuthHandoffError(
    lastError instanceof Error ? lastError.message : "Paperclip Cloud couldn’t prepare secure sign-in. Try again.",
    "unavailable",
  );
}

function exactReauthenticationTarget(value: unknown, session: string): PreparedOAuthNavigation | null {
  if (typeof value !== "string" || typeof window === "undefined") return null;
  try {
    const url = new URL(value, window.location.origin);
    if (
      url.origin !== window.location.origin
      || url.pathname !== CLOUD_REAUTH_PATH
      || url.username
      || url.password
      || url.hash
      || url.searchParams.size !== 1
      || url.searchParams.get("session") !== session
    ) return null;
    return { kind: "reauthentication", url: url.toString(), host: url.host };
  } catch {
    return null;
  }
}

/**
 * Resolve a start response into the next browser navigation.
 *
 * Managed Cloud sessions are exchanged only through the fixed same-origin
 * endpoint. Legacy, self-hosted, and direct provider OAuth keep using the
 * server-supplied authorization URL after the existing URL safety gate.
 */
export async function prepareOAuthNavigation(
  start: Pick<ToolOAuthStartResult, "authorizationUrl" | "handoff">,
  options: { signal?: AbortSignal; request?: typeof fetch } = {},
): Promise<PreparedOAuthNavigation> {
  const handoff = parseHandoff(start.handoff);
  if (!handoff) {
    const target = resolveAuthorizationTarget(start.authorizationUrl);
    if (!target.ok) throw new OAuthHandoffError(target.message, "invalid_handoff");
    return { kind: "authorization", url: target.url, host: target.host };
  }

  const response = await postCloudHandoff(handoff.session, options);
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    if (body?.error === "RECENT_LOGIN_REQUIRED") {
      const reauthentication = exactReauthenticationTarget(body.reauthenticationUrl, handoff.session);
      if (reauthentication) return reauthentication;
    }
    throw handoffFailure(response.status, body?.error);
  }
  const authorization = resolveAuthorizationTarget(
    typeof body?.authorizationUrl === "string" ? body.authorizationUrl : undefined,
  );
  if (!authorization.ok) {
    throw new OAuthHandoffError("Paperclip Cloud returned an invalid provider sign-in address.", "invalid_handoff");
  }
  return { kind: "authorization", url: authorization.url, host: authorization.host };
}

export function savePendingCloudHandoff(
  session: string,
  storage: Pick<Storage, "setItem"> = window.sessionStorage,
): void {
  const handoff = parseHandoff({ kind: "paperclip_cloud", session });
  if (!handoff) throw new OAuthHandoffError("Paperclip Cloud returned an invalid sign-in handoff.", "invalid_handoff");
  const pending: PendingCloudHandoff = { version: 1, session: handoff.session, savedAt: Date.now() };
  storage.setItem(PENDING_HANDOFF_KEY, JSON.stringify(pending));
}

export function readPendingCloudHandoff(
  storage: Pick<Storage, "getItem" | "removeItem"> = window.sessionStorage,
): { kind: "paperclip_cloud"; session: string } | null {
  const raw = storage.getItem(PENDING_HANDOFF_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as Partial<PendingCloudHandoff>;
    if (
      pending.version !== 1
      || typeof pending.savedAt !== "number"
      || Date.now() - pending.savedAt > 15 * 60_000
    ) throw new Error("expired");
    return parseHandoff({ kind: "paperclip_cloud", session: pending.session });
  } catch {
    storage.removeItem(PENDING_HANDOFF_KEY);
    return null;
  }
}

export function clearPendingCloudHandoff(
  storage: Pick<Storage, "removeItem"> = window.sessionStorage,
): void {
  storage.removeItem(PENDING_HANDOFF_KEY);
}
