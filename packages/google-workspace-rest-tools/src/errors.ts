import { McpError } from "@modelcontextprotocol/sdk/types.js";

export const GOOGLE_AUTH_ERROR_CODE = -32050;

export type GoogleAuthFailure = "unauthenticated" | "insufficient_scope";

export class GoogleWorkspaceAuthError extends McpError {
  readonly reason: GoogleAuthFailure;
  readonly httpStatus: 401 | 403;

  constructor(reason: GoogleAuthFailure) {
    const httpStatus = reason === "unauthenticated" ? 401 : 403;
    super(
      GOOGLE_AUTH_ERROR_CODE,
      reason === "unauthenticated"
        ? "Google did not accept the access token. Reconnect Google Workspace."
        : "Google Workspace has not granted the permission this action needs. Reconnect Google Workspace and allow it.",
      { code: reason, httpStatus },
    );
    this.name = "GoogleWorkspaceAuthError";
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

export type GoogleToolErrorKind =
  | "invalid_argument"
  | "not_found"
  | "permission_denied"
  | "api_disabled"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "network"
  | "invalid_response"
  | "unsupported"
  | "incomplete";

export class GoogleToolError extends Error {
  readonly kind: GoogleToolErrorKind;
  readonly httpStatus: number | null;

  constructor(kind: GoogleToolErrorKind, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "GoogleToolError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}
