import { checkMcpRemoteHeaderName, checkMcpRemoteHeaderValue, mcpRemoteHeaderRejectionMessage } from "@paperclipai/shared";
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
export type GenericConnectFocus = "url" | "name" | "credentials" | "deployment" | "none";

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
  const fallback = message?.trim() || "Paperclip couldn't connect to that address. Check it and try again.";
  switch (code) {
    case "mcp_remote_url_missing":
    case "mcp_remote_url_invalid":
      return {
        title: "That doesn't look like a server address",
        body: "Paste the full address, starting with https:// — for example https://mcp.example.com/mcp.",
        focus: "url",
      };
    case "remote_http_private_endpoint":
      return {
        title: "That address is inside a private network",
        body: "This Paperclip is reachable from the internet, so it won't call addresses on your local network. Use the server's public address instead.",
        focus: "url",
      };
    case "remote_http_dns_failed":
      return {
        title: "We couldn't find that host",
        body: "The address didn't resolve. Check the spelling, or confirm the server is published on the internet.",
        focus: "url",
      };
    case "mcp_header_rejected":
      return {
        title: "Paperclip can't send that header",
        body: fallback,
        focus: "credentials",
      };
    case "tool_access_name_conflict":
      return {
        title: "That name is taken",
        body: "Choose a different name for this connection, then try again.",
        focus: "name",
      };
    case "oauth_challenge":
      return {
        title: "This server wants a credential",
        body: "It asked us to authenticate but didn't offer a sign-in Paperclip can complete on its own. Add the key or headers its docs list under Advanced authentication.",
        focus: "credentials",
      };
    case "oauth_manual_client_required":
    case "oauth_manual_client_rebinding_required":
      return {
        title: "This server needs sign-in details you create yourself",
        body: "Register Paperclip in the provider's settings, then add the client ID and secret it gives you under Advanced authentication.",
        focus: "credentials",
      };
    case "oauth_redirect_origin_unsupported":
    case "oauth_redirect_uri_invalid":
      return {
        title: "This Paperclip needs a public HTTPS address first",
        body: "Sign-in sends the operator back to Paperclip, so this instance has to be reachable over HTTPS. Ask your Paperclip admin to configure it.",
        focus: "deployment",
      };
    case "runtime_error":
      return {
        title: "We couldn't reach that server",
        body: "Nothing answered at that address. Confirm the server is running and the address is right, then try again.",
        focus: "url",
      };
    default:
      return {
        title: "Paperclip couldn't connect",
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
export function customHeaderError(rows: CustomHeaderRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value.trim()) continue;
    const nameCheck = checkMcpRemoteHeaderName(name);
    if (!nameCheck.ok) return mcpRemoteHeaderRejectionMessage(name, nameCheck.reason!);
    const valueCheck = checkMcpRemoteHeaderValue(row.value);
    if (!valueCheck.ok) return mcpRemoteHeaderRejectionMessage(name, valueCheck.reason!);
    if (!row.value.trim()) return `Add a value for "${name}", or remove the row.`;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return `"${name}" is listed twice.`;
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
