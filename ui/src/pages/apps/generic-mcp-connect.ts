import { t as translate } from "@/i18n";
import { checkMcpRemoteHeaderName, checkMcpRemoteHeaderValue, mcpRemoteHeaderRejectionMessage, MCP_REMOTE_HEADER_LIMITS, type McpRemoteHeaderRejection } from "@paperclipai/shared";
import type { GenericMcpAuthMode } from "@paperclipai/shared";

/**
 * Logic behind the guided "Connect your own MCP server" flow (PAP-17087).
 *
 * Kept out of the component so the branch an operator lands on — and the
 * corrective advice they get — is directly testable, and so the wizard never has
 * to reason about protocol error codes inline.
 */

export type { GenericMcpAuthMode };

export interface CustomHeaderRow {
  /** Stable key so React can track rows across add/remove without reordering values. */
  id: string;
  name: string;
  value: string;
}

let customHeaderRowSeq = 0;

/** A blank custom-header row. The id is local only — it never reaches the API. */
export function newCustomHeaderRow(): CustomHeaderRow {
  customHeaderRowSeq += 1;
  return { id: `header-${customHeaderRowSeq}`, name: "", value: "" };
}

/** The endpoint host, shown prominently so the operator always sees who they are trusting. */
export function endpointHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * The callback URI shown to operators must exactly match the URI the API sends.
 *
 * Xero and a few other OAuth providers reject numeric loopback hosts even though
 * they point at the same machine. The API therefore uses `localhost` for local
 * HTTP OAuth, so the setup form must advertise that same canonical spelling.
 */
export function oauthCallbackUrlForBrowser(
  origin: string = window.location.origin,
  serverCallbackUrl?: string,
): string {
  if (serverCallbackUrl) return serverCallbackUrl;
  const callbackUrl = new URL("/api/tools/oauth/callback", origin);
  const hostname = callbackUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    callbackUrl.protocol === "http:"
    && (hostname === "127.0.0.1" || hostname === "::1")
  ) {
    callbackUrl.hostname = "localhost";
  }
  return callbackUrl.toString();
}

/**
 * A useful, non-secret default label for an arbitrary endpoint.
 *
 * Keep the port and path: one host commonly serves several MCP endpoints, and
 * collapsing all of them to the hostname makes the second connection fail the
 * company-wide application-name constraint. Query strings are deliberately
 * excluded because remote MCP URLs can carry credentials there.
 */
export function defaultGenericMcpName(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}`.slice(0, 160) || null;
  } catch {
    return null;
  }
}

/**
 * Where the operator has to look to fix a failed connect attempt. The wizard uses
 * this to decide whether to reopen the URL field or the credential section, rather
 * than leaving them to guess which of the two was wrong.
 */
export type GenericConnectFocus = "url" | "credentials" | "deployment" | "none";

export interface GenericConnectGuidance {
  title: string;
  body: string;
  focus: GenericConnectFocus;
}

/**
 * Turn an API failure into the specific corrective action the plan asks for:
 * invalid, unsafe, unreachable, or "needs a credential we could not discover".
 *
 * Anything unrecognised falls through to the server's own message, which is
 * already UI-safe (upstream bodies and secrets are stripped server-side).
 */
export function genericConnectGuidance(
  code: string | null | undefined,
  message: string | null | undefined,
): GenericConnectGuidance {
  const fallback = message?.trim() || translate("connections:paperclip_couldn_t_connect_to_that_address_e2ddaef");
  switch (code) {
    case "mcp_remote_url_missing":
    case "mcp_remote_url_invalid":
      return {
        title: translate("connections:that_doesn_t_look_like_a_server_bb44722"),
        body: translate("connections:paste_the_full_address_starting_with_https_a93b04a"),
        focus: "url",
      };
    case "remote_http_private_endpoint":
      return {
        title: translate("connections:that_address_is_inside_a_private_network_eadb64f"),
        body: translate("connections:this_paperclip_is_reachable_from_the_internet_6568a16"),
        focus: "url",
      };
    case "remote_http_dns_failed":
      return {
        title: translate("connections:we_couldn_t_find_that_host_82fd928"),
        body: translate("connections:the_address_didn_t_resolve_check_the_49e8166"),
        focus: "url",
      };
    case "mcp_header_rejected":
      return {
        title: translate("connections:paperclip_can_t_send_that_header_90644df"),
        body: fallback,
        focus: "credentials",
      };
    case "tool_access_name_conflict":
      return {
        title: translate("connections:paperclip_couldn_t_name_this_connection_075a616"),
        body: translate("connections:try_connecting_again_5b377ae"),
        focus: "none",
      };
    case "oauth_challenge":
      return {
        title: translate("connections:this_server_wants_a_credential_e6ac341"),
        body: translate("connections:it_asked_us_to_authenticate_but_didn_4095568"),
        focus: "credentials",
      };
    case "oauth_manual_client_required":
    case "oauth_manual_client_rebinding_required":
      return {
        title: translate("connections:this_server_needs_sign_in_details_you_f6653ad"),
        body: translate("connections:register_paperclip_in_the_provider_s_settings_fe16193"),
        focus: "credentials",
      };
    case "oauth_redirect_origin_unsupported":
    case "oauth_redirect_uri_invalid":
      return {
        title: translate("connections:this_paperclip_needs_a_public_https_address_db6c2dd"),
        body: translate("connections:sign_in_sends_the_operator_back_to_1699da1"),
        focus: "deployment",
      };
    case "runtime_error":
      return {
        title: translate("connections:we_couldn_t_reach_that_server_577095a"),
        body: translate("connections:nothing_answered_at_that_address_confirm_the_f9fb6f5"),
        focus: "url",
      };
    default:
      return {
        title: translate("connections:paperclip_couldn_t_connect_2690bb9"),
        body: fallback,
        focus: "none",
      };
  }
}

/**
 * First client-side complaint about the custom headers, or null when they're fine.
 * The API validates these too; checking here means the operator finds out before a
 * round trip rather than after one.
 */
function localizedHeaderError(headerName: string, reason: McpRemoteHeaderRejection): string {
  const name = reason === "too_long" || reason === "invalid_characters" ? headerName.slice(0, MCP_REMOTE_HEADER_LIMITS.maxNameLength) : headerName;
  return translate(`connections:headerValidation.${reason}`, { name, defaultValue: mcpRemoteHeaderRejectionMessage(headerName, reason) });
}

export function customHeaderError(rows: CustomHeaderRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value.trim()) continue;
    const nameCheck = checkMcpRemoteHeaderName(name);
    if (!nameCheck.ok) return localizedHeaderError(name, nameCheck.reason!);
    const valueCheck = checkMcpRemoteHeaderValue(row.value);
    if (!valueCheck.ok) return localizedHeaderError(name, valueCheck.reason!);
    if (!row.value.trim()) return translate("connections:add_a_value_for_or_remove_the_ee0921e", { name: name });
    const lower = name.toLowerCase();
    if (seen.has(lower)) return translate("connections:is_listed_twice_4aae50f", { name: name });
    seen.add(lower);
  }
  return null;
}

export interface GenericConnectDraft {
  link: string;
  name: string;
  authMode: GenericMcpAuthMode;
  /** Simple path: the operator answered "Yes" to "does it need a key?". */
  needsKey: boolean;
  keyValue: string;
  headers: CustomHeaderRow[];
  oauthClientId: string;
  oauthClientSecret: string;
}

export interface GenericConnectPayload {
  link: string;
  name?: string;
  authMode?: GenericMcpAuthMode;
  credentialValues?: Record<string, string>;
  oauthClient?: { clientId: string; clientSecret?: string };
}

/**
 * Build the connect request from wizard state.
 *
 * `authMode` is only sent when the operator made an explicit choice under Advanced
 * authentication; the simple path leaves it off so the server probes and decides.
 * Header values become `headers.<Name>` credential paths, which the server turns
 * into Paperclip secrets — nothing here ever puts a value in the config.
 */
export function genericConnectPayload(draft: GenericConnectDraft): GenericConnectPayload {
  const credentialValues: Record<string, string> = {};
  const bearerKey = draft.keyValue.trim();
  const useBearer = draft.authMode === "bearer" || (draft.authMode === "auto" && draft.needsKey);
  if (useBearer && bearerKey) credentialValues["credentials.authorization"] = bearerKey;
  if (draft.authMode === "custom_headers") {
    for (const row of draft.headers) {
      const name = row.name.trim();
      if (!name || !row.value.trim()) continue;
      credentialValues[`headers.${name}`] = row.value;
    }
  }
  const trimmedName = draft.name.trim();
  const clientId = draft.oauthClientId.trim();
  const clientSecret = draft.oauthClientSecret.trim();
  return {
    link: draft.link,
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(draft.authMode === "auto" ? {} : { authMode: draft.authMode }),
    ...(Object.keys(credentialValues).length > 0 ? { credentialValues } : {}),
    ...(draft.authMode === "oauth" && clientId
      ? { oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) } }
      : {}),
  };
}

/** Can "Check link" be pressed? */
export function canSubmitGenericConnect(draft: GenericConnectDraft): boolean {
  if (!draft.link.trim()) return false;
  if (draft.authMode === "auto") return !draft.needsKey || draft.keyValue.trim().length > 0;
  if (draft.authMode === "bearer") return draft.keyValue.trim().length > 0;
  if (draft.authMode === "custom_headers") {
    const filled = draft.headers.filter((row) => row.name.trim() && row.value.trim());
    return filled.length > 0 && customHeaderError(draft.headers) === null;
  }
  // "oauth" here means the operator is supplying a preregistered client, and
  // "none" means they are asserting the server is public — neither needs a value.
  return true;
}
