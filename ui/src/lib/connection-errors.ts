import {
  CONNECTION_RECOVERABLE_ERROR_CODES,
  type ConnectionRecoverableErrorCode,
  type ConnectionRecoverableErrorPayload,
} from "@paperclipai/shared";
import { ApiError } from "@/api/client";

/**
 * Connections v3 typed recoverable errors (plan-runtime §6).
 *
 * The server serializes recoverable connection errors as
 * `{ error, code, connection?: {uid}, subject?, grantId?, remediation? }`
 * (see server/src/middleware/error-handler.ts). This helper lets the UI branch
 * on the structured `code` instead of string-matching messages.
 */

const RECOVERABLE_CODES = new Set<string>(CONNECTION_RECOVERABLE_ERROR_CODES);

export interface ParsedConnectionError extends ConnectionRecoverableErrorPayload {
  /** Human-readable server message, if any. */
  message: string;
  grantId?: string;
}

export function isConnectionRecoverableCode(
  code: unknown,
): code is ConnectionRecoverableErrorCode {
  return typeof code === "string" && RECOVERABLE_CODES.has(code);
}

/**
 * Extract a typed recoverable connection error from a thrown error (typically
 * an {@link ApiError}). Returns `null` when the error is not one of the
 * recoverable connection codes.
 */
export function parseConnectionError(err: unknown): ParsedConnectionError | null {
  const body =
    err instanceof ApiError
      ? err.body
      : err && typeof err === "object" && "body" in err
        ? (err as { body: unknown }).body
        : err;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!isConnectionRecoverableCode(record.code)) return null;
  const connection =
    record.connection && typeof record.connection === "object"
      ? (record.connection as { uid: string })
      : { uid: "" };
  return {
    code: record.code,
    connection,
    message: typeof record.error === "string" ? record.error : record.code,
    ...(record.subject ? { subject: record.subject as ParsedConnectionError["subject"] } : {}),
    ...(typeof record.grantId === "string" ? { grantId: record.grantId } : {}),
    ...(record.remediation && typeof record.remediation === "object"
      ? { remediation: record.remediation as Record<string, unknown> }
      : {}),
  };
}

/** UI copy + recommended action for each recoverable code (plan-runtime §6 table). */
export const CONNECTION_ERROR_UI: Record<
  ConnectionRecoverableErrorCode,
  { title: string; body: string; action?: "connect_account" | "reconnect" | "add_installation" | "install" }
> = {
  user_authorization_required: {
    title: "Connect your account",
    body: "This connection acts on your behalf. Authorize your account to continue.",
    action: "connect_account",
  },
  grant_revoked: {
    title: "Reconnect required",
    body: "Access for this connection was revoked. Reconnect to restore it.",
    action: "reconnect",
  },
  needs_reauthorization: {
    title: "Reconnect required",
    body: "This connection needs to be re-authorized with the provider.",
    action: "reconnect",
  },
  installation_required: {
    title: "Add installation",
    body: "There is no installation for the requested workspace. Add one to continue.",
    action: "add_installation",
  },
  connection_not_installed: {
    title: "Not installed for this agent",
    body: "The agent is permitted to use this connection but it isn't installed for them yet.",
    action: "install",
  },
  subject_not_permitted: {
    title: "Not permitted",
    body: "You can't act as the requested subject for this connection.",
  },
};
