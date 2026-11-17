import { McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * JSON-RPC error code for a request Google refused because of the access
 * token, not the arguments. Outside the reserved -32000..-32099 server range
 * values used by the MCP SDK itself.
 */
export const GOOGLE_AUTH_ERROR_CODE = -32050;

export type GoogleAuthFailure = "unauthenticated" | "insufficient_scope";

/**
 * Google rejected the access token (401) or the token lacks a scope the call
 * needs (403 insufficient scope). Thrown, never returned as a tool result, so a
 * caller can refresh the token or ask the user to reconnect. `data.code` uses
 * the same `insufficient_scope` value the gateway already recognizes.
 */
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

/** Why a call failed for a reason other than authorization. Becomes an MCP tool error result. */
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
  | "unsupported";

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
