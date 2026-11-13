import type { ToolConnectionHealthStatus } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../../../errors.js";
import { mcpConnectionFailureReason, retainMcpConnectionFailure } from "../../mcp-connection-failure.js";
import type { ActorInfo } from "../types.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

/**
 * Did this error come from the OAuth endpoint gate (PAP-17099)? Such a refusal
 * is Paperclip's own decision about an unsafe address, so it must keep its code
 * and its 422 instead of being folded into a generic upstream failure.
 */
export function isOAuthEndpointRejection(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  const code = asRecord(error.details).code;
  return typeof code === "string" && code.endsWith("_endpoint_rejected");
}

export function healthFailureHttpStatus(failure: {
  status: ToolConnectionHealthStatus;
  code: string;
}): number {
  if (failure.status === "missing_secret") return 422;
  if (failure.code === "oauth_challenge") return 422;
  if (failure.code === "oauth_refresh_missing") return 422;
  if (failure.code === "oauth_reauthorization_required") return 422;
  if (failure.code === "oauth_insufficient_scope") return 422;
  if (failure.code === "slack_mcp_access_disabled") return 422;
  if (failure.code === "user_authorization_required") return 422;
  if (failure.code === "github_installation_required") return 422;
  if (failure.code === "composio_broker_retired") return 422;
  if (failure.code === "tool_connection_transport_unsupported") return 422;
  if (failure.code === "cognee_access_unverified" || failure.code === "memory_api_key_rejected") return 422;
  if (failure.code.endsWith("_endpoint_rejected")) return 422;
  return 502;
}

export function unsupportedToolConnectionTransport() {
  return unprocessable(
    "This connection has no supported tool integration. Add a supported account or MCP connection from Connectors.",
    { code: "tool_connection_transport_unsupported" },
  );
}

export function sanitizeHttpFailure(error: unknown): {
  status: ToolConnectionHealthStatus;
  message: string;
  code: string;
} {
  if (error instanceof HttpError) {
    const code = asRecord(error.details).code;
    if (code === "cognee_access_unverified" || code === "memory_api_key_rejected") {
      return { status: "error", message: error.message, code };
    }
    if (code === "grant_credential_invalid" || code === "oauth_insufficient_scope") {
      return { status: code === "grant_credential_invalid" ? "missing_secret" : "degraded", message: error.message, code };
    }
    if (code === "slack_mcp_access_disabled" || code === "google_workspace_services_unavailable") {
      return { status: "error", message: error.message, code };
    }
    if (code === "user_authorization_required" || code === "github_installation_required") {
      return { status: "error", message: error.message, code };
    }
    if (code === "tool_connection_transport_unsupported") {
      return { status: "error", message: error.message, code };
    }
    if (code === "composio_broker_retired") {
      return { status: "error", message: error.message, code };
    }
    if (typeof code === "string" && code.startsWith("remote_http_")) {
      return { status: "error", message: error.message, code };
    }
    if (isOAuthEndpointRejection(error)) {
      return { status: "error", message: error.message, code: String(code) };
    }
    if (code === "oauth_challenge") {
      return {
        status: "error",
        message: "This app needs you to sign in.",
        code: "oauth_challenge",
      };
    }
    if (code === "oauth_refresh_missing") {
      return {
        status: "failed",
        message: "OAuth credentials have expired and need to be reconnected.",
        code: "oauth_refresh_missing",
      };
    }
    if (code === "oauth_reauthorization_required") {
      return {
        status: "error",
        message: "OAuth authorization expired. Reconnect this app to continue.",
        code: "oauth_reauthorization_required",
      };
    }
    if (typeof code === "string" && code.startsWith("vercel_connect_")) {
      return {
        status:
          code === "vercel_connect_unavailable" ||
          code === "vercel_connect_auth_failed" ||
          code === "vercel_connect_installation_required"
            ? "degraded"
            : "error",
        message: error.message,
        code,
      };
    }
    if (
      code === "oauth_refresh_in_progress" ||
      code === "oauth_refresh_superseded" ||
      code === "oauth_refresh_outcome_unknown"
    ) {
      return {
        status: "error",
        message: error.message,
        code,
      };
    }
    if (
      code === "binding_missing" ||
      code === "secret_deleted" ||
      code === "secret_inactive" ||
      code === "version_missing"
    ) {
      return {
        status: "missing_secret",
        message: "A configured credential secret could not be resolved.",
        code: String(code),
      };
    }
    if (error.status === 404 && /secret/i.test(error.message)) {
      return {
        status: "missing_secret",
        message: "A configured credential secret could not be resolved.",
        code: "secret_missing",
      };
    }
    return { status: "error", message: error.message, code: "paperclip_error" };
  }
  if (error instanceof Error) {
    return {
      status: "error",
      message: error.message.slice(0, 240),
      code: "runtime_error",
    };
  }
  return {
    status: "error",
    message: "Connection check failed.",
    code: "runtime_error",
  };
}

const UNREACHABLE_SERVER_REASONS: Readonly<Record<string, string>> = {
  connection_refused: "nothing accepted the connection",
  dns_failure: "its host name did not resolve",
  network_unreachable: "its network address could not be reached",
  connection_reset: "the connection was dropped",
  connection_timeout: "it did not answer in time",
  tls_failure: "its TLS certificate was not accepted",
};

/**
 * For an agent, a check that could not reach the MCP server is final until the
 * person fixes the URL or the server. Say so, so the agent hands it back instead
 * of retrying or contacting other network addresses as a workaround.
 */
export function unreachableServerRemediation(
  source: unknown,
  actor?: Pick<ActorInfo, "actorType">,
): { remediation: string } | Record<string, never> {
  if (actor?.actorType !== "agent") return {};
  const reason = mcpConnectionFailureReason(source);
  const detail = reason ? UNREACHABLE_SERVER_REASONS[reason] : undefined;
  if (!detail) return {};
  return {
    remediation: `Paperclip could not reach this MCP server at its saved URL: ${detail}. This result is final until the person fixes it: they must correct the URL, or start the server or make it reachable from Paperclip, and then check it again. Retrying now will not connect it, and you must not contact other hosts, ports or network addresses yourself as a workaround. Reply now: tell the person the server could not be reached and what they need to fix, do not say it is connected, and link [Open Connectors](/<prefix>/apps), with this conversation's company prefix as <prefix>, where they can fix or remove the connection or set it up again.`,
  };
}

/**
 * Every Google Workspace service failed. Carry the first classified cause onto
 * the aggregate so an unreachable server still gets the final remediation
 * instead of a bare "retry".
 */
export function googleWorkspaceServicesUnavailable(services: readonly string[], causes: readonly unknown[]): HttpError {
  const error = new HttpError(502, `Google services unavailable: ${services.join(", ")}. Retry refreshing actions.`,
    { code: "google_workspace_services_unavailable" });
  const cause = causes.find((candidate) => mcpConnectionFailureReason(candidate) !== null);
  return cause === undefined ? error : retainMcpConnectionFailure(cause, error);
}
