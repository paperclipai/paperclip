import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, desc, eq, gte, inArray, isNull, lt, max, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  connectionGrantMembers,
  connectionGrantDelegations,
  connectionGrants,
  connectionTokenIssuances,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  userSecretDefinitions,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  plugins,
  projects,
  routines,
  toolAccessAuditEvents,
  toolApplications,
  toolActionRequests,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolOauthStates,
  toolStdioCommandTemplates,
  toolCallEvents,
  toolInvocations,
  toolPolicies,
  toolGatewaySessions,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeMetricCounters,
  toolRuntimeSlots,
} from "@paperclipai/db";
import type {
  AppDefinition,
  ConnectionGrantKind,
  ConnectionMethodDef,
  ConnectionTokenIssuanceOutcome,
  ConnectionTokenIssuancePath,
  ConnectionTokenRequest,
  ConnectionTokenResponse,
  CreateToolApplication,
  CreateToolConnection,
  ConnectToolApp,
  ConnectToolAppResult,
  CreateToolStdioCommandTemplate,
  FinishToolApp,
  FinishToolAppResult,
  FinalizeOAuthAccess,
  CreateToolProfileBindingForProfile,
  CreateToolProfileEntryForProfile,
  CreateToolProfileWithEntries,
  DeleteToolProfile,
  DeploymentExposure,
  DeploymentMode,
  DuplicateToolProfile,
  ImportMcpJson,
  McpConnectionCredentialRef,
  McpJsonImportPreview,
  ToolApplication,
  ToolCatalogEntry,
  ToolCatalogRefreshResult,
  ToolConnection,
  ToolConnectionInstall,
  ToolConnectionInstallSnapshot,
  ToolConnectionRemovalResult,
  ToolConnectionRemovalSummary,
  ToolConnectionHealthCheckResult,
  ToolConnectionHealthStatus,
  ToolConnectionAuthKind,
  ToolConnectionCredentialPolicy,
  ToolConnectionCredentialSource,
  ToolConnectionTransport,
  ToolCredentialSecretRef,
  ToolOAuthStartResult,
  ToolAppsAttentionResponse,
  ToolAppMetadataPreflightResult,
  ToolActionRequest,
  ToolActionRequestListItem,
  ToolActionRequestStatus,
  ToolConnectionActivityResponse,
  ToolAppConnectionActionSummary,
  ToolExampleInstallResult,
  ToolExampleSmokeCheck,
  ToolExampleSmokeResult,
  ToolExampleSummary,
  ToolCallEvent,
  ToolInvocation,
  ToolProfile,
  ToolProfileBinding,
  ToolProfileEffectiveSummary,
  ToolProfileEntry,
  ToolProfileNewToolReviewItem,
  ToolProfileNewToolsReview,
  ToolProfileNewToolsReviewResult,
  ToolProfileSummary,
  ToolProfileWithDetails,
  ToolPolicyDecision,
  ToolPolicy,
  ToolRiskLevel,
  ToolRuntimeAlertRecommendation,
  ToolRuntimeHealthSummary,
  ToolRunDecision,
  ToolRunDecisionLookup,
  ToolRuntimeSlot,
  ToolStdioCommandTemplate,
  ReviewToolProfileNewTools,
  UpdateToolApplication,
  UpdateToolConnection,
  PutToolConnectionInstalls,
  UpdateToolProfileEntry,
  UpdateToolProfileWithEntries,
  UnbindToolProfileBinding,
  VercelConnectCredentialReference,
  VercelConnectGrantReference,
} from "@paperclipai/shared";
import { CLASS3_STATIC_LEASE_ALLOWLIST, GOOGLE_WORKSPACE_CONNECTOR_PROFILES, connectionIntentPayloadSchema, credentialConfigPath, getAppDefinitionForUrl, getAvailableConnectionMethod, getAvailableConnectionMethods, getConnectableAppDefinition, isGoogleWorkspaceConnectorProfileId, isToolConnectionAttentionHealth, recommendedDefaultsForApp, resolveConnectionMethodServerUrl, type GoogleWorkspaceConnectorProfileId } from "@paperclipai/shared";
import {
  checkMcpRemoteHeaderName,
  checkMcpRemoteHeaderValue,
  mcpRemoteHeaderNameFromConfigPath,
  mcpRemoteHeaderRejectionMessage,
} from "@paperclipai/shared";
import {
  checkOAuthEndpointUrl,
  oauthEndpointUrlRejectionMessage,
  type OAuthEndpointKind,
  type OAuthEndpointUrlRejection,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  initializeMcpHttpSession,
  mcpHttpRequestHeaders,
  parseMcpHttpResponseBody,
} from "./mcp-http.js";
import {
  assertPublicRemoteHttpEndpoint,
  parseRemoteHttpEndpoint,
  type RemoteHttpEndpointLookup,
} from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch, type GuardedRemoteHttpFetchOptions } from "./remote-http-fetch.js";
import {
  REMOTE_URL_SECRET_CONFIG_PATH,
  remoteUrlCredentialMatchesPublicUrl,
  splitRemoteUrlCredential,
} from "./remote-url-credentials.js";
import { secretService } from "./secrets.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { readSignedToolArgumentsPayload } from "./tool-content-guards.js";
import {
  effectiveToolProfileBindings,
  narrowestScopeBindings,
  profileIdsInBindingOrder,
} from "./tool-profile-binding-precedence.js";
import { recordToolRuntimeAuditWriteFailure, TOOL_RUNTIME_AUDIT_WRITE_FAILURE_METRIC } from "./tool-runtime-metrics.js";
import { createToolRuntimeSupervisor, ToolRuntimeSupervisorError } from "./tool-runtime-supervisor.js";
import { listConnectionLifecycleEvents } from "./tool-connection-activity.js";
import { ComposioApiError, createComposioClient, type ComposioClient } from "./composio.js";
import { composioChildConfig, createComposioSessionManager } from "./composio-session-manager.js";
import {
  createPaperclipCloudConnector,
  isPaperclipCloudConnectorStrategy,
  paperclipCloudConnectorConfigFromEnv,
  type PaperclipCloudConnector,
} from "./paperclip-cloud-connector.js";
import {
  createVercelConnectClient,
  deriveVercelConnectSubject,
  vercelConnectCallbackUrl,
  vercelConnectIntegrationStatus,
  vercelGrantReference,
  vercelTokenRequest,
  VercelConnectClientError,
  type VercelConnectClient,
} from "./vercel-connect.js";

type ActorInfo = {
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  sessionId?: string | null;
};

const ACTIVE_BROKER_RUN_STATUSES = new Set(["running"]);
const REMOTE_HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REMOTE_HTTP_REDIRECTS = 5;
const MAX_OAUTH_DCR_CLIENT_ID_LENGTH = 4_096;
const MAX_OAUTH_DCR_CLIENT_SECRET_LENGTH = 16_384;
const OAUTH_REFRESH_LEASE_MS = 120_000;
const OAUTH_REFRESH_LEASE_WAIT_MS = 30_000;
const OAUTH_REFRESH_LEASE_POLL_MS = 25;

/**
 * Upstream OAuth error redaction (PAP-17108).
 *
 * A generic remote MCP connection points at an arbitrary authorization server,
 * so everything that server says about a failure is attacker-chosen: `error`,
 * `error_description`, `error_uri`, and the response body. Paperclip surfaces
 * connection failures to the operator through API responses, board UI copy,
 * audit rows and logs, so reflecting any of that text would let a hostile
 * provider plant secrets, ANSI escapes, or instructions ("paste your recovery
 * key here") into Paperclip's own voice.
 *
 * The rule is therefore: the operator only ever reads text Paperclip authored.
 * The provider's `error` code survives — as a *label* in structured `details`,
 * never in a message — and only when it is one of the codes the RFCs define,
 * because a label is still untrusted input. Everything else is dropped, and an
 * unrecognized code collapses to `unrecognized` rather than being echoed.
 *
 * `error_description` and the response body are never read at all: no call site
 * below parses them, which is what keeps a future edit from quietly
 * reintroducing the reflection.
 */
const OAUTH_PROVIDER_ERROR_CODES = new Set([
  // RFC 6749 §4.1.2.1 — authorization endpoint (the callback-denial path).
  "access_denied",
  "invalid_request",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_response_type",
  // RFC 6749 §5.2 — token endpoint (authorization-code and refresh exchanges).
  "invalid_client",
  "invalid_grant",
  "unsupported_grant_type",
  // RFC 7591 §3.2.2 — dynamic client registration.
  "invalid_client_metadata",
  "invalid_redirect_uri",
  "invalid_software_statement",
  "unapproved_software_statement",
  // OpenID Connect Core §3.1.2.6 — interactive re-authentication prompts.
  "account_selection_required",
  "consent_required",
  "interaction_required",
  "login_required",
]);

/** What an `error` that is absent, malformed, or off the allowlist becomes. */
const UNRECOGNIZED_OAUTH_PROVIDER_ERROR = "unrecognized";
const MAX_OAUTH_PROVIDER_ERROR_LENGTH = 64;
const OAUTH_PROVIDER_ERROR_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Stable, Paperclip-authored operator copy for each allowlisted provider error.
 * Deliberately keyed on the code alone: the calling context is already carried
 * by the Paperclip `code` in `details`, so one table serves the callback,
 * token-exchange and registration paths without any of them composing a message
 * out of provider text.
 */
const OAUTH_PROVIDER_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "The authorization server denied the request.",
  account_selection_required: "The authorization server needs an account to be selected. Try connecting again.",
  consent_required: "The authorization server needs consent to be granted. Try connecting again.",
  interaction_required: "The authorization server needs to be signed in to interactively. Try connecting again.",
  invalid_client: "The authorization server rejected Paperclip's OAuth client.",
  invalid_client_metadata: "The authorization server rejected Paperclip's client registration details.",
  invalid_grant: "The authorization server rejected the authorization code or refresh token.",
  invalid_redirect_uri: "The authorization server rejected Paperclip's callback URL.",
  invalid_request: "The authorization server rejected the request as malformed.",
  invalid_scope: "The authorization server rejected the requested permissions.",
  invalid_software_statement: "The authorization server rejected Paperclip's client registration details.",
  login_required: "The authorization server needs to be signed in to. Try connecting again.",
  server_error: "The authorization server reported an internal error. Try again shortly.",
  temporarily_unavailable: "The authorization server is temporarily unavailable. Try again shortly.",
  unapproved_software_statement: "The authorization server rejected Paperclip's client registration details.",
  unauthorized_client: "The authorization server refused to authorize Paperclip's OAuth client.",
  unsupported_grant_type: "The authorization server does not support the grant Paperclip uses.",
  unsupported_response_type: "The authorization server does not support the sign-in flow Paperclip uses.",
};

/**
 * Reduce a provider-supplied `error` to a bounded, allowlisted label safe to
 * keep in structured `details`. Returns `null` only when the provider sent no
 * `error` at all, so the caller can tell "silent failure" from "said something
 * Paperclip does not recognize".
 */
function normalizeOAuthProviderError(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // Bound length and character class before the allowlist even though
  // membership implies both: these limits are what keeps the label safe if the
  // allowlist above ever grows a pattern-matched entry.
  if (value.length > MAX_OAUTH_PROVIDER_ERROR_LENGTH) return UNRECOGNIZED_OAUTH_PROVIDER_ERROR;
  if (!OAUTH_PROVIDER_ERROR_PATTERN.test(value)) return UNRECOGNIZED_OAUTH_PROVIDER_ERROR;
  return OAUTH_PROVIDER_ERROR_CODES.has(value) ? value : UNRECOGNIZED_OAUTH_PROVIDER_ERROR;
}

/** Paperclip's own message for a provider failure, never the provider's. */
function oauthProviderErrorMessage(providerError: string | null, fallback: string): string {
  if (!providerError) return fallback;
  return OAUTH_PROVIDER_ERROR_MESSAGES[providerError] ?? fallback;
}

/**
 * Where this deployment publishes its Client ID Metadata Document. The document's
 * own URL is the `client_id` Paperclip presents, so this path is a stable part of
 * the deployment's public contract with every authorization server that has seen
 * it — changing it invalidates existing CIMD registrations.
 */
export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH = "/api/tools/oauth/client-metadata";

/**
 * Resolve the URL Paperclip would use as a CIMD client id, but only when its
 * hostname is not known to resolve into a private network.
 *
 * An authorization server fetches this URL from outside Paperclip's network and
 * will normally apply an SSRF guard. Tailscale/MagicDNS names are HTTPS but
 * resolve into 100.64.0.0/10, so presenting one as a client id can only produce
 * an `invalid_client` response. A local DNS failure remains inconclusive because
 * split-horizon public DNS may still let the authorization server resolve it.
 */
export async function resolveOAuthClientIdMetadataDocumentUrl(
  redirectUri: string,
  lookup?: RemoteHttpEndpointLookup,
): Promise<string | null> {
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isLoopback = hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (isLoopback) return null;
    const metadataUrl = new URL(OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH, parsed.origin).toString();
    try {
      await assertPublicRemoteHttpEndpoint(
        new URL(metadataUrl),
        { allowPrivateNetwork: false, lookup },
        (message, code) => Object.assign(new Error(message), { code }),
      );
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "remote_http_private_endpoint"
      ) {
        return null;
      }
    }
    return metadataUrl;
  } catch {
    return null;
  }
}

/**
 * Paperclip's client metadata for CIMD (RFC 7591 metadata, served rather than
 * registered). Only the callback for this deployment appears in it, so an
 * authorization server that fetches it can see exactly one legal redirect target.
 */
export function oauthClientIdMetadataDocument(input: {
  clientId: string;
  redirectUri: string;
}): Record<string, unknown> {
  return {
    client_id: input.clientId,
    client_name: `Paperclip (${new URL(input.redirectUri).host})`,
    client_uri: new URL("/", input.clientId).toString(),
    redirect_uris: [input.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
}

type OAuthProviderEndpoints = {
  provider: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl?: string | null;
  codeChallengeMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  grantTypesSupported?: string[];
  grantType?: "authorization_code" | "client_credentials";
  metadataUrl?: string | null;
  /**
   * Canonical authorization-server issuer, when discovery found one. Registered
   * client material is bound to it, `iss` on the callback is validated against
   * it, and reconnect/refresh reuse it instead of re-deriving a provider key.
   */
  issuer?: string | null;
  /**
   * RFC 8707 resource indicator: the MCP endpoint the token is for. Sent on both
   * authorization and token requests so the authorization server can audience-
   * restrict the access token to this server rather than to everything Paperclip
   * has ever connected.
   */
  resource?: string | null;
  /** The authorization server advertised support for Client ID Metadata Documents. */
  clientIdMetadataDocumentSupported?: boolean;
};

/**
 * Where an OAuth client came from, in the preference order the current MCP
 * client-registration guidance recommends (PAP-17087).
 */
type OAuthClientRegistrationSource = "preconfigured" | "cimd" | "dcr" | "manual";

/**
 * RFC 8414 §3.1 requires the well-known path to be *inserted between* the
 * issuer host and its path component, but a large amount of deployed software
 * only serves the naive suffix form. OpenID Connect Discovery 1.0 in turn
 * specifies the suffix form. Try all of them for an issuer that has a path, and
 * the plain origin form when it doesn't.
 */
function wellKnownMetadataUrls(issuer: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    return [];
  }
  const suffixes = ["oauth-authorization-server", "openid-configuration"];
  const path = parsed.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  for (const suffix of suffixes) {
    if (path) {
      // RFC 8414: https://host/.well-known/<suffix><path>
      urls.push(new URL(`/.well-known/${suffix}${path}`, parsed.origin).toString());
      // OIDC Discovery / widely deployed: https://host<path>/.well-known/<suffix>
      urls.push(new URL(`${path}/.well-known/${suffix}`, parsed.origin).toString());
    }
    urls.push(new URL(`/.well-known/${suffix}`, parsed.origin).toString());
  }
  return [...new Set(urls)];
}

/**
 * Protected-resource metadata lives at `/.well-known/oauth-protected-resource`
 * with the resource's path appended (RFC 9728 §3.1). Probe the path-aware form
 * first so a multi-tenant host that serves several MCP servers resolves to the
 * right one, then fall back to the origin form.
 */
function protectedResourceMetadataUrls(endpoint: URL): string[] {
  const path = endpoint.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (path) urls.push(new URL(`/.well-known/oauth-protected-resource${path}`, endpoint.origin).toString());
  urls.push(new URL("/.well-known/oauth-protected-resource", endpoint.origin).toString());
  return [...new Set(urls)];
}

/**
 * Canonical RFC 8707 resource indicator for an MCP endpoint: origin + path, with
 * query, fragment and any trailing slash removed. Vendor query parameters belong
 * to the connection config, not to the token audience.
 */
function canonicalResourceIndicator(endpoint: string): string | null {
  try {
    const parsed = new URL(endpoint);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`;
  } catch {
    return null;
  }
}

/**
 * Two issuers are the same authorization server only when scheme, host, port and
 * path match exactly (a trailing slash is not significant). Used for `iss`
 * validation on the callback and for detecting that a stored registration is
 * bound to a different server than the one we just discovered.
 */
function sameOAuthIssuer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol
      && left.host === right.host
      && left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

const oauthRegistrationFlights = new Map<string, Promise<unknown>>();

async function singleFlight<T>(
  flights: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = operation();
  flights.set(key, pending);
  try {
    return await pending;
  } finally {
    if (flights.get(key) === pending) flights.delete(key);
  }
}

type ToolAccessServiceOptions = {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  trustedLocalStdioRuntimeHost?: string | null;
  now?: () => Date;
  /** How long persisted remote MCP action discovery remains fresh. */
  catalogCacheTtlMs?: number;
  /** Test seam for deciding whether an OAuth client metadata URL is publicly resolvable. */
  oauthClientMetadataLookup?: RemoteHttpEndpointLookup;
  /** Test seam for deterministic remote endpoint resolution. Production uses DNS. */
  remoteHttpEndpointLookup?: RemoteHttpEndpointLookup;
  /** Test seam for protocol fixtures. Production uses the DNS-pinned transport. */
  remoteHttpRequest?: (url: string, init: RequestInit) => Promise<Response>;
  /** Test seam for Composio without live vendor traffic. */
  composioClientFactory?: (apiKey: string) => ComposioClient;
  /** Test seam for the centrally registered Gmail OAuth broker. */
  paperclipCloudConnector?: PaperclipCloudConnector | null;
  /** @deprecated Use paperclipCloudConnector. */
  paperclipIdGmailConnector?: PaperclipCloudConnector | null;
  /** Test seam for Vercel Connect without live vendor traffic. */
  vercelConnectClient?: VercelConnectClient | null;
};

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ToolAccessMutationDb = Pick<Db | DbTransaction, "select" | "insert" | "update" | "delete">;

export type McpToolDescriptor = {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

const GOOGLE_SHEETS_SPREADSHEET_SCHEMA = {
  type: "object",
  properties: {
    spreadsheetId: { type: "string", minLength: 1 },
  },
  required: ["spreadsheetId"],
};

const GOOGLE_SHEETS_RANGE_SCHEMA = {
  type: "object",
  properties: {
    spreadsheetId: { type: "string", minLength: 1 },
    range: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["spreadsheetId", "range"],
};

const GOOGLE_SHEETS_VALUE_ROWS_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "array",
    items: {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
      ],
    },
  },
};

const GOOGLE_SHEETS_WRITE_VALUES_SCHEMA = {
  type: "object",
  properties: {
    spreadsheetId: { type: "string", minLength: 1 },
    range: { type: "string", minLength: 1, maxLength: 500 },
    values: GOOGLE_SHEETS_VALUE_ROWS_SCHEMA,
    valueInputOption: { type: "string", enum: ["RAW", "USER_ENTERED"], default: "RAW" },
  },
  required: ["spreadsheetId", "range", "values"],
};

function schemaHasInputProperties(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const properties = (schema as Record<string, unknown>).properties;
  return Boolean(properties && typeof properties === "object" && !Array.isArray(properties) && Object.keys(properties).length > 0);
}

const APPROVED_STDIO_TEMPLATES: Record<string, {
  name: string;
  command?: string | null;
  args?: string[];
  envKeys?: string[];
  tools: McpToolDescriptor[];
}> = {
  "paperclip.echo-calculator-time": {
    name: "Paperclip Echo / Calculator / Time fixture",
    tools: [
      {
        name: "echo",
        description: "Return the provided message.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "add",
        description: "Add two numbers.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "now",
        description: "Return the current server time.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "fail_with_code",
        description: "Deterministically fail with a requested status code.",
        inputSchema: {
          type: "object",
          properties: { code: { type: "number" } },
          required: ["code"],
        },
        annotations: { readOnlyHint: true },
      },
    ],
  },
  "paperclip.synthetic-todo-kv": {
    name: "Paperclip Synthetic Todo / KV fixture",
    tools: [
      { name: "list_items", description: "List synthetic todo items.", annotations: { readOnlyHint: true } },
      { name: "create_item", description: "Create a synthetic todo item.", annotations: { readOnlyHint: false } },
      { name: "mark_done", description: "Mark a synthetic todo item done.", annotations: { readOnlyHint: false } },
      { name: "delete_item", description: "Delete a synthetic todo item.", annotations: { destructiveHint: true } },
      { name: "get_value", description: "Read a synthetic KV value.", annotations: { readOnlyHint: true } },
      { name: "set_value", description: "Write a synthetic KV value.", annotations: { readOnlyHint: false } },
    ],
  },
  "paperclip.google-sheets": {
    name: "Google Sheets",
    command: "paperclip-google-sheets-mcp-server",
    args: [],
    envKeys: [
      "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON",
      "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH",
      "GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS",
    ],
    tools: [
      {
        name: "list_spreadsheets",
        description: "List the Google Sheets spreadsheets configured in this connection allowlist.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_spreadsheet_info",
        description: "Get spreadsheet metadata and sheet tab information for an allowlisted spreadsheet.",
        inputSchema: GOOGLE_SHEETS_SPREADSHEET_SCHEMA,
        annotations: { readOnlyHint: true },
      },
      {
        name: "read_values",
        description: "Read cell values from an allowlisted spreadsheet range.",
        inputSchema: GOOGLE_SHEETS_RANGE_SCHEMA,
        annotations: { readOnlyHint: true },
      },
      {
        name: "search_rows",
        description: "Search rows in an allowlisted spreadsheet range.",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", minLength: 1 },
            range: { type: "string", minLength: 1, maxLength: 500 },
            query: { type: "string", minLength: 1 },
            caseSensitive: { type: "boolean", default: false },
            maxResults: { type: "integer", minimum: 1, maximum: 500, default: 50 },
          },
          required: ["spreadsheetId", "range", "query"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "append_rows",
        description: "Append rows to an allowlisted spreadsheet range.",
        inputSchema: GOOGLE_SHEETS_WRITE_VALUES_SCHEMA,
        annotations: { readOnlyHint: false },
      },
      {
        name: "update_values",
        description: "Update values in an allowlisted spreadsheet range.",
        inputSchema: GOOGLE_SHEETS_WRITE_VALUES_SCHEMA,
        annotations: { readOnlyHint: false },
      },
      {
        name: "add_sheet_tab",
        description: "Add a sheet tab to an allowlisted spreadsheet.",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1, maxLength: 100 },
            rowCount: { type: "integer", minimum: 1, maximum: 1000000 },
            columnCount: { type: "integer", minimum: 1, maximum: 18278 },
          },
          required: ["spreadsheetId", "title"],
        },
        annotations: { readOnlyHint: false },
      },
      {
        name: "clear_values",
        description: "Clear values in an allowlisted spreadsheet range.",
        inputSchema: GOOGLE_SHEETS_RANGE_SCHEMA,
        annotations: { destructiveHint: true },
      },
      {
        name: "delete_rows",
        description: "Delete rows from an allowlisted spreadsheet tab.",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", minLength: 1 },
            sheetId: { type: "integer", minimum: 0 },
            startIndex: { type: "integer", minimum: 0 },
            endIndex: { type: "integer", minimum: 1 },
          },
          required: ["spreadsheetId", "sheetId", "startIndex", "endIndex"],
        },
        annotations: { destructiveHint: true },
      },
    ],
  },
};

const GOOGLE_SHEETS_GALLERY_KEY = "google-sheets";
const COMPOSIO_GALLERY_KEY = "composio";
const GOOGLE_SHEETS_TEMPLATE_ID = "paperclip.google-sheets";
const GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS_ENV = "GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS";
const CONNECTION_TOKEN_MINT_TOOL_NAME = "connection_token.mint";

type ToolExampleDefinition = {
  id: string;
  title: string;
  description: string;
  applicationKey: string;
  applicationName: string;
  applicationDescription: string;
  connectionName: string;
  templateId: keyof typeof APPROVED_STDIO_TEMPLATES;
  profileKey: string;
  profileName: string;
  profileDescription: string;
};

const TOOL_EXAMPLES: ToolExampleDefinition[] = [
  {
    id: "safe-read-only-todo-kv",
    title: "Safe read-only Todo / KV fixture",
    description: "Installs a deterministic local MCP fixture and grants only its read-only catalog entries.",
    applicationKey: "paperclip.examples.safe-read-only-todo-kv",
    applicationName: "Paperclip example: Safe read-only Todo / KV",
    applicationDescription: "Deterministic MCP fixture for first-run tool governance checks.",
    connectionName: "Paperclip example: Safe read-only Todo / KV",
    templateId: "paperclip.synthetic-todo-kv",
    profileKey: "paperclip.examples.safe-read-only-todo-kv.profile",
    profileName: "Example safe read-only tools",
    profileDescription: "Allows only the read-only tools from the Paperclip Todo / KV example fixture.",
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function googleSheetsRobotEmailFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { available: true; robotEmail: string } | { available: false; reason: string } {
  const inlineOrPath = env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON?.trim();
  const explicitPath = env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH?.trim();
  if (!inlineOrPath && !explicitPath) {
    return { available: false, reason: "Google Sheets is not available on this instance yet." };
  }

  try {
    const raw = explicitPath
      ? readFileSync(explicitPath, "utf8")
      : inlineOrPath!.startsWith("{")
        ? inlineOrPath!
        : readFileSync(inlineOrPath!, "utf8");
    const parsed = JSON.parse(raw) as { client_email?: unknown };
    if (typeof parsed.client_email === "string" && parsed.client_email.trim()) {
      return { available: true, robotEmail: parsed.client_email.trim() };
    }
  } catch {
    return { available: false, reason: "Google Sheets is not available on this instance yet." };
  }
  return { available: false, reason: "Google Sheets is not available on this instance yet." };
}

function connectionMethodFor(app: AppDefinition, methodKey?: string | null) {
  const normalizedMethodKey = app.slug === "gmail" && methodKey === "paperclip-id-oauth"
    ? "paperclip-draft"
    : methodKey;
  const method = normalizedMethodKey
    ? app.methods.find((candidate) => candidate.key === normalizedMethodKey) ?? null
    : getAvailableConnectionMethod(app, null);
  if (!method) throw unprocessable("This app does not have an available connection method");
  return method;
}

function connectionMethodForConnection(
  app: AppDefinition,
  connection: typeof toolConnections.$inferSelect,
) {
  const methodKey = typeof connection.config.connectionMethodKey === "string"
    ? connection.config.connectionMethodKey
    : null;
  return connectionMethodFor(app, methodKey);
}

function credentialFieldsFor(app: AppDefinition, methodKey?: string | null) {
  const method = connectionMethodFor(app, methodKey);
  return (method.credentialFields ?? []).map((field) => ({
    label: field.label,
    configPath: credentialConfigPath(field),
    helpUrl: method.consoleLinks?.keys ?? method.consoleLinks?.docs ?? "",
    required: field.required,
    placement: method.keyPlacement?.location === "header" ? "header" as const : undefined,
    key: method.keyPlacement?.name,
    prefix: method.keyPlacement?.prefix,
  }));
}

function credentialRefConfigPath(ref: { name: string }): string {
  return ref.name.startsWith("credentials.") ? ref.name : `credentials.${ref.name}`;
}

export function normalizeConnectionMethodConfig(
  method: ConnectionMethodDef,
  configValues: Record<string, unknown> | undefined,
): { values: Record<string, string | boolean>; url?: string; headers?: Record<string, string> } {
  const fields = [...(method.tenantFields ?? []), ...(method.extensionFields ?? [])];
  const allowedKeys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(configValues ?? {})) {
    if (!allowedKeys.has(key)) throw badRequest(`Unknown connection setting: ${key}`);
  }

  const values: Record<string, string | boolean> = {};
  for (const field of fields) {
    const raw = configValues?.[field.key] ?? field.defaultValue;
    if (field.type === "checkbox") {
      if (raw !== undefined && typeof raw !== "boolean") throw badRequest(`${field.label} must be true or false`);
      if (raw !== undefined) values[field.key] = raw;
      continue;
    }
    if (raw !== undefined && typeof raw !== "string") throw badRequest(`${field.label} must be text`);
    let value = raw?.trim() ?? "";
    if (field.transport?.format === "csv") {
      value = Array.from(new Set(value.split(/[\n,]/g).map((entry) => entry.trim()).filter(Boolean))).join(",");
    }
    if (field.required && !value) throw badRequest(`Missing connection setting: ${field.label}`);
    if (!value) continue;
    if (field.validation?.maxLength && value.length > field.validation.maxLength) {
      throw badRequest(`${field.label} must be at most ${field.validation.maxLength} characters`);
    }
    if (field.validation?.pattern && !new RegExp(field.validation.pattern).test(value)) {
      throw badRequest(`${field.label} has an invalid value`);
    }
    if (field.type === "select" && !field.options?.some((option) => option.value === value)) {
      throw badRequest(`${field.label} has an invalid option`);
    }
    values[field.key] = value;
  }
  for (const keys of method.configRequirements?.atLeastOneOf ? [method.configRequirements.atLeastOneOf] : []) {
    if (!keys.some((key) => typeof values[key] === "string" && values[key].length > 0)) {
      throw badRequest(`Provide at least one of: ${keys.join(", ")}`);
    }
  }

  const resolvedServerUrl = resolveConnectionMethodServerUrl(method, values);
  if (method.defaults?.serverUrlTemplate && !resolvedServerUrl) {
    throw badRequest("Missing or invalid connection settings for the server URL");
  }
  const endpoint = resolvedServerUrl ? new URL(resolvedServerUrl) : null;
  if (endpoint && endpoint.protocol !== "https:") {
    throw badRequest("Connection server URL must use HTTPS");
  }
  const headers: Record<string, string> = {};
  for (const field of fields) {
    const transport = field.transport;
    const value = values[field.key];
    if (!transport || value === undefined || (value === false && transport.omitFalse)) continue;
    const serialized = typeof value === "boolean" ? String(value) : value;
    if (transport.location === "query") endpoint?.searchParams.set(transport.name, serialized);
    else {
      const nameCheck = checkMcpRemoteHeaderName(transport.name);
      const valueCheck = checkMcpRemoteHeaderValue(serialized);
      if (!nameCheck.ok || !valueCheck.ok) {
        throw badRequest(mcpRemoteHeaderRejectionMessage(transport.name, nameCheck.reason ?? valueCheck.reason!));
      }
      headers[transport.name] = serialized;
    }
  }
  return {
    values,
    ...(endpoint ? { url: endpoint.toString() } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function projectedConnectionHeaders(connection: typeof toolConnections.$inferSelect): Record<string, string> {
  const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string"
    ? connection.config.sourceTemplateKey
    : null;
  const app = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
  if (!app) return {};
  const method = connectionMethodForConnection(app, connection);
  return normalizeConnectionMethodConfig(method, asRecord(connection.config.methodConfig)).headers ?? {};
}

function mergeManagedToolArguments(
  supplied: Record<string, unknown>,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...supplied };
  for (const [key, value] of Object.entries(managed)) {
    const suppliedValue = merged[key];
    merged[key] = asRecord(value) === value && asRecord(suppliedValue) === suppliedValue
      ? mergeManagedToolArguments(suppliedValue as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return merged;
}

export function projectConnectionMethodToolArguments(
  method: ConnectionMethodDef,
  parameters: unknown,
): Record<string, unknown> {
  const supplied = asRecord(parameters);
  const managed = method.defaults?.toolArgumentDefaults;
  return managed ? mergeManagedToolArguments(supplied, managed) : supplied;
}

function stripManagedToolArgumentSchema(
  schema: Record<string, unknown>,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  const properties = asRecord(schema.properties);
  if (Object.keys(properties).length === 0) return schema;
  const nextProperties = { ...properties };
  for (const [key, managedValue] of Object.entries(managed)) {
    const propertySchema = asRecord(nextProperties[key]);
    const managedRecord = asRecord(managedValue);
    if (Object.keys(propertySchema).length === 0 || Object.keys(managedRecord).length === 0) {
      delete nextProperties[key];
      continue;
    }
    const projectedProperty = stripManagedToolArgumentSchema(propertySchema, managedRecord);
    if (Object.keys(asRecord(projectedProperty.properties)).length === 0) delete nextProperties[key];
    else nextProperties[key] = projectedProperty;
  }
  const nextSchema: Record<string, unknown> = { ...schema, properties: nextProperties };
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((key): key is string => typeof key === "string" && key in nextProperties);
    if (required.length > 0) nextSchema.required = required;
    else delete nextSchema.required;
  }
  return nextSchema;
}

export function projectConnectionMethodToolInputSchema(
  method: ConnectionMethodDef,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const managed = method.defaults?.toolArgumentDefaults;
  return managed ? stripManagedToolArgumentSchema(inputSchema, managed) : inputSchema;
}

export function projectedConnectionToolArguments(
  connection: typeof toolConnections.$inferSelect,
  parameters: unknown,
): Record<string, unknown> {
  const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string"
    ? connection.config.sourceTemplateKey
    : null;
  const app = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
  if (!app) return asRecord(parameters);
  return projectConnectionMethodToolArguments(connectionMethodForConnection(app, connection), parameters);
}

export function projectedConnectionToolInputSchema(
  connection: typeof toolConnections.$inferSelect,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string"
    ? connection.config.sourceTemplateKey
    : null;
  const app = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
  if (!app) return inputSchema;
  return projectConnectionMethodToolInputSchema(connectionMethodForConnection(app, connection), inputSchema);
}

function googleSheetsAllowedSpreadsheetIds(configValues: Record<string, unknown> | undefined): string[] {
  const raw = configValues?.allowedSpreadsheetIds;
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\n,]/g) : [];
  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
}

function isGoogleSheetsConnectionConfig(configValues: Record<string, unknown> | undefined): boolean {
  return configValues?.sourceTemplateKey === GOOGLE_SHEETS_GALLERY_KEY || configValues?.templateId === GOOGLE_SHEETS_TEMPLATE_ID;
}

function normalizeGoogleSheetsConnectionConfig(configValues: Record<string, unknown>): Record<string, unknown> {
  if (!isGoogleSheetsConnectionConfig(configValues)) return configValues;
  const allowedSpreadsheetIds = googleSheetsAllowedSpreadsheetIds(configValues);
  if (allowedSpreadsheetIds.length === 0) {
    throw badRequest("Paste at least one Google Sheets link.");
  }
  return {
    ...configValues,
    allowedSpreadsheetIds,
    env: {
      ...asRecord(configValues.env),
      [GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS_ENV]: allowedSpreadsheetIds.join(","),
    },
  };
}

// Detects a Postgres foreign_key_violation (SQLSTATE 23503) raised by the
// tool_connections.application_id constraint — i.e. an application delete that lost the race to
// a concurrently-created connection now that the FK is ON DELETE RESTRICT. Walks the error and
// its `cause` since the driver may wrap the original pg error.
function isToolConnectionForeignKeyViolation(error: unknown): boolean {
  const records: Record<string, unknown>[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as Record<string, unknown>;
    records.push(record);
    current = record.cause;
  }
  return records.some((record) => {
    const code = typeof record.code === "string" ? record.code : null;
    const constraint =
      typeof record.constraint === "string"
        ? record.constraint
        : typeof record.constraint_name === "string"
          ? record.constraint_name
          : null;
    const message = typeof record.message === "string" ? record.message : "";
    return (
      code === "23503" &&
      (constraint === "tool_connections_application_id_tool_applications_id_fk" ||
        /tool_connections/.test(constraint ?? "") ||
        /tool_connections/.test(message))
    );
  });
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function normalizeKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "tool";
}

function connectionUid(namespace: string, name: string, connectionId: string) {
  return `${normalizeKey(namespace)}/${normalizeKey(name)}-${connectionId.slice(0, 8)}`;
}

/**
 * The key namespace `connectGalleryApp`, `reconnectGalleryApp` and
 * `createOrRotateOAuthSecret` mint for credentials a connection owns outright.
 * Nothing else writes this prefix, which is what lets removal tell a dedicated
 * app credential apart from a secret the operator manages by hand — see
 * `classifyConnectionSecrets`. Matched as a prefix on purpose: `secrets.remove`
 * suffixes `__deleted__<id>` onto the key before it deletes the row, so a
 * removal that is retried after a provider failure must still recognise it.
 */
const CONNECTION_OWNED_SECRET_KEY_PREFIX = "tool_app.";

/** Token fields a legacy row may have inlined into `config.oauth`. */
const INLINE_OAUTH_TOKEN_FIELDS = [
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "client_secret",
  "clientSecret",
];

/**
 * Drop inline OAuth token material from a connection config, keeping the
 * non-secret identity (client id, issuer, registration source) a later
 * reconnect reuses. Current code stores tokens as secret refs, never in the
 * config; this exists so a row written by an older build cannot keep a usable
 * token after the operator removed the app.
 */
function withoutInlineOAuthTokens(config: Record<string, unknown>): Record<string, unknown> {
  const oauth = config.oauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return config;
  const next = { ...(oauth as Record<string, unknown>) };
  let changed = false;
  for (const field of INLINE_OAUTH_TOKEN_FIELDS) {
    if (field in next) {
      delete next[field];
      changed = true;
    }
  }
  return changed ? { ...config, oauth: next } : config;
}

function actorBinding(actor: ActorInfo | undefined) {
  return {
    actorType: actor?.actorType ?? null,
    actorId: actor?.actorId ?? null,
    sessionId: typeof actor?.sessionId === "string" && actor.sessionId.trim().length > 0 ? actor.sessionId : null,
  };
}

function oauthActorType(value: string | null): ActorInfo["actorType"] | null {
  return value === "agent" || value === "user" || value === "system" || value === "plugin" ? value : null;
}

function assertSameOAuthActor(stateRow: typeof toolOauthStates.$inferSelect, actor: ActorInfo | undefined) {
  const expected = {
    actorType: oauthActorType(stateRow.createdByActorType),
    actorId: stateRow.createdByActorId,
    sessionId: stateRow.createdBySessionId,
  };
  const actual = actorBinding(actor);
  if (!expected.actorType || !expected.actorId) {
    throw forbidden("OAuth sign-in state is not bound to an authenticated board session");
  }
  if (expected.actorType !== actual.actorType || expected.actorId !== actual.actorId) {
    throw forbidden("OAuth sign-in must be completed by the user who started it");
  }
  if (expected.sessionId && expected.sessionId !== actual.sessionId) {
    throw forbidden("OAuth sign-in must be completed from the same authenticated session");
  }
}

function toApplication(row: typeof toolApplications.$inferSelect): ToolApplication {
  return {
    id: row.id,
    companyId: row.companyId,
    applicationKey: row.applicationKey ?? undefined,
    name: row.name,
    description: row.description,
    type: row.type,
    status: row.status,
    pluginId: row.pluginId,
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    metadata: row.metadata ?? null,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertClass3ToolCredentialRefAllowed(ref: {
  configPath?: string | null;
  projectionClass?: string | null;
  projectionAllowlistKey?: string | null;
}) {
  const projectionClass = ref.projectionClass ?? "unclassified";
  if (projectionClass !== "class_3_static_lease") return;
  if (!ref.configPath?.trim() || !ref.projectionAllowlistKey?.trim()) {
    throw unprocessable("Class-3 static lease tool credentials require an allowlist key and config path", {
      code: "class_3_static_lease_allowlist_required",
      targetType: "tool_connection",
      configPath: ref.configPath ?? null,
    });
  }
  const allowed = CLASS3_STATIC_LEASE_ALLOWLIST.some((entry) =>
    entry.key === ref.projectionAllowlistKey
    && entry.targetType === "tool_connection"
    && entry.configPath === ref.configPath
  );
  if (!allowed) {
    throw unprocessable("Class-3 static lease tool credential is outside the approved allowlist", {
      code: "class_3_static_lease_not_allowed",
      allowlistKey: ref.projectionAllowlistKey,
      targetType: "tool_connection",
      configPath: ref.configPath,
    });
  }
}

function toConnection(row: typeof toolConnections.$inferSelect): ToolConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    applicationId: row.applicationId,
    name: row.name,
    uid: row.uid,
    connectionKind: row.connectionKind,
    ownership: row.ownership,
    transport: row.transport,
    authKind: row.authKind,
    credentialSource: row.credentialSource,
    externalCredential: row.externalCredential ?? null,
    credentialPolicy: row.credentialPolicy,
    status: row.status,
    enabled: row.enabled,
    config: row.config ?? {},
    transportConfig: row.transportConfig ?? {},
    credentialRefs: row.credentialRefs ?? [],
    credentialSecretRefs: row.credentialSecretRefs ?? [],
    healthStatus: row.healthStatus,
    healthMessage: row.healthMessage,
    healthCheckedAt: row.healthCheckedAt,
    lastHealthAt: row.lastHealthAt,
    lastCatalogRefreshAt: row.lastCatalogRefreshAt,
    lastError: row.lastError,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function redactedVercelGrant(
  value: VercelConnectGrantReference | null | undefined,
): Omit<VercelConnectGrantReference, "subjectId"> | null {
  if (!value) return null;
  const { subjectId: _subjectId, ...redacted } = value;
  return redacted;
}

function toConnectionGrant(row: typeof connectionGrants.$inferSelect) {
  return {
    ...row,
    externalCredential: redactedVercelGrant(row.externalCredential),
  };
}

function toConnectionInstall(row: typeof toolConnectionInstalls.$inferSelect): ToolConnectionInstall {
  return {
    id: row.id,
    companyId: row.companyId,
    connectionId: row.connectionId,
    targetType: row.targetType,
    targetId: row.targetId,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

function toCatalogEntry(row: typeof toolCatalogEntries.$inferSelect): ToolCatalogEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    entryKind: row.entryKind,
    name: row.name,
    toolName: row.toolName,
    title: row.title,
    description: row.description,
    inputSchema: row.inputSchema ?? {},
    outputSchema: row.outputSchema ?? null,
    annotations: row.annotations ?? {},
    riskLevel: row.riskLevel,
    isReadOnly: row.isReadOnly,
    isWrite: row.isWrite,
    isDestructive: row.isDestructive,
    status: row.status,
    addedAt: row.firstSeenAt,
    version: row.version,
    versionHash: row.versionHash,
    schemaHash: row.schemaHash,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    reviewedAt: row.reviewedAt,
    reviewedByAgentId: row.reviewedByAgentId,
    reviewedByUserId: row.reviewedByUserId,
    quarantinedAt: row.quarantinedAt,
    quarantineReason: row.quarantineReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCatalogEntryForConnection(
  row: typeof toolCatalogEntries.$inferSelect,
  connection: typeof toolConnections.$inferSelect,
): ToolCatalogEntry {
  const rawCatalogEntry = toCatalogEntry(row);
  const catalogEntry = {
    ...rawCatalogEntry,
    inputSchema: projectedConnectionToolInputSchema(connection, rawCatalogEntry.inputSchema ?? {}),
  };
  if (
    connection.transport === "local_stdio"
    && asRecord(connection.config).templateId === GOOGLE_SHEETS_TEMPLATE_ID
    && !schemaHasInputProperties(catalogEntry.inputSchema)
  ) {
    const templateTool = APPROVED_STDIO_TEMPLATES[GOOGLE_SHEETS_TEMPLATE_ID].tools.find((tool) => tool.name === row.toolName);
    if (schemaHasInputProperties(templateTool?.inputSchema)) {
      return { ...catalogEntry, inputSchema: templateTool!.inputSchema! };
    }
  }
  return catalogEntry;
}

function toRuntimeSlot(row: typeof toolRuntimeSlots.$inferSelect): ToolRuntimeSlot {
  return {
    id: row.id,
    companyId: row.companyId,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    projectWorkspaceId: row.projectWorkspaceId,
    executionWorkspaceId: row.executionWorkspaceId,
    issueId: row.issueId,
    ownerScopeType: row.ownerScopeType,
    ownerScopeId: row.ownerScopeId,
    runtimeKind: row.runtimeKind,
    slotKey: row.slotKey,
    status: row.status,
    reuseKey: row.reuseKey,
    workspaceScope: row.workspaceScope,
    credentialScopeHash: row.credentialScopeHash,
    provider: row.provider,
    providerRef: row.providerRef,
    processId: row.processId,
    commandTemplateKey: row.commandTemplateKey,
    healthStatus: row.healthStatus,
    healthMessage: row.healthMessage,
    lastHealthCheckAt: row.lastHealthCheckAt,
    lastStartedAt: row.lastStartedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    lastUsedAt: row.lastUsedAt,
    idleExpiresAt: row.idleExpiresAt,
    idleDeadlineAt: row.idleDeadlineAt,
    lastError: row.lastError,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function builtInStdioTemplate(templateId: string): ToolStdioCommandTemplate | null {
  const template = APPROVED_STDIO_TEMPLATES[templateId];
  if (!template) return null;
  return {
    templateId,
    name: template.name,
    title: template.name,
    description: null,
    status: "active",
    source: "built_in",
    command: template.command ?? null,
    args: template.args ?? [],
    envKeys: template.envKeys ?? [],
    tools: template.tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: tool.annotations ?? {},
    })),
  };
}

function toStdioCommandTemplate(row: typeof toolStdioCommandTemplates.$inferSelect): ToolStdioCommandTemplate {
  return {
    id: row.id,
    companyId: row.companyId,
    templateId: row.templateKey,
    name: row.name,
    title: row.name,
    description: row.description,
    status: row.status,
    source: "admin",
    command: row.command,
    args: row.args ?? [],
    envKeys: row.envKeys ?? [],
    tools: (row.tools ?? [])
      .map((tool) => normalizeToolDescriptor(tool))
      .filter((tool): tool is McpToolDescriptor => Boolean(tool))
      .map((tool) => ({
        name: tool.name,
        title: tool.title ?? null,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        annotations: tool.annotations ?? {},
      })),
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toToolInvocation(row: typeof toolInvocations.$inferSelect): ToolInvocation {
  return {
    id: row.id,
    companyId: row.companyId,
    idempotencyKey: row.idempotencyKey,
    actorType: row.actorType as ToolInvocation["actorType"],
    actorId: row.actorId,
    agentId: row.agentId,
    issueId: row.issueId,
    runId: row.runId,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    catalogEntryId: row.catalogEntryId,
    toolName: row.toolName,
    argumentsHash: row.argumentsHash,
    argumentsSummary: row.argumentsSummary ?? null,
    policyDecision: row.policyDecision,
    matchedPolicyIds: row.matchedPolicyIds,
    approvalState: row.approvalState,
    status: row.status,
    upstreamRequestId: row.upstreamRequestId,
    resultHash: row.resultHash,
    resultSummary: row.resultSummary ?? null,
    resultSizeBytes: row.resultSizeBytes,
    resultArtifactId: row.resultArtifactId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toToolActionRequest(row: typeof toolActionRequests.$inferSelect): ToolActionRequest {
  return {
    id: row.id,
    companyId: row.companyId,
    invocationId: row.invocationId,
    issueId: row.issueId,
    interactionId: row.interactionId,
    approvalId: row.approvalId,
    status: row.status,
    canonicalArgumentsHash: row.canonicalArgumentsHash,
    canonicalArgumentsSummary: row.canonicalArgumentsSummary,
    signedArguments: row.signedArguments,
    previewMarkdown: row.previewMarkdown,
    requestedByAgentId: row.requestedByAgentId,
    requestedByUserId: row.requestedByUserId,
    resolvedByAgentId: row.resolvedByAgentId,
    resolvedByUserId: row.resolvedByUserId,
    decidedByAgentId: row.decidedByAgentId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toToolCallEvent(row: typeof toolCallEvents.$inferSelect): ToolCallEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    eventType: row.eventType,
    actorType: row.actorType as ToolCallEvent["actorType"],
    actorId: row.actorId,
    agentId: row.agentId,
    runId: row.runId,
    issueId: row.issueId,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    catalogEntryId: row.catalogEntryId,
    invocationId: row.invocationId,
    actionRequestId: row.actionRequestId,
    runtimeSlotId: row.runtimeSlotId,
    toolName: row.toolName,
    decision: row.decision,
    matchedPolicyIds: row.matchedPolicyIds,
    reasonCode: row.reasonCode,
    outcome: row.outcome,
    latencyMs: row.latencyMs,
    argumentsSummary: row.argumentsSummary ?? null,
    requestHash: row.requestHash,
    requestSummary: row.requestSummary ?? null,
    resultHash: row.resultHash,
    resultSummary: row.resultSummary ?? null,
    resultSizeBytes: row.resultSizeBytes,
    redactionPlan: row.redactionPlan ?? null,
    rateLimitState: row.rateLimitState ?? null,
    metadata: row.metadata ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}

function userFallbackName(userId: string): string {
  if (userId === "local-board") return "Board";
  return userId;
}

function denialReasonForDecision(
  invocation: typeof toolInvocations.$inferSelect,
  latestAuditEvent: typeof toolCallEvents.$inferSelect | null,
) {
  if (
    invocation.status === "denied"
    || invocation.status === "rate_limited"
    || invocation.status === "failed"
    || invocation.status === "timed_out"
  ) {
    return invocation.errorMessage ?? invocation.errorCode ?? latestAuditEvent?.reasonCode ?? null;
  }
  if (latestAuditEvent?.outcome === "denied" || latestAuditEvent?.outcome === "failure" || latestAuditEvent?.outcome === "timeout") {
    return latestAuditEvent.errorMessage ?? latestAuditEvent.reasonCode ?? null;
  }
  return null;
}

function toProfile(row: typeof toolProfiles.$inferSelect): ToolProfile {
  return {
    id: row.id,
    companyId: row.companyId,
    profileKey: row.profileKey,
    name: row.name,
    description: row.description,
    status: row.status,
    defaultAction: row.defaultAction,
    newToolsReviewedAt: row.newToolsReviewedAt,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProfileEntry(row: typeof toolProfileEntries.$inferSelect): ToolProfileEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    profileId: row.profileId,
    selectorType: row.selectorType,
    effect: row.effect,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    catalogEntryId: row.catalogEntryId,
    toolName: row.toolName,
    riskLevel: row.riskLevel,
    conditions: row.conditions ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProfileBinding(row: typeof toolProfileBindings.$inferSelect): ToolProfileBinding {
  return {
    id: row.id,
    companyId: row.companyId,
    profileId: row.profileId,
    targetType: row.targetType,
    targetId: row.targetId,
    priority: row.priority,
    metadata: row.metadata ?? null,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPolicy(row: typeof toolPolicies.$inferSelect): ToolPolicy {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    policyType: row.policyType,
    priority: row.priority,
    enabled: row.enabled,
    selectors: row.selectors ?? {},
    conditions: row.conditions ?? null,
    config: row.config ?? null,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function profileEntryMatchesCatalog(
  entry: typeof toolProfileEntries.$inferSelect,
  catalogEntry: typeof toolCatalogEntries.$inferSelect,
): boolean {
  if (entry.selectorType === "application") return entry.applicationId === catalogEntry.applicationId;
  if (entry.selectorType === "connection") return entry.connectionId === catalogEntry.connectionId;
  if (entry.selectorType === "catalog_entry") return entry.catalogEntryId === catalogEntry.id;
  if (entry.selectorType === "tool_name") return entry.toolName === catalogEntry.toolName;
  if (entry.selectorType === "risk_level") return entry.riskLevel === catalogEntry.riskLevel;
  return false;
}

function summarizeProfile(input: {
  profile: typeof toolProfiles.$inferSelect;
  entries: Array<typeof toolProfileEntries.$inferSelect>;
  bindings: Array<typeof toolProfileBindings.$inferSelect>;
  catalog: Array<typeof toolCatalogEntries.$inferSelect>;
  agentIds: string[];
}): ToolProfileSummary {
  const includes = input.entries.filter((entry) => entry.effect === "include");
  const excludes = input.entries.filter((entry) => entry.effect === "exclude");
  const allowedCatalogIds = new Set<string>();
  const allowedApplicationIds = new Set<string>();
  const excludedCatalogIds = new Set<string>();

  for (const catalogEntry of input.catalog) {
    const excluded = excludes.some((entry) => profileEntryMatchesCatalog(entry, catalogEntry));
    if (excluded) excludedCatalogIds.add(catalogEntry.id);
    if (excluded) continue;
    const included = includes.some((entry) => profileEntryMatchesCatalog(entry, catalogEntry));
    if (input.profile.defaultAction === "allow" || included) {
      allowedCatalogIds.add(catalogEntry.id);
      if (catalogEntry.applicationId) allowedApplicationIds.add(catalogEntry.applicationId);
    }
  }

  const isCompanyDefault = input.bindings.some(
    (binding) => binding.targetType === "company" && binding.targetId === input.profile.companyId,
  );
  const appliesToAgents = new Set<string>();
  if (isCompanyDefault) {
    for (const agentId of input.agentIds) appliesToAgents.add(agentId);
  } else {
    const companyAgentIds = new Set(input.agentIds);
    for (const binding of input.bindings) {
      if (binding.targetType === "agent" && companyAgentIds.has(binding.targetId)) {
        appliesToAgents.add(binding.targetId);
      }
    }
  }

  return {
    accessMode: input.profile.defaultAction === "allow" ? "all_except" : "selected",
    allowedToolCount: allowedCatalogIds.size,
    allowedApplicationCount: allowedApplicationIds.size,
    excludedToolCount: excludedCatalogIds.size,
    totalToolCount: input.catalog.length,
    assignmentCount: input.bindings.length,
    appliesToAgentCount: appliesToAgents.size,
    isCompanyDefault,
  };
}

function profileCoversCatalogScope(input: {
  entry: typeof toolProfileEntries.$inferSelect;
  catalogEntry: typeof toolCatalogEntries.$inferSelect;
  catalogById: Map<string, typeof toolCatalogEntries.$inferSelect>;
}): boolean {
  if (input.entry.effect !== "include") return false;
  if (input.entry.selectorType === "application") return input.entry.applicationId === input.catalogEntry.applicationId;
  if (input.entry.selectorType === "connection") return input.entry.connectionId === input.catalogEntry.connectionId;
  if (input.entry.selectorType !== "catalog_entry" || !input.entry.catalogEntryId) return false;
  const scopedEntry = input.catalogById.get(input.entry.catalogEntryId);
  if (!scopedEntry) return false;
  if (scopedEntry.connectionId === input.catalogEntry.connectionId) return true;
  return Boolean(scopedEntry.applicationId && scopedEntry.applicationId === input.catalogEntry.applicationId);
}

function pendingNewToolsForProfile(input: {
  profile: typeof toolProfiles.$inferSelect;
  entries: Array<typeof toolProfileEntries.$inferSelect>;
  catalog: Array<typeof toolCatalogEntries.$inferSelect>;
  applicationsById?: Map<string, typeof toolApplications.$inferSelect>;
  connectionsById?: Map<string, typeof toolConnections.$inferSelect>;
}): ToolProfileNewToolReviewItem[] {
  if (input.profile.status !== "active" || input.profile.defaultAction !== "deny") return [];
  const watermark = input.profile.newToolsReviewedAt ?? input.profile.createdAt;
  const catalogById = new Map(input.catalog.map((entry) => [entry.id, entry]));
  const scopedIncludes = input.entries.filter((entry) =>
    entry.effect === "include"
    && (entry.selectorType === "application" || entry.selectorType === "connection" || entry.selectorType === "catalog_entry")
  );
  if (scopedIncludes.length === 0) return [];

  return input.catalog
    .filter((catalogEntry) => catalogEntry.status === "active" || catalogEntry.status === "quarantined")
    .filter((catalogEntry) => catalogEntry.firstSeenAt > watermark)
    .filter((catalogEntry) => scopedIncludes.some((entry) =>
      profileCoversCatalogScope({ entry, catalogEntry, catalogById })
    ))
    .filter((catalogEntry) => !input.entries.some((entry) => profileEntryMatchesCatalog(entry, catalogEntry)))
    .map((catalogEntry) => ({
      catalogEntryId: catalogEntry.id,
      applicationId: catalogEntry.applicationId,
      applicationName: catalogEntry.applicationId
        ? input.applicationsById?.get(catalogEntry.applicationId)?.name ?? null
        : null,
      connectionId: catalogEntry.connectionId,
      connectionName: input.connectionsById?.get(catalogEntry.connectionId)?.name ?? null,
      toolName: catalogEntry.toolName,
      title: catalogEntry.title,
      description: catalogEntry.description,
      capability: catalogEntry.riskLevel,
      riskLevel: catalogEntry.riskLevel,
      addedAt: catalogEntry.firstSeenAt,
      firstSeenAt: catalogEntry.firstSeenAt,
    }));
}

function buildProfileDetails(input: {
  profile: typeof toolProfiles.$inferSelect;
  entries: Array<typeof toolProfileEntries.$inferSelect>;
  bindings: Array<typeof toolProfileBindings.$inferSelect>;
  catalog: Array<typeof toolCatalogEntries.$inferSelect>;
  agentIds: string[];
  applicationsById?: Map<string, typeof toolApplications.$inferSelect>;
  connectionsById?: Map<string, typeof toolConnections.$inferSelect>;
}): ToolProfileWithDetails {
  const pendingNewTools = pendingNewToolsForProfile({
    profile: input.profile,
    entries: input.entries,
    catalog: input.catalog,
    applicationsById: input.applicationsById,
    connectionsById: input.connectionsById,
  });
  return {
    ...toProfile(input.profile),
    newToolsPendingCount: pendingNewTools.length,
    entries: input.entries.map(toProfileEntry),
    bindings: input.bindings.map(toProfileBinding),
    summary: summarizeProfile(input),
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, Object.keys(flattenKeys(value)).sort())).digest("hex");
}

function flattenKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      keys[key] = true;
      flattenKeys(nested, keys);
    }
  }
  return keys;
}

function normalizeToolDescriptor(tool: unknown): McpToolDescriptor | null {
  const record = asRecord(tool);
  if (typeof record.name !== "string" || record.name.trim().length === 0) return null;
  return {
    name: record.name.trim(),
    title: typeof record.title === "string" ? record.title : null,
    description: typeof record.description === "string" ? record.description : null,
    inputSchema: asRecord(record.inputSchema ?? record.input_schema),
    annotations: asRecord(record.annotations),
  };
}

// Match a verb anywhere it forms a name segment, not just at the leading edge.
// Real MCP servers namespace and style tool names many ways:
//   "github:create_issue", "notion:update_page", "slack:postMessage", "set_value".
// A leading-anchor regex (/^(create|...)/) misses every namespaced/camelCase
// form and silently classifies writes as read-only. We normalise camelCase to
// snake_case first so "postMessage" -> "post_message", then match the verb when
// it is delimiter- or word-bounded. This mirrors the gateway classifier in
// tool-gateway.ts (inferToolRisk) so the two stay consistent.
function verbMatches(toolName: string, verbs: string): boolean {
  const normalized = toolName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return new RegExp(`\\b(${verbs})\\b|(^|[:._-])(${verbs})([:._-]|$)`).test(normalized);
}

const NOTION_READ_TOOLS = new Set([
  "notion-fetch",
  "notion-get-async-task",
  "notion-get-comments",
  "notion-get-teams",
  "notion-get-users",
  "notion-query-data-sources",
  "notion-query-database-view",
  "notion-query-meeting-notes",
  "notion-search",
]);

const NOTION_WRITE_TOOLS = new Set([
  "notion-convert-page-to-skill",
  "notion-create-comment",
  "notion-create-database",
  "notion-create-folder",
  "notion-create-pages",
  "notion-create-view",
  "notion-duplicate-page",
  "notion-move-pages",
  "notion-update-data-source",
  "notion-update-page",
  "notion-update-view",
]);

const SHOPIFY_DESTRUCTIVE_TOOLS = new Set([
  "cancel-cart",
  "cancel-checkout",
  "complete-checkout",
]);

function normalizedProviderToolName(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[:._-]+/g, "-");
}

export function classifyRisk(tool: McpToolDescriptor, sourceTemplateKey?: string | null): ToolRiskLevel {
  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint === true || annotations.destructive === true) return "destructive";
  const normalizedToolName = normalizedProviderToolName(tool.name);
  if (sourceTemplateKey === "posthog" && normalizedToolName === "exec") return "destructive";
  if (sourceTemplateKey === "shopify" && SHOPIFY_DESTRUCTIVE_TOOLS.has(normalizedToolName)) return "destructive";
  // Notion's hosted MCP catalog contains mutations whose names do not use one
  // of the generic create/update/delete verbs (move, duplicate, and convert).
  // Keep all reviewed tools explicit so provider changes are visible in code,
  // while an annotation may still escalate a known read to a write.
  if (sourceTemplateKey === "notion" && NOTION_WRITE_TOOLS.has(normalizedToolName)) return "write";
  if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
  if (sourceTemplateKey === "notion" && NOTION_READ_TOOLS.has(normalizedToolName)) return "read";
  if (verbMatches(tool.name, "delete|remove|destroy|unpublish")) return "destructive";
  if (verbMatches(tool.name, "create|update|write|set|send|publish|post|mutate|mark|archive")) return "write";
  // PostHog exposes a broad and evolving catalog. Unknown tools must never be
  // silently treated as reads; provider annotations can opt known reads in.
  if (sourceTemplateKey === "posthog") return annotations.readOnlyHint === true ? "read" : "write";
  return "read";
}

export function isGmailToolPermanentlyBlocked(tool: McpToolDescriptor): boolean {
  const riskLevel = classifyRisk(tool, "gmail");
  return verbMatches(tool.name, "send|trash|spam|delete|remove|destroy|execute|run")
    || (normalizedProviderToolName(tool.name).includes("label") && riskLevel !== "read");
}

const GOOGLE_WORKSPACE_READ_TOOLS: Record<string, ReadonlySet<string>> = {
  gmail: new Set(["get-message", "get-thread", "get-draft", "list-drafts", "list-labels", "search-threads", "list-threads", "search-messages"]),
  "google-drive": new Set(["download-file-content", "get-file-metadata", "get-file-permissions", "list-recent-files", "read-file-content", "search-files"]),
  "google-docs": new Set(["read-doc"]),
  "google-sheets": new Set(["get-values", "get-spreadsheet"]),
  "google-slides": new Set(["read-presentation"]),
  "google-calendar": new Set(["get-event", "list-calendars", "list-events", "search-events", "suggest-time"]),
  "google-chat": new Set(["search-conversations", "list-messages", "search-messages"]),
  "google-people": new Set(["search-directory-people", "search-contacts", "get-user-profile"]),
  "google-workspace-search": new Set(["search-corpus"]),
};

function googleWorkspaceToolLeafName(name: string): string {
  return (name.split(/[.:/]/).pop() ?? name).replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
}

export function isGoogleWorkspaceToolAllowed(
  profileId: GoogleWorkspaceConnectorProfileId,
  tool: McpToolDescriptor,
): boolean {
  const profile = GOOGLE_WORKSPACE_CONNECTOR_PROFILES[profileId];
  const toolName = googleWorkspaceToolLeafName(tool.name);
  const readTools = GOOGLE_WORKSPACE_READ_TOOLS[profile.appSlug] ?? new Set<string>();
  return readTools.has(toolName)
    || profile.writeTools.some((writeTool) => googleWorkspaceToolLeafName(writeTool) === toolName);
}

function descriptorHash(tool: McpToolDescriptor, riskLevel: ToolRiskLevel): string {
  return stableHash({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? {},
    annotations: tool.annotations ?? {},
    riskLevel,
  });
}

/**
 * Did this error come from the OAuth endpoint gate (PAP-17099)? Such a refusal
 * is Paperclip's own decision about an unsafe address, so it must keep its code
 * and its 422 instead of being folded into a generic upstream failure.
 */
function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isOAuthEndpointRejection(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  const code = asRecord(error.details).code;
  return typeof code === "string" && code.endsWith("_endpoint_rejected");
}

function healthFailureHttpStatus(failure: { status: ToolConnectionHealthStatus; code: string }): number {
  if (failure.status === "missing_secret") return 422;
  if (failure.code === "composio_api_key_rejected") return 422;
  if (failure.code.endsWith("_endpoint_rejected")) return 422;
  return 502;
}

function sanitizeHttpFailure(error: unknown): { status: ToolConnectionHealthStatus; message: string; code: string } {
  if (error instanceof ComposioApiError) {
    return {
      status: "error",
      message: error.message,
      code: error.status === 401 || error.status === 403 ? "composio_api_key_rejected" : "composio_request_failed",
    };
  }
  if (error instanceof HttpError) {
    const code = asRecord(error.details).code;
    if (code === "composio_connected_account_inactive") {
      return { status: "degraded", message: error.message, code };
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
        status: code === "vercel_connect_unavailable"
          || code === "vercel_connect_auth_failed"
          || code === "vercel_connect_installation_required"
          ? "degraded"
          : "error",
        message: error.message,
        code,
      };
    }
    if (
      code === "oauth_refresh_in_progress"
      || code === "oauth_refresh_superseded"
      || code === "oauth_refresh_outcome_unknown"
    ) {
      return {
        status: "error",
        message: error.message,
        code,
      };
    }
    if (code === "binding_missing" || code === "secret_deleted" || code === "secret_inactive" || code === "version_missing") {
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
    return { status: "error", message: error.message.slice(0, 240), code: "runtime_error" };
  }
  return { status: "error", message: "Connection check failed.", code: "runtime_error" };
}

function remoteEndpoint(config: Record<string, unknown>): string {
  const value = config.url ?? config.endpoint ?? config.remoteUrl;
  const parsed = parseRemoteHttpEndpoint(value, (message, code) => badRequest(message, { code }));
  return parsed.toString();
}

function vercelConnectResourcesFor(
  connection: typeof toolConnections.$inferSelect,
): string[] {
  const resource = new URL(remoteEndpoint(connection.config));
  // OAuth resource indicators name the protected MCP resource, not the
  // connection's transport-only filtering query. PostHog uses this canonical
  // URL to select its MCP consent scope set.
  resource.search = "";
  resource.hash = "";
  return [resource.toString()];
}

function readStdioTemplateId(config: Record<string, unknown>): string {
  const templateId = config.templateId;
  if (typeof templateId !== "string" || templateId.trim().length === 0) {
    throw badRequest("Local stdio MCP connections must use an approved templateId");
  }
  return templateId.trim();
}

export function toolAccessService(db: Db, options: ToolAccessServiceOptions = {}) {
  const secrets = secretService(db);

  async function resolvedRemoteEndpoint(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
  ): Promise<string> {
    const publicEndpoint = remoteEndpoint(connection.config);
    const ref = connection.credentialRefs.find((candidate) => candidate.placement === "url");
    if (!ref) return publicEndpoint;
    let value: string;
    try {
      value = await secrets.resolveSecretValue(connection.companyId, ref.secretId, ref.version ?? "latest", {
        consumerType: "tool_connection",
        consumerId: connection.id,
        configPath: REMOTE_URL_SECRET_CONFIG_PATH,
        actorType: actor?.actorType ?? "system",
        actorId: actor?.actorId ?? null,
      });
    } catch {
      throw unprocessable("A configured credential secret could not be resolved.", {
        code: "mcp_remote_missing_secret",
        connectionId: connection.id,
        credential: REMOTE_URL_SECRET_CONFIG_PATH,
      });
    }
    if (!remoteUrlCredentialMatchesPublicUrl(publicEndpoint, value)) {
      throw unprocessable("The stored MCP URL credential no longer matches this connection.", {
        code: "mcp_remote_url_credential_mismatch",
        connectionId: connection.id,
      });
    }
    return parseRemoteHttpEndpoint(value, (message, code) => badRequest(message, { code })).toString();
  }
  const composioSessions = createComposioSessionManager(db, {
    composioClientFactory: options.composioClientFactory,
    now: options.now,
  });
  const policySvc = toolAccessPolicyService(db);
  const now = options.now ?? (() => new Date());
  const configuredCloudConnector = options.paperclipCloudConnector ?? options.paperclipIdGmailConnector;
  const connectorWasProvided = options.paperclipCloudConnector !== undefined || options.paperclipIdGmailConnector !== undefined;
  let cachedCloudConnector = configuredCloudConnector ?? null;
  const currentCloudConnector = (): PaperclipCloudConnector | null => {
    if (cachedCloudConnector || connectorWasProvided) return cachedCloudConnector;
    const config = paperclipCloudConnectorConfigFromEnv();
    cachedCloudConnector = config
      ? createPaperclipCloudConnector({ config, now: () => now().getTime() })
      : null;
    return cachedCloudConnector;
  };
  const vercelConnect = options.vercelConnectClient === undefined
    ? createVercelConnectClient()
    : options.vercelConnectClient;
  const runtimeSupervisor = createToolRuntimeSupervisor(db, options);
  // These maps remove duplicate work inside one service instance. OAuth also
  // uses the database refresh lease below as its cross-process boundary.
  const oauthRefreshFlights = new Map<string, Promise<unknown>>();
  const oauthGrantRefreshFlights = new Map<string, Promise<unknown>>();
  const catalogRefreshFlights = new Map<string, Promise<unknown>>();
  const catalogCacheTtlMs = Math.max(0, options.catalogCacheTtlMs ?? 15 * 60 * 1000);

  function vercelConnectHttpError(error: unknown): HttpError {
    if (error instanceof VercelConnectClientError) {
      return new HttpError(error.status, error.message, { code: error.code });
    }
    return new HttpError(502, "Vercel Connect could not complete the credential request.", {
      code: "vercel_connect_request_failed",
    });
  }

  function vercelCredentialFor(
    connection: typeof toolConnections.$inferSelect,
  ): VercelConnectCredentialReference {
    if (connection.credentialSource !== "vercel_connect" || !connection.externalCredential) {
      throw unprocessable("This connection does not use Vercel Connect", {
        code: "vercel_connect_not_configured",
      });
    }
    return connection.externalCredential;
  }

  async function resolveVercelCredentialHeaders(
    connection: typeof toolConnections.$inferSelect,
    grant: typeof connectionGrants.$inferSelect,
    options: { forceRefresh?: boolean } = {},
  ): Promise<Record<string, string>> {
    if (!vercelConnect) throw vercelConnectHttpError(new VercelConnectClientError("vercel_connect_unavailable", 503));
    const credential = vercelCredentialFor(connection);
    const derived = deriveVercelConnectSubject({
      credential,
      connectionId: connection.id,
      companyId: connection.companyId,
      grantKind: grant.kind,
      subjectUserId: grant.subjectUserId,
    });
    const request = vercelTokenRequest({
      credential,
      grant,
      connectionId: connection.id,
      companyId: connection.companyId,
      resources: vercelConnectResourcesFor(connection),
    });
    try {
      const token = await vercelConnect.getToken(request, options);
      if (
        token.connector.id !== credential.connectorId
        && token.connector.uid !== credential.connectorUid
      ) {
        throw new VercelConnectClientError("vercel_connect_request_failed", 502);
      }
      await db.update(connectionGrants).set({
        externalCredential: vercelGrantReference({
          credential,
          token,
          subjectId: derived.subjectId,
          verifiedAt: now(),
        }),
        status: "active",
        revokedAt: null,
        updatedAt: now(),
      }).where(and(
        eq(connectionGrants.id, grant.id),
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
      ));
      return {
        [credential.headerName]: `${credential.headerPrefix ?? ""}${token.token}`,
      };
    } catch (error) {
      if (
        error instanceof VercelConnectClientError
        && error.code === "vercel_connect_authorization_required"
      ) {
        await db.update(connectionGrants).set({
          status: "needs_reauthorization",
          updatedAt: now(),
        }).where(and(
          eq(connectionGrants.id, grant.id),
          eq(connectionGrants.companyId, connection.companyId),
        ));
      }
      throw vercelConnectHttpError(error);
    }
  }

  async function vercelGrantForConnection(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
  ) {
    const actorUserId = actor?.actorType === "user" ? actor.actorId ?? null : null;
    if (actorUserId) {
      const [personal] = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "user"),
        eq(connectionGrants.subjectUserId, actorUserId),
      )).limit(1);
      if (personal) return personal;
    }
    const [organization] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, connection.companyId),
      eq(connectionGrants.connectionId, connection.id),
      eq(connectionGrants.kind, "organization"),
      eq(connectionGrants.isDefault, true),
    )).limit(1);
    if (!organization) {
      throw conflict("This Vercel Connect identity has not been authorized", {
        code: "vercel_connect_authorization_required",
      });
    }
    return organization;
  }

  function allowPrivateRemoteEndpoints() {
    return options.deploymentMode !== "authenticated" || options.deploymentExposure !== "public";
  }

  async function assertRemoteHttpUrlAllowed(value: string): Promise<string> {
    const endpoint = parseRemoteHttpEndpoint(value, (message, code) => badRequest(message, { code }));
    await assertPublicRemoteHttpEndpoint(
      endpoint,
      {
        allowPrivateNetwork: allowPrivateRemoteEndpoints(),
        lookup: options.remoteHttpEndpointLookup,
      },
      (message, code) => badRequest(message, { code }),
    );
    return endpoint.toString();
  }

  function remoteHttpFetchOptions(): GuardedRemoteHttpFetchOptions {
    return {
      allowPrivateNetwork: allowPrivateRemoteEndpoints(),
      lookup: options.remoteHttpEndpointLookup,
      error: (message, code) => badRequest(message, { code }),
    };
  }

  async function requestRemoteHttpEndpoint(endpoint: URL, init: RequestInit): Promise<Response> {
    return options.remoteHttpRequest
      ? options.remoteHttpRequest(endpoint.toString(), { ...init, redirect: "manual" })
      : guardedRemoteHttpFetch(endpoint, init, remoteHttpFetchOptions());
  }

  /**
   * Fetch an operator-supplied remote URL with the egress guard bound to the
   * connection itself.
   *
   * `guardedRemoteHttpFetch` resolves the hostname once and dials the approved
   * address, so a name server that answers public-then-private cannot move the
   * connection onto a loopback or metadata address after validation
   * (PAP-17098). Redirects stay manual and run the full guard again on the next
   * hop, because a `Location` is just as attacker-controlled as the first URL.
   */
  async function fetchRemoteHttpUrl(value: string, init: RequestInit = {}): Promise<Response> {
    let currentUrl = value;
    const method = (init.method ?? "GET").toUpperCase();
    for (let redirectCount = 0; redirectCount <= MAX_REMOTE_HTTP_REDIRECTS; redirectCount += 1) {
      const endpoint = parseRemoteHttpEndpoint(currentUrl, (message, code) => badRequest(message, { code }));
      const response = await requestRemoteHttpEndpoint(endpoint, init);
      const location = REMOTE_HTTP_REDIRECT_STATUSES.has(response.status)
        ? response.headers?.get?.("location") ?? null
        : null;
      if (!location) return response;
      if (method !== "GET" && method !== "HEAD") {
        throw new HttpError(502, "Remote OAuth endpoint redirected unexpectedly", { code: "oauth_redirect_rejected" });
      }
      if (redirectCount >= MAX_REMOTE_HTTP_REDIRECTS) {
        throw new HttpError(502, "Remote OAuth endpoint redirected too many times", { code: "oauth_redirect_limit" });
      }
      currentUrl = new URL(location, endpoint).toString();
    }
    throw new HttpError(502, "Remote OAuth endpoint redirected too many times", { code: "oauth_redirect_limit" });
  }

  async function assertRemoteEndpointAllowed(config: Record<string, unknown>): Promise<string> {
    return assertRemoteHttpUrlAllowed(remoteEndpoint(config));
  }

  function normalizeTokenBrokerAllowedHost(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
      return parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase() || null;
    } catch {
      // Invalid allowlist entries grant no access. The configured broker URL is
      // still evaluated under the public-only policy below.
      return null;
    }
  }

  function tokenBrokerAllowedPrivateHosts(): Set<string> {
    const configured = (process.env.PAPERCLIP_TOKEN_BROKER_ALLOWED_HOSTS ?? "")
      .split(/[,\s]+/)
      .map(normalizeTokenBrokerAllowedHost)
      .filter((host): host is string => host !== null);
    const pagesApiHost = normalizeTokenBrokerAllowedHost(process.env.PAPERCLIP_PAGES_API_URL ?? "");
    if (pagesApiHost) configured.push(pagesApiHost);
    return new Set(configured);
  }

  function tokenBrokerAllowsPrivateNetwork(endpoint: URL): boolean {
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    return tokenBrokerAllowedPrivateHosts().has(hostname);
  }

  function tokenBrokerHttpFetchOptions(endpoint: URL): GuardedRemoteHttpFetchOptions {
    return {
      allowPrivateNetwork: tokenBrokerAllowsPrivateNetwork(endpoint),
      error: (message, code) => badRequest(message, { code }),
    };
  }

  async function assertTokenBrokerHttpUrlAllowed(value: string): Promise<string> {
    const endpoint = parseRemoteHttpEndpoint(value, (message, code) => badRequest(message, { code }));
    await assertPublicRemoteHttpEndpoint(
      endpoint,
      { allowPrivateNetwork: tokenBrokerAllowsPrivateNetwork(endpoint) },
      (message, code) => badRequest(message, { code }),
    );
    return endpoint.toString();
  }

  async function assertConfiguredTokenBrokerEndpointsAllowed(config: Record<string, unknown>): Promise<void> {
    for (const url of configuredTokenBrokerExchangeUrls(config)) {
      await assertTokenBrokerHttpUrlAllowed(url);
    }
  }

  async function assertRemoteConnectionEndpointsAllowed(config: Record<string, unknown>): Promise<string> {
    const endpoint = await assertRemoteEndpointAllowed(config);
    await assertConfiguredTokenBrokerEndpointsAllowed(config);
    return endpoint;
  }

  /**
   * OAuth endpoint scheme/transport gate (PAP-17099).
   *
   * Every OAuth endpoint Paperclip acts on is attacker-influenced: discovered
   * metadata, a `WWW-Authenticate` hint, a pasted config, or a gallery default.
   * The authorization endpoint is the sharpest one because it is handed to the
   * operator's browser as a top-level navigation, so `javascript:`/`data:` there
   * would run in the board's origin. `checkOAuthEndpointUrl` is the single place
   * that decides; loopback `http:` is accepted only under the same
   * local-development policy that governs private remote endpoints, and
   * Paperclip's own origin is exempt from the transport rule because a
   * first-party endpoint (the smoke-lab fixture) is served exactly as the board
   * itself is.
   */
  function oauthEndpointRejected(kind: OAuthEndpointKind, reason: OAuthEndpointUrlRejection): HttpError {
    return new HttpError(422, oauthEndpointUrlRejectionMessage(kind, reason), {
      code: `oauth_${kind}_endpoint_rejected`,
      reason,
    });
  }

  /**
   * Origins that are Paperclip itself: this deployment's configured public URL,
   * plus the callback origin of the request in hand when there is one. Only the
   * plaintext-transport rule is relaxed for these.
   */
  function firstPartyOrigins(candidate?: string | null): string[] {
    const configured = process.env.PAPERCLIP_PUBLIC_URL?.trim()
      || process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim()
      || process.env.BETTER_AUTH_URL?.trim()
      || process.env.BETTER_AUTH_BASE_URL?.trim()
      || null;
    return [originOf(candidate), originOf(configured)].filter((origin): origin is string => Boolean(origin));
  }

  /**
   * Origins for which the plaintext-transport rule is relaxed when checking
   * `value`. Adds the smoke-lab fixture's own origin, because that provider is
   * mounted on this deployment's own routes — `assertNotSmokeLabOAuthEndpoints`
   * is what stops any other connection from claiming those paths — and a smoke
   * run may be driven against a deployment served over plaintext HTTP.
   */
  function insecureTransportExemptions(value: unknown, candidate?: string | null): string[] {
    const origins = firstPartyOrigins(candidate);
    if (typeof value === "string" && isSmokeLabOAuthUrl(value)) {
      const origin = originOf(value);
      if (origin) origins.push(origin);
    }
    return origins;
  }

  /** Throws unless `value` is an endpoint Paperclip may use (and navigate to). */
  function assertOAuthEndpointUrl(
    kind: OAuthEndpointKind,
    value: unknown,
    options: { firstPartyOrigin?: string | null } = {},
  ): string {
    const check = checkOAuthEndpointUrl(value, {
      allowInsecureLoopback: allowPrivateRemoteEndpoints(),
      allowInsecureOrigins: insecureTransportExemptions(value, options.firstPartyOrigin),
    });
    if (!check.ok) throw oauthEndpointRejected(kind, check.reason);
    return check.url;
  }

  /**
   * Discovery variant: an unusable endpoint is dropped rather than thrown, so a
   * second advertised authorization server (or a later metadata candidate) still
   * gets a chance. Rejections are recorded in `rejections`; discovery raises the
   * first one only if it ends up with nothing safe to use, so the operator sees
   * *why* instead of a bare "does not advertise OAuth sign in".
   */
  function safeOAuthEndpointUrl(
    kind: OAuthEndpointKind,
    value: unknown,
    rejections: HttpError[],
    firstPartyOrigin?: string | null,
  ): string | null {
    if (value === null || value === undefined || value === "") return null;
    const check = checkOAuthEndpointUrl(value, {
      allowInsecureLoopback: allowPrivateRemoteEndpoints(),
      allowInsecureOrigins: insecureTransportExemptions(value, firstPartyOrigin),
    });
    if (check.ok) return check.url;
    if (check.reason !== "missing") rejections.push(oauthEndpointRejected(kind, check.reason));
    return null;
  }

  function trustedRuntimeHost() {
    return options.trustedLocalStdioRuntimeHost
      ?? process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST
      ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST
      ?? null;
  }

  function assertLocalStdioCanBeEnabled(transport: ToolConnectionTransport, enabled: boolean) {
    if (
      transport === "local_stdio"
      && enabled
      && options.deploymentMode === "authenticated"
      && options.deploymentExposure === "public"
      && !trustedRuntimeHost()
    ) {
      throw unprocessable("Local stdio MCP connections cannot be enabled in authenticated public deployments without a trusted runtime host");
    }
  }

  async function getAdminStdioTemplate(companyId: string, templateId: string) {
    return db
      .select()
      .from(toolStdioCommandTemplates)
      .where(and(eq(toolStdioCommandTemplates.companyId, companyId), eq(toolStdioCommandTemplates.templateKey, templateId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveStdioTemplate(companyId: string, configOrTemplateId: Record<string, unknown> | string) {
    const templateId = typeof configOrTemplateId === "string" ? configOrTemplateId.trim() : readStdioTemplateId(configOrTemplateId);
    const builtIn = builtInStdioTemplate(templateId);
    if (builtIn) return builtIn;
    const adminTemplate = await getAdminStdioTemplate(companyId, templateId);
    if (!adminTemplate || adminTemplate.status !== "active") {
      throw badRequest("Local stdio MCP connections must use an approved templateId");
    }
    return toStdioCommandTemplate(adminTemplate);
  }

  async function stdioTemplateId(companyId: string, config: Record<string, unknown>): Promise<string> {
    return (await resolveStdioTemplate(companyId, config)).templateId;
  }

  function shouldQuarantineNewEntries(connection: typeof toolConnections.$inferSelect): boolean {
    return asRecord(connection.config).quarantineNewEntries === true;
  }

  function isAttentionHealthStatus(status: ToolConnectionHealthStatus): boolean {
    return isToolConnectionAttentionHealth(status);
  }

  async function audit(input: {
    companyId: string;
    connectionId?: string | null;
    catalogEntryId?: string | null;
    action: string;
    outcome: "success" | "failure";
    reasonCode?: string | null;
    details?: Record<string, unknown>;
    actor?: ActorInfo;
  }) {
    try {
      await db.insert(toolAccessAuditEvents).values({
        companyId: input.companyId,
        connectionId: input.connectionId ?? null,
        catalogEntryId: input.catalogEntryId ?? null,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? null,
        action: input.action,
        outcome: input.outcome,
        reasonCode: input.reasonCode ?? null,
        details: input.details ?? {},
      });
    } catch (error) {
      await recordToolRuntimeAuditWriteFailure(db, input.companyId);
      throw error;
    }
  }


  function readConfigString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function readConfigStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (typeof value === "string") return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    return [];
  }

  function normalizeConnectionTokenScopes(scope: ConnectionTokenRequest["scope"]): string[] {
    if (Array.isArray(scope)) return [...new Set(scope.map((item) => item.trim()).filter(Boolean))];
    if (typeof scope === "string") return [...new Set(scope.split(/\s+/).map((item) => item.trim()).filter(Boolean))];
    return [];
  }

  function tokenBrokerConfigFromConnectionConfig(config: Record<string, unknown>): Record<string, unknown> {
    const broker = asRecord(config.tokenBroker);
    if (Object.keys(broker).length > 0) return broker;
    return asRecord(config.broker);
  }

  function tokenBrokerConfig(connection: typeof toolConnections.$inferSelect): Record<string, unknown> {
    return tokenBrokerConfigFromConnectionConfig(asRecord(connection.config));
  }

  function configuredTokenBrokerExchangeUrls(config: Record<string, unknown>): string[] {
    const broker = tokenBrokerConfigFromConnectionConfig(config);
    return [...new Set([
      readConfigString(broker, "tokenUrl"),
      readConfigString(broker, "exchangeTokenUrl"),
      readConfigString(config, "tokenExchangeUrl"),
      readConfigString(config, "pagesTokenExchangeUrl"),
    ].filter((url): url is string => url !== null))];
  }

  function connectionTokenBrokerEnabled(connection: typeof toolConnections.$inferSelect): boolean {
    const config = asRecord(connection.config);
    const tokenBroker = asRecord(config.tokenBroker);
    if (Object.keys(tokenBroker).length > 0) return tokenBroker.enabled === true;
    const broker = asRecord(config.broker);
    if (Object.keys(broker).length > 0) return broker.enabled === true;
    return false;
  }

  function isPagesTokenConnection(connection: typeof toolConnections.$inferSelect, application?: typeof toolApplications.$inferSelect | null) {
    const config = asRecord(connection.config);
    const broker = tokenBrokerConfig(connection);
    const applicationKey = application?.applicationKey ?? "";
    return Boolean(
      applicationKey === "paperclip-pages"
      || applicationKey === "paperclip.pages"
      || applicationKey === "pages.paperclip"
      || readConfigString(config, "connectionType") === "pages"
      || readConfigString(config, "service") === "pages"
      || readConfigString(broker, "connectionType") === "pages"
      || readConfigString(broker, "service") === "pages"
      || asRecord(config.pages).enabled === true,
    );
  }

  async function getConnectionApplication(connection: typeof toolConnections.$inferSelect) {
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
    return application ?? null;
  }

  function inferConnectionTokenPath(
    connection: typeof toolConnections.$inferSelect,
    application?: typeof toolApplications.$inferSelect | null,
  ): ConnectionTokenIssuancePath {
    const broker = tokenBrokerConfig(connection);
    const configuredPath = readConfigString(broker, "path") ?? readConfigString(asRecord(connection.config), "tokenPath");
    if (configuredPath === "exchange" || configuredPath === "oauth_access" || configuredPath === "static") return configuredPath;
    if (isPagesTokenConnection(connection, application)) return "exchange";
    if (readConfigString(broker, "tokenUrl") || readConfigString(asRecord(connection.config), "tokenExchangeUrl")) return "exchange";
    return "static";
  }

  function parentScopesForConnection(connection: typeof toolConnections.$inferSelect): string[] {
    const config = asRecord(connection.config);
    const broker = tokenBrokerConfig(connection);
    const configured = [
      ...readConfigStringArray(broker.parentScopes),
      ...readConfigStringArray(broker.scopes),
      ...readConfigStringArray(config.parentScopes),
      ...readConfigStringArray(asRecord(config.oauth).scopes),
      ...readConfigStringArray(asRecord(config.oauth).scope),
    ];
    const namespaceAllowlist = readConfigStringArray(config.namespaceAllowlist)
      .map((namespace) => `pages:publish:ns/${namespace}`);
    return [...new Set([...configured, ...namespaceAllowlist])];
  }

  function defaultScopesForConnection(connection: typeof toolConnections.$inferSelect): string[] {
    const broker = tokenBrokerConfig(connection);
    return [...new Set([
      ...readConfigStringArray(broker.defaultScopes),
      ...readConfigStringArray(asRecord(connection.config).defaultScopes),
    ])];
  }

  function assertScopeSubset(input: { requestedScope: string[]; parentScopes: string[] }) {
    if (input.requestedScope.length === 0) return;
    const parent = new Set(input.parentScopes);
    if (parent.size === 0 || input.requestedScope.some((scope) => !parent.has(scope))) {
      throw forbidden("Requested token scope exceeds the connection parent scope");
    }
  }

  function requestedTtlSeconds(body: ConnectionTokenRequest, connection: typeof toolConnections.$inferSelect): number {
    const broker = tokenBrokerConfig(connection);
    const configured = Number(broker.defaultTtlSeconds ?? broker.ttlSeconds ?? 900);
    const requested = Number(body.requestedTtlSeconds ?? configured);
    const finite = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 900;
    return Math.max(1, Math.min(900, finite));
  }

  function sha256Hex(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  function bearerTokenHash(token: string): string {
    return sha256Hex(token);
  }

  function runSnapshotString(snapshot: Record<string, unknown>, ...keys: string[]): string | null {
    for (const key of keys) {
      const value = snapshot[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
    return null;
  }

  async function loadBrokerRunContext(input: { companyId: string; agentId: string; runId: string }) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId) {
      throw forbidden("Agent run context does not match the authenticated actor");
    }
    if (!ACTIVE_BROKER_RUN_STATUSES.has(run.status)) {
      throw forbidden("Agent run is not active");
    }
    const snapshot = asRecord(run.contextSnapshot);
    const paperclipIssue = asRecord(snapshot.paperclipIssue);
    const responsibleUserId = runSnapshotString(snapshot, "responsibleUserId", "responsible_user_id")
      ?? runSnapshotString(paperclipIssue, "responsibleUserId", "responsible_user_id")
      ?? run.responsibleUserId;
    if (!responsibleUserId) {
      throw forbidden("Agent run has no responsible user for delegated connection access");
    }
    const responsibleMembership = await db
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, run.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, responsibleUserId),
      ))
      .then((rows) => rows[0] ?? null);
    if (
      !responsibleMembership
      || responsibleMembership.status !== "active"
      || !responsibleMembership.membershipRole
      || responsibleMembership.membershipRole === "viewer"
    ) {
      throw forbidden("Responsible user is no longer authorized for company write access");
    }
    return {
      run,
      issueId: runSnapshotString(snapshot, "issueId") ?? runSnapshotString(paperclipIssue, "id"),
      projectId: runSnapshotString(snapshot, "projectId") ?? runSnapshotString(paperclipIssue, "projectId"),
      routineId: runSnapshotString(snapshot, "routineId"),
      responsibleUserId,
    };
  }

  async function lockAuthorizedBrokerResponsibleMembership(input: {
    companyId: string;
    responsibleUserId: string;
  }, tx: DbTransaction) {
    const membership = await tx
      .select({
        id: companyMemberships.id,
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.responsibleUserId),
      ))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !membership
      || membership.status !== "active"
      || !membership.membershipRole
      || membership.membershipRole === "viewer"
    ) {
      throw new HttpError(403, "Responsible user is no longer authorized for company write access", {
        code: "responsible_user_unauthorized",
      });
    }
    return membership;
  }

  async function recordConnectionTokenIssuance(input: {
    companyId: string;
    applicationId: string | null;
    connectionId: string;
    agentId: string;
    runId: string | null;
    issueId: string | null;
    projectId: string | null;
    responsibleUserId: string | null;
    path: ConnectionTokenIssuancePath;
    requestedScope: string[];
    issuedScope: string[];
    ttlSeconds: number | null;
    expiresAt: Date | null;
    tokenHash: string | null;
    outcome: ConnectionTokenIssuanceOutcome;
    errorCode?: string | null;
    metadata?: Record<string, unknown>;
  }, dbClient: ToolAccessMutationDb = db) {
    await dbClient.insert(connectionTokenIssuances).values({
      companyId: input.companyId,
      applicationId: input.applicationId,
      connectionId: input.connectionId,
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId,
      projectId: input.projectId,
      responsibleUserId: input.responsibleUserId,
      path: input.path,
      requestedScope: input.requestedScope,
      issuedScope: input.issuedScope,
      ttlSeconds: input.ttlSeconds,
      expiresAt: input.expiresAt,
      tokenHash: input.tokenHash,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      metadata: input.metadata ?? {},
    });
  }

  async function auditConnectionTokenIssuance(input: {
    companyId: string;
    connectionId: string;
    agentId: string;
    runId: string;
    path: ConnectionTokenIssuancePath;
    outcome: ConnectionTokenIssuanceOutcome;
    reasonCode?: string | null;
    details?: Record<string, unknown>;
  }) {
    const success = input.outcome === "success";
    await audit({
      companyId: input.companyId,
      connectionId: input.connectionId,
      action: success ? "connection_token.minted" : "connection_token.denied",
      outcome: success ? "success" : "failure",
      reasonCode: input.reasonCode ?? null,
      actor: { actorType: "agent", actorId: input.agentId },
      details: { path: input.path, outcome: input.outcome, runId: input.runId, ...(input.details ?? {}) },
    });
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      action: success ? "connection_token.minted" : "connection_token.denied",
      entityType: "tool_connection",
      entityId: input.connectionId,
      details: { path: input.path, outcome: input.outcome, reasonCode: input.reasonCode ?? null, ...(input.details ?? {}) },
    });
  }

  async function createStandingDelegationAsk(input: {
    connection: typeof toolConnections.$inferSelect;
    issueId: string | null;
    runId: string;
    agentId: string;
    ownerUserId: string;
  }) {
    if (!input.issueId) return;
    const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies)
      .where(eq(companies.id, input.connection.companyId)).limit(1);
    const idempotencyKey = `connection-delegation:${input.connection.id}:${input.ownerUserId}:${input.agentId}`;
    const payload = {
      version: 1 as const,
      prompt: `Allow this agent to use your ${input.connection.name} account for autonomous runs`,
      acceptLabel: "Review delegation",
      rejectLabel: "Not now",
      detailsMarkdown: "This autonomous run is paused. Paperclip will not use your personal identity until you explicitly delegate it to this named agent.",
      target: {
        type: "custom" as const,
        key: `connection:${input.connection.uid}:delegation:${input.ownerUserId}:${input.agentId}`,
        revisionId: input.connection.updatedAt.toISOString(),
        label: `Delegate ${input.connection.name}`,
        href: `/${company?.issuePrefix ?? ""}/apps/${input.connection.id}/setup#personal-identity`,
      },
    };
    const [existing] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, input.connection.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.idempotencyKey, idempotencyKey),
    )).limit(1);
    if (existing) {
      await db.update(issueThreadInteractions).set({
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        resolverPolicyProvenance: "explicit",
        effectiveResolverPolicySource: "requested",
        addresseeUserId: input.ownerUserId,
        payload,
        result: null,
        resolvedAt: null,
        updatedAt: new Date(),
      }).where(eq(issueThreadInteractions.id, existing.id));
      return;
    }
    await db.insert(issueThreadInteractions).values({
      companyId: input.connection.companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      idempotencyKey,
      sourceRunId: input.runId,
      title: `Delegate your ${input.connection.name}`,
      summary: "An explicit standing delegation is required for this autonomous run.",
      createdByAgentId: input.agentId,
      addresseeUserId: input.ownerUserId,
      payload,
    });
  }

  async function enforceDefaultConnectionTokenRateLimit(input: {
    connection: typeof toolConnections.$inferSelect;
    agentId: string;
    path: ConnectionTokenIssuancePath;
  }) {
    const broker = tokenBrokerConfig(input.connection);
    const configured = Number(broker.rateLimitPerHour ?? 30);
    const limit = Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 30;
    const since = new Date(now().getTime() - 60 * 60 * 1000);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(connectionTokenIssuances)
      .where(and(
        eq(connectionTokenIssuances.companyId, input.connection.companyId),
        eq(connectionTokenIssuances.connectionId, input.connection.id),
        eq(connectionTokenIssuances.agentId, input.agentId),
        eq(connectionTokenIssuances.outcome, "success"),
        gte(connectionTokenIssuances.createdAt, since),
      ));
    const count = Number(row?.count ?? 0);
    if (count >= limit) {
      throw new HttpError(429, "Connection token mint rate limit exceeded", {
        code: "rate_limited",
        path: input.path,
        limit,
        windowSeconds: 3600,
      });
    }
  }

  async function hasExplicitConnectionTokenMintProfileGrant(input: {
    companyId: string;
    agentId: string;
    issueId: string | null;
    projectId: string | null;
    routineId: string | null;
  }) {
    const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, input.companyId));
    const matchingBindings = bindings.filter((binding) => {
      if (binding.targetType === "company") return binding.targetId === input.companyId;
      if (binding.targetType === "agent") return binding.targetId === input.agentId;
      if (binding.targetType === "issue") return Boolean(input.issueId && binding.targetId === input.issueId);
      if (binding.targetType === "project") return Boolean(input.projectId && binding.targetId === input.projectId);
      if (binding.targetType === "routine") return Boolean(input.routineId && binding.targetId === input.routineId);
      return false;
    });
    const profileIds = profileIdsInBindingOrder(narrowestScopeBindings(matchingBindings));
    if (profileIds.length === 0) return false;
    const profiles = await db.select().from(toolProfiles).where(and(
      eq(toolProfiles.companyId, input.companyId),
      inArray(toolProfiles.id, profileIds),
    ));
    const activeProfileIds = profiles
      .filter((profile) => profile.status === "active")
      .map((profile) => profile.id);
    if (activeProfileIds.length === 0) return false;
    const entries = await db.select().from(toolProfileEntries).where(and(
      eq(toolProfileEntries.companyId, input.companyId),
      inArray(toolProfileEntries.profileId, activeProfileIds),
    ));
    return activeProfileIds.some((profileId) => {
      const profileEntries = entries.filter((entry) => entry.profileId === profileId);
      const exactBrokerEntries = profileEntries.filter((entry) =>
        entry.selectorType === "tool_name"
        && entry.toolName === CONNECTION_TOKEN_MINT_TOOL_NAME
        && Object.keys(asRecord(entry.conditions)).length === 0
      );
      if (exactBrokerEntries.some((entry) => entry.effect === "exclude")) return false;
      return exactBrokerEntries.some((entry) => entry.effect === "include");
    });
  }

  function accessContextForBroker(input: {
    connection: typeof toolConnections.$inferSelect;
    agentId: string;
    runId: string;
    issueId: string | null;
    actorSource?: ActorInfo["actorType"] | null;
    configPath: string;
  }) {
    return {
      consumerType: "tool_connection" as const,
      consumerId: input.connection.id,
      configPath: input.configPath,
      actorType: "agent" as const,
      actorId: input.agentId,
      actorSource: "agent_jwt" as const,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
    };
  }

  function findBrokerCredentialRef(connection: typeof toolConnections.$inferSelect) {
    const broker = tokenBrokerConfig(connection);
    const configuredPath = readConfigString(broker, "parentCredentialConfigPath")
      ?? readConfigString(broker, "credentialConfigPath")
      ?? readConfigString(broker, "secretConfigPath");
    const configuredName = readConfigString(broker, "parentCredentialName") ?? readConfigString(broker, "credentialName");
    const secretCandidates = connection.credentialSecretRefs.filter((ref) =>
      ref.configPath !== "oauth.access_token"
      && ref.configPath !== "oauth.refresh_token"
      && ref.configPath !== "oauth.client_secret"
    );
    const secretRef = configuredPath
      ? connection.credentialSecretRefs.find((ref) => ref.configPath === configuredPath)
      : secretCandidates.find((ref) => ref.configPath === "credentials.deploy_token")
        ?? secretCandidates.find((ref) => ref.configPath === "pages.deploy_token")
        ?? secretCandidates[0];
    if (secretRef) return { kind: "secret_ref" as const, ref: secretRef, configPath: secretRef.configPath };
    const credentialRef = configuredName
      ? connection.credentialRefs.find((ref) => ref.name === configuredName)
      : connection.credentialRefs[0];
    if (credentialRef) return { kind: "credential_ref" as const, ref: credentialRef, configPath: `credentials.${credentialRef.name}` };
    return null;
  }

  async function resolveBrokerParentCredential(input: {
    connection: typeof toolConnections.$inferSelect;
    agentId: string;
    runId: string;
    issueId: string | null;
  }, secretClient: ReturnType<typeof secretService> = secrets) {
    const ref = findBrokerCredentialRef(input.connection);
    if (!ref) {
      throw unprocessable("Connection token exchange requires a vault-backed parent credential", {
        code: "parent_credential_missing",
      });
    }
    if (ref.kind === "secret_ref") {
      return secretClient.resolveSecretValue(input.connection.companyId, ref.ref.secretId, ref.ref.versionSelector ?? "latest", {
        accessContext: accessContextForBroker({ ...input, configPath: ref.configPath }),
        bindingContext: accessContextForBroker({ ...input, configPath: ref.configPath }),
      });
    }
    return secretClient.resolveSecretValue(input.connection.companyId, ref.ref.secretId, ref.ref.version ?? "latest", {
      accessContext: accessContextForBroker({ ...input, configPath: ref.configPath }),
      bindingContext: accessContextForBroker({ ...input, configPath: ref.configPath }),
    });
  }

  function exchangeTokenUrl(connection: typeof toolConnections.$inferSelect, isPages: boolean): string {
    const broker = tokenBrokerConfig(connection);
    const config = asRecord(connection.config);
    const url = readConfigString(broker, "tokenUrl")
      ?? readConfigString(broker, "exchangeTokenUrl")
      ?? readConfigString(config, "tokenExchangeUrl")
      ?? readConfigString(config, "pagesTokenExchangeUrl");
    if (url) return url;
    const pagesApiBase = process.env.PAPERCLIP_PAGES_API_URL?.trim();
    if (isPages && pagesApiBase) return new URL("/v1/tokens/exchange", pagesApiBase.endsWith("/") ? pagesApiBase : `${pagesApiBase}/`).toString();
    throw unprocessable("Connection token exchange URL is not configured", { code: "exchange_url_missing" });
  }

  function pagesNamespaceFromScope(scope: string[]): string | null {
    const first = scope[0];
    if (!first) return null;
    const match = first.match(/^pages:publish:ns\/([^/\s]+)$/);
    return match?.[1] ?? null;
  }

  async function mintExchangeConnectionToken(input: {
    connection: typeof toolConnections.$inferSelect;
    application: typeof toolApplications.$inferSelect | null;
    agentId: string;
    runId: string;
    issueId: string | null;
    responsibleUserId: string | null;
    scope: string[];
    ttlSeconds: number;
  }, secretClient: ReturnType<typeof secretService> = secrets) {
    const isPages = isPagesTokenConnection(input.connection, input.application);
    const parentToken = await resolveBrokerParentCredential(input, secretClient);
    const broker = tokenBrokerConfig(input.connection);
    const protocol = readConfigString(broker, "protocol") ?? readConfigString(broker, "exchangeProtocol") ?? (isPages ? "pages" : "generic");
    const url = exchangeTokenUrl(input.connection, isPages);
    const actor = {
      type: "agent",
      id: input.agentId,
      runId: input.runId,
      ...(input.responsibleUserId ? { onBehalfOf: `user:${input.responsibleUserId}` } : {}),
    };
    let response: Response;
    if (protocol === "rfc8693") {
      const body = new URLSearchParams();
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
      body.set("subject_token", parentToken);
      body.set("subject_token_type", readConfigString(broker, "subjectTokenType") ?? "urn:ietf:params:oauth:token-type:access_token");
      body.set("scope", input.scope.join(" "));
      const audience = readConfigString(broker, "audience");
      if (audience) body.set("audience", audience);
      body.set("requested_token_type", readConfigString(broker, "requestedTokenType") ?? "urn:ietf:params:oauth:token-type:access_token");
      body.set("actor_token", Buffer.from(JSON.stringify(actor)).toString("base64url"));
      body.set("actor_token_type", readConfigString(broker, "actorTokenType") ?? "urn:ietf:params:oauth:token-type:jwt");
      const endpoint = parseRemoteHttpEndpoint(url, (message, code) => badRequest(message, { code }));
      response = await guardedRemoteHttpFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }, tokenBrokerHttpFetchOptions(endpoint));
    } else {
      const namespace = isPages ? pagesNamespaceFromScope(input.scope) : null;
      const body = isPages && namespace
        ? { namespace, ttlSeconds: input.ttlSeconds, actions: ["publish"], actor }
        : { scope: input.scope, ttlSeconds: input.ttlSeconds, actor, audience: readConfigString(broker, "audience") };
      const endpoint = parseRemoteHttpEndpoint(url, (message, code) => badRequest(message, { code }));
      response = await guardedRemoteHttpFetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${parentToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }, tokenBrokerHttpFetchOptions(endpoint));
    }
    const payload = await response.json().catch(() => ({})) as unknown;
    const record = asRecord(payload);
    if (!response.ok) {
      const code = typeof record.code === "string"
        ? record.code
        : typeof record.error === "string"
          ? record.error
          : "upstream_error";
      throw new HttpError(response.status === 401 || response.status === 403 ? 409 : 502, "Connection token exchange failed", {
        code: code === "parent_revoked" ? "credential_revoked" : "upstream_error",
        upstreamCode: code,
        upstreamStatus: response.status,
        upstreamRequestId: typeof record.requestId === "string" ? record.requestId : null,
      });
    }
    const token = typeof record.token === "string"
      ? record.token
      : typeof record.access_token === "string"
        ? record.access_token
        : null;
    if (!token) throw new HttpError(502, "Connection token exchange did not return a token", { code: "upstream_token_missing" });
    const expiresIn = typeof record.expires_in === "number" ? record.expires_in : Number(record.expires_in);
    const expiresAt = typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt))
      ? new Date(record.expiresAt)
      : typeof record.expires_at === "string" && Number.isFinite(Date.parse(record.expires_at))
        ? new Date(record.expires_at)
        : new Date(now().getTime() + Math.min(input.ttlSeconds, Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : input.ttlSeconds) * 1000);
    const responseScope = readConfigStringArray(record.scope).length > 0 ? readConfigStringArray(record.scope) : input.scope;
    return {
      token,
      tokenType: typeof record.token_type === "string" ? record.token_type : "Bearer",
      expiresAt,
      scope: responseScope,
    };
  }

  function runtimeAlert(input: ToolRuntimeAlertRecommendation): ToolRuntimeAlertRecommendation {
    return input;
  }

  function buildRuntimeAlerts(input: {
    stuckStartingSlots: number;
    stuckRunningSlots: number;
    timeoutRate: number;
    timeoutCount: number;
    failureRate: number;
    failureCount: number;
    capacityDeferrals: number;
    restartAttempts: number;
    restartSuppressions: number;
    degradedConnections: number;
    disabledConnections: number;
    missingSecretFailures: number;
    auditWriteFailures: number;
  }): ToolRuntimeAlertRecommendation[] {
    const runbookSection = "doc/MCP-RUNTIME-OPERATIONS.md";
    const timeoutSeverity =
      input.timeoutCount >= 10 || input.timeoutRate >= 25
        ? "critical"
        : input.timeoutCount >= 3 && input.timeoutRate >= 10
          ? "warning"
          : "warning";
    const failureSeverity =
      input.failureCount >= 10 || input.failureRate >= 25
        ? "critical"
        : input.failureCount >= 5 && input.failureRate >= 10
          ? "warning"
          : "warning";
    const restartSeverity = input.restartSuppressions > 0 ? "critical" : "warning";
    return [
      runtimeAlert({
        name: "mcp_runtime_stuck_starting_slot",
        severity: "critical",
        status: input.stuckStartingSlots > 0 ? "firing" : "ok",
        threshold: "Any starting slot older than 5 minutes.",
        observed: `${input.stuckStartingSlots} stuck starting slot(s).`,
        description: "A local stdio runtime slot is stuck before it reaches running state.",
        firstResponderAction: "Inspect the slot health/logs, stop the slot, restart it once, then disable the connection if the slot sticks again.",
        runbookSection,
      }),
      runtimeAlert({
        name: "mcp_runtime_stuck_running_slot",
        severity: "critical",
        status: input.stuckRunningSlots > 0 ? "firing" : "ok",
        threshold: "Any running slot with no progress for 5 minutes.",
        observed: `${input.stuckRunningSlots} stuck running slot(s).`,
        description: "A runtime slot is running but has not recorded progress inside the supervisor stuck-slot window.",
        firstResponderAction: "Inspect recent audit events and active tool calls; restart the slot only after confirming no healthy call is still in progress.",
        runbookSection,
      }),
      runtimeAlert({
        name: "mcp_runtime_high_timeout_rate",
        severity: timeoutSeverity,
        status: input.timeoutCount >= 3 && input.timeoutRate >= 10 ? "firing" : "ok",
        threshold: "Warning at >=3 timeouts and >=10% timeout rate in 1 hour; critical at >=10 timeouts or >=25%.",
        observed: `${input.timeoutCount} timeout(s), ${input.timeoutRate}% timeout rate.`,
        description: "Tool gateway calls are timing out or being runtime-deferred at an elevated rate.",
        firstResponderAction: "Check upstream MCP health, Paperclip runtime capacity, and recent gateway audit failures before retrying workloads.",
        runbookSection,
      }),
      runtimeAlert({
        name: "mcp_runtime_high_error_rate",
        severity: failureSeverity,
        status: input.failureCount >= 5 && input.failureRate >= 10 ? "firing" : "ok",
        threshold: "Warning at >=5 failures and >=10% failure rate in 1 hour; critical at >=10 failures or >=25%.",
        observed: `${input.failureCount} failure(s), ${input.failureRate}% failure rate.`,
        description: "Tool gateway calls are failing after policy authorization.",
        firstResponderAction: "Group audit failures by reasonCode, then fix credentials/config or disable the affected connection.",
        runbookSection,
      }),
      runtimeAlert({
        name: "mcp_runtime_capacity_deferrals_repeated",
        severity: input.capacityDeferrals >= 10 ? "critical" : "warning",
        status: input.capacityDeferrals >= 3 ? "firing" : "ok",
        threshold: "Warning at >=3 capacity deferrals in 1 hour; critical at >=10.",
        observed: `${input.capacityDeferrals} capacity deferral(s) in 1 hour.`,
        description: "The runtime supervisor is refusing local stdio work because company or host slot capacity is exhausted.",
        firstResponderAction: "Stop idle/stale slots, lower noisy workloads, or raise slot caps only after confirming host capacity.",
        runbookSection,
      }),
      runtimeAlert({
        name: "mcp_runtime_restart_storm",
        severity: restartSeverity,
        status: input.restartSuppressions > 0 || input.restartAttempts >= 3 ? "firing" : "ok",
        threshold: "Warning at >=3 restarts in 1 hour; critical on any restart suppression.",
        observed: `${input.restartAttempts} restart attempt(s), ${input.restartSuppressions} suppression(s).`,
        description: "Runtime slots are restarting repeatedly or have hit restart-storm suppression.",
        firstResponderAction: "Stop the affected slot, inspect stderr/audit reason codes, and keep the connection disabled until the template/upstream is fixed.",
        runbookSection,
      }),
      runtimeAlert({
        name: "mcp_runtime_connection_health_degraded",
        severity: input.degradedConnections > 0 ? "critical" : "warning",
        status: input.degradedConnections > 0 || input.disabledConnections > 0 ? "firing" : "ok",
        threshold: "Any active enabled connection with degraded/failed/missing-secret health, or any disabled enabled-path connection.",
        observed: `${input.degradedConnections} degraded connection(s), ${input.disabledConnections} disabled connection(s).`,
        description: "A configured MCP connection is not healthy or has been disabled.",
        firstResponderAction: "Run a connection health check, refresh catalog after recovery, or keep the connection disabled and route agents to alternatives.",
        runbookSection,
      }),
      runtimeAlert({
        name: "mcp_runtime_missing_secret_failures",
        severity: input.missingSecretFailures >= 3 ? "critical" : "warning",
        status: input.missingSecretFailures > 0 ? "firing" : "ok",
        threshold: "Warning on any missing-secret failure; critical at >=3 in 1 hour.",
        observed: `${input.missingSecretFailures} missing-secret failure(s) in 1 hour.`,
        description: "A connection or tool call needed a bound secret that could not be resolved.",
        firstResponderAction: "Check secret bindings and provider health without printing secret values; rotate or rebind missing secrets.",
        runbookSection,
      }),
      runtimeAlert({
        name: "mcp_runtime_audit_write_failures",
        severity: "critical",
        status: input.auditWriteFailures > 0 ? "firing" : "ok",
        threshold: "Any audit write failure.",
        observed: `${input.auditWriteFailures} audit write failure(s) in 1 hour.`,
        description: "Tool gateway audit writes failed, reducing incident traceability.",
        firstResponderAction: "Treat as a control-plane incident: check database writes, activity log writes, and retry only after audit durability is restored.",
        runbookSection,
      }),
    ];
  }

  async function runtimeHealth(companyId: string): Promise<ToolRuntimeHealthSummary> {
    const generatedAt = now();
    const windowStartedAt = new Date(generatedAt.getTime() - 60 * 60 * 1000);
    const stuckSlotMs = 5 * 60 * 1000;
    const [slots, connections, auditRows, callEvents, auditWriteFailureCounterRows] = await Promise.all([
      db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.companyId, companyId)),
      db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId)),
      db
        .select()
        .from(toolAccessAuditEvents)
        .where(and(eq(toolAccessAuditEvents.companyId, companyId), gte(toolAccessAuditEvents.createdAt, windowStartedAt)))
        .orderBy(desc(toolAccessAuditEvents.createdAt)),
      db
        .select()
        .from(toolCallEvents)
        .where(and(eq(toolCallEvents.companyId, companyId), gte(toolCallEvents.createdAt, windowStartedAt)))
        .orderBy(desc(toolCallEvents.createdAt)),
      db
        .select({ count: sql<number>`coalesce(sum(${toolRuntimeMetricCounters.count}), 0)::int` })
        .from(toolRuntimeMetricCounters)
        .where(and(
          eq(toolRuntimeMetricCounters.companyId, companyId),
          eq(toolRuntimeMetricCounters.metric, TOOL_RUNTIME_AUDIT_WRITE_FAILURE_METRIC),
          gte(toolRuntimeMetricCounters.bucketStartAt, windowStartedAt),
        )),
    ]);
    const activeSlots = slots.filter((slot) => slot.status === "starting" || slot.status === "running" || slot.status === "idle");
    const staleActiveSlots = activeSlots.filter((slot) => {
      const lastProgressAt = slot.lastUsedAt ?? slot.startedAt ?? slot.updatedAt;
      return generatedAt.getTime() - lastProgressAt.getTime() > stuckSlotMs;
    });
    const callTerminalEvents = callEvents.filter((event) =>
      event.eventType === "call_completed" || event.eventType === "call_failed" || event.eventType === "call_denied"
    );
    const toolCallsLastHour = callTerminalEvents.length;
    const toolTimeoutsLastHour = callTerminalEvents.filter((event) => event.outcome === "timeout").length;
    const toolFailuresLastHour = callTerminalEvents.filter((event) => event.outcome === "failure").length;
    const durations = auditRows
      .map((row) => numberValue(asRecord(row.details).durationMs))
      .filter((value): value is number => value !== null && value >= 0);
    const capacityDeferrals = auditRows.filter((row) =>
      row.action === "runtime_deferred"
      || row.reasonCode === "runtime_company_capacity_exhausted"
      || row.reasonCode === "runtime_host_capacity_exhausted"
    ).length;
    const restartAttempts = auditRows.filter((row) =>
      row.action === "runtime_started"
      && row.reasonCode !== "lazy_start"
    ).length;
    const restartSuppressions = auditRows.filter((row) =>
      row.action === "runtime_restart_suppressed"
      || row.reasonCode === "runtime_restart_suppressed"
    ).length;
    const idleEvictions = auditRows.filter((row) =>
      row.action === "runtime_stopped"
      && row.reasonCode === "idle_ttl_expired"
    ).length;
    const missingSecretFailures = auditRows.filter((row) =>
      row.reasonCode === "missing_secret"
      || row.outcome === "failure" && row.reasonCode?.includes("secret")
    ).length;
    const legacyAuditWriteFailures = auditRows.filter((row) =>
      row.action === "runtime_audit_write_failed"
      || row.reasonCode === "audit_write_failed"
    ).length;
    const auditWriteFailuresMetric = Number(auditWriteFailureCounterRows[0]?.count ?? 0) + legacyAuditWriteFailures;
    const enabledPathConnections = connections.filter((connection) =>
      connection.status === "active"
      && connection.enabled
    );
    const activeConnections = enabledPathConnections.length;
    const disabledConnections = connections.filter((connection) => connection.status === "disabled").length;
    const degradedConnections = enabledPathConnections.filter((connection) =>
      ["degraded", "failed", "error", "missing_secret"].includes(connection.healthStatus)
    ).length;
    const metrics = {
      windowStartedAt,
      windowEndedAt: generatedAt,
      activeSlots: activeSlots.length,
      startingSlots: slots.filter((slot) => slot.status === "starting").length,
      runningSlots: slots.filter((slot) => slot.status === "running").length,
      idleSlots: slots.filter((slot) => slot.status === "idle").length,
      failedSlots: slots.filter((slot) => slot.status === "failed" || slot.status === "error").length,
      stoppedSlots: slots.filter((slot) => slot.status === "stopped" || slot.status === "disabled").length,
      stuckStartingSlots: staleActiveSlots.filter((slot) => slot.status === "starting").length,
      stuckRunningSlots: staleActiveSlots.filter((slot) => slot.status === "running").length,
      capacityDeferralsLastHour: capacityDeferrals,
      restartAttemptsLastHour: restartAttempts,
      restartSuppressionsLastHour: restartSuppressions,
      idleEvictionsLastHour: idleEvictions,
      toolCallsLastHour,
      toolTimeoutsLastHour,
      toolFailuresLastHour,
      timeoutRateLastHour: percent(toolTimeoutsLastHour, toolCallsLastHour),
      failureRateLastHour: percent(toolFailuresLastHour, toolCallsLastHour),
      averageToolLatencyMsLastHour: durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : null,
      p95ToolLatencyMsLastHour: percentile(durations, 95),
      missingSecretFailuresLastHour: missingSecretFailures,
      auditWriteFailuresLastHour: auditWriteFailuresMetric,
      activeConnections,
      disabledConnections,
      degradedConnections,
      remoteHttpConnections: connections.filter((connection) => connection.status !== "archived" && connection.transport === "mcp_remote").length,
      localStdioConnections: connections.filter((connection) => connection.status !== "archived" && connection.transport === "local_stdio").length,
    };
    const recommendations = buildRuntimeAlerts({
      stuckStartingSlots: metrics.stuckStartingSlots,
      stuckRunningSlots: metrics.stuckRunningSlots,
      timeoutRate: metrics.timeoutRateLastHour,
      timeoutCount: metrics.toolTimeoutsLastHour,
      failureRate: metrics.failureRateLastHour,
      failureCount: metrics.toolFailuresLastHour,
      capacityDeferrals,
      restartAttempts,
      restartSuppressions,
      degradedConnections,
      disabledConnections,
      missingSecretFailures,
      auditWriteFailures: metrics.auditWriteFailuresLastHour,
    });
    const firing = recommendations.filter((alert) => alert.status === "firing");
    const status = firing.some((alert) => alert.severity === "critical")
      ? "critical"
      : firing.length > 0
        ? "degraded"
        : "ok";
    const deploymentMode = options.deploymentMode ?? "local_trusted";
    const deploymentExposure = options.deploymentExposure ?? "private";
    const localStdioSupported = deploymentMode === "local_trusted" || Boolean(trustedRuntimeHost());
    return {
      status,
      generatedAt,
      runbookPath: "doc/MCP-RUNTIME-OPERATIONS.md",
      metrics,
      supportMatrix: {
        remoteHttp: {
          supported: true,
          note: "mcp_remote MCP connections are supported in hosted cloud and local deployments.",
        },
        localStdio: {
          supported: localStdioSupported,
          note: localStdioSupported
            ? "local_stdio is available for local trusted mode or through the configured trusted MCP runtime host."
            : `local_stdio should stay disabled for ${deploymentMode}/${deploymentExposure}; use mcp_remote or configure a trusted runtime worker.`,
        },
      },
      alerts: firing,
      recommendations,
    };
  }

  async function runtimeSlotById(companyId: string, slotId: string): Promise<ToolRuntimeSlot> {
    const [row] = await db
      .select()
      .from(toolRuntimeSlots)
      .where(and(eq(toolRuntimeSlots.companyId, companyId), eq(toolRuntimeSlots.id, slotId)))
      .limit(1);
    if (!row) throw notFound("Runtime slot not found");
    return toRuntimeSlot(row);
  }

  function runtimeSupervisorHttpError(error: ToolRuntimeSupervisorError) {
    return new HttpError(error.status, error.message, {
      code: error.reasonCode,
      ...error.details,
    });
  }

  async function controlRuntimeSlot(input: {
    companyId: string;
    slotId: string;
    action: "stop" | "restart";
    actor?: ActorInfo;
  }): Promise<ToolRuntimeSlot> {
    try {
      if (input.action === "stop") {
        await runtimeSupervisor.stopSlot({
          companyId: input.companyId,
          slotId: input.slotId,
          reason: "operator_stop",
        });
      } else {
        await runtimeSupervisor.restartSlot({
          companyId: input.companyId,
          slotId: input.slotId,
        });
      }
      const slot = await runtimeSlotById(input.companyId, input.slotId);
      await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "tool-access-service",
        action: input.action === "stop" ? "tool_runtime_slot.operator_stopped" : "tool_runtime_slot.operator_restarted",
        entityType: "tool_runtime_slot",
        entityId: input.slotId,
        details: {
          runtimeKind: slot.runtimeKind,
          status: slot.status,
          slotKey: slot.slotKey,
        },
      });
      return slot;
    } catch (error) {
      if (error instanceof ToolRuntimeSupervisorError) {
        throw runtimeSupervisorHttpError(error);
      }
      throw error;
    }
  }

  async function assertApplication(companyId: string, applicationId: string) {
    const [row] = await db
      .select()
      .from(toolApplications)
      .where(and(eq(toolApplications.id, applicationId), eq(toolApplications.companyId, companyId)));
    if (!row) throw notFound("Tool application not found");
    return row;
  }

  async function assertOptionalAgent(companyId: string, agentId: string | null | undefined, label: string) {
    if (!agentId) return;
    const [row] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!row) throw unprocessable(`${label} must belong to the same company`);
  }

  async function assertOptionalPlugin(pluginId: string | null | undefined) {
    if (!pluginId) return;
    const [row] = await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.id, pluginId));
    if (!row) throw unprocessable("Tool application plugin was not found");
  }

  async function assertSecretRefs(companyId: string, refs: Array<{
    secretId: string;
    configPath?: string | null;
    projectionClass?: string | null;
    projectionAllowlistKey?: string | null;
  }>) {
    if (refs.length === 0) return;
    for (const ref of refs) {
      assertClass3ToolCredentialRefAllowed(ref);
    }
    const secretIds = [...new Set(refs.map((ref) => ref.secretId))];
    for (const secretId of secretIds) {
      const [secret] = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId)));
      if (!secret) throw unprocessable("Tool connection credential secrets must belong to the same company");
    }
  }

  async function assertGoogleSheetsSpreadsheetOwnership(
    companyId: string,
    config: Record<string, unknown>,
    options: { excludeConnectionId?: string } = {},
  ) {
    if (!isGoogleSheetsConnectionConfig(config)) return;
    const allowedSpreadsheetIds = googleSheetsAllowedSpreadsheetIds(config);
    if (allowedSpreadsheetIds.length === 0) return;
    const allowed = new Set(allowedSpreadsheetIds);
    const rows = await db
      .select({
        id: toolConnections.id,
        companyId: toolConnections.companyId,
        config: toolConnections.config,
      })
      .from(toolConnections)
      .where(ne(toolConnections.status, "archived"));

    const conflictingSpreadsheetIds = new Set<string>();
    for (const row of rows) {
      if (row.id === options.excludeConnectionId || row.companyId === companyId) continue;
      if (!isGoogleSheetsConnectionConfig(row.config)) continue;
      for (const spreadsheetId of googleSheetsAllowedSpreadsheetIds(row.config)) {
        if (allowed.has(spreadsheetId)) conflictingSpreadsheetIds.add(spreadsheetId);
      }
    }

    if (conflictingSpreadsheetIds.size > 0) {
      throw conflict("Google Sheets spreadsheet is already connected to another company.", {
        code: "google_sheets_spreadsheet_already_bound",
        spreadsheetIds: Array.from(conflictingSpreadsheetIds).sort(),
      });
    }
  }

  async function assertCatalogEntry(companyId: string, catalogEntryId: string | null | undefined) {
    if (!catalogEntryId) return;
    const [row] = await db
      .select({ id: toolCatalogEntries.id })
      .from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.id, catalogEntryId), eq(toolCatalogEntries.companyId, companyId)));
    if (!row) throw unprocessable("Tool profile catalog entry selector must belong to the same company");
  }

  async function assertTargetExists(companyId: string, targetType: CreateToolProfileBindingForProfile["targetType"], targetId: string) {
    if (targetType === "company") {
      if (targetId !== companyId) throw unprocessable("Company profile bindings must target the same company id");
      return;
    }
    if (targetType === "agent") {
      const [row] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, targetId), eq(agents.companyId, companyId)));
      if (!row) throw unprocessable("Tool profile agent binding target must belong to the same company");
      return;
    }
    if (targetType === "project") {
      const [row] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, targetId), eq(projects.companyId, companyId)));
      if (!row) throw unprocessable("Tool profile project binding target must belong to the same company");
      return;
    }
    if (targetType === "routine") {
      const [row] = await db.select({ id: routines.id }).from(routines).where(and(eq(routines.id, targetId), eq(routines.companyId, companyId)));
      if (!row) throw unprocessable("Tool profile routine binding target must belong to the same company");
      return;
    }
    if (targetType === "issue") {
      const [row] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, targetId), eq(issues.companyId, companyId)));
      if (!row) throw unprocessable("Tool profile issue binding target must belong to the same company");
      return;
    }
    if (targetType === "gateway") {
      const [row] = await db.select({ id: toolMcpGateways.id }).from(toolMcpGateways).where(and(eq(toolMcpGateways.id, targetId), eq(toolMcpGateways.companyId, companyId)));
      if (!row) throw unprocessable("Tool profile gateway binding target must belong to the same company");
    }
  }

  async function appProfileForConnection(
    dbClient: Pick<Db, "select" | "insert" | "delete">,
    connection: typeof toolConnections.$inferSelect,
  ) {
    const profileKey = `app:${connection.id}`;
    let [profile] = await dbClient
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, connection.companyId), eq(toolProfiles.profileKey, profileKey)))
      .limit(1);
    if (!profile) {
      const [sameName] = await dbClient
        .select({ id: toolProfiles.id })
        .from(toolProfiles)
        .where(and(
          eq(toolProfiles.companyId, connection.companyId),
          eq(toolProfiles.name, connection.name),
        ))
        .limit(1);
      const profileName = sameName
        ? `${connection.name} (${connection.id.replace(/-/g, "").slice(0, 8)})`
        : connection.name;
      [profile] = await dbClient.insert(toolProfiles).values({
        companyId: connection.companyId,
        profileKey,
        name: profileName,
        description: `Access profile for ${connection.name}.`,
        status: "active",
        defaultAction: "deny",
        metadata: { source: "tool_connection_install", connectionId: connection.id },
      }).returning();
    }
    // Installation controls where a connection is exposed, not which actions
    // it grants. The app wizard's catalog-entry includes are the authority for
    // action selection, so remove the legacy connection-wide include that used
    // to silently turn every installed action on.
    await dbClient
      .delete(toolProfileEntries)
      .where(and(
        eq(toolProfileEntries.companyId, connection.companyId),
        eq(toolProfileEntries.profileId, profile.id),
        eq(toolProfileEntries.selectorType, "connection"),
        eq(toolProfileEntries.effect, "include"),
        eq(toolProfileEntries.connectionId, connection.id),
      ));
    return profile;
  }

  async function enableCatalogEntriesByDefault(input: {
    connection: typeof toolConnections.$inferSelect;
    newCatalogEntryIds: string[];
    activeCatalogEntryIds: string[];
    restoreDraftDefaults?: boolean;
    actor?: ActorInfo;
  }) {
    // Catalog discovery also runs while the setup wizard is still a draft.
    // Access is not granted until the operator finishes that wizard, so a
    // draft refresh must never manufacture a profile or company-wide binding.
    // Active legacy connections may still need the managed profile created on
    // their first refresh. A reconnect is the one draft exception: removal
    // deliberately clears the old selections, so reconnecting restores the
    // documented defaults without activating the connection itself.
    if (input.connection.status !== "active" && !input.restoreDraftDefaults) return;
    const profileKey = `app:${input.connection.id}`;
    let [profile] = await db
      .select()
      .from(toolProfiles)
      .where(and(
        eq(toolProfiles.companyId, input.connection.companyId),
        eq(toolProfiles.profileKey, profileKey),
      ))
      .limit(1);
    const createdProfile = !profile;
    const resetToRecommendedDefaults = !profile || profile.status !== "active";
    if (!profile) {
      const [sameName] = await db
        .select({ id: toolProfiles.id })
        .from(toolProfiles)
        .where(and(
          eq(toolProfiles.companyId, input.connection.companyId),
          eq(toolProfiles.name, input.connection.name),
        ))
        .limit(1);
      const profileName = sameName
        ? `${input.connection.name} (${input.connection.id.replace(/-/g, "").slice(0, 8)})`
        : input.connection.name;
      [profile] = await db.insert(toolProfiles).values({
        companyId: input.connection.companyId,
        profileKey,
        name: profileName,
        description: `Access profile for ${input.connection.name}.`,
        status: "active",
        defaultAction: "deny",
        metadata: { source: "app_gallery_finish", connectionId: input.connection.id },
      }).returning();
      await db.insert(toolProfileBindings).values({
        companyId: input.connection.companyId,
        profileId: profile.id,
        targetType: "company",
        targetId: input.connection.companyId,
        priority: 100,
        metadata: { source: "app_gallery_finish" },
        createdByAgentId: input.actor?.actorType === "agent" ? input.actor.actorId ?? null : null,
        createdByUserId: input.actor?.actorType === "user" ? input.actor.actorId ?? null : null,
      });
    } else if (resetToRecommendedDefaults) {
      // Removing an app may retain its profile row when another record still
      // references it (for example, an MCP gateway). Reconnecting revives the
      // same connection id, so restore that retained profile as a fresh
      // all-agents assignment instead of leaving every read action Off.
      [profile] = await db
        .update(toolProfiles)
        .set({
          name: input.connection.name,
          description: `Access profile for ${input.connection.name}.`,
          status: "active",
          defaultAction: "deny",
          metadata: { source: "app_gallery_finish", connectionId: input.connection.id },
          updatedAt: new Date(),
        })
        .where(eq(toolProfiles.id, profile.id))
        .returning();
      await db.delete(toolProfileBindings).where(and(
        eq(toolProfileBindings.companyId, input.connection.companyId),
        eq(toolProfileBindings.profileId, profile.id),
      ));
      await db.delete(toolProfileEntries).where(and(
        eq(toolProfileEntries.companyId, input.connection.companyId),
        eq(toolProfileEntries.profileId, profile.id),
      ));
      await db.insert(toolProfileBindings).values({
        companyId: input.connection.companyId,
        profileId: profile.id,
        targetType: "company",
        targetId: input.connection.companyId,
        priority: 100,
        metadata: { source: "app_gallery_finish" },
        createdByAgentId: input.actor?.actorType === "agent" ? input.actor.actorId ?? null : null,
        createdByUserId: input.actor?.actorType === "user" ? input.actor.actorId ?? null : null,
      });
    }

    if (resetToRecommendedDefaults) {
      // Old setup defaults created app-scoped Ask first policies for writes.
      // They outrank profile allows, so a revived connection must explicitly
      // retire them to make every action Allowed. Policies outside this app's
      // managed profile are intentionally untouched.
      await upsertAskFirstPolicies({
        companyId: input.connection.companyId,
        connection: input.connection,
        askFirstEntries: [],
        actor: input.actor,
      });
    }

    // A new or revived connection starts with every discovered action enabled.
    // Later refreshes extend an active managed profile only for genuinely new
    // actions, so an action the operator deliberately turned off remains off.
    const candidateIds = [...new Set(
      createdProfile || resetToRecommendedDefaults
        ? input.activeCatalogEntryIds
        : input.newCatalogEntryIds,
    )];
    if (candidateIds.length === 0) return;
    const existingEntries = await db
      .select({ catalogEntryId: toolProfileEntries.catalogEntryId })
      .from(toolProfileEntries)
      .where(and(
        eq(toolProfileEntries.companyId, input.connection.companyId),
        eq(toolProfileEntries.profileId, profile.id),
        inArray(toolProfileEntries.catalogEntryId, candidateIds),
      ));
    const configuredIds = new Set(existingEntries.flatMap((entry) =>
      entry.catalogEntryId ? [entry.catalogEntryId] : [],
    ));
    const entryIds = candidateIds.filter((id) => !configuredIds.has(id));
    if (entryIds.length === 0) return;
    await db.insert(toolProfileEntries).values(entryIds.map((catalogEntryId) => ({
      companyId: input.connection.companyId,
      profileId: profile.id,
      selectorType: "catalog_entry" as const,
      effect: "include" as const,
      applicationId: input.connection.applicationId,
      connectionId: input.connection.id,
      catalogEntryId,
    })));
  }

  async function listConnectionInstalls(connectionId: string, companyId?: string): Promise<ToolConnectionInstall[]> {
    const connection = await getConnectionRow(connectionId, companyId);
    const rows = await db
      .select()
      .from(toolConnectionInstalls)
      .where(and(
        eq(toolConnectionInstalls.companyId, connection.companyId),
        eq(toolConnectionInstalls.connectionId, connection.id),
      ))
      .orderBy(asc(toolConnectionInstalls.targetType), asc(toolConnectionInstalls.targetId));
    return rows.map(toConnectionInstall);
  }

  async function resolveInstalledConnectionsForAgent(companyId: string, agentId: string): Promise<ToolConnection[]> {
    await assertOptionalAgent(companyId, agentId, "Tool connection install agent");
    const installRows = await db
      .select()
      .from(toolConnectionInstalls)
      .where(and(
        eq(toolConnectionInstalls.companyId, companyId),
        sql`((${toolConnectionInstalls.targetType} = 'company' and ${toolConnectionInstalls.targetId} = ${companyId}) or (${toolConnectionInstalls.targetType} = 'agent' and ${toolConnectionInstalls.targetId} = ${agentId}))`,
      ));
    if (installRows.length === 0) return [];
    const connectionIds = [...new Set(installRows.map((install) => install.connectionId))];
    const rows = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), inArray(toolConnections.id, connectionIds)))
      .orderBy(asc(toolConnections.name));
    return rows.map((row) => ({
      ...toConnection(row),
      installs: installRows.filter((install) => install.connectionId === row.id).map(toConnectionInstall),
    }));
  }

  async function assertProfileEntryInput(companyId: string, input: CreateToolProfileEntryForProfile) {
    if (input.selectorType === "application" && !input.applicationId) {
      throw badRequest("Application profile entries require applicationId");
    }
    if (input.selectorType === "connection" && !input.connectionId) {
      throw badRequest("Connection profile entries require connectionId");
    }
    if (input.selectorType === "catalog_entry" && !input.catalogEntryId) {
      throw badRequest("Catalog-entry profile entries require catalogEntryId");
    }
    if (input.selectorType === "tool_name" && !input.toolName) {
      throw badRequest("Tool-name profile entries require toolName");
    }
    if (input.selectorType === "risk_level" && !input.riskLevel) {
      throw badRequest("Risk-level profile entries require riskLevel");
    }
    if (input.applicationId) await assertApplication(companyId, input.applicationId);
    if (input.connectionId) await getConnectionRow(input.connectionId, companyId);
    if (input.catalogEntryId) await assertCatalogEntry(companyId, input.catalogEntryId);
  }

  async function getConnectionRow(idOrUid: string, companyId?: string) {
    const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idOrUid)
      ? eq(toolConnections.id, idOrUid)
      : eq(toolConnections.uid, idOrUid);
    const where = companyId
      ? and(identifier, eq(toolConnections.companyId, companyId))
      : identifier;
    const [row] = await db.select().from(toolConnections).where(where);
    if (!row) throw notFound("Tool connection not found");
    return row;
  }

  async function ensureDefaultOrganizationGrant(
    connection: typeof toolConnections.$inferSelect,
    dbClient: ToolAccessMutationDb = db,
  ) {
    const [existing] = await dbClient
      .select()
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "organization"),
        eq(connectionGrants.isDefault, true),
      ))
      .limit(1);
    if (existing) {
      // OAuth connections create their organization grant before the browser
      // callback has issued any credentials. Reconnects can rotate those
      // credentials later as well. Keep the execution grant synchronized with
      // the connection so the gateway projects the current secrets instead of
      // sending an unauthenticated request after an apparently successful
      // setup. Reconnecting is also the explicit recovery path for a revoked
      // shared identity, so it is correct to reactivate that default grant here.
      const [updated] = await dbClient
        .update(connectionGrants)
        .set({
          credentialSecretRefs: connection.credentialSecretRefs,
          status: "active",
          revokedAt: null,
          revokedByAgentId: null,
          revokedByUserId: null,
          updatedAt: new Date(),
        })
        .where(eq(connectionGrants.id, existing.id))
        .returning();
      if (!updated) throw new Error("Failed to update default connection grant");
      return updated;
    }
    const [created] = await dbClient
      .insert(connectionGrants)
      .values({
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: "organization",
        credentialSecretRefs: connection.credentialSecretRefs,
        status: "active",
        isDefault: true,
      })
      .returning();
    if (!created) throw new Error("Failed to create default connection grant");
    return created;
  }

  async function getProfileRow(profileId: string, companyId?: string) {
    const where = companyId
      ? and(eq(toolProfiles.id, profileId), eq(toolProfiles.companyId, companyId))
      : eq(toolProfiles.id, profileId);
    const [row] = await db.select().from(toolProfiles).where(where);
    if (!row) throw notFound("Tool profile not found");
    return row;
  }

  async function profileDetails(profileId: string, companyId?: string): Promise<ToolProfileWithDetails> {
    const profile = await getProfileRow(profileId, companyId);
    const [entries, bindings, catalog, companyAgents, applications, connections] = await Promise.all([
      db
        .select()
        .from(toolProfileEntries)
        .where(and(eq(toolProfileEntries.companyId, profile.companyId), eq(toolProfileEntries.profileId, profile.id)))
        .orderBy(asc(toolProfileEntries.createdAt)),
      db
        .select()
        .from(toolProfileBindings)
        .where(and(eq(toolProfileBindings.companyId, profile.companyId), eq(toolProfileBindings.profileId, profile.id)))
        .orderBy(asc(toolProfileBindings.priority), asc(toolProfileBindings.createdAt)),
      db
        .select()
        .from(toolCatalogEntries)
        .where(and(eq(toolCatalogEntries.companyId, profile.companyId), eq(toolCatalogEntries.status, "active"))),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, profile.companyId)),
      db
        .select()
        .from(toolApplications)
        .where(eq(toolApplications.companyId, profile.companyId)),
      db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.companyId, profile.companyId)),
    ]);
    return buildProfileDetails({
      profile,
      entries,
      bindings,
      catalog,
      agentIds: companyAgents.map((agent) => agent.id),
      applicationsById: new Map(applications.map((application) => [application.id, application])),
      connectionsById: new Map(connections.map((connection) => [connection.id, connection])),
    });
  }

  async function listProfileNewTools(profileId: string, companyId?: string): Promise<ToolProfileNewToolsReview> {
    const profile = await getProfileRow(profileId, companyId);
    const [entries, catalog, applications, connections] = await Promise.all([
      db
        .select()
        .from(toolProfileEntries)
        .where(and(eq(toolProfileEntries.companyId, profile.companyId), eq(toolProfileEntries.profileId, profile.id)))
        .orderBy(asc(toolProfileEntries.createdAt)),
      db
        .select()
        .from(toolCatalogEntries)
        .where(and(eq(toolCatalogEntries.companyId, profile.companyId), eq(toolCatalogEntries.status, "active")))
        .orderBy(asc(toolCatalogEntries.toolName)),
      db
        .select()
        .from(toolApplications)
        .where(eq(toolApplications.companyId, profile.companyId)),
      db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.companyId, profile.companyId)),
    ]);
    const tools = pendingNewToolsForProfile({
      profile,
      entries,
      catalog,
      applicationsById: new Map(applications.map((application) => [application.id, application])),
      connectionsById: new Map(connections.map((connection) => [connection.id, connection])),
    });
    return {
      profileId: profile.id,
      reviewedAt: profile.newToolsReviewedAt,
      pendingCount: tools.length,
      tools,
    };
  }

  async function reviewProfileNewTools(
    profileId: string,
    input: ReviewToolProfileNewTools,
    actor?: ActorInfo,
  ): Promise<ToolProfileNewToolsReviewResult> {
    const profile = await getProfileRow(profileId);
    const review = await listProfileNewTools(profile.id, profile.companyId);
    if (review.tools.length === 0) throw badRequest("No new tools are pending review for this profile");

    const decisionIds = input.decisions.map((decision) => decision.catalogEntryId);
    if (new Set(decisionIds).size !== decisionIds.length) {
      throw badRequest("New-tools review decisions must not contain duplicate catalogEntryId values");
    }
    const pendingIds = new Set(review.tools.map((tool) => tool.catalogEntryId));
    if (decisionIds.length !== pendingIds.size || decisionIds.some((id) => !pendingIds.has(id))) {
      throw badRequest("New-tools review decisions must cover every currently pending tool exactly once");
    }

    const toolById = new Map(review.tools.map((tool) => [tool.catalogEntryId, tool]));
    const allowTools = input.decisions
      .filter((decision) => decision.decision === "allow")
      .map((decision) => toolById.get(decision.catalogEntryId))
      .filter(Boolean) as ToolProfileNewToolReviewItem[];
    const nowAt = now();
    let createdEntries: ToolProfileEntry[] = [];
    if (allowTools.length > 0) {
      const rows = await db.insert(toolProfileEntries).values(allowTools.map((tool) => ({
        companyId: profile.companyId,
        profileId: profile.id,
        selectorType: "catalog_entry" as const,
        effect: "include" as const,
        applicationId: tool.applicationId,
        connectionId: tool.connectionId,
        catalogEntryId: tool.catalogEntryId,
      }))).returning();
      createdEntries = rows.map(toProfileEntry);
    }

    await db
      .update(toolCatalogEntries)
      .set({
        reviewedAt: nowAt,
        reviewedByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
        reviewedByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
        updatedAt: nowAt,
      })
      .where(and(eq(toolCatalogEntries.companyId, profile.companyId), inArray(toolCatalogEntries.id, decisionIds)));
    await db
      .update(toolProfiles)
      .set({ newToolsReviewedAt: nowAt, updatedAt: nowAt })
      .where(eq(toolProfiles.id, profile.id));

    return {
      profile: await profileDetails(profile.id, profile.companyId),
      reviewedAt: nowAt,
      allowedCount: allowTools.length,
      keptBlockedCount: input.decisions.length - allowTools.length,
      entriesCreated: createdEntries,
      reviewedCatalogEntryIds: decisionIds,
    };
  }

  async function createProfileEntries(companyId: string, profileId: string, entries: CreateToolProfileEntryForProfile[]) {
    for (const entry of entries) {
      await assertProfileEntryInput(companyId, entry);
    }
    if (entries.length === 0) return;
    await db.insert(toolProfileEntries).values(entries.map((entry) => ({
      companyId,
      profileId,
      selectorType: entry.selectorType,
      effect: entry.effect ?? "include",
      applicationId: entry.applicationId ?? null,
      connectionId: entry.connectionId ?? null,
      catalogEntryId: entry.catalogEntryId ?? null,
      toolName: entry.toolName ?? null,
      riskLevel: entry.riskLevel ?? null,
      conditions: entry.conditions ?? null,
    })));
  }

  async function replaceProfileEntries(companyId: string, profileId: string, entries: CreateToolProfileEntryForProfile[]) {
    for (const entry of entries) {
      await assertProfileEntryInput(companyId, entry);
    }
    await db
      .delete(toolProfileEntries)
      .where(and(eq(toolProfileEntries.companyId, companyId), eq(toolProfileEntries.profileId, profileId)));
    await createProfileEntries(companyId, profileId, entries);
  }

  /**
   * @param grantSecretRefs Secret refs held by a grant rather than the connection
   *   row. A personal credential lives only on its user grant (PAP-17835), so it
   *   would otherwise have no `company_secret_bindings` row and drop out of
   *   secret projection and removal teardown.
   */
  async function syncCredentialBindings(
    connection: typeof toolConnections.$inferSelect,
    grantSecretRefs: ToolCredentialSecretRef[] = [],
    dbClient: ToolAccessMutationDb = db,
  ) {
    await dbClient
      .delete(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, connection.companyId),
          eq(companySecretBindings.targetType, "tool_connection"),
          eq(companySecretBindings.targetId, connection.id),
        ),
      );
    const rawBindings = [
      ...connection.credentialRefs.map((ref) => ({
        secretId: ref.secretId,
        configPath: credentialRefConfigPath(ref),
        projectionClass: "unclassified",
        projectionAllowlistKey: null,
        required: true,
        label: null,
      })),
      ...[...connection.credentialSecretRefs, ...grantSecretRefs].map((ref) => ({
        secretId: ref.secretId,
        configPath: ref.configPath,
        projectionClass: ref.projectionClass ?? "unclassified",
        projectionAllowlistKey: ref.projectionAllowlistKey ?? null,
        required: ref.required ?? true,
        label: ref.label ?? null,
      })),
    ];
    // Organization grants can mirror connection-owned credentials, and more
    // than one personal grant can reference the same client registration.
    // Binding rows are unique per secret/config path, so collapse those mirrors
    // before replacing the durable projection declarations.
    const bindings = [...new Map(rawBindings.map((ref) => [
      `${ref.secretId}:${ref.configPath}`,
      ref,
    ])).values()];
    const secretRows = bindings.length > 0
      ? await dbClient.select({
          id: companySecrets.id,
          scope: companySecrets.scope,
          userSecretDefinitionId: companySecrets.userSecretDefinitionId,
        }).from(companySecrets).where(and(
          eq(companySecrets.companyId, connection.companyId),
          inArray(companySecrets.id, [...new Set(bindings.map((ref) => ref.secretId))]),
        ))
      : [];
    const secretById = new Map(secretRows.map((row) => [row.id, row]));
    const definitionIds = [...new Set(secretRows.flatMap((row) => row.userSecretDefinitionId ? [row.userSecretDefinitionId] : []))];
    const definitions = definitionIds.length > 0
      ? await dbClient.select({ id: userSecretDefinitions.id, key: userSecretDefinitions.key })
          .from(userSecretDefinitions)
          .where(and(
            eq(userSecretDefinitions.companyId, connection.companyId),
            inArray(userSecretDefinitions.id, definitionIds),
          ))
      : [];
    const definitionKeyById = new Map(definitions.map((row) => [row.id, row.key]));
    const userDeclarations = [...new Map(bindings.flatMap((ref) => {
      const secret = secretById.get(ref.secretId);
      const definitionKey = secret?.scope === "user" && secret.userSecretDefinitionId
        ? definitionKeyById.get(secret.userSecretDefinitionId)
        : null;
      return definitionKey
        ? [{
            definitionKey,
            configPath: ref.configPath,
            envKey: ref.configPath,
            versionSelector: "latest" as const,
            required: ref.required,
            label: ref.label,
          }]
        : [];
    }).map((ref) => [`${ref.definitionKey}:${ref.configPath}`, ref])).values()];
    await secrets.syncUserSecretDeclarationsForTarget(
      connection.companyId,
      { targetType: "tool_connection", targetId: connection.id },
      userDeclarations,
      { replaceAll: true, db: dbClient },
    );
    const companyBindings = bindings.filter((ref) => secretById.get(ref.secretId)?.scope !== "user");
    if (companyBindings.length === 0) return;
    await dbClient.insert(companySecretBindings).values(companyBindings.map((ref) => ({
      companyId: connection.companyId,
      secretId: ref.secretId,
      targetType: "tool_connection" as const,
      targetId: connection.id,
      configPath: ref.configPath,
      required: ref.required,
      label: ref.label,
      projectionClass: ref.projectionClass,
      projectionAllowlistKey: ref.projectionAllowlistKey,
    })));
  }

  /**
   * Split the secrets a connection points at into the ones it owns outright and
   * the ones another consumer still depends on.
   *
   * Removing an app is a credential revocation boundary (PAP-17119), but it must
   * never destroy a secret the operator manages by hand or shares with another
   * target. Two independent tests have to agree before a secret is destroyed:
   *
   * 1. Provenance — the key sits in the `tool_app.` namespace only the
   *    connect/reconnect/OAuth paths mint, and the row is a company-scoped
   *    Paperclip secret rather than a per-user credential.
   * 2. Exclusivity — nothing outside this connection references it: no
   *    `company_secret_bindings` row from another target, and no other
   *    connection or connection grant naming the same secret id.
   *
   * A secret failing either test is reported as retained; removal still drops
   * this connection's binding and ref, so the connection loses the credential
   * either way. Retaining a secret nobody can reach is a leak of an unused row;
   * deleting one another target still resolves is an outage, so the ambiguous
   * case fails towards retention.
   */
  async function classifyConnectionSecrets(
    connection: typeof toolConnections.$inferSelect,
    secretIds: string[],
  ): Promise<{ owned: string[]; retained: string[] }> {
    const unique = [...new Set(secretIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (unique.length === 0) return { owned: [], retained: [] };

    const secretRows = await db
      .select({
        id: companySecrets.id,
        key: companySecrets.key,
        scope: companySecrets.scope,
        userSecretDefinitionId: companySecrets.userSecretDefinitionId,
      })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, connection.companyId), inArray(companySecrets.id, unique)));
    const byId = new Map(secretRows.map((row) => [row.id, row]));

    const referencedElsewhere = new Set<string>();
    const foreignBindings = await db
      .select({ secretId: companySecretBindings.secretId })
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, connection.companyId),
        inArray(companySecretBindings.secretId, unique),
        sql`not (${companySecretBindings.targetType} = 'tool_connection' and ${companySecretBindings.targetId} = ${connection.id})`,
      ));
    for (const row of foreignBindings) referencedElsewhere.add(row.secretId);

    // Bindings are the authority, but read the sibling refs too: a row written
    // before `syncCredentialBindings` existed — or by hand — can reference a
    // secret with no binding to prove it.
    const siblingConnections = await db
      .select({
        credentialRefs: toolConnections.credentialRefs,
        credentialSecretRefs: toolConnections.credentialSecretRefs,
      })
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, connection.companyId), ne(toolConnections.id, connection.id)));
    for (const row of siblingConnections) {
      for (const ref of row.credentialRefs ?? []) referencedElsewhere.add(ref.secretId);
      for (const ref of row.credentialSecretRefs ?? []) referencedElsewhere.add(ref.secretId);
    }
    const siblingGrants = await db
      .select({ credentialSecretRefs: connectionGrants.credentialSecretRefs })
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, connection.companyId),
        ne(connectionGrants.connectionId, connection.id),
      ));
    for (const row of siblingGrants) {
      for (const ref of row.credentialSecretRefs ?? []) referencedElsewhere.add(ref.secretId);
    }

    const owned: string[] = [];
    const retained: string[] = [];
    for (const secretId of unique) {
      const row = byId.get(secretId);
      // No row means an earlier pass of this same removal already deleted it.
      // Hand it back as owned so a retry re-runs the (idempotent) revocation
      // instead of reporting a credential this connection never shared.
      if (!row) {
        owned.push(secretId);
        continue;
      }
      const dedicated = row.scope === "company"
        && row.userSecretDefinitionId === null
        && row.key.startsWith(CONNECTION_OWNED_SECRET_KEY_PREFIX);
      if (dedicated && !referencedElsewhere.has(secretId)) owned.push(secretId);
      else retained.push(secretId);
    }
    return { owned, retained };
  }

  /**
   * Remove an app: a credential-revoking teardown, not a status flip (PAP-17119).
   *
   * Order is the security property. Every database-side access path closes
   * first — grants, installs, the app-managed profile, gateway tokens minted
   * against it, outstanding OAuth state, the catalog, and the connection itself
   * — so the app is already undispatchable before the first call out to a secret
   * provider. Secret revocation runs last, and each secret's ref survives until
   * that secret is gone, so a provider that errors leaves the operation failed
   * closed and resumable: the credential is already unresolvable (its row is
   * marked deleted first), and retrying the same removal finishes the job.
   *
   * What stays behind is deliberate: the connection and application rows, their
   * ids, names and activity keep working so a later reconnect reuses the same
   * identity — but with no credential, no install and no profile, so
   * reconnecting has to ask for fresh authentication and rebuild access.
   */
  async function removeConnection(
    connectionId: string,
    companyId?: string,
    actor?: ActorInfo,
    removalOptions: { confirmComposioChildren?: boolean } = {},
  ): Promise<ToolConnectionRemovalResult> {
    const connection = await getConnectionRow(connectionId, companyId);
    const now = new Date();
    const binding = actorBinding(actor);

    if (isComposioConnection(connection)) {
      const children = (await existingComposioChildren(connection)).filter((child) => child.status !== "archived");
      if (children.length > 0 && removalOptions.confirmComposioChildren !== true) {
        throw conflict("Deleting this Composio connection also removes its connected services. Confirm child removal to continue.", {
          code: "composio_child_removal_confirmation_required",
          childConnectionCount: children.length,
        });
      }
      for (const child of children) {
        await removeConnection(child.id, child.companyId, actor, { confirmComposioChildren: true });
      }
    }

    // Grants are read before they are revoked: a retried removal must still see
    // the credential refs of a grant an earlier pass already marked revoked.
    const grantRows = await db
      .select({
        id: connectionGrants.id,
        status: connectionGrants.status,
        kind: connectionGrants.kind,
        subjectUserId: connectionGrants.subjectUserId,
        credentialSecretRefs: connectionGrants.credentialSecretRefs,
        externalCredential: connectionGrants.externalCredential,
      })
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
      ));
    const grantsToRevoke = grantRows.filter((row) => row.status !== "revoked");
    if (grantsToRevoke.length > 0) {
      await db
        .update(connectionGrants)
        .set({
          status: "revoked",
          isDefault: false,
          revokedAt: now,
          revokedByAgentId: binding.actorType === "agent" ? binding.actorId : null,
          revokedByUserId: binding.actorType === "user" ? binding.actorId : null,
          updatedAt: now,
        })
        .where(inArray(connectionGrants.id, grantsToRevoke.map((row) => row.id)));
    }
    let externalCredentialCleanup: ToolConnectionRemovalSummary["externalCredentialCleanup"] = null;
    if (connection.credentialSource === "vercel_connect" && connection.externalCredential) {
      let attempted = 0;
      let revoked = 0;
      let failures = 0;
      let appSubjectCleanup: "not_applicable" | "manage_in_vercel" = "not_applicable";
      for (const grant of grantRows) {
        const request = vercelTokenRequest({
          credential: connection.externalCredential,
          grant,
          connectionId: connection.id,
          companyId: connection.companyId,
          resources: vercelConnectResourcesFor(connection),
        });
        vercelConnect?.evict(request);
        if (grant.externalCredential?.subjectType === "app") {
          appSubjectCleanup = "manage_in_vercel";
          continue;
        }
        if (grant.externalCredential?.subjectType !== "user") continue;
        attempted += 1;
        try {
          if (!vercelConnect) throw new Error("Vercel Connect unavailable");
          await vercelConnect.revoke(request);
          revoked += 1;
        } catch {
          failures += 1;
        }
      }
      externalCredentialCleanup = {
        provider: "vercel_connect",
        userSubjectsAttempted: attempted,
        userSubjectsRevoked: revoked,
        userSubjectFailures: failures,
        appSubjectCleanup,
        manageUrl: vercelConnectIntegrationStatus().manageUrl,
      };
    }

    // Bindings are how a credential reaches a runtime, so they go before the
    // provider round-trip rather than after it. They are also not needed to
    // finish the job: the refs on the connection row are what a resumed removal
    // reads to find the secrets it still owes a revocation.
    const removedSecretBindings = await db
      .delete(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, connection.companyId),
        eq(companySecretBindings.targetType, "tool_connection"),
        eq(companySecretBindings.targetId, connection.id),
      ))
      .returning({ id: companySecretBindings.id });

    const removedInstalls = await db
      .delete(toolConnectionInstalls)
      .where(and(
        eq(toolConnectionInstalls.companyId, connection.companyId),
        eq(toolConnectionInstalls.connectionId, connection.id),
      ))
      .returning({ id: toolConnectionInstalls.id });

    // The app-managed profile exists only to carry this connection's action
    // selection, so it goes with the connection. Operator-authored profiles that
    // happen to mention the connection are left alone — the archived connection
    // is denied by the policy engine regardless.
    const [appProfile] = await db
      .select({ id: toolProfiles.id })
      .from(toolProfiles)
      .where(and(
        eq(toolProfiles.companyId, connection.companyId),
        eq(toolProfiles.profileKey, `app:${connection.id}`),
      ))
      .limit(1);
    let appProfileOutcome: ToolConnectionRemovalSummary["appProfile"] = "absent";
    let appProfileEntriesRemoved = 0;
    let appProfileBindingsRemoved = 0;
    let gatewayTokensRevoked = 0;
    let gatewaySessionsRevoked = 0;
    if (appProfile) {
      appProfileEntriesRemoved = (await db
        .delete(toolProfileEntries)
        .where(and(
          eq(toolProfileEntries.companyId, connection.companyId),
          eq(toolProfileEntries.profileId, appProfile.id),
        ))
        .returning({ id: toolProfileEntries.id })).length;
      appProfileBindingsRemoved = (await db
        .delete(toolProfileBindings)
        .where(and(
          eq(toolProfileBindings.companyId, connection.companyId),
          eq(toolProfileBindings.profileId, appProfile.id),
        ))
        .returning({ id: toolProfileBindings.id })).length;

      const gatewayRows = await db
        .select({ id: toolMcpGateways.id })
        .from(toolMcpGateways)
        .where(and(
          eq(toolMcpGateways.companyId, connection.companyId),
          eq(toolMcpGateways.profileId, appProfile.id),
        ));
      if (gatewayRows.length === 0) {
        await db.delete(toolProfiles).where(eq(toolProfiles.id, appProfile.id));
        appProfileOutcome = "deleted";
      } else {
        // `tool_mcp_gateways.profile_id` is ON DELETE RESTRICT, so a gateway
        // pointing here keeps the row alive. Archive it instead — the policy
        // engine only consults `active` profiles, and it has no entries left —
        // and revoke the tokens those gateways already handed out, which are the
        // one credential a caller could still present.
        await db
          .update(toolProfiles)
          .set({ status: "archived", defaultAction: "deny", updatedAt: now })
          .where(eq(toolProfiles.id, appProfile.id));
        appProfileOutcome = "archived";
        const revokedTokens = await db
          .update(toolMcpGatewayTokens)
          .set({ revokedAt: now, updatedAt: now })
          .where(and(
            eq(toolMcpGatewayTokens.companyId, connection.companyId),
            inArray(toolMcpGatewayTokens.gatewayId, gatewayRows.map((row) => row.id)),
            isNull(toolMcpGatewayTokens.revokedAt),
          ))
          .returning({ id: toolMcpGatewayTokens.id });
        gatewayTokensRevoked = revokedTokens.length;
        if (revokedTokens.length > 0) {
          gatewaySessionsRevoked = (await db
            .update(toolGatewaySessions)
            .set({ revokedAt: now, updatedAt: now })
            .where(and(
              eq(toolGatewaySessions.companyId, connection.companyId),
              inArray(toolGatewaySessions.gatewayTokenId, revokedTokens.map((row) => row.id)),
              isNull(toolGatewaySessions.revokedAt),
            ))
            .returning({ id: toolGatewaySessions.id })).length;
        }
      }
    }

    // A local runtime already holds the injected credential inside a live child
    // process, so archiving rows is not enough — the process itself is an access
    // path. Stopping is best effort on purpose: if the supervisor cannot be
    // reached, revoking the credential anyway (so nothing can start again) beats
    // abandoning the teardown, and the warning says which slot was left running.
    let runtimeSlotsStopped = 0;
    const runtimeSlotRows = await db
      .select({ id: toolRuntimeSlots.id, status: toolRuntimeSlots.status })
      .from(toolRuntimeSlots)
      .where(and(
        eq(toolRuntimeSlots.companyId, connection.companyId),
        eq(toolRuntimeSlots.connectionId, connection.id),
      ));
    for (const slot of runtimeSlotRows) {
      if (slot.status === "stopped") continue;
      try {
        await runtimeSupervisor.stopSlot({
          companyId: connection.companyId,
          slotId: slot.id,
          reason: "connection_removed",
        });
        runtimeSlotsStopped += 1;
      } catch (error) {
        logger.warn(
          { err: error, companyId: connection.companyId, connectionId: connection.id, slotId: slot.id },
          "tool connection removal could not stop a runtime slot",
        );
      }
    }

    // The catalog stays as history, but `removed` is the status that stops a
    // standing trust rule from auto-allowing one of these actions again.
    const removedCatalogEntries = await db
      .update(toolCatalogEntries)
      .set({ status: "removed", updatedAt: now })
      .where(and(
        eq(toolCatalogEntries.companyId, connection.companyId),
        eq(toolCatalogEntries.connectionId, connection.id),
        ne(toolCatalogEntries.status, "removed"),
      ))
      .returning({ id: toolCatalogEntries.id });

    // An authorization already in flight would otherwise come back and mint a
    // fresh token for an app the operator just removed.
    const discardedOAuthStates = await db
      .delete(toolOauthStates)
      .where(and(
        eq(toolOauthStates.companyId, connection.companyId),
        eq(toolOauthStates.connectionId, connection.id),
      ))
      .returning({ state: toolOauthStates.state });

    // Token-derived material in the issuance ledger is not an access path —
    // nothing validates against it — but there is no reason to keep a hash of a
    // credential the operator asked us to revoke. Path, outcome, actor and time
    // stay, so the usage history survives.
    const clearedIssuanceHashes = await db
      .update(connectionTokenIssuances)
      .set({ tokenHash: null })
      .where(and(
        eq(connectionTokenIssuances.companyId, connection.companyId),
        eq(connectionTokenIssuances.connectionId, connection.id),
        sql`${connectionTokenIssuances.tokenHash} is not null`,
      ))
      .returning({ id: connectionTokenIssuances.id });

    const archived = await db.transaction(async (tx) => {
      const [updatedConnection] = await tx
        .update(toolConnections)
        .set({ status: "archived", enabled: false, updatedAt: now })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      if (!updatedConnection) throw notFound("Tool connection not found");

      const remainingConnections = await tx
        .select({ id: toolConnections.id })
        .from(toolConnections)
        .where(and(
          eq(toolConnections.applicationId, updatedConnection.applicationId),
          ne(toolConnections.status, "archived"),
        ))
        .limit(1);

      let applicationArchived = false;
      if (remainingConnections.length === 0) {
        const [application] = await tx
          .update(toolApplications)
          .set({ status: "archived", archivedAt: now, updatedAt: now })
          .where(and(
            eq(toolApplications.id, updatedConnection.applicationId),
            ne(toolApplications.status, "archived"),
          ))
          .returning({ id: toolApplications.id });
        applicationArchived = Boolean(application);
      }

      return { connection: updatedConnection, applicationArchived };
    });

    // Only now, with every access path closed, revoke the credentials. Each
    // `secrets.remove` marks the row deleted before it calls the provider, so a
    // provider error leaves an unresolvable secret and a resumable removal
    // rather than a half-open app.
    const candidateSecretIds = [
      ...connection.credentialRefs.map((ref) => ref.secretId),
      ...connection.credentialSecretRefs.map((ref) => ref.secretId),
      ...grantRows.flatMap((grant) => (grant.credentialSecretRefs ?? []).map((ref) => ref.secretId)),
    ];
    const { owned, retained } = await classifyConnectionSecrets(connection, candidateSecretIds);
    let secretsRevoked = 0;
    for (const secretId of owned) {
      const removed = await secrets.remove(secretId);
      if (removed) secretsRevoked += 1;
    }

    const credentialRefsCleared = connection.credentialRefs.length + connection.credentialSecretRefs.length;
    const [cleared] = await db
      .update(toolConnections)
      .set({
        credentialRefs: [],
        credentialSecretRefs: [],
        config: withoutInlineOAuthTokens(connection.config),
        transportConfig: withoutInlineOAuthTokens(connection.transportConfig),
        updatedAt: now,
      })
      .where(eq(toolConnections.id, connection.id))
      .returning();
    if (grantRows.some((grant) => (grant.credentialSecretRefs ?? []).length > 0)) {
      await db
        .update(connectionGrants)
        .set({ credentialSecretRefs: [], updatedAt: now })
        .where(and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
        ));
    }

    return {
      connection: toConnection(cleared ?? archived.connection),
      removal: {
        secretsRevoked,
        secretsRetainedShared: retained.length,
        credentialRefsCleared,
        secretBindingsRemoved: removedSecretBindings.length,
        grantsRevoked: grantsToRevoke.length,
        installsRemoved: removedInstalls.length,
        appProfile: appProfileOutcome,
        appProfileEntriesRemoved,
        appProfileBindingsRemoved,
        catalogEntriesMarkedRemoved: removedCatalogEntries.length,
        oauthStatesDiscarded: discardedOAuthStates.length,
        tokenIssuanceHashesCleared: clearedIssuanceHashes.length,
        runtimeSlotsStopped,
        gatewayTokensRevoked,
        gatewaySessionsRevoked,
        applicationArchived: archived.applicationArchived,
        externalCredentialCleanup,
      },
    };
  }

  async function ensureRuntimeSlot(connection: typeof toolConnections.$inferSelect): Promise<ToolRuntimeSlot | null> {
    if (connection.transport !== "local_stdio") return null;
    const slotKey = `mcp:${connection.companyId}:${connection.id}`;
    const [existing] = await db
      .select()
      .from(toolRuntimeSlots)
      .where(and(eq(toolRuntimeSlots.companyId, connection.companyId), eq(toolRuntimeSlots.slotKey, slotKey)));
    if (existing) return toRuntimeSlot(existing);
    const [created] = await db.insert(toolRuntimeSlots).values({
      companyId: connection.companyId,
      applicationId: connection.applicationId,
      connectionId: connection.id,
      slotKey,
      ownerScopeType: "connection",
      ownerScopeId: connection.id,
      runtimeKind: "local_stdio",
      status: "stopped",
      provider: "paperclip",
      providerRef: `template:${String(connection.config.templateId)}`,
      commandTemplateKey: String(connection.config.templateId),
      healthStatus: "unchecked",
      metadata: { templateId: connection.config.templateId },
    }).returning();
    return toRuntimeSlot(created);
  }

  async function vaultGrantForConnection(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
  ): Promise<typeof connectionGrants.$inferSelect | null> {
    const actorUserId = actor?.actorType === "user" ? actor.actorId ?? null : null;
    if (actorUserId) {
      const [personal] = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "user"),
        eq(connectionGrants.subjectUserId, actorUserId),
      )).limit(1);
      if (personal) {
        if (personal.status !== "active") {
          throw unprocessable("OAuth authorization must be reconnected", {
            code: "oauth_reauthorization_required",
            setupUrl: connectionSetupUrl(connection),
            reconnectUrl: connectionReconnectUrl(connection),
          });
        }
        return personal;
      }
    }
    if (!actorUserId && connection.credentialPolicy === "per_user") {
      // A personal-only connection is intentionally fixed to one identity.
      // Background health/catalog checks have no acting user, but may safely
      // exercise that sole owner-bound grant without turning it into a shared
      // credential or making it available to a different caller.
      const personalGrants = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "user"),
        eq(connectionGrants.status, "active"),
      )).limit(2);
      if (personalGrants.length === 1) return personalGrants[0]!;
    }
    const [organization] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, connection.companyId),
      eq(connectionGrants.connectionId, connection.id),
      eq(connectionGrants.kind, "organization"),
      eq(connectionGrants.isDefault, true),
    )).limit(1);
    if (organization?.status === "active") return organization;
    if (connection.credentialPolicy === "per_user") {
      throw unprocessable("This connection needs the current user's authorization", {
        code: "user_authorization_required",
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
      });
    }
    return null;
  }

  async function resolveCredentialHeaders(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
    options: { forceRefresh?: boolean } = {},
  ): Promise<Record<string, string>> {
    if (connection.credentialSource === "vercel_connect") {
      const grant = await vercelGrantForConnection(connection, actor);
      return resolveVercelCredentialHeaders(connection, grant, options);
    }
    let grant: typeof connectionGrants.$inferSelect | null = null;
    try {
      if (connection.authKind === "oauth" || connection.credentialPolicy !== "shared") {
        grant = await vaultGrantForConnection(connection, actor);
      }
      if (connection.authKind === "oauth" && grant) {
        grant = await refreshOAuthGrantCredentials({
          companyId: connection.companyId,
          connectionId: connection.id,
          grantId: grant.id,
          forceRefresh: options.forceRefresh,
          actor,
        });
      } else {
        connection = await maybeRefreshOAuthCredentials(connection, actor);
      }
    } catch (error) {
      const scope = credentialScope(connection);
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.credential_resolution",
        outcome: "failure",
        reasonCode: error instanceof HttpError ? String(asRecord(error.details).code ?? "oauth_refresh_failed") : "oauth_refresh_failed",
        details: {
          credentialCount: connection.credentialRefs.length,
          credentialSecretRefCount: connection.credentialSecretRefs.length,
          credentialScopeType: scope.type,
          credentialScopeHash: scope.hash,
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
        },
      });
      throw error;
    }
    const headers: Record<string, string> = {};
    const scope = credentialScope(connection);
    for (const ref of connection.credentialRefs) {
      let value: string;
      const configPath = credentialRefConfigPath(ref);
      try {
        const grantRef = grant?.credentialSecretRefs.find((candidate) => candidate.configPath === configPath);
        value = grantRef && grant
          ? (await resolveOAuthGrantSecret(connection, grant, grantRef, actor, undefined)).value
          : await secrets.resolveSecretValue(connection.companyId, ref.secretId, ref.version ?? "latest", {
              consumerType: "tool_connection",
              consumerId: connection.id,
              configPath,
              actorType: "system",
            });
      } catch (error) {
        await audit({
          companyId: connection.companyId,
          connectionId: connection.id,
          action: "tool_connection.credential_resolution",
          outcome: "failure",
          reasonCode: error instanceof HttpError ? String(asRecord(error.details).code ?? "secret_resolution_failed") : "secret_resolution_failed",
          details: {
            credentialCount: connection.credentialRefs.length,
            credentialScopeType: scope.type,
            credentialScopeHash: scope.hash,
          },
        });
        throw error;
      }
      if (ref.placement === "header") {
        headers[ref.key] = `${ref.prefix ?? ""}${value}`;
      }
    }
    const oauthAccessRef = grant?.credentialSecretRefs.find((ref) => ref.configPath === "oauth.access_token");
    if (oauthAccessRef && headers.Authorization === undefined) {
      headers.Authorization = `Bearer ${(await resolveOAuthGrantSecret(
        connection,
        grant!,
        oauthAccessRef,
        actor,
        undefined,
      )).value}`;
    }
    if (connection.credentialRefs.length > 0 || connection.credentialSecretRefs.length > 0 || Object.keys(oauthConfig(connection)).length > 0) {
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.credential_resolution",
        outcome: "success",
        details: {
          credentialCount: connection.credentialRefs.length,
          credentialSecretRefCount: connection.credentialSecretRefs.length,
          credentialScopeType: scope.type,
          credentialScopeHash: scope.hash,
        },
      });
    }
    return headers;
  }

  async function remoteTools(
    connection: typeof toolConnections.$inferSelect,
    credentialHeaders?: Record<string, string>,
    actor?: ActorInfo,
  ): Promise<McpToolDescriptor[]> {
    const composioChild = composioChildConfig(connection);
    const composioSession = composioChild ? await composioSessions.ensureSession(connection.id) : null;
    let headers = composioSession?.headers
      ?? credentialHeaders
      ?? { ...projectedConnectionHeaders(connection), ...await resolveCredentialHeaders(connection, actor) };
    const endpoint = composioSession?.url ?? await resolvedRemoteEndpoint(connection, actor);
    // Pinned to the address the guard approved: `config.url` is operator-supplied,
    // so a second DNS resolution here would reopen the rebinding window that
    // PAP-17098 closed for the OAuth endpoints.
    const listRequestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "paperclip-catalog-refresh",
      method: "tools/list",
      params: {},
    });
    const sendRemote = (init: RequestInit) => requestRemoteHttpEndpoint(new URL(endpoint), init);
    const sendToolsList = (requestHeaders: Record<string, string>) => sendRemote({
      method: "POST",
      // MCP Streamable HTTP requires advertising that we accept both a JSON body
      // and an SSE stream; spec-compliant servers 406 without it (see mcp-http.ts).
      headers: mcpHttpRequestHeaders(requestHeaders),
      body: listRequestBody,
    });
    let usedInitializedSession = connection.config.mcpSessionRequired === true;
    let response: Response;
    if (usedInitializedSession) {
      const sessionHeaders = await initializeMcpHttpSession({
        send: sendRemote,
        headers,
        requestId: "paperclip-catalog-refresh",
      });
      response = await sendToolsList(sessionHeaders);
    } else {
      response = await sendToolsList(headers);
      // `tools/list` is read-only, so a 400 can safely be retried after the MCP
      // initialize handshake. Stateful servers such as Supabase require the
      // returned Mcp-Session-Id on every non-initialization request.
      if (response.status === 400) {
        try {
          const sessionHeaders = await initializeMcpHttpSession({
            send: sendRemote,
            headers,
            requestId: "paperclip-catalog-refresh",
          });
          response = await sendToolsList(sessionHeaders);
          usedInitializedSession = response.ok;
        } catch {
          // Preserve the original HTTP failure below when this was not an MCP
          // session requirement after all.
        }
      }
    }
    if (usedInitializedSession && connection.config.mcpSessionRequired !== true) {
      const nextConfig = { ...connection.config, mcpSessionRequired: true };
      await db.update(toolConnections).set({
        config: nextConfig,
        transportConfig: nextConfig,
        updatedAt: now(),
      }).where(and(
        eq(toolConnections.id, connection.id),
        eq(toolConnections.companyId, connection.companyId),
      ));
    }
    if (response.status === 401 && composioChild) {
      const refreshed = await composioSessions.ensureSession(connection.id, { force: true });
      response = await requestRemoteHttpEndpoint(new URL(refreshed.url), {
        method: "POST",
        headers: mcpHttpRequestHeaders(refreshed.headers),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "paperclip-catalog-refresh-retry",
          method: "tools/list",
          params: {},
        }),
      });
    }
    if (response.status === 401 && connection.credentialSource === "vercel_connect") {
      const grant = await vercelGrantForConnection(connection, actor);
      const credential = vercelCredentialFor(connection);
      const request = vercelTokenRequest({
        credential,
        grant,
        connectionId: connection.id,
        companyId: connection.companyId,
        resources: vercelConnectResourcesFor(connection),
      });
      vercelConnect?.evict(request);
      headers = {
        ...projectedConnectionHeaders(connection),
        ...await resolveVercelCredentialHeaders(connection, grant, { forceRefresh: true }),
      };
      response = await sendToolsList(headers);
    }
    if (
      response.status === 401
      && connection.authKind === "oauth"
      && connection.credentialSource === "paperclip_vault"
      && !isPaperclipCloudConnectorStrategy(oauthConfig(connection).strategy)
    ) {
      headers = {
        ...projectedConnectionHeaders(connection),
        ...await resolveCredentialHeaders(connection, actor, { forceRefresh: true }),
      };
      response = await sendToolsList(headers);
    }
    if (!response.ok) {
      const authenticate = response.headers.get("www-authenticate") ?? "";
      if (response.status === 401 && /bearer|oauth|authorization/i.test(authenticate)) {
        const endpoints = await discoverOAuthEndpoints(connection, authenticate);
        if (endpoints) {
          const nextConfig = {
            ...connection.config,
            oauth: {
              ...oauthConfig(connection),
              provider: endpoints.provider,
              authorizationUrl: endpoints.authorizationUrl,
              tokenUrl: endpoints.tokenUrl,
              registrationUrl: endpoints.registrationUrl ?? null,
              metadataUrl: endpoints.metadataUrl ?? null,
              scopes: endpoints.scopes,
              codeChallengeMethodsSupported: endpoints.codeChallengeMethodsSupported ?? [],
              tokenEndpointAuthMethodsSupported: endpoints.tokenEndpointAuthMethodsSupported ?? [],
              grantType: endpoints.grantType ?? "authorization_code",
              issuer: endpoints.issuer ?? null,
              resource: endpoints.resource ?? null,
              clientIdMetadataDocumentSupported: endpoints.clientIdMetadataDocumentSupported === true,
              discoveredAt: new Date().toISOString(),
            },
          };
          await db
            .update(toolConnections)
            .set({
              // Record the discovered auth kind now, so a URL-only connection that
              // is waiting on sign-in reads as OAuth everywhere rather than
              // falling back to `authKind: none` semantics.
              authKind: "oauth",
              config: nextConfig,
              transportConfig: nextConfig,
              updatedAt: new Date(),
            })
            .where(eq(toolConnections.id, connection.id));
        }
        throw new HttpError(502, "This app needs you to sign in.", {
          code: "oauth_challenge",
          status: response.status,
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
          oauthSupported: Boolean(endpoints),
        });
      }
      throw new HttpError(502, `Remote app returned HTTP ${response.status}`, { status: response.status });
    }
    const payload = parseMcpHttpResponseBody(await response.text(), response.headers.get("content-type"));
    const result = asRecord(asRecord(payload).result);
    const payloadTools = asRecord(payload).tools;
    const tools: unknown[] = Array.isArray(result.tools) ? result.tools : Array.isArray(payloadTools) ? payloadTools : [];
    return tools.map((tool) => normalizeToolDescriptor(tool)).filter((tool): tool is McpToolDescriptor => Boolean(tool));
  }

  async function localTools(connection: typeof toolConnections.$inferSelect): Promise<McpToolDescriptor[]> {
    const template = await resolveStdioTemplate(connection.companyId, connection.config);
    return template.tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: tool.annotations ?? {},
    }));
  }

  function isComposioConnection(connection: typeof toolConnections.$inferSelect): boolean {
    return asRecord(connection.config).sourceTemplateKey === COMPOSIO_GALLERY_KEY;
  }

  async function composioClientForParent(parent: typeof toolConnections.$inferSelect) {
    if (!isComposioConnection(parent) || parent.transport !== "rest_api") {
      throw unprocessable("This connection is not a parent Composio connection.", { code: "not_composio_parent" });
    }
    const headers = await resolveCredentialHeaders(parent);
    const apiKey = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-api-key")?.[1];
    if (!apiKey) throw unprocessable("The Composio API key secret is missing.", { code: "secret_missing" });
    return options.composioClientFactory?.(apiKey) ?? createComposioClient({ apiKey });
  }

  async function existingComposioChildren(parent: typeof toolConnections.$inferSelect) {
    const rows = await db.select().from(toolConnections).where(and(
      eq(toolConnections.companyId, parent.companyId),
      eq(toolConnections.applicationId, parent.applicationId),
    ));
    return rows.filter((row) => composioChildConfig(row)?.parentConnectionId === parent.id);
  }

  async function assertComposioConnectedAccountActive(child: typeof toolConnections.$inferSelect) {
    const childConfig = composioChildConfig(child);
    if (!childConfig) return;
    const parent = await getConnectionRow(childConfig.parentConnectionId, child.companyId);
    const client = await composioClientForParent(parent);
    const accounts = await client.listConnectedAccounts({
      toolkitSlugs: [childConfig.toolkitSlug],
      userIds: [`paperclip:${child.companyId}`],
      limit: 100,
    });
    const account = childConfig.connectedAccountId
      ? accounts.items.find((candidate) => candidate.id === childConfig.connectedAccountId)
      : accounts.items.find((candidate) => candidate.toolkit.slug === childConfig.toolkitSlug);
    if (account?.status.toUpperCase() === "ACTIVE") return;
    const status = account?.status.trim().toUpperCase() || "MISSING";
    throw unprocessable(
      `Composio reports the ${childConfig.toolkitSlug} connected account as ${status}. Reconnect it in Composio.`,
      { code: "composio_connected_account_inactive", connectedAccountStatus: status },
    );
  }

  async function disableComposioChildren(parent: typeof toolConnections.$inferSelect) {
    const children = await existingComposioChildren(parent);
    for (const child of children) {
      if (child.status === "archived") continue;
      const config = asRecord(child.config);
      await db.update(toolConnections).set({
        enabled: false,
        config: child.enabled ? { ...config, disabledByComposioParent: true } : config,
        updatedAt: now(),
      }).where(eq(toolConnections.id, child.id));
    }
  }

  async function restoreComposioChildren(parent: typeof toolConnections.$inferSelect) {
    const children = await existingComposioChildren(parent);
    const restorable = children.filter((child) =>
      child.status !== "archived" && asRecord(child.config).disabledByComposioParent === true,
    );
    if (restorable.length === 0) return;

    let accounts: Awaited<ReturnType<ComposioClient["listConnectedAccounts"]>>["items"] = [];
    try {
      const client = await composioClientForParent(parent);
      accounts = (await client.listConnectedAccounts({
        userIds: [`paperclip:${parent.companyId}`],
        limit: 1000,
      })).items;
    } catch {
      // Fail closed while Composio is unavailable. A later resume or reconnect
      // can retry without exposing a child whose account state is unknown.
      return;
    }

    for (const child of restorable) {
      const childConfig = composioChildConfig(child)!;
      const account = childConfig.connectedAccountId
        ? accounts.find((candidate) => candidate.id === childConfig.connectedAccountId)
        : accounts.find((candidate) => candidate.toolkit.slug === childConfig.toolkitSlug);
      const config = { ...asRecord(child.config) };
      delete config.disabledByComposioParent;
      const active = account?.status.toUpperCase() === "ACTIVE";
      await db.update(toolConnections).set({
        enabled: active,
        config: active ? config : { ...config, disabledByComposioParent: true },
        healthStatus: active ? "unchecked" : "degraded",
        healthMessage: active
          ? null
          : `Composio reports the ${childConfig.toolkitSlug} connected account as ${account?.status.toUpperCase() ?? "MISSING"}. Reconnect it in Composio.`,
        updatedAt: now(),
      }).where(eq(toolConnections.id, child.id));
    }
  }

  async function syncComposioChild(
    parent: typeof toolConnections.$inferSelect,
    account: { id: string; status: string; toolkit: { slug: string } },
    toolkitName: string,
    actor?: ActorInfo,
  ) {
    if (account.status.toUpperCase() !== "ACTIVE") return null;
    const children = await existingComposioChildren(parent);
    const existing = children.find((candidate) => {
      const config = composioChildConfig(candidate);
      return config?.toolkitSlug === account.toolkit.slug && candidate.status !== "archived";
    });
    if (existing) {
      const config = composioChildConfig(existing)!;
      if (config.connectedAccountId !== account.id) {
        const nextConfig = { ...existing.config, connectedAccountId: account.id };
        const [updated] = await db.update(toolConnections).set({
          config: nextConfig,
          transportConfig: { ...existing.transportConfig, connectedAccountId: account.id, composioSessions: {} },
          updatedAt: now(),
        }).where(eq(toolConnections.id, existing.id)).returning();
        return updated;
      }
      return existing;
    }
    const connectionId = randomUUID();
    const binding = actorBinding(actor);
    const config = {
      provider: "composio",
      parentConnectionId: parent.id,
      toolkitSlug: account.toolkit.slug,
      connectedAccountId: account.id,
    };
    const [created] = await db.insert(toolConnections).values({
      id: connectionId,
      companyId: parent.companyId,
      applicationId: parent.applicationId,
      name: `${toolkitName} (via Composio)`,
      uid: connectionUid(`composio:${parent.id}`, account.toolkit.slug, connectionId),
      connectionKind: "managed",
      ownership: parent.ownership,
      transport: "mcp_remote",
      authKind: "none",
      credentialPolicy: "shared",
      status: "active",
      enabled: true,
      config,
      transportConfig: { ...config, composioSessions: {} },
      credentialRefs: [],
      credentialSecretRefs: [],
      createdByAgentId: binding.actorType === "agent" ? binding.actorId : null,
      createdByUserId: binding.actorType === "user" ? binding.actorId : null,
    }).returning();
    if (!created) throw new Error("Failed to create Composio toolkit connection");
    await ensureDefaultOrganizationGrant(created);
    await syncCredentialBindings(created);
    await ensureRuntimeSlot(created);
    await audit({
      companyId: created.companyId,
      connectionId: created.id,
      action: "composio.child_created",
      outcome: "success",
      actor,
      details: { parentConnectionId: parent.id, toolkitSlug: account.toolkit.slug },
    });
    return created;
  }

  async function syncComposioToolkit(
    parent: typeof toolConnections.$inferSelect,
    toolkitSlug: string,
    actor?: ActorInfo,
  ) {
    const client = await composioClientForParent(parent);
    const userId = `paperclip:${parent.companyId}`;
    const [toolkits, accounts] = await Promise.all([
      client.listToolkits({ limit: 1000 }),
      client.listConnectedAccounts({ toolkitSlugs: [toolkitSlug], userIds: [userId], limit: 100 }),
    ]);
    const toolkit = toolkits.items.find((item) => item.slug === toolkitSlug);
    if (!toolkit) throw notFound("Composio toolkit not found");
    const account = accounts.items.find((item) => item.toolkit.slug === toolkitSlug && item.status.toUpperCase() === "ACTIVE")
      ?? accounts.items.find((item) => item.toolkit.slug === toolkitSlug)
      ?? null;
    const child = account ? await syncComposioChild(parent, account, toolkit.name, actor) : null;
    if (child) await refreshCatalog(child.id, actor, { enableAllByDefault: true });
    return { toolkit, account, child: child ? toConnection(await getConnectionRow(child.id)) : null };
  }

  async function validateComposioConnection(connection: typeof toolConnections.$inferSelect) {
    const client = await composioClientForParent(connection);
    await client.validateApiKey();
  }

  async function listComposioServices(parentConnectionId: string, actor?: ActorInfo) {
    const parent = await getConnectionRow(parentConnectionId);
    const client = await composioClientForParent(parent);
    const userId = `paperclip:${parent.companyId}`;
    const [toolkits, accounts] = await Promise.all([
      client.listToolkits({ limit: 1000 }),
      client.listConnectedAccounts({ userIds: [userId], limit: 1000 }),
    ]);
    const children = await existingComposioChildren(parent);
    const childByToolkit = new Map(children.filter((child) => child.status !== "archived").map((child) => [
      composioChildConfig(child)?.toolkitSlug,
      child,
    ]));
    const services = [];
    for (const toolkit of toolkits.items) {
      const toolkitAccounts = accounts.items.filter((account) => account.toolkit.slug === toolkit.slug);
      const account = toolkitAccounts.find((candidate) => candidate.status.toUpperCase() === "ACTIVE")
        ?? toolkitAccounts[0]
        ?? null;
      let child = childByToolkit.get(toolkit.slug) ?? null;
      if (account?.status.toUpperCase() === "ACTIVE" && !child) {
        child = await syncComposioChild(parent, account, toolkit.name, actor);
        if (child) await refreshCatalog(child.id, actor, { enableAllByDefault: true });
      }
      services.push({
        toolkit,
        status: account?.status.toUpperCase() === "ACTIVE"
          ? "connected"
          : account ? "pending" : "not_connected",
        connectedAccountId: account?.id ?? null,
        connectedAccountStatus: account?.status ?? null,
        childConnectionId: child?.id ?? null,
      });
    }
    return { parentConnectionId: parent.id, userId, services };
  }

  async function startComposioServiceConnect(
    parentConnectionId: string,
    toolkitSlug: string,
    input: { authConfigId?: string; callbackUrl?: string },
  ) {
    const parent = await getConnectionRow(parentConnectionId);
    const client = await composioClientForParent(parent);
    let authConfigId = input.authConfigId?.trim();
    if (!authConfigId) {
      const configs = await client.listAuthConfigs({ toolkitSlugs: [toolkitSlug], showDisabled: false, limit: 100 });
      authConfigId = configs.items.find((config) => config.toolkit.slug === toolkitSlug && config.status !== "DISABLED")?.id;
    }
    if (!authConfigId) throw unprocessable("This Composio toolkit has no enabled auth configuration.", { code: "composio_auth_config_missing" });
    const link = await client.createConnectLink({
      authConfigId,
      userId: `paperclip:${parent.companyId}`,
      alias: `paperclip-${parent.companyId}-${toolkitSlug}`,
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    });
    return { toolkitSlug, authConfigId, ...link };
  }

  async function disconnectComposioService(parentConnectionId: string, toolkitSlug: string, actor?: ActorInfo) {
    const parent = await getConnectionRow(parentConnectionId);
    const client = await composioClientForParent(parent);
    const accounts = await client.listConnectedAccounts({
      toolkitSlugs: [toolkitSlug],
      userIds: [`paperclip:${parent.companyId}`],
      limit: 100,
    });
    for (const account of accounts.items.filter((candidate) => candidate.toolkit.slug === toolkitSlug)) {
      await client.deleteConnectedAccount(account.id);
    }
    const children = await existingComposioChildren(parent);
    const removedChildIds: string[] = [];
    for (const child of children) {
      if (composioChildConfig(child)?.toolkitSlug !== toolkitSlug || child.status === "archived") continue;
      await removeConnection(child.id, child.companyId, actor);
      removedChildIds.push(child.id);
    }
    await audit({
      companyId: parent.companyId,
      connectionId: parent.id,
      action: "composio.service_disconnected",
      outcome: "success",
      actor,
      details: { toolkitSlug, connectedAccountCount: accounts.items.length, removedChildCount: removedChildIds.length },
    });
    return { toolkitSlug, disconnectedAccountIds: accounts.items.map((account) => account.id), removedChildIds };
  }

  async function discoverTools(
    connection: typeof toolConnections.$inferSelect,
    credentialHeaders?: Record<string, string>,
    actor?: ActorInfo,
  ): Promise<McpToolDescriptor[]> {
    if (connection.transport === "mcp_remote") return remoteTools(connection, credentialHeaders, actor);
    if (isComposioConnection(connection)) {
      await validateComposioConnection(connection);
      return [];
    }
    await resolveCredentialHeaders(connection);
    return localTools(connection);
  }

  async function updateConnectionHealth(
    connection: typeof toolConnections.$inferSelect,
    status: ToolConnectionHealthStatus,
    message: string | null,
  ) {
    const now = new Date();
    const [updated] = await db
      .update(toolConnections)
      .set({
        healthStatus: status,
        healthMessage: message,
        healthCheckedAt: now,
        lastHealthAt: now,
        lastError: status === "ok" ? null : message,
        updatedAt: now,
      })
      .where(eq(toolConnections.id, connection.id))
      .returning();
    if (connection.transport === "local_stdio") {
      await db
        .update(toolRuntimeSlots)
        .set({ healthStatus: status, healthMessage: message, lastHealthCheckAt: now, updatedAt: now })
        .where(eq(toolRuntimeSlots.connectionId, connection.id));
    }
    return updated;
  }

  async function checkConnectionHealth(connectionId: string, actor?: ActorInfo): Promise<ToolConnectionHealthCheckResult> {
    const connection = await getConnectionRow(connectionId);
    try {
      if (connection.transport === "mcp_remote") {
        await assertComposioConnectedAccountActive(connection);
        const credentialHeaders = connection.credentialSource === "vercel_connect"
          ? await resolveCredentialHeaders(connection, actor, { forceRefresh: true })
          : undefined;
        await remoteTools(connection, credentialHeaders, actor);
      } else if (isComposioConnection(connection)) {
        await validateComposioConnection(connection);
      } else {
        await resolveCredentialHeaders(connection);
        await stdioTemplateId(connection.companyId, connection.config);
      }
      const updated = await updateConnectionHealth(
        connection,
        "ok",
        isComposioConnection(connection)
          ? "Composio accepted the API key and returned its toolkits."
          : connection.transport === "local_stdio"
            ? "Approved stdio template is ready."
            : "Remote MCP server responded to tools/list.",
      );
      const runtimeSlot = await ensureRuntimeSlot(updated);
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.health_check",
        outcome: "success",
        actor,
        details: { transport: connection.transport },
      });
      return { connection: toConnection(updated), runtimeSlot };
    } catch (error) {
      const failure = sanitizeHttpFailure(error);
      const updated = await updateConnectionHealth(connection, failure.status, failure.message);
      const runtimeSlot = connection.transport === "local_stdio" ? await ensureRuntimeSlot(updated) : null;
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.health_check",
        outcome: "failure",
        reasonCode: failure.code,
        actor,
        details: { status: failure.status, transport: connection.transport },
      });
      throw new HttpError(healthFailureHttpStatus(failure), failure.message, {
        code: failure.code,
        connection: toConnection(updated),
        runtimeSlot,
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
      });
    }
  }

  async function refreshCatalog(
    connectionId: string,
    actor?: ActorInfo,
    refreshOptions: {
      enableAllByDefault?: boolean;
      restoreDraftDefaults?: boolean;
      /** Keep first managed OAuth discovery quarantined without changing generic draft refresh semantics. */
      quarantineManagedOAuthDraft?: boolean;
      skipDefaultProfileSync?: boolean;
      credentialHeaders?: Record<string, string>;
    } = {},
  ): Promise<ToolCatalogRefreshResult> {
    const connection = await getConnectionRow(connectionId);
    const refreshedAt = now();
    let descriptors: McpToolDescriptor[];
    try {
      descriptors = await discoverTools(connection, refreshOptions.credentialHeaders, actor);
    } catch (error) {
      const failure = sanitizeHttpFailure(error);
      const updated = await updateConnectionHealth(connection, failure.status, failure.message);
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.catalog_refresh",
        outcome: "failure",
        reasonCode: failure.code,
        details: { status: failure.status },
        actor,
      });
      throw new HttpError(healthFailureHttpStatus(failure), failure.message, {
        code: failure.code,
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
      });
    }

    const existingRows = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connection.id));
    const existingByName = new Map(existingRows.map((entry) => [entry.toolName, entry]));
    const updatedEntries: ToolCatalogEntry[] = [];
    let quarantinedCount = 0;
    const sourceTemplateKey = typeof asRecord(connection.config).sourceTemplateKey === "string"
      ? String(asRecord(connection.config).sourceTemplateKey)
      : null;
    const sourceApp = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    const sourceMethod = sourceApp ? connectionMethodForConnection(sourceApp, connection) : null;
    const sourceCapabilityKey = sourceMethod?.capabilityProfile?.key;
    const googleProfileValue = sourceMethod?.connectorProfile
      ?? sourceApp?.methods.find((candidate) =>
        candidate.connectorProfile
        && candidate.capabilityProfile?.key === sourceCapabilityKey
      )?.connectorProfile;
    const googleProfile = googleProfileValue && isGoogleWorkspaceConnectorProfileId(googleProfileValue)
      ? googleProfileValue
      : null;
    const quarantineOnRefresh = !refreshOptions.enableAllByDefault
      && shouldQuarantineNewEntries(connection)
      && (
        connection.status === "active"
        || sourceTemplateKey === "posthog"
        || refreshOptions.quarantineManagedOAuthDraft === true
      );
    const safeDefault = asRecord(connection.config).safeDefault === true;
    for (const descriptor of descriptors) {
      const riskLevel = classifyRisk(descriptor, sourceTemplateKey);
      const hash = descriptorHash(descriptor, riskLevel);
      const schemaHash = stableHash(descriptor.inputSchema ?? {});
      const existing = existingByName.get(descriptor.name);
      const changed = existing && (existing.versionHash !== hash || existing.schemaHash !== schemaHash);
      const shouldQuarantine =
        quarantineOnRefresh
        && (!existing || changed)
        && existing?.status !== "disabled"
        && (!safeDefault || riskLevel !== "read");
      const googlePermanentlyBlocked = Boolean(googleProfile && !isGoogleWorkspaceToolAllowed(googleProfile, descriptor));
      const status = googlePermanentlyBlocked
        ? "disabled"
        : shouldQuarantine
          ? "quarantined"
          : existing?.status === "disabled"
            ? "disabled"
            : quarantineOnRefresh && existing?.status === "quarantined"
              ? "quarantined"
              : "active";
      if (shouldQuarantine && !googlePermanentlyBlocked) quarantinedCount += 1;

      if (existing) {
        const [updated] = await db
          .update(toolCatalogEntries)
          .set({
            title: descriptor.title ?? null,
            description: descriptor.description ?? null,
            inputSchema: descriptor.inputSchema ?? {},
            annotations: descriptor.annotations ?? {},
            riskLevel,
            isReadOnly: riskLevel === "read",
            isWrite: riskLevel === "write",
            isDestructive: riskLevel === "destructive",
            status,
            versionHash: hash,
            schemaHash,
            lastSeenAt: refreshedAt,
            quarantinedAt: status === "quarantined"
              ? shouldQuarantine ? refreshedAt : existing.quarantinedAt
              : null,
            quarantineReason: status === "quarantined"
              ? shouldQuarantine ? "pending_review" : existing.quarantineReason
              : null,
            updatedAt: refreshedAt,
          })
          .where(eq(toolCatalogEntries.id, existing.id))
          .returning();
        updatedEntries.push(toCatalogEntry(updated));
      } else {
        const [created] = await db.insert(toolCatalogEntries).values({
          companyId: connection.companyId,
          applicationId: connection.applicationId,
          connectionId: connection.id,
          name: descriptor.name,
          toolName: descriptor.name,
          entryKind: "tool",
          title: descriptor.title ?? null,
          description: descriptor.description ?? null,
          inputSchema: descriptor.inputSchema ?? {},
          annotations: descriptor.annotations ?? {},
          riskLevel,
          isReadOnly: riskLevel === "read",
          isWrite: riskLevel === "write",
          isDestructive: riskLevel === "destructive",
          status,
          versionHash: hash,
          schemaHash,
          firstSeenAt: refreshedAt,
          lastSeenAt: refreshedAt,
          quarantinedAt: shouldQuarantine ? refreshedAt : null,
          quarantineReason: shouldQuarantine ? "pending_review" : null,
        }).returning();
        updatedEntries.push(toCatalogEntry(created));
      }
    }

    const normalizedConfig = refreshOptions.enableAllByDefault
      ? { ...connection.config, quarantineNewEntries: false }
      : connection.config;
    const normalizedTransportConfig = refreshOptions.enableAllByDefault
      ? { ...connection.transportConfig, quarantineNewEntries: false }
      : connection.transportConfig;
    const [updatedConnection] = await db
      .update(toolConnections)
      .set({
        config: normalizedConfig,
        transportConfig: normalizedTransportConfig,
        healthStatus: "ok",
        healthMessage: "Tool catalog refreshed.",
        healthCheckedAt: refreshedAt,
        lastHealthAt: refreshedAt,
        lastCatalogRefreshAt: refreshedAt,
        lastError: null,
        updatedAt: refreshedAt,
      })
      .where(eq(toolConnections.id, connection.id))
      .returning();

    if (connection.transport === "local_stdio") {
      await ensureRuntimeSlot(updatedConnection);
      await db
        .update(toolRuntimeSlots)
        .set({
          healthStatus: "ok",
          healthMessage: "Approved stdio template is ready.",
          lastHealthCheckAt: refreshedAt,
          updatedAt: refreshedAt,
        })
        .where(eq(toolRuntimeSlots.connectionId, connection.id));
    }

    const activeEntries = updatedEntries.filter((entry) => entry.status === "active");
    if (!refreshOptions.skipDefaultProfileSync) {
      await enableCatalogEntriesByDefault({
        connection: updatedConnection,
        newCatalogEntryIds: refreshOptions.enableAllByDefault
          ? activeEntries.map((entry) => entry.id)
          : activeEntries
            .filter((entry) => {
              const previous = existingByName.get(entry.toolName);
              return !previous || previous.status === "quarantined";
            })
            .map((entry) => entry.id),
        activeCatalogEntryIds: activeEntries.map((entry) => entry.id),
        restoreDraftDefaults: refreshOptions.restoreDraftDefaults,
        actor,
      });
    }
    await audit({
      companyId: connection.companyId,
      connectionId: connection.id,
      action: "tool_connection.catalog_refresh",
      outcome: "success",
      details: { discoveredCount: descriptors.length, quarantinedCount },
      actor,
    });

    return {
      connection: toConnection(updatedConnection),
      catalog: updatedEntries,
      discoveredCount: descriptors.length,
      quarantinedCount,
    };
  }

  async function listAppsNeedingAttention(companyId: string): Promise<ToolAppsAttentionResponse> {
    const generatedAt = now();
    const [connections, quarantinedEntries, pendingActionRequests, invocations, profiles, profileEntries, activeCatalog] = await Promise.all([
      db
        .select()
        .from(toolConnections)
        .where(and(eq(toolConnections.companyId, companyId), ne(toolConnections.status, "archived"))),
      db
        .select()
        .from(toolCatalogEntries)
        .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.status, "quarantined"))),
      db
        .select()
        .from(toolActionRequests)
        .where(and(eq(toolActionRequests.companyId, companyId), eq(toolActionRequests.status, "pending"))),
      db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.companyId, companyId)),
      db
        .select()
        .from(toolProfiles)
        .where(eq(toolProfiles.companyId, companyId)),
      db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, companyId)),
      db
        .select()
        .from(toolCatalogEntries)
        .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.status, "active"))),
    ]);
    const quarantinedCountByConnection = new Map<string, number>();
    for (const entry of quarantinedEntries) {
      quarantinedCountByConnection.set(entry.connectionId, (quarantinedCountByConnection.get(entry.connectionId) ?? 0) + 1);
    }
    const invocationConnectionById = new Map(invocations.map((invocation) => [invocation.id, invocation.connectionId]));
    const pendingActionRequestCountByConnection = new Map<string, number>();
    for (const request of pendingActionRequests) {
      const connectionId = invocationConnectionById.get(request.invocationId);
      if (!connectionId) continue;
      pendingActionRequestCountByConnection.set(connectionId, (pendingActionRequestCountByConnection.get(connectionId) ?? 0) + 1);
    }
    const entriesByProfile = new Map<string, Array<typeof toolProfileEntries.$inferSelect>>();
    for (const entry of profileEntries) {
      const list = entriesByProfile.get(entry.profileId) ?? [];
      list.push(entry);
      entriesByProfile.set(entry.profileId, list);
    }
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const pendingProfilesByConnection = new Map<string, Map<string, { profileId: string; profileName: string; pendingCount: number }>>();
    for (const profile of profiles) {
      const tools = pendingNewToolsForProfile({
        profile,
        entries: entriesByProfile.get(profile.id) ?? [],
        catalog: activeCatalog,
        connectionsById,
      });
      for (const tool of tools) {
        const profileCounts = pendingProfilesByConnection.get(tool.connectionId) ?? new Map();
        const existing = profileCounts.get(profile.id) ?? { profileId: profile.id, profileName: profile.name, pendingCount: 0 };
        existing.pendingCount += 1;
        profileCounts.set(profile.id, existing);
        pendingProfilesByConnection.set(tool.connectionId, profileCounts);
      }
    }
    const apps = connections.flatMap((connection) => {
      const healthNeedsAttention = isAttentionHealthStatus(connection.healthStatus);
      const quarantinedCatalogEntryCount = quarantinedCountByConnection.get(connection.id) ?? 0;
      const pendingActionRequestCount = pendingActionRequestCountByConnection.get(connection.id) ?? 0;
      const newToolsPendingProfiles = [...(pendingProfilesByConnection.get(connection.id)?.values() ?? [])]
        .sort((a, b) => b.pendingCount - a.pendingCount || a.profileName.localeCompare(b.profileName));
      const newToolsPendingReviewCount = newToolsPendingProfiles.reduce((sum, profile) => sum + profile.pendingCount, 0);
      const reasons = [
        ...(healthNeedsAttention ? ["health" as const] : []),
        ...(quarantinedCatalogEntryCount > 0 ? ["quarantined_catalog_entries" as const] : []),
        ...(pendingActionRequestCount > 0 ? ["pending_action_requests" as const] : []),
        ...(newToolsPendingReviewCount > 0 ? ["profile_new_tools" as const] : []),
      ];
      return reasons.length > 0
        ? [{
            connection: toConnection(connection),
            healthNeedsAttention,
            quarantinedCatalogEntryCount,
            pendingActionRequestCount,
            newToolsPendingReviewCount,
            newToolsPendingProfiles,
            reasons,
          }]
        : [];
    });
    return {
      generatedAt,
      apps,
      totals: {
        connections: apps.length,
        health: apps.filter((app) => app.healthNeedsAttention).length,
        quarantinedCatalogEntries: apps.reduce((sum, app) => sum + app.quarantinedCatalogEntryCount, 0),
        pendingActionRequests: apps.reduce((sum, app) => sum + app.pendingActionRequestCount, 0),
        newToolsPendingReview: apps.reduce((sum, app) => sum + app.newToolsPendingReviewCount, 0),
        newToolsPendingProfiles: apps.reduce((sum, app) => sum + app.newToolsPendingProfiles.length, 0),
      },
    };
  }

  async function sweepConnectionHealth(input: { staleAfterMs?: number; limit?: number } = {}) {
    const generatedAt = now();
    const staleAfterMs = input.staleAfterMs ?? 15 * 60 * 1000;
    const limit = input.limit ?? 25;
    const cutoff = new Date(generatedAt.getTime() - staleAfterMs);
    const connections = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.enabled, true), eq(toolConnections.status, "active")))
      .orderBy(asc(toolConnections.healthCheckedAt), asc(toolConnections.createdAt));
    const due = connections
      .filter((connection) => !connection.healthCheckedAt || connection.healthCheckedAt <= cutoff)
      .slice(0, limit);
    let healthy = 0;
    let failed = 0;
    const failedConnectionIds: string[] = [];
    for (const connection of due) {
      try {
        await checkConnectionHealth(connection.id, { actorType: "system", actorId: "tool_health_sweep" });
        healthy += 1;
      } catch {
        failed += 1;
        failedConnectionIds.push(connection.id);
      }
    }
    return {
      checked: due.length,
      healthy,
      failed,
      failedConnectionIds,
    };
  }

  function findExample(exampleId: string): ToolExampleDefinition {
    const definition = TOOL_EXAMPLES.find((example) => example.id === exampleId);
    if (!definition) throw notFound("Tool example not found");
    return definition;
  }

  function localStdioInstallBlocker(): string | null {
    return options.deploymentMode === "authenticated"
      && options.deploymentExposure === "public"
      && !trustedRuntimeHost()
      ? "Local stdio examples require a trusted MCP runtime host in authenticated public deployments."
      : null;
  }

  function exampleToolSummaries(definition: ToolExampleDefinition): ToolExampleSummary["fixture"]["tools"] {
    return APPROVED_STDIO_TEMPLATES[definition.templateId].tools.map((tool) => {
      const riskLevel = classifyRisk(tool);
      return {
        name: tool.name,
        description: tool.description ?? null,
        riskLevel,
        readOnly: riskLevel === "read",
      };
    });
  }

  async function exampleRows(companyId: string, definition: ToolExampleDefinition) {
    const [application] = await db
      .select()
      .from(toolApplications)
      .where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.applicationKey, definition.applicationKey)));
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, definition.connectionName)));
    const [profile] = await db
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, definition.profileKey)));
    const [profileBinding] = profile
      ? await db
        .select()
        .from(toolProfileBindings)
        .where(and(
          eq(toolProfileBindings.companyId, companyId),
          eq(toolProfileBindings.profileId, profile.id),
          eq(toolProfileBindings.targetType, "company"),
          eq(toolProfileBindings.targetId, companyId),
        ))
      : [];
    const catalog = connection
      ? await db
        .select()
        .from(toolCatalogEntries)
        .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.connectionId, connection.id)))
        .orderBy(asc(toolCatalogEntries.toolName))
      : [];
    return { application: application ?? null, connection: connection ?? null, profile: profile ?? null, profileBinding: profileBinding ?? null, catalog };
  }

  function exampleSummary(
    definition: ToolExampleDefinition,
    rows: Awaited<ReturnType<typeof exampleRows>>,
  ): ToolExampleSummary {
    const blocker = localStdioInstallBlocker();
    const tools = exampleToolSummaries(definition);
    const installed = Boolean(
      rows.application
      && rows.connection
      && rows.profile
      && rows.profileBinding
      && rows.connection.status !== "archived"
      && rows.profile.status !== "archived",
    );
    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      fixture: {
        transport: "local_stdio",
        templateId: definition.templateId,
        available: Boolean(APPROVED_STDIO_TEMPLATES[definition.templateId]),
        tools,
      },
      safeDefaultProfile: {
        profileKey: definition.profileKey,
        name: definition.profileName,
        defaultAction: "deny",
        allowedToolNames: tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
      },
      install: {
        installed,
        canInstall: !blocker,
        reason: blocker,
        applicationId: rows.application?.id ?? null,
        connectionId: rows.connection?.id ?? null,
        profileId: rows.profile?.id ?? null,
        profileBindingId: rows.profileBinding?.id ?? null,
      },
    };
  }

  async function upsertExampleApplication(
    companyId: string,
    definition: ToolExampleDefinition,
    existing: typeof toolApplications.$inferSelect | null,
  ) {
    const metadata = { ...(existing?.metadata ?? {}), source: "paperclip_example", exampleId: definition.id, safeDefault: true };
    if (existing) {
      const [updated] = await db
        .update(toolApplications)
        .set({
          name: definition.applicationName,
          description: definition.applicationDescription,
          type: "mcp_stdio",
          status: "active",
          metadata,
          archivedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(toolApplications.id, existing.id))
        .returning();
      return { row: updated, created: false };
    }
    const [created] = await db.insert(toolApplications).values({
      companyId,
      applicationKey: definition.applicationKey,
      name: definition.applicationName,
      description: definition.applicationDescription,
      type: "mcp_stdio",
      status: "active",
      metadata,
    }).returning();
    return { row: created, created: true };
  }

  async function upsertExampleConnection(
    companyId: string,
    definition: ToolExampleDefinition,
    applicationId: string,
    existing: typeof toolConnections.$inferSelect | null,
  ) {
    const config = {
      templateId: definition.templateId,
      exampleId: definition.id,
      safeDefault: true,
      quarantineNewEntries: true,
    };
    if (existing) {
      const [updated] = await db
        .update(toolConnections)
        .set({
          applicationId,
          name: definition.connectionName,
          transport: "local_stdio",
          status: "active",
          enabled: true,
          config,
          transportConfig: config,
          credentialRefs: [],
          credentialSecretRefs: [],
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, existing.id))
        .returning();
      await ensureDefaultOrganizationGrant(updated);
      await syncCredentialBindings(updated);
      await ensureRuntimeSlot(updated);
      return { row: updated, created: false };
    }
    const connectionId = randomUUID();
    const [created] = await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: definition.connectionName,
      uid: connectionUid("paperclip", definition.connectionName, connectionId),
      connectionKind: "managed",
      transport: "local_stdio",
      status: "active",
      enabled: true,
      config,
      transportConfig: config,
      credentialRefs: [],
      credentialSecretRefs: [],
    }).returning();
    await ensureDefaultOrganizationGrant(created);
    await syncCredentialBindings(created);
    await ensureRuntimeSlot(created);
    return { row: created, created: true };
  }

  async function upsertExampleProfile(
    companyId: string,
    definition: ToolExampleDefinition,
    existing: typeof toolProfiles.$inferSelect | null,
  ) {
    const metadata = { ...(existing?.metadata ?? {}), source: "paperclip_example", exampleId: definition.id, safeDefault: true };
    if (existing) {
      const [updated] = await db
        .update(toolProfiles)
        .set({
          name: definition.profileName,
          description: definition.profileDescription,
          status: "active",
          defaultAction: "deny",
          metadata,
          updatedAt: new Date(),
        })
        .where(eq(toolProfiles.id, existing.id))
        .returning();
      return { row: updated, created: false };
    }
    const [created] = await db.insert(toolProfiles).values({
      companyId,
      profileKey: definition.profileKey,
      name: definition.profileName,
      description: definition.profileDescription,
      status: "active",
      defaultAction: "deny",
      metadata,
    }).returning();
    return { row: created, created: true };
  }

  async function syncExampleProfileEntries(
    companyId: string,
    profileId: string,
    catalog: ToolCatalogEntry[],
  ): Promise<ToolProfileEntry[]> {
    await db
      .delete(toolProfileEntries)
      .where(and(eq(toolProfileEntries.companyId, companyId), eq(toolProfileEntries.profileId, profileId)));
    const readEntries = catalog.filter((entry) => entry.riskLevel === "read" && entry.status === "active");
    if (readEntries.length === 0) return [];
    const rows = await db.insert(toolProfileEntries).values(readEntries.map((entry) => ({
      companyId,
      profileId,
      selectorType: "catalog_entry" as const,
      effect: "include" as const,
      applicationId: entry.applicationId,
      connectionId: entry.connectionId,
      catalogEntryId: entry.id,
      toolName: entry.toolName,
      riskLevel: entry.riskLevel,
      conditions: { source: "paperclip_example" },
    }))).returning();
    return rows.map(toProfileEntry);
  }

  async function upsertExampleProfileBinding(
    companyId: string,
    profileId: string,
    existing: typeof toolProfileBindings.$inferSelect | null,
    actor?: ActorInfo,
  ): Promise<ToolProfileBinding> {
    const metadata = { ...(existing?.metadata ?? {}), source: "paperclip_example", safeDefault: true };
    if (existing) {
      const [updated] = await db
        .update(toolProfileBindings)
        .set({ priority: 100, metadata, updatedAt: new Date() })
        .where(eq(toolProfileBindings.id, existing.id))
        .returning();
      return toProfileBinding(updated);
    }
    const [created] = await db.insert(toolProfileBindings).values({
      companyId,
      profileId,
      targetType: "company",
      targetId: companyId,
      priority: 100,
      metadata,
      createdByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
      createdByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
    }).returning();
    return toProfileBinding(created);
  }

  async function exampleSmokeActor(companyId: string, actor?: ActorInfo) {
    const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId)).limit(1);
    if (agent) {
      return { actorType: "agent" as const, actorId: agent.id, agentId: agent.id };
    }
    const actorType = actor?.actorType === "user" ? "user" as const : "system" as const;
    return { actorType, actorId: actor?.actorId ?? "example-smoke", agentId: null };
  }

  function sampleArguments(toolName: string): Record<string, unknown> {
    if (toolName === "get_value") return { key: "project" };
    if (toolName === "set_value") return { key: "project", value: "paperclip" };
    if (toolName === "create_item") return { title: "Smoke test item" };
    if (toolName === "mark_done" || toolName === "delete_item") return { id: "todo-1" };
    return {};
  }

  async function runSmokeDecisionCheck(input: {
    companyId: string;
    actor: Awaited<ReturnType<typeof exampleSmokeActor>>;
    connection: ToolConnection;
    catalogEntry: ToolCatalogEntry;
    expectedDecision: ToolPolicyDecision;
    name: string;
  }): Promise<ToolExampleSmokeCheck> {
    const decisionInput = {
      companyId: input.companyId,
      actor: input.actor,
      request: {
        applicationId: input.connection.applicationId,
        connectionId: input.connection.id,
        catalogEntryId: input.catalogEntry.id,
        toolName: input.catalogEntry.toolName,
        arguments: sampleArguments(input.catalogEntry.toolName),
      },
    };
    const decision = await policySvc.decide(decisionInput);
    const auditResult = await policySvc.writeAudit(decisionInput, decision, "policy_decision");
    return {
      name: input.name,
      ok: decision.decision === input.expectedDecision,
      toolName: input.catalogEntry.toolName,
      expectedDecision: input.expectedDecision,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      explanation: decision.explanation,
      auditEventId: auditResult.legacyAuditEvent.id,
      toolCallEventId: auditResult.toolCallEvent.id,
    };
  }

  function actionSummary(entry: ToolCatalogEntry): ToolAppConnectionActionSummary {
    return {
      catalogEntryId: entry.id,
      toolName: entry.toolName,
      title: entry.title,
      description: entry.description,
      riskLevel: entry.riskLevel,
      isReadOnly: entry.isReadOnly,
      isWrite: entry.isWrite,
      isDestructive: entry.isDestructive,
      status: entry.status,
    };
  }

  function groupedActions(catalog: ToolCatalogEntry[]): ConnectToolAppResult["actions"] {
    const readOnly: ToolAppConnectionActionSummary[] = [];
    const canMakeChanges: ToolAppConnectionActionSummary[] = [];
    for (const entry of catalog) {
      const summary = actionSummary(entry);
      if (entry.isReadOnly && entry.riskLevel === "read" && !entry.isWrite && !entry.isDestructive) {
        readOnly.push(summary);
      } else {
        canMakeChanges.push(summary);
      }
    }
    return { readOnly, canMakeChanges };
  }

  function defaultLinkName(link: string): string {
    try {
      const url = new URL(link);
      const host = url.host.replace(/^www\./, "");
      const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
      return `${host}${path}`.slice(0, 160) || "MCP app";
    } catch {
      return "MCP app";
    }
  }

  function linkCredentialFields(credentialValues: Record<string, string>) {
    const fields: Array<{
      label: string;
      configPath: string;
      required: boolean;
      placement: "header";
      key: string;
      prefix: string | null;
    }> = [];
    if (credentialValues["credentials.authorization"]?.trim()) {
      fields.push({
        label: "App key",
        configPath: "credentials.authorization",
        required: false,
        placement: "header",
        key: "Authorization",
        prefix: "Bearer ",
      });
    }
    for (const configPath of Object.keys(credentialValues).sort()) {
      if (!configPath.startsWith("headers.")) continue;
      const headerName = mcpRemoteHeaderNameFromConfigPath(configPath);
      if (!headerName) throw badRequest("Header names cannot be blank.", { code: "mcp_header_rejected" });
      // The API schema already rejected unsafe headers, but this is the last
      // point before a name becomes a real outbound request header — and the
      // normalized paste-config path lands here too — so re-check rather than
      // trust the caller.
      const nameCheck = checkMcpRemoteHeaderName(headerName);
      if (!nameCheck.ok) {
        throw badRequest(mcpRemoteHeaderRejectionMessage(headerName, nameCheck.reason!), {
          code: "mcp_header_rejected",
          headerName,
        });
      }
      const valueCheck = checkMcpRemoteHeaderValue(credentialValues[configPath] ?? "");
      if (!valueCheck.ok) {
        throw badRequest(mcpRemoteHeaderRejectionMessage(headerName, valueCheck.reason!), {
          code: "mcp_header_rejected",
          headerName,
        });
      }
      fields.push({
        label: headerName,
        configPath,
        required: true,
        placement: "header",
        key: headerName,
        prefix: null,
      });
    }
    return fields;
  }

  function actorForSecret(actor?: ActorInfo): { userId?: string | null; agentId?: string | null } | undefined {
    if (actor?.actorType === "user") return { userId: actor.actorId ?? null };
    if (actor?.actorType === "agent") return { agentId: actor.actorId ?? null };
    return undefined;
  }

  function oauthEnvName(provider: string, suffix: "CLIENT_ID" | "CLIENT_SECRET") {
    return `PAPERCLIP_TOOL_OAUTH_${provider.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_${suffix}`;
  }

  function oauthClientConfig(provider: string) {
    const clientIdEnv = oauthEnvName(provider, "CLIENT_ID");
    const clientSecretEnv = oauthEnvName(provider, "CLIENT_SECRET");
    return {
      clientIdEnv,
      clientSecretEnv,
      clientId: process.env[clientIdEnv] ?? process.env.PAPERCLIP_TOOL_OAUTH_CLIENT_ID ?? null,
      clientSecret: process.env[clientSecretEnv] ?? process.env.PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET ?? null,
    };
  }

  function isSmokeLabOAuthFixture(connection: typeof toolConnections.$inferSelect) {
    const config = asRecord(connection.config);
    const oauth = oauthConfig(connection);
    return config.smokeLabFixture === "oauth-http" && oauth.smokeLabFixture === true;
  }

  function smokeLabOAuthEndpoints(
    connection: typeof toolConnections.$inferSelect,
    redirectUri?: string,
  ): OAuthProviderEndpoints | null {
    if (!isSmokeLabOAuthFixture(connection) || !redirectUri) return null;
    let origin: string;
    try {
      origin = new URL(redirectUri).origin;
    } catch {
      return null;
    }
    const oauthBasePath = `/api/companies/${encodeURIComponent(connection.companyId)}/smoke-lab/oauth`;
    return {
      provider: "smoke_lab",
      scopes: normalizeOauthScopes(oauthConfig(connection).scopes),
      authorizationUrl: new URL(`${oauthBasePath}/authorize`, origin).toString(),
      tokenUrl: new URL(`${oauthBasePath}/token`, origin).toString(),
      metadataUrl: null,
      grantType: "authorization_code",
    };
  }

  function configuredOAuthClientForConnection(
    connection: typeof toolConnections.$inferSelect,
    provider: string,
  ) {
    if (isSmokeLabOAuthFixture(connection) && provider === "smoke_lab") {
      return {
        clientIdEnv: "SMOKE_LAB_FIXED_CLIENT_ID",
        clientSecretEnv: "SMOKE_LAB_FIXED_CLIENT_SECRET",
        clientId: "paperclip-smoke-lab",
        clientSecret: null,
      };
    }
    return oauthClientConfig(provider);
  }

  async function oauthClientForConnection(
    connection: typeof toolConnections.$inferSelect,
    provider: string,
    actor?: ActorInfo,
  ) {
    const configured = configuredOAuthClientForConnection(connection, provider);
    if (configured.clientId) return configured;
    const oauth = oauthConfig(connection);
    const clientId = typeof oauth.clientId === "string" && oauth.clientId.trim()
      ? oauth.clientId.trim()
      : null;
    if (!clientId) return configured;
    // CIMD clients and public DCR clients have no token-endpoint secret. A DCR
    // authorization server may instead issue a confidential client (for
    // example, `client_secret_basic`); in that case the registration secret is
    // encrypted like every other provider credential and resolved only for the
    // token endpoint.
    const registrationSource = oauth.clientRegistrationSource;
    const publicRegisteredClient = registrationSource === "cimd"
      || (registrationSource === "dcr" && oauth.clientTokenEndpointAuthMethod === "none");
    let credentialSecretRefs = connection.credentialSecretRefs;
    if (
      connection.credentialPolicy === "per_user"
      && actor?.actorType === "user"
      && actor.actorId
      && !credentialSecretRefs.some((ref) => ref.configPath === "oauth.client_secret")
    ) {
      const [personalGrant] = await db.select({
        credentialSecretRefs: connectionGrants.credentialSecretRefs,
      }).from(connectionGrants).where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "user"),
        eq(connectionGrants.subjectUserId, actor.actorId),
        eq(connectionGrants.status, "active"),
      )).limit(1);
      credentialSecretRefs = personalGrant?.credentialSecretRefs ?? credentialSecretRefs;
    }
    const clientSecretRef = publicRegisteredClient
      ? undefined
      : credentialSecretRefs.find((ref) => ref.configPath === "oauth.client_secret");
    const clientSecret = clientSecretRef
      ? await secrets.resolveSecretValue(
          connection.companyId,
          clientSecretRef.secretId,
          clientSecretRef.versionSelector ?? "latest",
          {
            consumerType: "tool_connection",
            consumerId: connection.id,
            configPath: "oauth.client_secret",
            actorType: actor?.actorType ?? "system",
            actorId: actor?.actorId ?? null,
          },
        )
      : null;
    return {
      clientIdEnv: null,
      clientSecretEnv: null,
      clientId,
      clientSecret,
    };
  }

  function base64UrlSha256(input: string) {
    return createHash("sha256").update(input).digest("base64url");
  }

  function randomOauthToken(bytes = 32) {
    return randomBytes(bytes).toString("base64url");
  }

  function oauthConfig(connection: typeof toolConnections.$inferSelect) {
    const oauth = asRecord(connection.config).oauth ? asRecord(asRecord(connection.config).oauth) : {};
    const {
      access_token: _accessToken,
      refresh_token: _refreshToken,
      accessToken: _camelAccessToken,
      refreshToken: _camelRefreshToken,
      ...metadata
    } = oauth;
    return metadata;
  }

  function connectionSetupUrl(connection: typeof toolConnections.$inferSelect) {
    return `/apps/${connection.id}/setup`;
  }

  function connectionReconnectUrl(connection: typeof toolConnections.$inferSelect) {
    return `/apps/${connection.id}/advanced`;
  }

  function credentialScope(connection: typeof toolConnections.$inferSelect, actor?: ActorInfo) {
    const configured = asRecord(oauthConfig(connection).credentialScope);
    const type = typeof configured.type === "string"
      ? configured.type
      : typeof configured.targetType === "string"
        ? configured.targetType
        : actor?.actorType === "agent"
          ? "agent"
          : actor?.actorType === "user"
            ? "user"
            : "company";
    const id = typeof configured.id === "string"
      ? configured.id
      : typeof configured.targetId === "string"
        ? configured.targetId
        : actor?.actorId ?? connection.companyId;
    return {
      type,
      id,
      hash: stableHash({ companyId: connection.companyId, connectionId: connection.id, type, id }),
    };
  }

  function normalizeOauthScopes(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (typeof value === "string") return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    return [];
  }

  function isSmokeLabOAuthUrl(value: string | null | undefined) {
    if (!value) return false;
    try {
      return /\/smoke-lab\/oauth(?:\/|$)/.test(new URL(value).pathname);
    } catch {
      return false;
    }
  }

  function assertNotSmokeLabOAuthEndpoints(
    connection: typeof toolConnections.$inferSelect,
    endpoints: OAuthProviderEndpoints,
  ) {
    const blockedUrl = [endpoints.authorizationUrl, endpoints.tokenUrl, endpoints.metadataUrl].find(isSmokeLabOAuthUrl);
    if (blockedUrl && !isSmokeLabOAuthFixture(connection)) {
      throw unprocessable("Smoke Lab OAuth provider cannot be used for tool app sign-in");
    }
  }

  function oauthProviderForConnection(connection: typeof toolConnections.$inferSelect, metadataUrl?: string | null): string {
    const oauth = oauthConfig(connection);
    if (typeof oauth.provider === "string" && oauth.provider.trim()) return oauth.provider.trim();
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string"
      ? connection.config.sourceTemplateKey.trim()
      : "";
    if (sourceTemplateKey) return sourceTemplateKey;
    const url = metadataUrl ?? remoteEndpoint(connection.config);
    try {
      return new URL(url).hostname.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "generic";
    } catch {
      return "generic";
    }
  }

  function parseWwwAuthenticateParams(value: string): Record<string, string> {
    const params: Record<string, string> = {};
    const input = value.replace(/^\s*Bearer\s+/i, "");
    const re = /([a-zA-Z_][a-zA-Z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(input))) {
      params[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
    }
    return params;
  }

  function challengeOAuthHints(wwwAuthenticate: string) {
    const params = parseWwwAuthenticateParams(wwwAuthenticate);
    return {
      metadataUrl: params.resource_metadata ?? params.resource_metadata_url ?? params.metadata_url ?? null,
      authorizationUrl: params.authorization_uri ?? params.authorization_url ?? null,
      tokenUrl: params.token_uri ?? params.token_url ?? null,
      scope: params.scope ?? null,
    };
  }

  function oauthSecretRef(
    connection: typeof toolConnections.$inferSelect,
    configPath: "oauth.access_token" | "oauth.refresh_token" | "oauth.client_secret",
  ) {
    return connection.credentialSecretRefs.find((ref) => ref.configPath === configPath) ?? null;
  }

  function oauthExpiresAtMs(connection: typeof toolConnections.$inferSelect): number | null {
    const expiresAt = oauthConfig(connection).expiresAt;
    if (typeof expiresAt !== "string") return null;
    const ms = Date.parse(expiresAt);
    return Number.isFinite(ms) ? ms : null;
  }

  async function fetchJsonRecord(url: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchRemoteHttpUrl(url);
      if (!response.ok) return null;
      return asRecord(await response.json() as unknown) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Candidate authorization-server metadata URLs advertised by protected-resource
   * metadata, paired with the issuer that advertised them so the caller can bind
   * the resulting client material to a canonical issuer.
   */
  function authServerMetadataUrls(metadata: Record<string, unknown>): Array<{ issuer: string; metadataUrl: string }> {
    const candidates: Array<{ issuer: string; metadataUrl: string }> = [];
    const issuers: string[] = [];
    if (Array.isArray(metadata.authorization_servers)) {
      for (const server of metadata.authorization_servers) {
        if (typeof server === "string" && server.trim()) issuers.push(server.trim());
      }
    }
    if (typeof metadata.issuer === "string" && metadata.issuer.trim()) issuers.push(metadata.issuer.trim());
    for (const issuer of [...new Set(issuers)]) {
      for (const metadataUrl of wellKnownMetadataUrls(issuer)) {
        candidates.push({ issuer, metadataUrl });
      }
    }
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      if (seen.has(candidate.metadataUrl)) return false;
      seen.add(candidate.metadataUrl);
      return true;
    });
  }

  async function endpointsFromMetadataUrl(
    connection: typeof toolConnections.$inferSelect,
    metadataUrl: string,
    rejections: HttpError[] = [],
    firstPartyOrigin?: string | null,
  ): Promise<OAuthProviderEndpoints | null> {
    const metadata = await fetchJsonRecord(metadataUrl);
    if (!metadata) return null;
    // Every endpoint below is a string the remote server chose, so none of them
    // is adopted before `safeOAuthEndpointUrl` has vetted its scheme and host.
    let authorizationUrl = safeOAuthEndpointUrl("authorization", metadata.authorization_endpoint, rejections, firstPartyOrigin);
    let tokenUrl = safeOAuthEndpointUrl("token", metadata.token_endpoint, rejections, firstPartyOrigin);
    let registrationUrl = safeOAuthEndpointUrl("registration", metadata.registration_endpoint, rejections, firstPartyOrigin);
    let scopes = normalizeOauthScopes(metadata.scopes_supported);
    let codeChallengeMethodsSupported = normalizeOauthScopes(metadata.code_challenge_methods_supported);
    let tokenEndpointAuthMethodsSupported = normalizeOauthScopes(metadata.token_endpoint_auth_methods_supported);
    let grantTypesSupported = normalizeOauthScopes(metadata.grant_types_supported);
    let clientIdMetadataDocumentSupported = metadata.client_id_metadata_document_supported === true;
    // A document that carries the authorization endpoint itself *is* the
    // authorization-server metadata, so its own `issuer` is the canonical one.
    // Otherwise this was protected-resource metadata and the issuer comes from
    // whichever advertised authorization server answered.
    let issuer = authorizationUrl && typeof metadata.issuer === "string" && metadata.issuer.trim()
      ? metadata.issuer.trim()
      : null;
    const resource = typeof metadata.resource === "string" && metadata.resource.trim()
      ? metadata.resource.trim()
      : null;
    for (const candidate of authServerMetadataUrls(metadata)) {
      const authMetadata = await fetchJsonRecord(candidate.metadataUrl);
      if (!authMetadata) continue;
      const candidateAuthorizationUrl = safeOAuthEndpointUrl(
        "authorization",
        authMetadata.authorization_endpoint,
        rejections,
        firstPartyOrigin,
      );
      const candidateTokenUrl = safeOAuthEndpointUrl("token", authMetadata.token_endpoint, rejections, firstPartyOrigin);
      if (!candidateAuthorizationUrl && !candidateTokenUrl) continue;
      // RFC 8414 §3.3: the metadata document's `issuer` must match the issuer we
      // used to build the discovery URL, or the document is not authoritative.
      const advertisedIssuer = typeof authMetadata.issuer === "string" && authMetadata.issuer.trim()
        ? authMetadata.issuer.trim()
        : null;
      if (advertisedIssuer && !sameOAuthIssuer(advertisedIssuer, candidate.issuer)) continue;
      authorizationUrl = authorizationUrl ?? candidateAuthorizationUrl;
      tokenUrl = tokenUrl ?? candidateTokenUrl;
      registrationUrl = registrationUrl
        ?? safeOAuthEndpointUrl("registration", authMetadata.registration_endpoint, rejections, firstPartyOrigin);
      issuer = issuer ?? advertisedIssuer ?? candidate.issuer;
      if (scopes.length === 0) scopes = normalizeOauthScopes(authMetadata.scopes_supported);
      if (codeChallengeMethodsSupported.length === 0) {
        codeChallengeMethodsSupported = normalizeOauthScopes(authMetadata.code_challenge_methods_supported);
      }
      if (tokenEndpointAuthMethodsSupported.length === 0) {
        tokenEndpointAuthMethodsSupported = normalizeOauthScopes(authMetadata.token_endpoint_auth_methods_supported);
      }
      if (grantTypesSupported.length === 0) {
        grantTypesSupported = normalizeOauthScopes(authMetadata.grant_types_supported);
      }
      if (!clientIdMetadataDocumentSupported) {
        clientIdMetadataDocumentSupported = authMetadata.client_id_metadata_document_supported === true;
      }
      if (authorizationUrl && tokenUrl) break;
    }
    if (!authorizationUrl || !tokenUrl) return null;
    return {
      provider: oauthProviderForConnection(connection, metadataUrl),
      scopes,
      authorizationUrl,
      tokenUrl,
      registrationUrl,
      codeChallengeMethodsSupported,
      tokenEndpointAuthMethodsSupported,
      grantTypesSupported,
      metadataUrl,
      issuer,
      resource,
      clientIdMetadataDocumentSupported,
    };
  }

  async function discoverOAuthEndpoints(
    connection: typeof toolConnections.$inferSelect,
    challenge?: string | null,
    firstPartyOrigin?: string | null,
  ): Promise<OAuthProviderEndpoints | null> {
    const oauth = oauthConfig(connection);
    const hints = challenge ? challengeOAuthHints(challenge) : null;
    // A configured endpoint was pasted by an operator or persisted from an
    // earlier discovery, and a hint came straight out of the endpoint's
    // `WWW-Authenticate` header. Neither is more trusted than metadata, so both
    // go through the same gate; an unusable one is dropped so full metadata
    // discovery still runs below.
    const rejections: HttpError[] = [];
    const configuredAuthorizationUrl = safeOAuthEndpointUrl(
      "authorization",
      typeof oauth.authorizationUrl === "string" ? oauth.authorizationUrl : hints?.authorizationUrl ?? null,
      rejections,
      firstPartyOrigin,
    );
    const configuredTokenUrl = safeOAuthEndpointUrl(
      "token",
      typeof oauth.tokenUrl === "string" ? oauth.tokenUrl : hints?.tokenUrl ?? null,
      rejections,
      firstPartyOrigin,
    );
    const provider = oauthProviderForConnection(connection, typeof oauth.metadataUrl === "string" ? oauth.metadataUrl : hints?.metadataUrl);
    const scopes = normalizeOauthScopes(oauth.scopes).length > 0
      ? normalizeOauthScopes(oauth.scopes)
      : normalizeOauthScopes(oauth.scope).length > 0
        ? normalizeOauthScopes(oauth.scope)
        : normalizeOauthScopes(hints?.scope);
    const grantType = oauth.grantType === "client_credentials" || oauth.clientCredentials === true
      ? "client_credentials" as const
      : "authorization_code" as const;
    // The resource indicator is the MCP endpoint itself, independent of which
    // authorization server ends up serving it.
    const configuredResource = typeof oauth.resource === "string" && oauth.resource.trim()
      ? oauth.resource.trim()
      : canonicalResourceIndicator(remoteEndpoint(connection.config));
    if (configuredAuthorizationUrl && configuredTokenUrl) {
      return {
        provider,
        scopes,
        authorizationUrl: configuredAuthorizationUrl,
        tokenUrl: configuredTokenUrl,
        registrationUrl: safeOAuthEndpointUrl("registration", oauth.registrationUrl, rejections, firstPartyOrigin),
        codeChallengeMethodsSupported: normalizeOauthScopes(oauth.codeChallengeMethodsSupported),
        tokenEndpointAuthMethodsSupported: normalizeOauthScopes(oauth.tokenEndpointAuthMethodsSupported),
        grantType,
        metadataUrl: typeof oauth.metadataUrl === "string" ? oauth.metadataUrl : hints?.metadataUrl ?? null,
        issuer: typeof oauth.issuer === "string" && oauth.issuer.trim() ? oauth.issuer.trim() : null,
        resource: configuredResource,
        clientIdMetadataDocumentSupported: oauth.clientIdMetadataDocumentSupported === true,
      };
    }

    const metadataCandidates = [
      typeof oauth.metadataUrl === "string" ? oauth.metadataUrl : null,
      hints?.metadataUrl ?? null,
    ].filter((value): value is string => Boolean(value));
    if (metadataCandidates.length === 0) {
      const endpoint = new URL(await assertRemoteEndpointAllowed(connection.config));
      metadataCandidates.push(...protectedResourceMetadataUrls(endpoint));
      // The MCP server may double as its own authorization server, in which case
      // it serves authorization-server metadata directly at (or under) its path.
      metadataCandidates.push(...wellKnownMetadataUrls(endpoint.toString()));
    }
    for (const metadataUrl of [...new Set(metadataCandidates)]) {
      const endpoints = await endpointsFromMetadataUrl(connection, metadataUrl, rejections, firstPartyOrigin);
      if (endpoints) {
        return {
          ...endpoints,
          scopes: scopes.length > 0 ? scopes : endpoints.scopes,
          grantType,
          resource: endpoints.resource ?? configuredResource,
        };
      }
    }
    // Nothing usable was found *and* something was refused on the way: report the
    // refusal rather than the generic "does not advertise OAuth sign in", so the
    // operator learns the server offered an unsafe address.
    if (rejections.length > 0) throw rejections[0];
    return null;
  }

  async function oauthProviderEndpoints(app: AppDefinition, methodKey?: string | null): Promise<OAuthProviderEndpoints> {
    const method = connectionMethodFor(app, methodKey);
    if (method.auth !== "oauth") throw unprocessable("This app does not support sign in");
    let authorizationUrl = method.defaults?.authorizationEndpoint ?? null;
    let tokenUrl = method.defaults?.tokenEndpoint ?? null;
    const metadataUrl = method.defaults?.metadataUrl ?? null;
    if ((!authorizationUrl || !tokenUrl) && metadataUrl) {
      const response = await fetchRemoteHttpUrl(metadataUrl);
      if (!response.ok) throw new HttpError(502, "OAuth provider metadata could not be loaded", { code: "oauth_metadata_failed" });
      const metadata = asRecord(await response.json() as unknown);
      authorizationUrl = authorizationUrl ?? (typeof metadata.authorization_endpoint === "string" ? metadata.authorization_endpoint : null);
      tokenUrl = tokenUrl ?? (typeof metadata.token_endpoint === "string" ? metadata.token_endpoint : null);
    }
    if (!authorizationUrl || !tokenUrl) {
      throw unprocessable("OAuth provider endpoints are not configured for this app");
    }
    // A gallery default is Paperclip's own data, but it is still a URL that ends
    // up as a browser navigation, and the metadata branch above reads the same
    // untrusted document a generic connection does. Both go through the gate.
    return {
      provider: app.slug,
      scopes: method.defaults?.scopesHint ?? [],
      authorizationUrl: assertOAuthEndpointUrl("authorization", authorizationUrl),
      tokenUrl: assertOAuthEndpointUrl("token", tokenUrl),
      grantType: "authorization_code",
      metadataUrl,
    };
  }

  async function oauthEndpointsForConnection(
    connection: typeof toolConnections.$inferSelect,
    challenge?: string | null,
    redirectUri?: string,
  ): Promise<OAuthProviderEndpoints> {
    const smokeLabEndpoints = smokeLabOAuthEndpoints(connection, redirectUri);
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    const galleryMethod = galleryEntry ? connectionMethodForConnection(galleryEntry, connection) : null;
    const hasCompleteGalleryEndpointHints = Boolean(
      galleryMethod?.defaults?.authorizationEndpoint && galleryMethod.defaults.tokenEndpoint,
    );
    // The smoke-lab fixture's endpoints are first-party and complete, so
    // discovery is not just unnecessary there, it must not run: an unreachable
    // fixture endpoint would fail the whole callback.
    const firstPartyOrigin = originOf(redirectUri);
    const discovered = !smokeLabEndpoints && connection.transport === "mcp_remote" && !hasCompleteGalleryEndpointHints
      ? await discoverOAuthEndpoints(connection, challenge, firstPartyOrigin)
      : null;
    const endpoints = smokeLabEndpoints
      ?? discovered
      ?? (galleryEntry && galleryMethod?.auth === "oauth"
        ? await oauthProviderEndpoints(galleryEntry, galleryMethod.key)
        : await discoverOAuthEndpoints(connection, challenge, firstPartyOrigin));
    if (!endpoints) throw unprocessable("This app connection does not advertise OAuth sign in");
    assertNotSmokeLabOAuthEndpoints(connection, endpoints);
    return endpoints;
  }

  async function oauthGalleryEntryForConnection(connection: typeof toolConnections.$inferSelect) {
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    if (!sourceTemplateKey) throw unprocessable("This app connection was not created from the app gallery");
    const galleryEntry = getConnectableAppDefinition(sourceTemplateKey);
    if (!galleryEntry || connectionMethodForConnection(galleryEntry, connection).auth !== "oauth") {
      throw unprocessable("This app connection does not use sign in");
    }
    return galleryEntry;
  }

  async function createOrRotateOAuthSecret(input: {
    companyId: string;
    connection: typeof toolConnections.$inferSelect;
    configPath: "oauth.access_token" | "oauth.refresh_token" | "oauth.client_secret";
    label: string;
    value: string;
    actor?: ActorInfo;
    existingRefs?: typeof connectionGrants.$inferSelect.credentialSecretRefs;
    ownerUserId?: string;
  }, context?: {
    dbClient: ToolAccessMutationDb;
    secretClient: ReturnType<typeof secretService>;
  }) {
    const dbClient = context?.dbClient ?? db;
    const secretClient = context?.secretClient ?? secrets;
    const existing = input.existingRefs === undefined
      ? oauthSecretRef(input.connection, input.configPath)
      : input.existingRefs.find((ref) => ref.configPath === input.configPath);
    if (existing) {
      await secretClient.rotate(existing.secretId, { value: input.value }, actorForSecret(input.actor));
      return existing;
    }
    if (input.ownerUserId) {
      const definitionKey = `tool_oauth.${input.connection.id}.${input.configPath.replace(/[^a-z0-9_:-]+/gi, "_")}`;
      let [definition] = await dbClient.select().from(userSecretDefinitions).where(and(
        eq(userSecretDefinitions.companyId, input.companyId),
        eq(userSecretDefinitions.key, definitionKey),
        isNull(userSecretDefinitions.deletedAt),
      )).limit(1);
      if (!definition) {
        [definition] = await dbClient.insert(userSecretDefinitions).values({
          companyId: input.companyId,
          key: definitionKey,
          name: `${input.connection.name} ${input.label}`,
          description: `Personal OAuth ${input.label.toLowerCase()} for ${input.connection.name}.`,
          provider: "local_encrypted",
          managedMode: "paperclip_managed",
          createdByAgentId: input.actor?.actorType === "agent" ? input.actor.actorId : null,
          createdByUserId: input.actor?.actorType === "user" ? input.actor.actorId : null,
        }).onConflictDoNothing().returning();
        if (!definition) {
          [definition] = await dbClient.select().from(userSecretDefinitions).where(and(
            eq(userSecretDefinitions.companyId, input.companyId),
            eq(userSecretDefinitions.key, definitionKey),
            isNull(userSecretDefinitions.deletedAt),
          )).limit(1);
        }
      }
      if (!definition) throw new Error("Failed to create personal OAuth secret definition");
      const [existingUserValue] = await dbClient.select().from(companySecrets).where(and(
        eq(companySecrets.companyId, input.companyId),
        eq(companySecrets.scope, "user"),
        eq(companySecrets.ownerUserId, input.ownerUserId),
        eq(companySecrets.userSecretDefinitionId, definition.id),
        ne(companySecrets.status, "deleted"),
      )).limit(1);
      if (existingUserValue) {
        // A removed/revoked grant can predate credential cleanup and therefore
        // lose its ref while its deterministic owner value remains. Reconnect
        // is explicit fresh consent, so revive that owner-bound value and
        // rotate it instead of colliding with the one-value-per-definition
        // constraint.
        if (existingUserValue.status !== "active") {
          await secretClient.updateCurrentUserSecretValue(
            input.companyId,
            input.ownerUserId,
            existingUserValue.id,
            { status: "active" },
            actorForSecret(input.actor),
          );
        }
        const secret = await secretClient.rotateCurrentUserSecretValue(
          input.companyId,
          input.ownerUserId,
          existingUserValue.id,
          { value: input.value },
          actorForSecret(input.actor),
        );
        return {
          secretId: secret.id,
          versionSelector: "latest" as const,
          configPath: input.configPath,
          required: input.configPath === "oauth.access_token",
          label: input.label,
        };
      }
      const secret = await secretClient.createCurrentUserSecretValue(input.companyId, input.ownerUserId, {
        definitionId: definition.id,
        value: input.value,
      }, actorForSecret(input.actor));
      return {
        secretId: secret.id,
        versionSelector: "latest" as const,
        configPath: input.configPath,
        required: input.configPath === "oauth.access_token",
        label: input.label,
      };
    }
    const secret = await secretClient.create(input.companyId, {
      name: `${input.connection.name} ${input.label} ${randomUUID().slice(0, 8)}`,
      key: `tool_app.${randomUUID()}.${input.configPath.replace(/[^a-z0-9_:-]+/gi, "_")}`,
      provider: "local_encrypted",
      value: input.value,
      description: `OAuth ${input.label.toLowerCase()} for ${input.connection.name}.`,
    }, actorForSecret(input.actor));
    return {
      secretId: secret.id,
      versionSelector: "latest" as const,
      configPath: input.configPath,
      required: input.configPath === "oauth.access_token",
      label: input.label,
    };
  }

  function assertOAuthRedirectConstraints(app: AppDefinition | null, redirectUri: string) {
    if (app?.redirectConstraints !== "https-or-loopback-http") return;
    let redirect: URL;
    try {
      redirect = new URL(redirectUri);
    } catch {
      throw unprocessable("OAuth callback URL is invalid", { code: "oauth_redirect_uri_invalid" });
    }
    const hostname = redirect.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isLoopback = hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (redirect.protocol === "https:" || (redirect.protocol === "http:" && isLoopback)) return;
    throw unprocessable(
      "This provider requires an HTTPS or loopback origin. Configure TLS before connecting.",
      {
        code: "oauth_redirect_origin_unsupported",
        redirectConstraints: app.redirectConstraints,
        docsPath: "docs/deploy",
      },
    );
  }

  /**
   * Validate RFC 9207 `iss` on the authorization callback.
   *
   * When an authorization server returns `iss`, it must name the same issuer the
   * authorization request was bound to. A mismatch means the code came back from a
   * different server than the one we sent the user to — the mix-up attack RFC 9207
   * exists to stop — so the code is refused rather than exchanged. An absent `iss`
   * is tolerated: it is optional, and many deployed servers omit it.
   */
  function assertOAuthCallbackIssuer(
    connection: typeof toolConnections.$inferSelect,
    endpoints: OAuthProviderEndpoints,
    iss: string | null | undefined,
  ) {
    const returnedIssuer = typeof iss === "string" ? iss.trim() : "";
    if (!returnedIssuer) return;
    const oauth = oauthConfig(connection);
    const expectedIssuer = typeof oauth.expectedIssuer === "string" && oauth.expectedIssuer.trim()
      ? oauth.expectedIssuer.trim()
      : endpoints.issuer ?? null;
    if (!expectedIssuer) return;
    if (sameOAuthIssuer(returnedIssuer, expectedIssuer)) return;
    throw badRequest("Sign-in came back from an unexpected server. Start the connection again.", {
      code: "oauth_issuer_mismatch",
    });
  }

  function invalidOAuthDcrResponse(field: string, reason: string): HttpError {
    return new HttpError(502, "OAuth provider returned incompatible dynamic client metadata", {
      code: "oauth_dcr_response_invalid",
      field,
      reason,
    });
  }

  function parseOAuthDcrString(
    record: Record<string, unknown>,
    field: "client_id" | "client_secret",
    input: { required: boolean; maxLength: number },
  ): string | null {
    const value = record[field];
    if (value === undefined || value === null) {
      if (input.required) throw invalidOAuthDcrResponse(field, "missing");
      return null;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > input.maxLength) {
      throw invalidOAuthDcrResponse(field, "invalid_string");
    }
    if (field === "client_id" && value.trim() !== value) {
      throw invalidOAuthDcrResponse(field, "invalid_string");
    }
    return value;
  }

  function assertOAuthDcrArray(
    record: Record<string, unknown>,
    field: "redirect_uris" | "grant_types" | "response_types",
    expected: string[],
    options: { allowAdditional?: boolean; allowOmitted?: boolean } = {},
  ) {
    if (record[field] === undefined) {
      if (options.allowOmitted) return;
      throw invalidOAuthDcrResponse(field, "missing");
    }
    const value = record[field];
    if (
      !Array.isArray(value)
      || value.length < expected.length
      || value.length > 32
      || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 2_048)
    ) {
      throw invalidOAuthDcrResponse(field, "invalid_array");
    }
    const actual = new Set(value);
    if (
      expected.some((entry) => !actual.has(entry))
      || (!options.allowAdditional && actual.size !== expected.length)
    ) {
      throw invalidOAuthDcrResponse(field, "registered_value_mismatch");
    }
  }

  function parseOAuthDcrTimestamp(record: Record<string, unknown>, field: string): number | null {
    const value = record[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw invalidOAuthDcrResponse(field, "invalid_timestamp");
    }
    return value;
  }

  type OAuthTokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

  function selectOAuthDcrTokenEndpointAuthMethod(
    supported: string[] | undefined,
  ): OAuthTokenEndpointAuthMethod {
    if (!supported?.length || supported.includes("none")) return "none";
    // When a confidential client is required, preserve the provider's advertised
    // ordering. Miro advertises both methods but only completes its MCP exchange
    // for the first one (`client_secret_post`), while Supabase and Hugging Face
    // advertise `client_secret_basic` first. Treating Basic as a global preference
    // creates a valid-looking registration that fails only after user consent.
    for (const method of supported) {
      if (method === "client_secret_basic" || method === "client_secret_post") return method;
    }
    throw unprocessable("OAuth provider does not support a compatible dynamic client authentication method", {
      code: "oauth_dcr_client_auth_unsupported",
      supportedMethods: supported,
    });
  }

  function storedOAuthTokenEndpointAuthMethod(
    oauth: Record<string, unknown>,
    clientSecret: string | null | undefined,
  ): OAuthTokenEndpointAuthMethod {
    const method = oauth.clientTokenEndpointAuthMethod;
    if (method === "none" || method === "client_secret_basic" || method === "client_secret_post") {
      return method;
    }
    const advertised = Array.isArray(oauth.tokenEndpointAuthMethodsSupported)
      ? oauth.tokenEndpointAuthMethodsSupported.filter((value): value is string => typeof value === "string")
      : [];
    // Manual OAuth clients do not carry a DCR-selected method. Follow the
    // authorization server's advertised preference when it offers a
    // confidential-client method; Xero, for example, documents Basic auth and
    // rejects an otherwise valid code when the secret is posted in the body.
    if (clientSecret && advertised.includes("client_secret_basic")) return "client_secret_basic";
    if (clientSecret && advertised.includes("client_secret_post")) return "client_secret_post";
    // Existing manually configured and preconfigured clients predate the
    // persisted method field and already use client_secret_post successfully.
    return clientSecret ? "client_secret_post" : "none";
  }

  async function registerOAuthClient(input: {
    connection: typeof toolConnections.$inferSelect;
    endpoints: OAuthProviderEndpoints;
    redirectUri: string;
    actor?: ActorInfo;
  }) {
    if (!input.endpoints.registrationUrl) {
      throw unprocessable("OAuth provider does not advertise dynamic client registration", {
        code: "oauth_dcr_not_supported",
      });
    }
    if (
      input.endpoints.codeChallengeMethodsSupported?.length
      && !input.endpoints.codeChallengeMethodsSupported.includes("S256")
    ) {
      throw unprocessable("OAuth provider does not support the required PKCE S256 method", {
        code: "oauth_pkce_s256_required",
      });
    }
    const tokenEndpointAuthMethod = selectOAuthDcrTokenEndpointAuthMethod(
      input.endpoints.tokenEndpointAuthMethodsSupported,
    );

    const host = new URL(input.redirectUri).host;
    const requestedMetadata = {
      client_name: `Paperclip (${host})`,
      redirect_uris: [input.redirectUri],
      grant_types: [
        "authorization_code",
        ...(!input.endpoints.grantTypesSupported?.length
          || input.endpoints.grantTypesSupported.includes("refresh_token")
          ? ["refresh_token"]
          : []),
      ],
      response_types: ["code"],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      // RFC 7591: Paperclip's callback is a server-side HTTPS endpoint, so this
      // is a `web` client, not a `native` one. Some authorization servers reject
      // an https redirect URI when the default (`web`) is left implicit, and
      // others apply native-client redirect rules without it.
      application_type: "web",
    };
    const response = await fetchRemoteHttpUrl(assertOAuthEndpointUrl("registration", input.endpoints.registrationUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestedMetadata),
    });
    const record = asRecord(await response.json().catch(() => ({})) as unknown);
    if (!response.ok) {
      const providerError = normalizeOAuthProviderError(record.error);
      throw new HttpError(502, oauthProviderErrorMessage(providerError, "OAuth dynamic client registration failed"), {
        code: "oauth_dynamic_client_registration_failed",
        providerError,
        status: response.status,
      });
    }
    const clientId = parseOAuthDcrString(record, "client_id", {
      required: true,
      maxLength: MAX_OAUTH_DCR_CLIENT_ID_LENGTH,
    })!;
    const clientSecret = parseOAuthDcrString(record, "client_secret", {
      required: tokenEndpointAuthMethod !== "none",
      maxLength: MAX_OAUTH_DCR_CLIENT_SECRET_LENGTH,
    });
    // Some authorization servers add provider-owned metadata to the registered
    // client. Paperclip still uses only the exact redirect, grant and response
    // types it requested, so accept bounded supersets while requiring every
    // requested value to remain present. Hugging Face, for example, adds the
    // device-code grant to an otherwise valid authorization-code registration.
    assertOAuthDcrArray(record, "redirect_uris", requestedMetadata.redirect_uris, { allowAdditional: true });
    // RFC 7591 registration responses do not consistently echo every accepted
    // request field. Supabase, for example, returns only the client material and
    // redirect URIs. Redirect binding remains mandatory; omitted grant/response
    // metadata inherits the values Paperclip requested. Additional provider-owned
    // values do not widen Paperclip's behavior because they are never persisted as
    // a flow choice or sent in authorization/token requests.
    assertOAuthDcrArray(record, "grant_types", requestedMetadata.grant_types, {
      allowAdditional: true,
      allowOmitted: true,
    });
    assertOAuthDcrArray(record, "response_types", requestedMetadata.response_types, {
      allowAdditional: true,
      allowOmitted: true,
    });
    if (
      record.token_endpoint_auth_method !== undefined
      && record.token_endpoint_auth_method !== requestedMetadata.token_endpoint_auth_method
    ) {
      throw invalidOAuthDcrResponse("token_endpoint_auth_method", "registered_value_mismatch");
    }
    const clientIdIssuedAt = parseOAuthDcrTimestamp(record, "client_id_issued_at");
    const returnedClientSecretExpiresAt = parseOAuthDcrTimestamp(record, "client_secret_expires_at");
    // A few public-client registrars (including Mixpanel) return the RFC 7591
    // `0` sentinel even though they issued no secret. It carries no credential
    // lifetime in that case, so normalize it away. A positive expiry without a
    // secret is still contradictory and remains a hard failure.
    if (returnedClientSecretExpiresAt !== null && returnedClientSecretExpiresAt > 0 && clientSecret === null) {
      throw invalidOAuthDcrResponse("client_secret_expires_at", "client_secret_missing");
    }
    const clientSecretExpiresAt = clientSecret ? returnedClientSecretExpiresAt : null;
    const existingClientSecretRef = oauthSecretRef(input.connection, "oauth.client_secret");
    const nextCredentialSecretRefs = input.connection.credentialSecretRefs.filter(
      (ref) => ref.configPath !== "oauth.client_secret",
    );
    if (clientSecret) {
      const clientSecretRef = await createOrRotateOAuthSecret({
        companyId: input.connection.companyId,
        connection: input.connection,
        configPath: "oauth.client_secret",
        label: "OAuth client secret",
        value: clientSecret,
        actor: input.actor,
      });
      nextCredentialSecretRefs.push(clientSecretRef);
    } else if (existingClientSecretRef && oauthConfig(input.connection).clientId === clientId) {
      nextCredentialSecretRefs.push(existingClientSecretRef);
    }

    const oauth = oauthConfig(input.connection);
    const nextConfig = {
      ...input.connection.config,
      oauth: {
        ...oauth,
        provider: input.endpoints.provider,
        authorizationUrl: input.endpoints.authorizationUrl,
        tokenUrl: input.endpoints.tokenUrl,
        registrationUrl: input.endpoints.registrationUrl,
        metadataUrl: input.endpoints.metadataUrl ?? null,
        scopes: input.endpoints.scopes,
        codeChallengeMethodsSupported: input.endpoints.codeChallengeMethodsSupported ?? [],
        tokenEndpointAuthMethodsSupported: input.endpoints.tokenEndpointAuthMethodsSupported ?? [],
        issuer: input.endpoints.issuer ?? oauth.issuer ?? null,
        resource: input.endpoints.resource ?? oauth.resource ?? null,
        clientId,
        clientRegistrationSource: "dcr" satisfies OAuthClientRegistrationSource,
        clientTokenEndpointAuthMethod: tokenEndpointAuthMethod,
        clientRedirectUri: input.redirectUri,
        // Registered client material is only valid for the issuer/resource pair
        // it was minted against. `assertOAuthClientBinding` re-registers when any
        // of these move, so a re-pointed endpoint can never silently reuse a
        // client another authorization server issued.
        clientIssuer: input.endpoints.issuer ?? null,
        clientResource: input.endpoints.resource ?? null,
        clientCompanyId: input.connection.companyId,
        clientIdIssuedAt,
        clientSecretExpiresAt,
      },
    };
    const [updated] = await db
      .update(toolConnections)
      .set({
        ownership: "dcr",
        config: nextConfig,
        transportConfig: nextConfig,
        credentialSecretRefs: nextCredentialSecretRefs,
        updatedAt: now(),
      })
      .where(and(
        eq(toolConnections.id, input.connection.id),
        eq(toolConnections.companyId, input.connection.companyId),
      ))
      .returning();
    if (!updated) throw notFound("Tool connection not found");
    await syncCredentialBindings(updated);
    return updated;
  }

  /**
   * Adopt a Client ID Metadata Document as this connection's client: the
   * `client_id` *is* the https URL of Paperclip's published client metadata, so
   * there is nothing to register with the authorization server. Still recorded on
   * the connection so the issuer/resource/callback binding is enforced on reuse
   * exactly like a dynamically registered client.
   */
  async function adoptClientIdMetadataDocument(input: {
    connection: typeof toolConnections.$inferSelect;
    endpoints: OAuthProviderEndpoints;
    redirectUri: string;
    clientId: string;
  }) {
    const oauth = oauthConfig(input.connection);
    const nextConfig = {
      ...input.connection.config,
      oauth: {
        ...oauth,
        provider: input.endpoints.provider,
        authorizationUrl: input.endpoints.authorizationUrl,
        tokenUrl: input.endpoints.tokenUrl,
        registrationUrl: input.endpoints.registrationUrl ?? null,
        metadataUrl: input.endpoints.metadataUrl ?? null,
        scopes: input.endpoints.scopes,
        codeChallengeMethodsSupported: input.endpoints.codeChallengeMethodsSupported ?? [],
        tokenEndpointAuthMethodsSupported: input.endpoints.tokenEndpointAuthMethodsSupported ?? [],
        clientIdMetadataDocumentSupported: true,
        issuer: input.endpoints.issuer ?? oauth.issuer ?? null,
        resource: input.endpoints.resource ?? oauth.resource ?? null,
        clientId: input.clientId,
        clientRegistrationSource: "cimd" satisfies OAuthClientRegistrationSource,
        clientTokenEndpointAuthMethod: "none",
        clientRedirectUri: input.redirectUri,
        clientIssuer: input.endpoints.issuer ?? null,
        clientResource: input.endpoints.resource ?? null,
        clientCompanyId: input.connection.companyId,
      },
    };
    // A CIMD client has no secret. Drop any leftover one so a stale credential
    // from an earlier registration can never be replayed against a new issuer.
    const nextCredentialSecretRefs = input.connection.credentialSecretRefs.filter(
      (ref) => ref.configPath !== "oauth.client_secret",
    );
    const [updated] = await db
      .update(toolConnections)
      .set({
        authKind: "oauth",
        config: nextConfig,
        transportConfig: nextConfig,
        credentialSecretRefs: nextCredentialSecretRefs,
        updatedAt: now(),
      })
      .where(and(
        eq(toolConnections.id, input.connection.id),
        eq(toolConnections.companyId, input.connection.companyId),
      ))
      .returning();
    if (!updated) throw notFound("Tool connection not found");
    await syncCredentialBindings(updated);
    return updated;
  }

  /**
   * How the client already stored on this connection was obtained. Anything
   * unrecognised (including connections written before this field existed) reads
   * as `manual`, which is the conservative answer: Paperclip will not silently
   * re-register over client material it cannot prove it minted.
   */
  function storedOAuthClientRegistrationSource(
    connection: typeof toolConnections.$inferSelect,
  ): OAuthClientRegistrationSource {
    const source = oauthConfig(connection).clientRegistrationSource;
    return source === "cimd" || source === "dcr" || source === "preconfigured" ? source : "manual";
  }

  /**
   * Is the client material already stored on this connection still valid for the
   * authorization server, MCP resource, callback URI and company we are about to
   * use it with? Client credentials are minted against exactly one such tuple;
   * reusing them across a moved binding would let a re-pointed endpoint borrow
   * another server's registration.
   */
  function oauthClientBindingMatches(
    connection: typeof toolConnections.$inferSelect,
    endpoints: OAuthProviderEndpoints,
    redirectUri: string,
    clientIdMetadataDocumentUrl: string | null,
  ): boolean {
    const oauth = oauthConfig(connection);
    if (typeof oauth.clientId !== "string" || !oauth.clientId.trim()) return false;
    const source = typeof oauth.clientRegistrationSource === "string" ? oauth.clientRegistrationSource : null;
    // Older interrupted setup flows could accidentally round-trip a DCR client
    // through the customer-client form and relabel it `manual`. Ownership is the
    // durable proof that Paperclip minted that client. Force a fresh registration
    // instead of preserving the damaged binding forever.
    if (source === "manual" && connection.ownership === "dcr") return false;
    // A URL client id that now resolves only to a private network is unusable by
    // an external authorization server. Treat the stored binding as stale so a
    // retry can replace it with a dynamically registered client.
    if (source === "cimd" && oauth.clientId !== clientIdMetadataDocumentUrl) return false;
    // A manually preregistered client was registered by the operator against
    // Paperclip's callback, so it has no recorded callback until first use.
    const redirectMatches = source === "manual"
      ? oauth.clientRedirectUri === undefined
        || oauth.clientRedirectUri === null
        || oauth.clientRedirectUri === redirectUri
      : oauth.clientRedirectUri === redirectUri;
    if (!redirectMatches) return false;
    if (typeof oauth.clientCompanyId === "string" && oauth.clientCompanyId !== connection.companyId) return false;
    if (
      endpoints.issuer
      && typeof oauth.clientIssuer === "string"
      && oauth.clientIssuer
      && !sameOAuthIssuer(oauth.clientIssuer, endpoints.issuer)
    ) {
      return false;
    }
    if (
      endpoints.resource
      && typeof oauth.clientResource === "string"
      && oauth.clientResource
      && oauth.clientResource !== endpoints.resource
    ) {
      return false;
    }
    return true;
  }

  /**
   * Record the issuer/resource/callback/company a client is bound to, the first
   * time that client is actually used.
   *
   * A dynamically registered or CIMD client is stamped at registration. A client
   * the operator pasted in has no binding until now — without this, its
   * `clientRedirectUri` would stay unset forever and `oauthClientBindingMatches`
   * would keep accepting it for *any* callback, which is exactly the drift the
   * binding check exists to catch.
   */
  async function stampOAuthClientBinding(
    connection: typeof toolConnections.$inferSelect,
    endpoints: OAuthProviderEndpoints,
    redirectUri: string,
  ): Promise<typeof toolConnections.$inferSelect> {
    const oauth = oauthConfig(connection);
    const nextBinding = {
      clientRedirectUri: redirectUri,
      clientIssuer: typeof oauth.clientIssuer === "string" && oauth.clientIssuer
        ? oauth.clientIssuer
        : endpoints.issuer ?? null,
      clientResource: typeof oauth.clientResource === "string" && oauth.clientResource
        ? oauth.clientResource
        : endpoints.resource ?? null,
      clientCompanyId: typeof oauth.clientCompanyId === "string" && oauth.clientCompanyId
        ? oauth.clientCompanyId
        : connection.companyId,
    };
    const unchanged = Object.entries(nextBinding).every(([key, value]) => oauth[key] === value);
    if (unchanged) return connection;
    const nextConfig = { ...connection.config, oauth: { ...oauth, ...nextBinding } };
    const [updated] = await db
      .update(toolConnections)
      .set({ config: nextConfig, transportConfig: nextConfig, updatedAt: now() })
      .where(and(
        eq(toolConnections.id, connection.id),
        eq(toolConnections.companyId, connection.companyId),
      ))
      .returning();
    return updated ?? connection;
  }

  /**
   * May Paperclip mint client material for this connection without an operator
   * pasting client credentials?
   *
   * A curated app opts in through its `ownershipModes`. A generic remote MCP
   * connection may register once — and only once — protected-resource and
   * authorization-server discovery actually produced a metadata document; an
   * endpoint that merely returned a 401 does not earn a registration.
   */
  function canRegisterOAuthClientDynamically(
    connection: typeof toolConnections.$inferSelect,
    endpoints: OAuthProviderEndpoints,
    galleryEntry: AppDefinition | null,
  ): boolean {
    if (galleryEntry) {
      return connectionMethodForConnection(galleryEntry, connection).ownershipModes.includes("dcr");
    }
    return connection.transport === "mcp_remote" && Boolean(endpoints.metadataUrl);
  }

  async function ensureOAuthClient(input: {
    connection: typeof toolConnections.$inferSelect;
    endpoints: OAuthProviderEndpoints;
    redirectUri: string;
    galleryEntry: AppDefinition | null;
    actor?: ActorInfo;
  }) {
    // 1. A client the deployment preconfigured for this issuer wins outright.
    const configured = configuredOAuthClientForConnection(input.connection, input.endpoints.provider);
    if (configured.clientId) {
      return { connection: input.connection, client: configured, source: "preconfigured" as const };
    }
    const metadataDocumentUrl = input.endpoints.clientIdMetadataDocumentSupported
      ? await resolveOAuthClientIdMetadataDocumentUrl(input.redirectUri, options.oauthClientMetadataLookup)
      : null;
    // 2. Client material already bound to this issuer/resource/callback/company.
    if (oauthClientBindingMatches(input.connection, input.endpoints, input.redirectUri, metadataDocumentUrl)) {
      const bound = await stampOAuthClientBinding(input.connection, input.endpoints, input.redirectUri);
      return {
        connection: bound,
        client: await oauthClientForConnection(bound, input.endpoints.provider, input.actor),
        source: storedOAuthClientRegistrationSource(bound),
      };
    }
    const oauth = oauthConfig(input.connection);
    if (
      oauth.clientRegistrationSource === "manual"
      && input.connection.ownership !== "dcr"
      && typeof oauth.clientId === "string"
      && oauth.clientId.trim()
    ) {
      // Paperclip cannot re-register on the operator's behalf: the credentials
      // came from a console this deployment does not control.
      throw unprocessable(
        "This connection's sign-in details no longer match the server it points at. Re-enter the client ID and secret to continue.",
        { code: "oauth_manual_client_rebinding_required" },
      );
    }
    if (!canRegisterOAuthClientDynamically(input.connection, input.endpoints, input.galleryEntry)) {
      throw unprocessable(`OAuth client id is not configured for ${input.endpoints.provider}`, {
        code: "oauth_client_registration_unavailable",
      });
    }

    const key = `${input.connection.id}:${input.redirectUri}`;
    return singleFlight(oauthRegistrationFlights, key, async () => {
      const latest = await getConnectionRow(input.connection.id, input.connection.companyId);
      const latestConfigured = configuredOAuthClientForConnection(latest, input.endpoints.provider);
      if (latestConfigured.clientId) {
        return { connection: latest, client: latestConfigured, source: "preconfigured" as const };
      }
      if (oauthClientBindingMatches(latest, input.endpoints, input.redirectUri, metadataDocumentUrl)) {
        const bound = await stampOAuthClientBinding(latest, input.endpoints, input.redirectUri);
        return {
          connection: bound,
          client: await oauthClientForConnection(bound, input.endpoints.provider, input.actor),
          source: storedOAuthClientRegistrationSource(bound),
        };
      }
      // 3. Client ID Metadata Documents: no registration call at all, so prefer
      //    them over DCR when the authorization server advertises support.
      if (metadataDocumentUrl) {
        const adopted = await adoptClientIdMetadataDocument({
          connection: latest,
          endpoints: input.endpoints,
          redirectUri: input.redirectUri,
          clientId: metadataDocumentUrl,
        });
        return {
          connection: adopted,
          client: await oauthClientForConnection(adopted, input.endpoints.provider, input.actor),
          source: "cimd" as const,
        };
      }
      // 4. Dynamic client registration.
      if (!input.endpoints.registrationUrl) {
        throw unprocessable(
          "This server needs sign-in details you create yourself. Add a client ID and secret under Advanced authentication.",
          { code: "oauth_manual_client_required" },
        );
      }
      const registered = await registerOAuthClient({
        connection: latest,
        endpoints: input.endpoints,
        redirectUri: input.redirectUri,
        actor: input.actor,
      });
      return {
        connection: registered,
        client: await oauthClientForConnection(registered, input.endpoints.provider, input.actor),
        source: "dcr" as const,
      };
    });
  }

  async function exchangeOAuthToken(input: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string | null;
    tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
    grantType?: "authorization_code" | "refresh_token" | "client_credentials";
    scopes?: string[];
    redirectUri?: string | null;
    codeVerifier?: string | null;
    code?: string | null;
    refreshToken?: string | null;
    /** RFC 8707 resource indicator: the MCP server this token is for. */
    resource?: string | null;
  }) {
    const body = new URLSearchParams();
    if (input.grantType === "client_credentials") {
      body.set("grant_type", "client_credentials");
      if (input.scopes && input.scopes.length > 0) body.set("scope", input.scopes.join(" "));
    } else if (input.refreshToken) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", input.refreshToken);
    } else {
      body.set("grant_type", "authorization_code");
      body.set("code", input.code ?? "");
      body.set("redirect_uri", input.redirectUri ?? "");
      body.set("code_verifier", input.codeVerifier ?? "");
    }
    const tokenEndpointAuthMethod = input.tokenEndpointAuthMethod
      ?? (input.clientSecret ? "client_secret_post" : "none");
    if (tokenEndpointAuthMethod !== "client_secret_basic") body.set("client_id", input.clientId);
    if (tokenEndpointAuthMethod === "client_secret_post") {
      if (!input.clientSecret) {
        throw unprocessable("OAuth client secret is missing for client_secret_post authentication", {
          code: "oauth_client_secret_missing",
        });
      }
      body.set("client_secret", input.clientSecret);
    }
    // RFC 8707: repeat the resource indicator on the token request so the
    // authorization server audience-restricts the access token (and any refresh
    // exchange) to this MCP server.
    if (input.resource) body.set("resource", input.resource);

    // The token URL can come from a connection row written before the endpoint
    // gate existed, so a client secret / authorization code never leaves
    // Paperclip without re-checking the transport it would leave over.
    const tokenUrl = assertOAuthEndpointUrl("token", input.tokenUrl, {
      // Paperclip's own callback origin, so a first-party token endpoint keeps
      // working on a deployment that is itself served over plaintext HTTP.
      firstPartyOrigin: originOf(input.redirectUri),
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (tokenEndpointAuthMethod === "client_secret_basic") {
      if (!input.clientSecret) {
        throw unprocessable("OAuth client secret is missing for client_secret_basic authentication", {
          code: "oauth_client_secret_missing",
        });
      }
      const formEncode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
      headers.Authorization = `Basic ${Buffer.from(
        `${formEncode(input.clientId)}:${formEncode(input.clientSecret)}`,
        "utf8",
      ).toString("base64")}`;
    }
    const response = await fetchRemoteHttpUrl(tokenUrl, {
      method: "POST",
      headers,
      body,
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    const record = asRecord(payload);
    if (!response.ok || record.ok === false) {
      const providerError = normalizeOAuthProviderError(record.error);
      const message = oauthProviderErrorMessage(providerError, "OAuth token exchange failed");
      if (input.grantType === "refresh_token" && providerError === "invalid_grant") {
        throw new HttpError(422, "OAuth authorization has expired. Reconnect this app to continue.", {
          code: "oauth_reauthorization_required",
          providerError,
          status: response.status,
        });
      }
      throw new HttpError(502, message, {
        code: "oauth_token_exchange_failed",
        providerError,
        status: response.status,
      });
    }
    const accessToken = typeof record.access_token === "string" ? record.access_token : null;
    if (!accessToken) throw new HttpError(502, "OAuth provider did not return an access token", { code: "oauth_access_token_missing" });
    const expiresIn = typeof record.expires_in === "number" ? record.expires_in : Number(record.expires_in);
    return {
      accessToken,
      refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : null,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
      scope: typeof record.scope === "string" ? record.scope : null,
      tokenType: typeof record.token_type === "string" ? record.token_type : "Bearer",
      raw: record,
    };
  }

  function withoutOAuthRefreshLease(oauth: Record<string, unknown>) {
    const { refreshLease: _refreshLease, ...rest } = oauth;
    return rest;
  }

  function oauthRefreshLeaseId(connection: typeof toolConnections.$inferSelect): string | null {
    const lease = asRecord(oauthConfig(connection).refreshLease);
    return typeof lease.id === "string" && lease.id ? lease.id : null;
  }

  async function clearOAuthRefreshLease(
    connection: typeof toolConnections.$inferSelect,
    leaseId: string,
  ) {
    const latest = await getConnectionRow(connection.id, connection.companyId);
    if (oauthRefreshLeaseId(latest) !== leaseId) return latest;
    const nextConfig = {
      ...latest.config,
      oauth: withoutOAuthRefreshLease(oauthConfig(latest)),
    };
    const [updated] = await db
      .update(toolConnections)
      .set({ config: nextConfig, transportConfig: nextConfig, updatedAt: now() })
      .where(and(
        eq(toolConnections.id, latest.id),
        eq(toolConnections.companyId, latest.companyId),
        sql`${toolConnections.config} -> 'oauth' -> 'refreshLease' ->> 'id' = ${leaseId}`,
      ))
      .returning();
    return updated ?? getConnectionRow(connection.id, connection.companyId);
  }

  async function acquireOAuthRefreshLease(
    connection: typeof toolConnections.$inferSelect,
  ): Promise<{ connection: typeof toolConnections.$inferSelect; leaseId: string | null }> {
    const waitDeadline = Date.now() + OAUTH_REFRESH_LEASE_WAIT_MS;
    while (true) {
      const latest = await getConnectionRow(connection.id, connection.companyId);
      const latestExpiresAtMs = oauthExpiresAtMs(latest);
      if (latestExpiresAtMs && latestExpiresAtMs > Date.now() + 60_000) {
        return { connection: latest, leaseId: null };
      }

      const oauth = oauthConfig(latest);
      const currentLease = asRecord(oauth.refreshLease);
      const currentLeaseExpiresAt = typeof currentLease.expiresAt === "string"
        ? Date.parse(currentLease.expiresAt)
        : Number.NaN;
      const currentLeaseId = typeof currentLease.id === "string" && currentLease.id
        ? currentLease.id
        : null;
      const leaseIsActive = currentLeaseId !== null
        && Number.isFinite(currentLeaseExpiresAt)
        && currentLeaseExpiresAt > Date.now();
      if (!currentLeaseId) {
        const leaseId = randomUUID();
        const claimedAt = now();
        const nextConfig = {
          ...latest.config,
          oauth: {
            ...withoutOAuthRefreshLease(oauth),
            refreshLease: {
              id: leaseId,
              expiresAt: new Date(Date.now() + OAUTH_REFRESH_LEASE_MS).toISOString(),
            },
          },
        };
        const [claimed] = await db
          .update(toolConnections)
          .set({ config: nextConfig, transportConfig: nextConfig, updatedAt: claimedAt })
          .where(and(
            eq(toolConnections.id, latest.id),
            eq(toolConnections.companyId, latest.companyId),
            sql`${toolConnections.config} = ${JSON.stringify(latest.config)}::jsonb`,
            sql`${toolConnections.config} #>> '{oauth,refreshLease,id}' is null`,
          ))
          .returning();
        if (claimed) return { connection: claimed, leaseId };
      }

      if (currentLeaseId && !leaseIsActive) {
        throw new HttpError(422, "The previous OAuth refresh did not finish. Reconnect this app before retrying.", {
          code: "oauth_refresh_outcome_unknown",
          setupUrl: connectionSetupUrl(latest),
          reconnectUrl: connectionReconnectUrl(latest),
        });
      }

      if (Date.now() >= waitDeadline) {
        throw conflict("OAuth credential refresh is already in progress", {
          code: "oauth_refresh_in_progress",
          retryable: true,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, OAUTH_REFRESH_LEASE_POLL_MS));
    }
  }

  async function markOAuthReauthorizationRequired(
    connection: typeof toolConnections.$inferSelect,
    guard: {
      leaseId: string;
      refreshSecretId: string;
      refreshTokenVersion: number;
    },
  ) {
    const oauth = oauthConfig(connection);
    const nextCredentialSecretRefs = connection.credentialSecretRefs.filter(
      (ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token",
    );
    const nextCredentialRefs = connection.credentialRefs.filter((ref) => ref.name !== "oauth.access_token");
    const nextConfig = {
      ...connection.config,
      oauth: {
        ...withoutOAuthRefreshLease(oauth),
        expiresAt: null,
        reauthorizationRequiredAt: now().toISOString(),
      },
    };
    const [updated] = await db
      .update(toolConnections)
      .set({
        status: "draft",
        enabled: false,
        healthStatus: "error",
        healthMessage: "OAuth authorization expired. Reconnect this app to continue.",
        lastError: "oauth_reauthorization_required",
        config: nextConfig,
        transportConfig: nextConfig,
        credentialSecretRefs: nextCredentialSecretRefs,
        credentialRefs: nextCredentialRefs,
        updatedAt: now(),
      })
      .where(and(
        eq(toolConnections.id, connection.id),
        eq(toolConnections.companyId, connection.companyId),
        sql`${toolConnections.config} -> 'oauth' -> 'refreshLease' ->> 'id' = ${guard.leaseId}`,
        sql`exists (
          select 1 from ${companySecrets}
          where ${companySecrets.id} = ${guard.refreshSecretId}
            and ${companySecrets.companyId} = ${connection.companyId}
            and ${companySecrets.latestVersion} = ${guard.refreshTokenVersion}
        )`,
      ))
      .returning();
    if (updated) await syncCredentialBindings(updated);
    return updated ?? null;
  }

  async function refreshOAuthCredentials(
    connection: typeof toolConnections.$inferSelect,
    leaseId: string,
    actor?: ActorInfo,
    accessContext?: {
      actorSource?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant";
      issueId?: string | null;
      heartbeatRunId?: string | null;
    },
  ): Promise<typeof toolConnections.$inferSelect> {
    const oauth = oauthConfig(connection);
    if (typeof oauth.tokenUrl !== "string" || typeof oauth.provider !== "string") return connection;
    const expiresAtMs = oauthExpiresAtMs(connection);
    if (expiresAtMs && expiresAtMs > Date.now() + 60_000) return connection;
    const grantType = oauth.grantType === "client_credentials" || oauth.clientCredentials === true
      ? "client_credentials" as const
      : "refresh_token" as const;
    const refreshRef = oauthSecretRef(connection, "oauth.refresh_token");
    if (grantType !== "client_credentials" && !refreshRef) {
      throw new HttpError(422, "OAuth credentials have expired and no refresh token is available", {
        code: "oauth_refresh_missing",
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
      });
    }
    const client = await oauthClientForConnection(connection, oauth.provider, actor);
    if (!client.clientId) throw unprocessable(`OAuth client id is not configured for ${oauth.provider}`);
    const [refreshSecret] = refreshRef
      ? await db
          .select({ latestVersion: companySecrets.latestVersion })
          .from(companySecrets)
          .where(and(
            eq(companySecrets.id, refreshRef.secretId),
            eq(companySecrets.companyId, connection.companyId),
          ))
          .limit(1)
      : [undefined];
    const refreshTokenVersion = refreshSecret?.latestVersion ?? null;
    const refreshToken = refreshRef && refreshTokenVersion !== null
      ? await secrets.resolveSecretValue(connection.companyId, refreshRef.secretId, refreshTokenVersion, {
          consumerType: "tool_connection",
          consumerId: connection.id,
          configPath: "oauth.refresh_token",
          actorType: actor?.actorType ?? "system",
          actorId: actor?.actorId ?? null,
          actorSource: accessContext?.actorSource,
          issueId: accessContext?.issueId,
          heartbeatRunId: accessContext?.heartbeatRunId,
        })
      : null;
    let token: Awaited<ReturnType<typeof exchangeOAuthToken>>;
    try {
      token = await exchangeOAuthToken({
        tokenUrl: oauth.tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenEndpointAuthMethod: storedOAuthTokenEndpointAuthMethod(oauth, client.clientSecret),
        grantType,
        scopes: normalizeOauthScopes(oauth.scopes).length > 0 ? normalizeOauthScopes(oauth.scopes) : normalizeOauthScopes(oauth.scope),
        refreshToken,
        // Refreshing must stay bound to the same MCP server the original grant
        // named, or the authorization server may widen the token's audience.
        resource: typeof oauth.resource === "string" && oauth.resource ? oauth.resource : null,
      });
    } catch (error) {
      if (error instanceof HttpError && asRecord(error.details).code === "oauth_reauthorization_required") {
        const marked = refreshRef && refreshTokenVersion !== null
          ? await markOAuthReauthorizationRequired(connection, {
              leaseId,
              refreshSecretId: refreshRef.secretId,
              refreshTokenVersion,
            })
          : null;
        if (!marked) {
          const latest = await getConnectionRow(connection.id, connection.companyId);
          const latestExpiresAtMs = oauthExpiresAtMs(latest);
          if (latestExpiresAtMs && latestExpiresAtMs > Date.now() + 60_000) return latest;
          throw conflict("OAuth credentials changed while refresh was in progress. Retry the request.", {
            code: "oauth_refresh_superseded",
            retryable: true,
          });
        }
        throw new HttpError(error.status, error.message, {
          ...asRecord(error.details),
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
        });
      }
      throw error;
    }
    // Rotating providers invalidate the submitted refresh token immediately.
    // Persist its replacement before the new access token can be returned to a
    // caller, so a crash cannot leave the grant with only the consumed token.
    let nextRefreshRef: Awaited<ReturnType<typeof createOrRotateOAuthSecret>> | null = null;
    if (token.refreshToken) {
      nextRefreshRef = await createOrRotateOAuthSecret({
        companyId: connection.companyId,
        connection,
        configPath: "oauth.refresh_token",
        label: "OAuth refresh token",
        value: token.refreshToken,
        actor,
      });
    }
    const accessRef = await createOrRotateOAuthSecret({
      companyId: connection.companyId,
      connection,
      configPath: "oauth.access_token",
      label: "OAuth access token",
      value: token.accessToken,
      actor,
    });
    const nextCredentialSecretRefs = [
      ...connection.credentialSecretRefs.filter((ref) =>
        ref.configPath !== "oauth.access_token"
        && (!nextRefreshRef || ref.configPath !== "oauth.refresh_token")
      ),
      accessRef,
      ...(nextRefreshRef ? [nextRefreshRef] : []),
    ];
    const expiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
    const nextConfig = {
      ...connection.config,
      oauth: {
        ...withoutOAuthRefreshLease(oauth),
        grantType: grantType === "client_credentials" ? grantType : oauth.grantType ?? "authorization_code",
        expiresAt,
        scope: token.scope ?? oauth.scope ?? null,
        tokenType: token.tokenType,
        refreshedAt: new Date().toISOString(),
      },
      providerMetadata: {
        ...asRecord(connection.config.providerMetadata),
        oauth: {
          expiresAt,
          scope: token.scope ?? oauth.scope ?? null,
          tokenType: token.tokenType,
        },
      },
    };
    const [updated] = await db
      .update(toolConnections)
      .set({
        config: nextConfig,
        transportConfig: nextConfig,
        credentialSecretRefs: nextCredentialSecretRefs,
        credentialRefs: [
          ...connection.credentialRefs.filter((ref) => ref.name !== "oauth.access_token"),
          {
            name: "oauth.access_token",
            secretId: accessRef.secretId,
            version: "latest" as const,
            placement: "header" as const,
            key: "Authorization",
            prefix: "Bearer ",
          },
        ],
        updatedAt: new Date(),
      })
      .where(and(
        eq(toolConnections.id, connection.id),
        eq(toolConnections.companyId, connection.companyId),
        sql`${toolConnections.config} -> 'oauth' -> 'refreshLease' ->> 'id' = ${leaseId}`,
      ))
      .returning();
    if (!updated) {
      throw conflict("OAuth credentials changed while refresh was in progress. Retry the request.", {
        code: "oauth_refresh_superseded",
        retryable: true,
      });
    }
    const previousBindingKeys = new Set(connection.credentialSecretRefs.map(
      (ref) => `${ref.secretId}:${ref.configPath}`,
    ));
    const nextBindingKeys = new Set(nextCredentialSecretRefs.map(
      (ref) => `${ref.secretId}:${ref.configPath}`,
    ));
    const bindingsChanged = previousBindingKeys.size !== nextBindingKeys.size
      || [...previousBindingKeys].some((key) => !nextBindingKeys.has(key));
    if (bindingsChanged) await syncCredentialBindings(updated);
    return updated;
  }

  function oauthGrantConfig(grant: typeof connectionGrants.$inferSelect) {
    return asRecord(asRecord(grant.providerTenant).oauth);
  }

  function withoutOAuthGrantRefreshLease(oauth: Record<string, unknown>) {
    const { refreshLease: _refreshLease, ...rest } = oauth;
    return rest;
  }

  function oauthGrantExpiresAtMs(
    grant: typeof connectionGrants.$inferSelect,
    connection: typeof toolConnections.$inferSelect,
  ): number | null {
    const grantExpiresAt = oauthGrantConfig(grant).accessTokenExpiresAt;
    const value = typeof grantExpiresAt === "string"
      ? grantExpiresAt
      : oauthConfig(connection).expiresAt;
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  async function getOAuthGrantRow(input: {
    companyId: string;
    connectionId: string;
    grantId: string;
  }) {
    const [grant] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.id, input.grantId),
      eq(connectionGrants.companyId, input.companyId),
      eq(connectionGrants.connectionId, input.connectionId),
    )).limit(1);
    if (!grant) throw notFound("Connection authorization not found");
    return grant;
  }

  async function resolveOAuthGrantSecret(
    connection: typeof toolConnections.$inferSelect,
    grant: typeof connectionGrants.$inferSelect,
    ref: ToolCredentialSecretRef,
    actor: ActorInfo | undefined,
    accessContext: { issueId?: string | null; heartbeatRunId?: string | null } | undefined,
  ) {
    const [secret] = await db.select({
      scope: companySecrets.scope,
      ownerUserId: companySecrets.ownerUserId,
      userSecretDefinitionId: companySecrets.userSecretDefinitionId,
      latestVersion: companySecrets.latestVersion,
    }).from(companySecrets).where(and(
      eq(companySecrets.id, ref.secretId),
      eq(companySecrets.companyId, connection.companyId),
    )).limit(1);
    if (!secret) throw notFound("OAuth credential secret not found");
    const consumerContext = {
      consumerType: "tool_connection" as const,
      consumerId: connection.id,
      configPath: ref.configPath,
      actorType: actor?.actorType ?? "system" as const,
      actorId: actor?.actorId ?? null,
      responsibleUserId: grant.subjectUserId,
      issueId: accessContext?.issueId,
      heartbeatRunId: accessContext?.heartbeatRunId,
    };
    if (secret.scope !== "user") {
      return {
        value: await secrets.resolveSecretValue(
          connection.companyId,
          ref.secretId,
          ref.versionSelector ?? "latest",
          consumerContext,
        ),
        latestVersion: secret.latestVersion,
      };
    }
    if (
      grant.kind !== "user"
      || !grant.subjectUserId
      || secret.ownerUserId !== grant.subjectUserId
      || !secret.userSecretDefinitionId
    ) {
      throw unprocessable("Personal authorization has an invalid credential", {
        code: "grant_credential_invalid",
        connectionId: connection.id,
        grantId: grant.id,
        credential: ref.configPath,
      });
    }
    const resolved = await secrets.resolveUserSecretValue(connection.companyId, {
      definitionId: secret.userSecretDefinitionId,
      responsibleUserId: grant.subjectUserId,
      version: ref.versionSelector ?? "latest",
      required: ref.required ?? true,
    }, consumerContext);
    if (!resolved) throw unprocessable("Personal OAuth credential is not configured", {
      code: "user_secret_missing",
      connectionId: connection.id,
      grantId: grant.id,
      credential: ref.configPath,
    });
    return { value: resolved.value, latestVersion: secret.latestVersion };
  }

  async function clearOAuthGrantRefreshLease(
    grant: typeof connectionGrants.$inferSelect,
    leaseId: string,
  ) {
    const latest = await getOAuthGrantRow({
      companyId: grant.companyId,
      connectionId: grant.connectionId,
      grantId: grant.id,
    });
    const oauth = oauthGrantConfig(latest);
    if (asRecord(oauth.refreshLease).id !== leaseId) return latest;
    const providerTenant = {
      ...(latest.providerTenant ?? {}),
      oauth: withoutOAuthGrantRefreshLease(oauth),
    };
    const [updated] = await db.update(connectionGrants).set({
      providerTenant,
      updatedAt: now(),
    }).where(and(
      eq(connectionGrants.id, latest.id),
      eq(connectionGrants.companyId, latest.companyId),
      sql`${connectionGrants.providerTenant} -> 'oauth' -> 'refreshLease' ->> 'id' = ${leaseId}`,
    )).returning();
    return updated ?? getOAuthGrantRow({
      companyId: grant.companyId,
      connectionId: grant.connectionId,
      grantId: grant.id,
    });
  }

  async function acquireOAuthGrantRefreshLease(
    connection: typeof toolConnections.$inferSelect,
    grant: typeof connectionGrants.$inferSelect,
    forceRefresh: boolean,
  ): Promise<{ grant: typeof connectionGrants.$inferSelect; leaseId: string | null }> {
    const waitDeadline = Date.now() + OAUTH_REFRESH_LEASE_WAIT_MS;
    const initialUpdatedAt = grant.updatedAt.getTime();
    while (true) {
      const latest = await getOAuthGrantRow({
        companyId: connection.companyId,
        connectionId: connection.id,
        grantId: grant.id,
      });
      if (latest.status !== "active") {
        throw unprocessable("OAuth authorization must be reconnected", {
          code: "oauth_reauthorization_required",
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
        });
      }
      const expiresAtMs = oauthGrantExpiresAtMs(latest, connection);
      if (
        (!forceRefresh && (expiresAtMs === null || expiresAtMs > Date.now() + 60_000))
        || (forceRefresh && latest.updatedAt.getTime() > initialUpdatedAt && !asRecord(oauthGrantConfig(latest).refreshLease).id)
      ) {
        return { grant: latest, leaseId: null };
      }

      const oauth = oauthGrantConfig(latest);
      const currentLease = asRecord(oauth.refreshLease);
      const currentLeaseId = typeof currentLease.id === "string" && currentLease.id
        ? currentLease.id
        : null;
      const currentLeaseExpiresAt = typeof currentLease.expiresAt === "string"
        ? Date.parse(currentLease.expiresAt)
        : Number.NaN;
      const leaseIsActive = currentLeaseId !== null
        && Number.isFinite(currentLeaseExpiresAt)
        && currentLeaseExpiresAt > Date.now();
      if (!currentLeaseId) {
        const leaseId = randomUUID();
        const providerTenant = {
          ...(latest.providerTenant ?? {}),
          oauth: {
            ...withoutOAuthGrantRefreshLease(oauth),
            refreshLease: {
              id: leaseId,
              expiresAt: new Date(Date.now() + OAUTH_REFRESH_LEASE_MS).toISOString(),
            },
          },
        };
        const [claimed] = await db.update(connectionGrants).set({
          providerTenant,
          updatedAt: now(),
        }).where(and(
          eq(connectionGrants.id, latest.id),
          eq(connectionGrants.companyId, latest.companyId),
          eq(connectionGrants.status, "active"),
          sql`${connectionGrants.providerTenant} #>> '{oauth,refreshLease,id}' is null`,
        )).returning();
        if (claimed) return { grant: claimed, leaseId };
      }
      if (currentLeaseId && !leaseIsActive) {
        throw unprocessable("The previous OAuth refresh did not finish. Reconnect this app before retrying.", {
          code: "oauth_refresh_outcome_unknown",
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
        });
      }
      if (Date.now() >= waitDeadline) {
        throw conflict("OAuth credential refresh is already in progress", {
          code: "oauth_refresh_in_progress",
          retryable: true,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, OAUTH_REFRESH_LEASE_POLL_MS));
    }
  }

  async function refreshOAuthGrantCredentials(input: {
    companyId: string;
    connectionId: string;
    grantId: string;
    forceRefresh?: boolean;
    actor?: ActorInfo;
    issueId?: string | null;
    heartbeatRunId?: string | null;
  }): Promise<typeof connectionGrants.$inferSelect> {
    const connection = await getConnectionRow(input.connectionId, input.companyId);
    const initialGrant = await getOAuthGrantRow(input);
    const oauth = oauthConfig(connection);
    const oauthProvider = typeof oauth.provider === "string" ? oauth.provider : null;
    const oauthTokenUrl = typeof oauth.tokenUrl === "string" ? oauth.tokenUrl : null;
    if (
      connection.authKind !== "oauth"
      || connection.credentialSource !== "paperclip_vault"
      || isPaperclipCloudConnectorStrategy(oauth.strategy)
      || !oauthTokenUrl
      || !oauthProvider
    ) {
      return initialGrant;
    }
    const expiresAtMs = oauthGrantExpiresAtMs(initialGrant, connection);
    if (!input.forceRefresh && (expiresAtMs === null || expiresAtMs > Date.now() + 60_000)) {
      return initialGrant;
    }

    return singleFlight(oauthGrantRefreshFlights, initialGrant.id, async () => {
      const lease = await acquireOAuthGrantRefreshLease(connection, initialGrant, input.forceRefresh === true);
      if (!lease.leaseId) return lease.grant;
      try {
        const grant = lease.grant;
        const refreshRef = grant.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token");
        if (!refreshRef) {
          throw unprocessable("OAuth credentials have expired and no refresh token is available", {
            code: "oauth_refresh_missing",
            setupUrl: connectionSetupUrl(connection),
            reconnectUrl: connectionReconnectUrl(connection),
          });
        }
        const refreshSecret = await resolveOAuthGrantSecret(
          connection,
          grant,
          refreshRef,
          input.actor,
          input,
        );
        const credentialActor: ActorInfo | undefined = grant.kind === "user" && grant.subjectUserId
          ? { actorType: "user", actorId: grant.subjectUserId }
          : input.actor;
        const client = await oauthClientForConnection(connection, oauthProvider, credentialActor);
        if (!client.clientId) throw unprocessable(`OAuth client id is not configured for ${oauthProvider}`);
        const grantOauth = oauthGrantConfig(grant);
        let token: Awaited<ReturnType<typeof exchangeOAuthToken>>;
        try {
          token = await exchangeOAuthToken({
            tokenUrl: oauthTokenUrl,
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            tokenEndpointAuthMethod: storedOAuthTokenEndpointAuthMethod(oauth, client.clientSecret),
            grantType: "refresh_token",
            scopes: normalizeOauthScopes(grantOauth.scopes).length > 0
              ? normalizeOauthScopes(grantOauth.scopes)
              : normalizeOauthScopes(oauth.scopes).length > 0
                ? normalizeOauthScopes(oauth.scopes)
                : normalizeOauthScopes(oauth.scope),
            refreshToken: refreshSecret.value,
            resource: typeof oauth.resource === "string" && oauth.resource ? oauth.resource : null,
          });
        } catch (error) {
          if (error instanceof HttpError && asRecord(error.details).code === "oauth_reauthorization_required") {
            const retainedCredentialSecretRefs = grant.credentialSecretRefs.filter(
              (ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token",
            );
            const providerTenant = {
              ...(grant.providerTenant ?? {}),
              oauth: {
                ...withoutOAuthGrantRefreshLease(grantOauth),
                accessTokenExpiresAt: undefined,
              },
            };
            const [marked] = await db.update(connectionGrants).set({
              status: "needs_reauthorization",
              providerTenant,
              credentialSecretRefs: retainedCredentialSecretRefs,
              updatedAt: now(),
            }).where(and(
              eq(connectionGrants.id, grant.id),
              eq(connectionGrants.companyId, grant.companyId),
              eq(connectionGrants.status, "active"),
              sql`${connectionGrants.providerTenant} -> 'oauth' -> 'refreshLease' ->> 'id' = ${lease.leaseId}`,
              sql`exists (
                select 1 from ${companySecrets}
                where ${companySecrets.id} = ${refreshRef.secretId}
                  and ${companySecrets.companyId} = ${connection.companyId}
                  and ${companySecrets.latestVersion} = ${refreshSecret.latestVersion}
              )`,
            )).returning();
            if (!marked) {
              const latest = await getOAuthGrantRow(input);
              const latestExpiresAt = oauthGrantExpiresAtMs(latest, connection);
              if (latest.status === "active" && latestExpiresAt && latestExpiresAt > Date.now() + 60_000) return latest;
              throw conflict("OAuth credentials changed while refresh was in progress. Retry the request.", {
                code: "oauth_refresh_superseded",
                retryable: true,
              });
            }
            if (marked.kind === "organization") {
              const latestConnection = await getConnectionRow(connection.id, connection.companyId);
              const [reauthorizationRequired] = await db.update(toolConnections).set({
                status: "draft",
                enabled: false,
                credentialSecretRefs: latestConnection.credentialSecretRefs.filter(
                  (ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token",
                ),
                credentialRefs: latestConnection.credentialRefs.filter(
                  (ref) => ref.name !== "oauth.access_token" && ref.name !== "oauth.refresh_token",
                ),
                updatedAt: now(),
              }).where(and(
                eq(toolConnections.id, latestConnection.id),
                eq(toolConnections.companyId, latestConnection.companyId),
              )).returning();
              await syncCredentialBindings(reauthorizationRequired);
            } else {
              const activeGrantRefs = await db.select({
                refs: connectionGrants.credentialSecretRefs,
              }).from(connectionGrants).where(and(
                eq(connectionGrants.companyId, connection.companyId),
                eq(connectionGrants.connectionId, connection.id),
                eq(connectionGrants.status, "active"),
              ));
              await syncCredentialBindings(connection, activeGrantRefs.flatMap((row) => row.refs));
            }
            throw new HttpError(error.status, error.message, {
              ...asRecord(error.details),
              setupUrl: connectionSetupUrl(connection),
              reconnectUrl: connectionReconnectUrl(connection),
            });
          }
          throw error;
        }

        let nextRefreshRef: ToolCredentialSecretRef | null = null;
        if (token.refreshToken) {
          nextRefreshRef = await createOrRotateOAuthSecret({
            companyId: connection.companyId,
            connection,
            configPath: "oauth.refresh_token",
            label: "OAuth refresh token",
            value: token.refreshToken,
            actor: credentialActor,
            existingRefs: grant.credentialSecretRefs,
            ownerUserId: grant.kind === "user" ? grant.subjectUserId ?? undefined : undefined,
          });
        }
        const accessRef = await createOrRotateOAuthSecret({
          companyId: connection.companyId,
          connection,
          configPath: "oauth.access_token",
          label: "OAuth access token",
          value: token.accessToken,
          actor: credentialActor,
          existingRefs: grant.credentialSecretRefs,
          ownerUserId: grant.kind === "user" ? grant.subjectUserId ?? undefined : undefined,
        });
        const nextCredentialSecretRefs = [
          ...grant.credentialSecretRefs.filter((ref) =>
            ref.configPath !== "oauth.access_token"
            && (!nextRefreshRef || ref.configPath !== "oauth.refresh_token")
          ),
          accessRef,
          ...(nextRefreshRef ? [nextRefreshRef] : []),
        ];
        const expiresAt = token.expiresIn
          ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
          : null;
        const providerTenant = {
          ...(grant.providerTenant ?? {}),
          oauth: {
            ...withoutOAuthGrantRefreshLease(grantOauth),
            strategy: typeof grantOauth.strategy === "string" ? grantOauth.strategy : "direct_oauth",
            accessTokenExpiresAt: expiresAt ?? undefined,
            scopes: normalizeOauthScopes(token.scope ?? grantOauth.scopes ?? oauth.scopes ?? oauth.scope),
            tokenType: token.tokenType,
            refreshedAt: now().toISOString(),
          },
        };
        const [updated] = await db.update(connectionGrants).set({
          providerTenant,
          credentialSecretRefs: nextCredentialSecretRefs,
          status: "active",
          updatedAt: now(),
        }).where(and(
          eq(connectionGrants.id, grant.id),
          eq(connectionGrants.companyId, grant.companyId),
          eq(connectionGrants.status, "active"),
          sql`${connectionGrants.providerTenant} -> 'oauth' -> 'refreshLease' ->> 'id' = ${lease.leaseId}`,
        )).returning();
        if (!updated) {
          throw conflict("OAuth credentials changed while refresh was in progress. Retry the request.", {
            code: "oauth_refresh_superseded",
            retryable: true,
          });
        }
        if (grant.kind === "organization") {
          const latestConnection = await getConnectionRow(connection.id, connection.companyId);
          const latestOauth = oauthConfig(latestConnection);
          const nextConfig = {
            ...latestConnection.config,
            oauth: {
              ...withoutOAuthRefreshLease(latestOauth),
              expiresAt,
              scope: token.scope ?? latestOauth.scope ?? null,
              tokenType: token.tokenType,
              refreshedAt: now().toISOString(),
            },
            providerMetadata: {
              ...asRecord(latestConnection.config.providerMetadata),
              oauth: {
                expiresAt,
                scope: token.scope ?? latestOauth.scope ?? null,
                tokenType: token.tokenType,
              },
            },
          };
          await db.update(toolConnections).set({
            config: nextConfig,
            transportConfig: nextConfig,
            updatedAt: now(),
          }).where(and(
            eq(toolConnections.id, latestConnection.id),
            eq(toolConnections.companyId, latestConnection.companyId),
          ));
        }
        const previousKeys = new Set(grant.credentialSecretRefs.map((ref) => `${ref.secretId}:${ref.configPath}`));
        const nextKeys = new Set(nextCredentialSecretRefs.map((ref) => `${ref.secretId}:${ref.configPath}`));
        if (previousKeys.size !== nextKeys.size || [...previousKeys].some((key) => !nextKeys.has(key))) {
          const activeGrantRefs = await db.select({
            refs: connectionGrants.credentialSecretRefs,
          }).from(connectionGrants).where(and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.status, "active"),
          ));
          await syncCredentialBindings(connection, activeGrantRefs.flatMap((row) => row.refs));
        }
        return updated;
      } finally {
        await clearOAuthGrantRefreshLease(lease.grant, lease.leaseId).catch(() => undefined);
      }
    });
  }

  async function maybeRefreshOAuthCredentials(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
    accessContext?: {
      actorSource?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant";
      issueId?: string | null;
      heartbeatRunId?: string | null;
    },
  ): Promise<typeof toolConnections.$inferSelect> {
    const oauth = oauthConfig(connection);
    if (typeof oauth.tokenUrl !== "string" || typeof oauth.provider !== "string") return connection;
    const expiresAtMs = oauthExpiresAtMs(connection);
    if (expiresAtMs && expiresAtMs > Date.now() + 60_000) return connection;
    return singleFlight(oauthRefreshFlights, connection.id, async () => {
      const lease = await acquireOAuthRefreshLease(connection);
      if (!lease.leaseId) return lease.connection;
      try {
        return await refreshOAuthCredentials(lease.connection, lease.leaseId, actor, accessContext);
      } finally {
        await clearOAuthRefreshLease(lease.connection, lease.leaseId).catch(() => undefined);
      }
    });
  }

  function policyNameForApp(connection: typeof toolConnections.$inferSelect, entry: typeof toolCatalogEntries.$inferSelect) {
    const base = `Ask first ${connection.id.slice(0, 8)} ${entry.toolName}`;
    return base.length <= 160 ? base : base.slice(0, 160);
  }

  async function connectGalleryApp(
    companyId: string,
    input: ConnectToolApp,
    actor?: ActorInfo,
  ): Promise<ConnectToolAppResult> {
    const galleryEntry = input.galleryKey ? getConnectableAppDefinition(input.galleryKey) : null;
    if (input.galleryKey && !galleryEntry) throw notFound("Tool app gallery entry not found");

    let existingApplication: typeof toolApplications.$inferSelect | null = null;
    let requestedResumeConnection: typeof toolConnections.$inferSelect | null = null;
    if (input.resumeConnectionId) {
      const [connection] = await db.select().from(toolConnections).where(and(
        eq(toolConnections.id, input.resumeConnectionId),
        eq(toolConnections.companyId, companyId),
      ));
      if (!connection) throw notFound("Incomplete app connection not found");
      if (connection.status !== "draft") {
        throw conflict("Only an incomplete app connection can resume setup", {
          code: "connection_setup_not_incomplete",
        });
      }
      if (input.applicationId && input.applicationId !== connection.applicationId) {
        throw badRequest("The app and draft connection do not match");
      }
      const [application] = await db.select().from(toolApplications).where(and(
        eq(toolApplications.id, connection.applicationId),
        eq(toolApplications.companyId, companyId),
      ));
      if (!application) throw notFound("App not found");
      requestedResumeConnection = connection;
      existingApplication = application;
    } else if (input.applicationId) {
      const [row] = await db.select().from(toolApplications).where(and(
        eq(toolApplications.id, input.applicationId),
        eq(toolApplications.companyId, companyId),
      ));
      if (!row) throw notFound("App not found");
      existingApplication = row;
    } else {
      // Removal and interrupted setup intentionally retain their
      // application/connection rows. A fresh gallery click has no
      // applicationId, so recover that retained identity by its company-unique
      // name and source instead of inserting a duplicate application that the
      // unique index rejects. Active applications are excluded: connecting a
      // second account still requires its own name/application identity.
      const requestedName = input.name ?? galleryEntry?.name ?? defaultLinkName(input.link ?? "");
      const recoverableApplicationStatuses = galleryEntry
        ? ["draft", "archived"] as const
        : ["archived"] as const;
      const [recoverableApplication] = await db
        .select()
        .from(toolApplications)
        .where(and(
          eq(toolApplications.companyId, companyId),
          eq(toolApplications.name, requestedName),
          inArray(toolApplications.status, recoverableApplicationStatuses),
        ))
        .orderBy(desc(toolApplications.updatedAt))
        .limit(1);
      const recoverableSource = recoverableApplication?.metadata
        ? recoverableApplication.metadata.sourceTemplateKey
          ?? recoverableApplication.metadata.galleryKey
          ?? recoverableApplication.metadata.source
        : null;
      const requestedSource = galleryEntry?.slug ?? (input.link ? "link" : null);
      if (recoverableApplication && requestedSource && recoverableSource === requestedSource) {
        existingApplication = recoverableApplication;
      }
    }

    const name = input.name ?? existingApplication?.name ?? galleryEntry?.name ?? defaultLinkName(input.link ?? "");
    // Compatibility for the original Sheets robot flow, whose clients predate
    // method selection and identify the method by its spreadsheet allowlist.
    const inferredMethodKey = !input.connectionMethodKey
      && galleryEntry?.slug === "google-sheets"
      && Array.isArray(input.configValues?.allowedSpreadsheetIds)
      ? "local"
      : input.connectionMethodKey;
    if (!galleryEntry && input.connectionMethodKey) throw badRequest("Connection method selection requires a gallery app");
    if (galleryEntry && getAvailableConnectionMethods(galleryEntry).length > 1 && !inferredMethodKey) {
      throw badRequest("Choose a connection method for this app");
    }
    const method = galleryEntry ? connectionMethodFor(galleryEntry, inferredMethodKey) : null;
    if (galleryEntry && input.link) {
      const acceptsProviderGeneratedUrl = method?.transport === "mcp_remote"
        && method.auth === "none"
        && !method.defaults?.serverUrl
        && !method.defaults?.serverUrlTemplate;
      if (!acceptsProviderGeneratedUrl) {
        throw badRequest(`${galleryEntry.name} does not accept a provider-generated connection URL`);
      }
      if (!getAppDefinitionForUrl(input.link, [galleryEntry])) {
        throw badRequest(`That connection URL does not belong to ${galleryEntry.name}`);
      }
    }
    if (requestedResumeConnection && galleryEntry) {
      const storedConnectionSource = requestedResumeConnection.config?.sourceTemplateKey
        ?? requestedResumeConnection.transportConfig?.sourceTemplateKey;
      const storedApplicationSource = existingApplication?.metadata?.sourceTemplateKey
        ?? existingApplication?.metadata?.galleryKey;
      if (storedConnectionSource !== galleryEntry.slug && storedApplicationSource !== galleryEntry.slug) {
        throw badRequest("The selected provider does not match this incomplete connection");
      }
    }
    // Reconnect is not a second identity decision. Removed connections retain
    // their row precisely so the next credential can be attached to the same
    // identity and history. Resolve that retained row before interpreting the
    // request so a client default cannot silently turn a personal connection
    // into an organization connection (or vice versa).
    const canResumeInterruptedDraft = Boolean(requestedResumeConnection) || (
      !input.applicationId
      && Boolean(galleryEntry)
      && existingApplication?.status === "draft"
    );
    const retainedConnectionStatuses = canResumeInterruptedDraft
      ? ["draft", "archived"] as const
      : ["archived"] as const;
    const [recoveredConnection] = !requestedResumeConnection && existingApplication
      ? await db
          .select()
          .from(toolConnections)
          .where(and(
            eq(toolConnections.companyId, companyId),
            eq(toolConnections.applicationId, existingApplication.id),
            inArray(toolConnections.status, retainedConnectionStatuses),
          ))
          .orderBy(desc(toolConnections.updatedAt))
          .limit(1)
      : [undefined];
    const retainedConnection = requestedResumeConnection ?? recoveredConnection;
    const retainedGrantKind: ConnectionGrantKind | null = retainedConnection
      ? retainedConnection.credentialPolicy === "per_user"
        ? "user"
        : "organization"
      : null;
    const requestedGrantKind = retainedGrantKind ?? input.grantKind ?? "organization";
    if (method?.grantKinds && !method.grantKinds.includes(requestedGrantKind)) {
      throw badRequest(`${galleryEntry?.name ?? "This app"} supports only ${method.grantKinds.join(" or ")} credentials`);
    }
    const transport = method?.transport ?? "mcp_remote";
    const credentialSource: ToolConnectionCredentialSource = input.credentialSource ?? "paperclip_vault";
    if (retainedConnection && retainedConnection.credentialSource !== credentialSource) {
      throw conflict("Changing credential source requires a new app connection", {
        code: "credential_source_migration_not_supported",
      });
    }
    let externalCredential: VercelConnectCredentialReference | null = null;
    if (credentialSource === "vercel_connect") {
      const integration = vercelConnectIntegrationStatus();
      if (!integration.enabled || !integration.configured || !vercelConnect) {
        throw unprocessable("Vercel Connect setup is not available on this Paperclip instance", {
          code: "vercel_connect_unavailable",
        });
      }
      if (!galleryEntry || !method || method.transport !== "mcp_remote" || method.auth === "none") {
        throw badRequest("Vercel Connect is available only for reviewed remote MCP app methods");
      }
      const reviewed = method.credentialSources?.vercelConnect;
      if (!reviewed) {
        throw unprocessable(`${galleryEntry.name} has not been reviewed for Vercel Connect`, {
          code: "vercel_connect_method_not_reviewed",
        });
      }
      const expectedPrincipalMode = method.auth === "oauth" ? "user" : "app";
      if (!reviewed.principalModes.includes(expectedPrincipalMode)) {
        throw unprocessable("This connector principal mode has not been reviewed for this app", {
          code: "vercel_connect_principal_not_reviewed",
        });
      }
      if (expectedPrincipalMode === "app" && requestedGrantKind !== "organization") {
        throw badRequest("App-subject Vercel connectors can only back an organization identity");
      }
      let metadata;
      try {
        metadata = await vercelConnect.getConnectorMetadata(input.vercelConnect!.connector);
      } catch (error) {
        throw vercelConnectHttpError(error);
      }
      const service = metadata.service.trim().toLowerCase();
      if (!reviewed.services.map((value) => value.toLowerCase()).includes(service)) {
        throw badRequest(`That Vercel connector is for ${metadata.service}, not ${galleryEntry.name}`, {
          code: "vercel_connect_service_mismatch",
        });
      }
      if (expectedPrincipalMode === "app") {
        const [connectorInUse] = await db.select({ id: toolConnections.id }).from(toolConnections).where(and(
          eq(toolConnections.credentialSource, "vercel_connect"),
          ne(toolConnections.status, "archived"),
          sql`${toolConnections.externalCredential}->>'connectorUid' = ${metadata.uid}`,
          ...(retainedConnection ? [ne(toolConnections.id, retainedConnection.id)] : []),
        )).limit(1);
        if (connectorInUse) {
          throw conflict("App-subject Vercel connectors are dedicated to one Paperclip connection. Create or attach a separate connector in Vercel.", {
            code: "vercel_connect_app_connector_in_use",
          });
        }
      }
      externalCredential = {
        provider: "vercel_connect",
        connectorId: metadata.id,
        connectorUid: metadata.uid,
        service: metadata.service,
        connectorType: metadata.type,
        principalMode: expectedPrincipalMode,
        headerName: reviewed.header.name,
        headerPrefix: reviewed.header.prefix ?? null,
        scopes: [...reviewed.scopes],
      };
    }
    const isGoogleSheetsRobotMethod = galleryEntry?.slug === GOOGLE_SHEETS_GALLERY_KEY && method?.key === "local";
    const normalizedMethodConfig = isGoogleSheetsRobotMethod || !method
      ? null
      : normalizeConnectionMethodConfig(method, input.configValues);
    const remoteUrlCredential = transport === "mcp_remote" && input.link
      ? splitRemoteUrlCredential(input.link)
      : null;
    const baseConfig = transport === "mcp_remote"
      ? { url: normalizedMethodConfig?.url ?? method?.defaults?.serverUrl ?? remoteUrlCredential?.publicUrl ?? input.link ?? "" }
      : { templateId: method?.defaults?.templateKey };
    let config: Record<string, unknown> = galleryEntry
      ? {
          ...baseConfig,
          sourceTemplateKey: galleryEntry.slug,
          connectionMethodKey: method?.key,
          methodConfig: normalizedMethodConfig?.values ?? {},
          // Grant-backed setup keeps the full discovered catalog selectable;
          // the wizard projects the app's ask-first defaults into policies at
          // finish time instead of using catalog quarantine as access state.
          quarantineNewEntries: false,
          ...(galleryEntry.slug === "posthog" ? { safeDefault: true } : {}),
        }
      : { ...baseConfig, quarantineNewEntries: false, unverifiedServer: true };
    if (method && isPaperclipCloudConnectorStrategy(method.oauthStrategy)) {
      const connectorProfile = method.connectorProfile;
      if (!connectorProfile || !isGoogleWorkspaceConnectorProfileId(connectorProfile)) {
        throw badRequest("This app has an invalid Google connector profile");
      }
      const profile = GOOGLE_WORKSPACE_CONNECTOR_PROFILES[connectorProfile];
      config.oauth = {
        strategy: method.oauthStrategy,
        provider: galleryEntry?.slug,
        connectorProfile,
        resource: method.defaults?.serverUrl,
        scopes: [...profile.scopes],
      };
      config.quarantineNewEntries = true;
    }
    const acceptsCustomerOAuthClient = method?.auth === "oauth"
      && method.ownershipModes.includes("customer");
    if (galleryEntry && input.oauthClient && !acceptsCustomerOAuthClient) {
      throw badRequest(`${galleryEntry.name} does not accept customer-owned OAuth client credentials`);
    }
    // A pasted URL or an explicitly customer-owned curated method may arrive
    // with a client the operator preregistered in the provider's console. Record
    // the client id now; the secret becomes an encrypted Paperclip secret below.
    if (input.oauthClient) {
      config.oauth = {
        clientId: input.oauthClient.clientId.trim(),
        clientRegistrationSource: "manual" satisfies OAuthClientRegistrationSource,
        clientCompanyId: companyId,
      };
    }
    if (isGoogleSheetsRobotMethod) {
      const availability = googleSheetsRobotEmailFromEnv();
      if (!availability.available) {
        throw unprocessable(availability.reason, { code: "google_sheets_unavailable" });
      }
      const allowedSpreadsheetIds = googleSheetsAllowedSpreadsheetIds(input.configValues);
      if (allowedSpreadsheetIds.length === 0) {
        throw badRequest("Paste at least one Google Sheets link.");
      }
      config.allowedSpreadsheetIds = allowedSpreadsheetIds;
      config.robotEmail = availability.robotEmail;
      config.env = {
        [GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS_ENV]: allowedSpreadsheetIds.join(","),
      };
      config = normalizeGoogleSheetsConnectionConfig(config);
      await assertGoogleSheetsSpreadsheetOwnership(companyId, config);
    }
    if (transport === "mcp_remote") await assertRemoteConnectionEndpointsAllowed(config);
    if (transport === "local_stdio") await stdioTemplateId(companyId, config);
    assertLocalStdioCanBeEnabled(transport, false);

    const credentialValues = input.credentialValues ?? {};
    // A curated method declares its auth kind. A pasted URL declares one only
    // under Advanced authentication; on the simple path it starts from what the
    // operator supplied and is upgraded to `oauth` when discovery proves the
    // endpoint needs sign-in (see `remoteTools` and `startOAuth`).
    const genericAuthKind: ToolConnectionAuthKind = method?.auth
      ?? (input.authMode === "oauth" || input.oauthClient
        ? "oauth"
        : input.authMode === "bearer" || input.authMode === "custom_headers"
          ? "api_key"
          : input.authMode === "none"
            ? "none"
            : Object.keys(credentialValues).length > 0
              ? "api_key"
              : "none");
    const credentialSecretRefs: CreateToolConnection["credentialSecretRefs"] = [];
    const credentialRefs: McpConnectionCredentialRef[] = [];
    const createdSecretIds: string[] = [];
    // "Just me" needs a named board user to own the consent. An agent actor
    // cannot hold a personal identity, and silently falling back to a shared
    // credential is exactly the mis-scoping the design forbids, so refuse.
    const personalIdentityUserId = requestedGrantKind === "user"
      ? (actor?.actorType === "user" && actor.actorId ? actor.actorId : null)
      : null;
    if (requestedGrantKind === "user" && !personalIdentityUserId) {
      throw badRequest("Connecting an app as yourself requires a signed-in user");
    }
    const retainedPersonalIdentity = retainedConnection?.credentialPolicy === "per_user"
      ? await fixedPersonalIdentityForReconnect(
        retainedConnection,
        personalIdentityUserId ?? undefined,
        actor,
      )
      : null;
    const retainedConfig = asRecord(retainedConnection?.config);
    const retainedMethodKey = retainedConfig.connectionMethodKey;
    const retainedSource = retainedConfig.sourceTemplateKey
      ?? asRecord(retainedConnection?.transportConfig).sourceTemplateKey;
    // Setup forms never receive stored secret values. Treat an omitted value as
    // "keep the existing secret" only while resuming the exact same curated
    // provider and method. This prevents a retry from detaching a client secret
    // or API key, without carrying credentials across a method/provider change.
    const canRetainCredentialMaterial = Boolean(
      retainedConnection
      && galleryEntry
      && retainedSource === galleryEntry.slug
      && retainedMethodKey === method?.key,
    );
    const retainedCredentialSecretRefs = canRetainCredentialMaterial
      ? (retainedPersonalIdentity?.grant?.credentialSecretRefs ?? retainedConnection?.credentialSecretRefs ?? [])
      : [];
    // Only the personal path changes the policy; every existing gallery app keeps
    // the shared default it has today.
      const credentialPolicy: ToolConnectionCredentialPolicy | undefined = personalIdentityUserId
      ? "per_user"
        : undefined;
    const connectionOwnership = isPaperclipCloudConnectorStrategy(method?.oauthStrategy) ? "platform_shared" : "customer";
    let applicationRow: typeof toolApplications.$inferSelect | null = null;
    let connectionRow: typeof toolConnections.$inferSelect | null = null;
    let revivedConnectionPrevious: typeof toolConnections.$inferSelect | null = retainedConnection ?? null;

    try {
      const credentialFields = credentialSource === "vercel_connect"
        ? []
        : galleryEntry
          ? credentialFieldsFor(galleryEntry, method?.key)
          : linkCredentialFields(credentialValues);
      for (const field of credentialFields) {
        const value = credentialValues[field.configPath];
        const retainedSecretRef = retainedCredentialSecretRefs.find(
          (ref) => ref.configPath === field.configPath,
        );
        if (!value && retainedSecretRef) {
          credentialSecretRefs.push(retainedSecretRef);
          if (field.placement === "header" && field.key) {
            credentialRefs.push({
              name: field.configPath,
              secretId: retainedSecretRef.secretId,
              version: retainedSecretRef.versionSelector ?? "latest",
              placement: "header",
              key: field.key,
              prefix: field.prefix ?? null,
            });
          }
          continue;
        }
        if (!value && field.required !== false) {
          throw badRequest(`Missing credential value for ${field.configPath}`);
        }
        if (!value) continue;
        const secret = await secrets.create(companyId, {
          name: `${name} ${field.label} ${randomUUID().slice(0, 8)}`,
          key: `tool_app.${randomUUID()}.${field.configPath.replace(/[^a-z0-9_:-]+/gi, "_")}`,
          provider: "local_encrypted",
          value,
          description: `Credential for ${name} (${field.configPath}).`,
        }, actorForSecret(actor));
        createdSecretIds.push(secret.id);
        credentialSecretRefs.push({
          secretId: secret.id,
          versionSelector: "latest",
          configPath: field.configPath,
          required: field.required ?? true,
          label: field.label,
        });
        if (field.placement === "header" && field.key) {
          credentialRefs.push({
            name: field.configPath,
            secretId: secret.id,
            version: "latest",
            placement: "header",
            key: field.key,
            prefix: field.prefix ?? null,
          });
        }
      }

      if (remoteUrlCredential?.secretUrl) {
        const secret = await secrets.create(companyId, {
          name: `${name} MCP server URL ${randomUUID().slice(0, 8)}`,
          key: `tool_app.${randomUUID()}.remote_url`,
          provider: "local_encrypted",
          value: remoteUrlCredential.secretUrl,
          description: `Credential-bearing MCP server URL for ${name}.`,
        }, actorForSecret(actor));
        createdSecretIds.push(secret.id);
        credentialSecretRefs.push({
          secretId: secret.id,
          versionSelector: "latest",
          configPath: REMOTE_URL_SECRET_CONFIG_PATH,
          required: true,
          label: "MCP server URL",
        });
        credentialRefs.push({
          name: REMOTE_URL_SECRET_CONFIG_PATH,
          secretId: secret.id,
          version: "latest",
          placement: "url",
          key: "url",
          prefix: null,
        });
      }

      // A preregistered OAuth client secret is not a request header — it is only
      // ever sent to the token endpoint — so it gets a secret ref with no
      // credential ref, keeping it out of `projectedConnectionHeaders`.
      if (input.oauthClient?.clientSecret) {
        const secret = await secrets.create(companyId, {
          name: `${name} OAuth client secret ${randomUUID().slice(0, 8)}`,
          key: `tool_app.${randomUUID()}.oauth_client_secret`,
          provider: "local_encrypted",
          value: input.oauthClient.clientSecret,
          description: `OAuth client secret for ${name}.`,
        }, actorForSecret(actor));
        createdSecretIds.push(secret.id);
        credentialSecretRefs.push({
          secretId: secret.id,
          versionSelector: "latest",
          configPath: "oauth.client_secret",
          required: false,
          label: "OAuth client secret",
        });
      } else if (input.oauthClient) {
        const retainedOAuth = asRecord(retainedConfig.oauth);
        const clientIdUnchanged = retainedOAuth.clientId === input.oauthClient.clientId.trim();
        const retainedClientSecretRef = clientIdUnchanged
          ? retainedCredentialSecretRefs.find((ref) => ref.configPath === "oauth.client_secret")
          : undefined;
        if (retainedClientSecretRef) credentialSecretRefs.push(retainedClientSecretRef);
      }

      const safeApplicationDescription = galleryEntry?.description
        ?? `Connected app at ${remoteUrlCredential?.publicUrl ?? input.link}`;
      if (existingApplication) {
        if (existingApplication.status !== "active") {
          [applicationRow] = await db.update(toolApplications)
            .set({
              status: "draft",
              archivedAt: null,
              ...(!galleryEntry ? { description: safeApplicationDescription } : {}),
              updatedAt: new Date(),
            })
            .where(eq(toolApplications.id, existingApplication.id))
            .returning();
        } else {
          applicationRow = existingApplication;
        }
      } else {
        [applicationRow] = await db.insert(toolApplications).values({
          companyId,
          applicationKey: `app-gallery:${galleryEntry?.slug ?? "link"}:${randomUUID()}`,
          name,
          description: safeApplicationDescription,
          type: transport === "mcp_remote" ? "mcp_http" : "mcp_stdio",
          status: "draft",
          metadata: galleryEntry ? { sourceTemplateKey: galleryEntry.slug, galleryKey: galleryEntry.slug } : { source: "link" },
        }).returning();
      }

      await assertSecretRefs(companyId, [...credentialRefs, ...credentialSecretRefs]);
      // Reconnecting an app revives its most recent archived connection instead
      // of inserting a fresh row: keeps the connection id (and its activity
      // history) stable and avoids the unique (company, name) constraint.
      // A personal credential never becomes the connection's shared secret: the
      // row carries the header shape only, and the secret refs go to the user
      // grant below. `ensureDefaultOrganizationGrant` copies this list, so
      // leaving it empty is what keeps the secret off an organization grant.
      const connectionCredentialSecretRefs = personalIdentityUserId ? [] : credentialSecretRefs;
      if (revivedConnectionPrevious) {
        [connectionRow] = await db.update(toolConnections).set({
          name,
          authKind: genericAuthKind,
          transport,
          status: "draft",
          enabled: false,
          config,
          transportConfig: config,
          credentialRefs,
          credentialSecretRefs: connectionCredentialSecretRefs,
          credentialSource,
          externalCredential,
          // Identity is immutable for a retained connection. A fresh
          // connection still derives it from the explicit Access choice.
          credentialPolicy: revivedConnectionPrevious.credentialPolicy,
          updatedAt: new Date(),
        }).where(eq(toolConnections.id, revivedConnectionPrevious.id)).returning();
      } else {
        const connectionId = randomUUID();
        [connectionRow] = await db.insert(toolConnections).values({
          id: connectionId,
          companyId,
          applicationId: applicationRow.id,
          name,
          uid: connectionUid(applicationRow.applicationKey ?? applicationRow.name, name, connectionId),
          connectionKind: "managed",
          ownership: connectionOwnership,
          authKind: genericAuthKind,
          credentialSource,
          externalCredential,
          transport,
          status: "draft",
          enabled: false,
          config,
          transportConfig: config,
          credentialRefs,
          credentialSecretRefs: connectionCredentialSecretRefs,
          ...(credentialPolicy ? { credentialPolicy } : {}),
          createdByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
          createdByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
        }).returning();
      }
      if (personalIdentityUserId) {
        // "Just me" (PAP-17835 seam #4). The credential is committed straight to
        // the caller's own grant; the connection row keeps only the header
        // *shape* in `credentialRefs` (which the gateway reads for placement and
        // then resolves against the acting user's grant) and no shared secret
        // refs at all. Two consequences the design requires:
        //  - `ensureDefaultOrganizationGrant` is skipped, so no organization
        //    grant is created first and later "moved" to a user grant. It stays
        //    absent until someone explicitly connects an organization identity,
        //    which is what makes "Organization identity · Not connected"
        //    truthful rather than a silent fallback.
        //  - the credential never lands in `connection.credentialSecretRefs`,
        //    which is what an organization grant would have copied.
        //
        // OAuth is the exception: no credential exists yet at connect time, and
        // the callback upserts this same (connection, user, subject) grant with
        // the tokens. Pre-creating an empty `active` grant there would render as
        // "Connected" with nothing behind it, so the grant is left to the
        // callback and only the organization grant is suppressed.
        if (credentialSecretRefs.length > 0) {
          if (retainedPersonalIdentity?.grant) {
            await db.update(connectionGrants).set({
              credentialSecretRefs,
              status: "active",
              revokedAt: null,
              revokedByAgentId: null,
              revokedByUserId: null,
              updatedAt: new Date(),
            }).where(eq(connectionGrants.id, retainedPersonalIdentity.grant.id));
          } else {
            await db.insert(connectionGrants).values({
              companyId,
              connectionId: connectionRow.id,
              kind: "user",
              subjectUserId: personalIdentityUserId,
              credentialSecretRefs,
              status: "active",
              isDefault: false,
              createdByUserId: personalIdentityUserId,
            });
          }
          await db.insert(toolAccessAuditEvents).values({
            companyId,
            connectionId: connectionRow.id,
            actorType: "user",
            actorId: personalIdentityUserId,
            action: retainedPersonalIdentity?.grant ? "connection_grant.updated" : "connection_grant.created",
            outcome: "success",
            reasonCode: retainedPersonalIdentity?.grant
              ? "personal_identity_reconnected"
              : "personal_identity_created",
            details: { kind: "user", credentialSecretRefCount: credentialSecretRefs.length },
          });
        }
      } else {
        await ensureDefaultOrganizationGrant(connectionRow);
        if (credentialSource === "vercel_connect") {
          const derived = deriveVercelConnectSubject({
            credential: externalCredential!,
            connectionId: connectionRow.id,
            companyId,
            grantKind: "organization",
          });
          await db.update(connectionGrants).set({
            externalCredential: {
              provider: "vercel_connect",
              subjectType: externalCredential!.principalMode,
              ...(derived.subjectId ? { subjectId: derived.subjectId } : {}),
            },
            credentialSecretRefs: [],
            updatedAt: now(),
          }).where(and(
            eq(connectionGrants.companyId, companyId),
            eq(connectionGrants.connectionId, connectionRow.id),
            eq(connectionGrants.kind, "organization"),
            eq(connectionGrants.isDefault, true),
          ));
        }
      }
      await syncCredentialBindings(connectionRow, personalIdentityUserId ? credentialSecretRefs : []);
      await ensureRuntimeSlot(connectionRow);

      if (galleryEntry && method?.auth === "oauth") {
        return {
          connectionId: connectionRow.id,
          application: toApplication(applicationRow),
          connection: toConnection(connectionRow),
          catalog: [],
          actions: { readOnly: [], canMakeChanges: [] },
          suggestedDefaults: recommendedDefaultsForApp(galleryEntry, method.key),
          auth: { kind: "oauth", startUrl: null },
        };
      }

      let health: ToolConnectionHealthCheckResult;
      try {
        health = await checkConnectionHealth(connectionRow.id, actor);
      } catch (error) {
        if (!galleryEntry && error instanceof HttpError && asRecord(error.details).code === "oauth_challenge") {
          const [oauthConnection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionRow.id));
          const endpoints = await discoverOAuthEndpoints(oauthConnection).catch((discoveryError: unknown) => {
            // "This server advertised an address Paperclip refuses to open" is a
            // refusal, not a failed discovery: keep it instead of collapsing it
            // into the generic sign-in-required error.
            if (isOAuthEndpointRejection(discoveryError)) throw discoveryError;
            return null;
          });
          if (!endpoints) throw error;
          return {
            connectionId: oauthConnection.id,
            application: toApplication(applicationRow),
            connection: toConnection(oauthConnection),
            catalog: [],
            actions: { readOnly: [], canMakeChanges: [] },
            suggestedDefaults: {
              access: "all_agents",
              askFirstRiskLevels: [],
            },
            // The endpoint asked for authorization and discovery found a real
            // authorization server, so the wizard can offer "Sign in to
            // continue" instead of a dead end. The caller starts the flow and
            // fills in `startUrl`/`registrationSource`; it only needs the issuer
            // and resource here to show which server the operator is about to
            // trust.
            auth: {
              kind: "oauth",
              startUrl: null,
              issuer: endpoints.issuer ?? null,
              resource: endpoints.resource ?? null,
            },
          };
        }
        throw error;
      }
      if (galleryEntry?.slug === COMPOSIO_GALLERY_KEY) {
        const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationRow.id));
        return {
          connectionId: health.connection.id,
          application: toApplication(application),
          connection: health.connection,
          catalog: [],
          actions: { readOnly: [], canMakeChanges: [] },
          suggestedDefaults: recommendedDefaultsForApp(galleryEntry, method?.key),
        };
      }
      const restoreDraftDefaults = Boolean(revivedConnectionPrevious);
      const refresh = await refreshCatalog(connectionRow.id, actor, {
        enableAllByDefault: restoreDraftDefaults,
        restoreDraftDefaults,
      });
      const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationRow.id));
      return {
        connectionId: refresh.connection.id,
        application: toApplication(application),
        connection: refresh.connection,
        catalog: refresh.catalog,
        actions: groupedActions(refresh.catalog),
        suggestedDefaults: galleryEntry ? recommendedDefaultsForApp(galleryEntry, method?.key) : {
          access: "all_agents",
          askFirstRiskLevels: [],
        },
      };
    } catch (error) {
      if (connectionRow && revivedConnectionPrevious) {
        await db.update(toolConnections).set({
          name: revivedConnectionPrevious.name,
          transport: revivedConnectionPrevious.transport,
          status: revivedConnectionPrevious.status,
          enabled: revivedConnectionPrevious.enabled,
          config: revivedConnectionPrevious.config,
          transportConfig: revivedConnectionPrevious.transportConfig,
          credentialRefs: revivedConnectionPrevious.credentialRefs,
          credentialSecretRefs: revivedConnectionPrevious.credentialSecretRefs,
          credentialSource: revivedConnectionPrevious.credentialSource,
          externalCredential: revivedConnectionPrevious.externalCredential,
          updatedAt: new Date(),
        }).where(eq(toolConnections.id, revivedConnectionPrevious.id)).catch(() => undefined);
      } else if (connectionRow) {
        await db.delete(toolConnections).where(eq(toolConnections.id, connectionRow.id)).catch(() => undefined);
      }
      if (applicationRow && !existingApplication) {
        await db.delete(toolApplications).where(eq(toolApplications.id, applicationRow.id)).catch(() => undefined);
      } else if (existingApplication && applicationRow && applicationRow.status !== existingApplication.status) {
        await db.update(toolApplications)
          .set({ status: existingApplication.status, archivedAt: existingApplication.archivedAt, updatedAt: new Date() })
          .where(eq(toolApplications.id, existingApplication.id))
          .catch(() => undefined);
      }
      for (const secretId of createdSecretIds) {
        await secrets.remove(secretId).catch(() => undefined);
      }
      throw error;
    }
  }

  async function assertCatalogEntriesForConnection(
    companyId: string,
    connectionId: string,
    catalogEntryIds: string[],
  ): Promise<Array<typeof toolCatalogEntries.$inferSelect>> {
    const uniqueIds = [...new Set(catalogEntryIds)];
    if (uniqueIds.length === 0) return [];
    const rows = await db
      .select()
      .from(toolCatalogEntries)
      .where(and(
        eq(toolCatalogEntries.companyId, companyId),
        eq(toolCatalogEntries.connectionId, connectionId),
        inArray(toolCatalogEntries.id, uniqueIds),
      ));
    if (rows.length !== uniqueIds.length) {
      throw unprocessable("All selected catalog entries must belong to this app connection");
    }
    return rows;
  }

  async function assertAgentsInCompany(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return;
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...new Set(agentIds)])));
    if (rows.length !== new Set(agentIds).size) {
      throw unprocessable("All app access agent ids must belong to the same company");
    }
  }

  async function upsertAskFirstPolicies(input: {
    companyId: string;
    connection: typeof toolConnections.$inferSelect;
    askFirstEntries: Array<typeof toolCatalogEntries.$inferSelect>;
    actor?: ActorInfo;
    disableStale?: boolean;
  }, dbClient: ToolAccessMutationDb = db): Promise<ToolPolicy[]> {
    const existingPolicies = await dbClient
      .select()
      .from(toolPolicies)
      .where(and(eq(toolPolicies.companyId, input.companyId), eq(toolPolicies.policyType, "require_approval")));
    const managedPolicies = existingPolicies.filter((policy) => {
      const config = asRecord(policy.config);
      return config.source === "app_gallery_finish" && config.connectionId === input.connection.id;
    });
    const policiesByCatalogEntryId = new Map<string, typeof toolPolicies.$inferSelect>();
    for (const policy of managedPolicies) {
      const config = asRecord(policy.config);
      if (typeof config.catalogEntryId === "string") {
        policiesByCatalogEntryId.set(config.catalogEntryId, policy);
      }
    }
    const askFirstIds = new Set(input.askFirstEntries.map((entry) => entry.id));
    const results: ToolPolicy[] = [];
    for (const entry of input.askFirstEntries) {
      const config = {
        source: "app_gallery_finish",
        connectionId: input.connection.id,
        catalogEntryId: entry.id,
      };
      const existing = policiesByCatalogEntryId.get(entry.id);
      if (existing) {
        const [updated] = await dbClient
          .update(toolPolicies)
          .set({
            name: policyNameForApp(input.connection, entry),
            description: `Ask first before running ${entry.toolName}.`,
            enabled: true,
            selectors: { catalogEntryId: entry.id },
            config,
            updatedAt: new Date(),
          })
          .where(eq(toolPolicies.id, existing.id))
          .returning();
        results.push(toPolicy(updated));
      } else {
        const [created] = await dbClient.insert(toolPolicies).values({
          companyId: input.companyId,
          name: policyNameForApp(input.connection, entry),
          description: `Ask first before running ${entry.toolName}.`,
          policyType: "require_approval",
          priority: 50,
          enabled: true,
          selectors: { catalogEntryId: entry.id },
          config,
          createdByAgentId: input.actor?.actorType === "agent" ? input.actor.actorId ?? null : null,
          createdByUserId: input.actor?.actorType === "user" ? input.actor.actorId ?? null : null,
        }).returning();
        results.push(toPolicy(created));
      }
    }
    if (input.disableStale !== false) {
      const stalePolicies = managedPolicies.filter((policy) => {
        const config = asRecord(policy.config);
        return typeof config.catalogEntryId === "string" && !askFirstIds.has(config.catalogEntryId);
      });
      for (const policy of stalePolicies) {
        await dbClient
          .update(toolPolicies)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(toolPolicies.id, policy.id));
      }
    }
    return results;
  }

  async function finishGalleryAppConnection(
    companyId: string,
    connectionId: string,
    input: FinishToolApp,
    actor?: ActorInfo,
  ): Promise<FinishToolAppResult> {
    const connection = await getConnectionRow(connectionId, companyId);
    if (connection.status === "archived") throw conflict("Archived app connections cannot be finished");
    const enabledIds = [...new Set([...input.enabledCatalogEntryIds, ...input.askFirstCatalogEntryIds])];
    const requestedReviewedIds = input.reviewedCatalogEntryIds ?? [];
    const reviewedIds = [...new Set(requestedReviewedIds)];
    if (reviewedIds.length !== requestedReviewedIds.length) {
      throw badRequest("Action review decisions must not contain duplicate catalogEntryId values");
    }
    const enabledRows = await assertCatalogEntriesForConnection(companyId, connection.id, enabledIds);
    const askFirstRows = await assertCatalogEntriesForConnection(companyId, connection.id, input.askFirstCatalogEntryIds);
    if (enabledRows.some((entry) => entry.status === "disabled")) {
      throw badRequest("Disabled actions cannot be enabled");
    }
    if (reviewedIds.length > 0) {
      await assertCatalogEntriesForConnection(companyId, connection.id, reviewedIds);
      const quarantinedRows = await db
        .select({ id: toolCatalogEntries.id })
        .from(toolCatalogEntries)
        .where(and(
          eq(toolCatalogEntries.companyId, companyId),
          eq(toolCatalogEntries.connectionId, connection.id),
          eq(toolCatalogEntries.status, "quarantined"),
        ));
      const reviewedIdSet = new Set(reviewedIds);
      if (
        quarantinedRows.length !== reviewedIdSet.size
        || quarantinedRows.some((entry) => !reviewedIdSet.has(entry.id))
      ) {
        throw badRequest("Action review decisions must cover every currently quarantined action exactly once");
      }
    }
    if (input.access !== "all_agents") await assertAgentsInCompany(companyId, input.access.agentIds);

    const entries: CreateToolProfileEntryForProfile[] = enabledRows.map((entry) => ({
      selectorType: "catalog_entry",
      effect: "include",
      catalogEntryId: entry.id,
      connectionId: connection.id,
      applicationId: connection.applicationId,
    }));
    const profileKey = `app:${connection.id}`;
    const bindingInputs: CreateToolProfileBindingForProfile[] = input.access === "all_agents"
      ? [{ targetType: "company", targetId: companyId, priority: 100, metadata: { source: "app_gallery_finish" } }]
      : [...new Set(input.access.agentIds)].map((agentId) => ({
          targetType: "agent" as const,
          targetId: agentId,
          priority: 100,
          metadata: { source: "app_gallery_finish" },
        }));
    const transactionResult = await db.transaction(async (tx) => {
      const [existingProfile] = await tx
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, profileKey)))
        .limit(1);
      let profileId: string;
      if (existingProfile) {
        await tx
          .delete(toolProfileBindings)
          .where(and(eq(toolProfileBindings.companyId, companyId), eq(toolProfileBindings.profileId, existingProfile.id)));
        await tx
          .delete(toolProfileEntries)
          .where(and(eq(toolProfileEntries.companyId, companyId), eq(toolProfileEntries.profileId, existingProfile.id)));
        if (entries.length > 0) {
          await tx.insert(toolProfileEntries).values(entries.map((entry) => ({
            companyId,
            profileId: existingProfile.id,
            selectorType: entry.selectorType,
            effect: entry.effect ?? "include",
            applicationId: entry.applicationId ?? null,
            connectionId: entry.connectionId ?? null,
            catalogEntryId: entry.catalogEntryId ?? null,
            toolName: entry.toolName ?? null,
            riskLevel: entry.riskLevel ?? null,
            conditions: entry.conditions ?? null,
          })));
        }
        const [updated] = await tx
          .update(toolProfiles)
          .set({
            name: connection.name,
            description: `Access profile for ${connection.name}.`,
            status: "active",
            defaultAction: "deny",
            metadata: { source: "app_gallery_finish", connectionId: connection.id },
            updatedAt: new Date(),
          })
          .where(eq(toolProfiles.id, existingProfile.id))
          .returning();
        profileId = updated.id;
      } else {
        const [created] = await tx.insert(toolProfiles).values({
          companyId,
          profileKey,
          name: connection.name,
          description: `Access profile for ${connection.name}.`,
          status: "active",
          defaultAction: "deny",
          metadata: { source: "app_gallery_finish", connectionId: connection.id },
        }).returning();
        if (entries.length > 0) {
          await tx.insert(toolProfileEntries).values(entries.map((entry) => ({
            companyId,
            profileId: created.id,
            selectorType: entry.selectorType,
            effect: entry.effect ?? "include",
            applicationId: entry.applicationId ?? null,
            connectionId: entry.connectionId ?? null,
            catalogEntryId: entry.catalogEntryId ?? null,
            toolName: entry.toolName ?? null,
            riskLevel: entry.riskLevel ?? null,
            conditions: entry.conditions ?? null,
          })));
        }
        profileId = created.id;
      }

      const profileBindings: ToolProfileBinding[] = [];
      for (const bindingInput of bindingInputs) {
        const [binding] = await tx.insert(toolProfileBindings).values({
          companyId,
          profileId,
          targetType: bindingInput.targetType,
          targetId: bindingInput.targetId,
          priority: bindingInput.priority ?? 100,
          metadata: bindingInput.metadata ?? {},
          createdByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
          createdByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
        }).returning();
        profileBindings.push(toProfileBinding(binding));
      }

      const reviewedAt = new Date();
      if (reviewedIds.length > 0) {
        await tx
          .update(toolCatalogEntries)
          .set({
            status: "active",
            reviewedAt,
            reviewedByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
            reviewedByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
            quarantinedAt: null,
            quarantineReason: null,
            updatedAt: reviewedAt,
          })
          .where(and(
            eq(toolCatalogEntries.companyId, companyId),
            eq(toolCatalogEntries.connectionId, connection.id),
            inArray(toolCatalogEntries.id, reviewedIds),
            eq(toolCatalogEntries.status, "quarantined"),
          ));
      }
      if (enabledIds.length > 0) {
        await tx
          .update(toolCatalogEntries)
          .set({
            status: "active",
            reviewedAt,
            reviewedByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
            reviewedByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
            quarantinedAt: null,
            quarantineReason: null,
            updatedAt: reviewedAt,
          })
          .where(and(
            eq(toolCatalogEntries.companyId, companyId),
            inArray(toolCatalogEntries.id, enabledIds),
            ne(toolCatalogEntries.status, "quarantined"),
          ));
      }

      const policies = await upsertAskFirstPolicies({
        companyId,
        connection,
        askFirstEntries: askFirstRows,
        actor,
      }, tx);
      const [updatedConnection] = await tx
        .update(toolConnections)
        .set({ status: "active", enabled: true, updatedAt: new Date() })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      await tx
        .update(toolApplications)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(toolApplications.id, connection.applicationId));

      return { profileId, profileBindings, policies, updatedConnection };
    });

    const details = await profileDetails(transactionResult.profileId, companyId);
    return {
      connection: toConnection(transactionResult.updatedConnection),
      profile: {
        id: details.id,
        companyId: details.companyId,
        profileKey: details.profileKey,
        name: details.name,
        description: details.description,
        status: details.status,
        defaultAction: details.defaultAction,
        newToolsReviewedAt: details.newToolsReviewedAt,
        metadata: details.metadata,
        createdAt: details.createdAt,
        updatedAt: details.updatedAt,
      },
      profileEntries: details.entries,
      profileBindings: transactionResult.profileBindings,
      policies: transactionResult.policies,
    };
  }

  /**
   * Resolve the one user identity a personal-only connection is allowed to
   * refresh. The connection creator is authoritative for new rows; retained
   * grants cover older or agent-created rows. Reconnect may rotate that
   * identity's credential, but it may never create a different user's identity
   * on the same connection.
   */
  async function fixedPersonalIdentityForReconnect(
    connection: typeof toolConnections.$inferSelect,
    requestedSubjectUserId: string | undefined,
    actor?: ActorInfo,
  ): Promise<{
    subjectUserId: string;
    grant: typeof connectionGrants.$inferSelect | null;
  } | null> {
    if (connection.credentialPolicy !== "per_user") return null;

    const personalGrants = await db
      .select()
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "user"),
      ))
      .orderBy(desc(connectionGrants.updatedAt));
    const creatorGrant = connection.createdByUserId
      ? personalGrants.find((grant) => grant.subjectUserId === connection.createdByUserId) ?? null
      : null;
    const retainedGrant = creatorGrant
      ?? personalGrants.find((grant) => grant.credentialSecretRefs.length > 0)
      ?? personalGrants[0]
      ?? null;
    const fixedSubjectUserId = connection.createdByUserId ?? retainedGrant?.subjectUserId ?? null;
    const binding = actorBinding(actor);
    const actorUserId = binding.actorType === "user" ? binding.actorId : null;
    const subjectUserId = requestedSubjectUserId ?? actorUserId;

    if (!subjectUserId) {
      throw forbidden("Reconnect this personal connection as the user it belongs to");
    }
    if (actorUserId && subjectUserId !== actorUserId) {
      throw forbidden("Board users may only reconnect their own personal connection");
    }
    if (fixedSubjectUserId && subjectUserId !== fixedSubjectUserId) {
      throw forbidden("Only the existing personal identity can reconnect this connection");
    }

    return {
      subjectUserId,
      grant: personalGrants.find((grant) => grant.subjectUserId === subjectUserId) ?? null,
    };
  }

  /**
   * Replace the credential(s) on an existing connection and re-run the health
   * check — the "Replace key" / reconnect flow (M7, PAP-10859). Rotates the
   * secret in place when a ref already exists so the connection keeps its
   * profile, policies, and catalog; creates a fresh secret only when the field
   * had none (e.g. a link connection added a key after the fact).
   */
  async function reconnectGalleryApp(
    connectionId: string,
    companyId: string,
    input: { credentialValues: Record<string, string> },
    actor?: ActorInfo,
  ): Promise<ToolConnectionHealthCheckResult> {
    const connection = await getConnectionRow(connectionId, companyId);
    if (connection.status === "archived") throw conflict("Archived app connections cannot be reconnected");
    if (connection.credentialSource === "vercel_connect") {
      throw conflict("Manage this connector in Vercel Connect, then run a Paperclip health check to verify it.", {
        code: "vercel_connect_managed_externally",
        manageUrl: vercelConnectIntegrationStatus().manageUrl,
      });
    }
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    const credentialFields = galleryEntry ? credentialFieldsFor(galleryEntry, connectionMethodForConnection(galleryEntry, connection).key) : [
      {
        label: "App key",
        configPath: "credentials.authorization",
        helpUrl: "",
        required: false,
        placement: "header" as const,
        key: "Authorization",
        prefix: "Bearer ",
      },
    ];

    const providedFields = credentialFields.filter(
      (field) => (input.credentialValues[field.configPath]?.trim().length ?? 0) > 0,
    );
    if (providedFields.length === 0) throw badRequest("Paste a new key to reconnect this app");

    const personalIdentity = await fixedPersonalIdentityForReconnect(connection, undefined, actor);
    const credentialSecretRefs = [
      ...(personalIdentity?.grant?.credentialSecretRefs ?? connection.credentialSecretRefs),
    ];
    const credentialRefs: McpConnectionCredentialRef[] = [...(connection.credentialRefs ?? [])];

    for (const field of providedFields) {
      const value = input.credentialValues[field.configPath]!.trim();
      const existing = credentialSecretRefs.find((ref) => ref.configPath === field.configPath);
      if (existing) {
        await secrets.rotate(existing.secretId, { value }, actorForSecret(actor));
        continue;
      }
      const secret = await secrets.create(companyId, {
        name: `${connection.name} ${field.label} ${randomUUID().slice(0, 8)}`,
        key: `tool_app.${randomUUID()}.${field.configPath.replace(/[^a-z0-9_:-]+/gi, "_")}`,
        provider: "local_encrypted",
        value,
        description: `Credential for ${connection.name} (${field.configPath}).`,
      }, actorForSecret(actor));
      credentialSecretRefs.push({
        secretId: secret.id,
        versionSelector: "latest",
        configPath: field.configPath,
        required: field.required ?? true,
        label: field.label,
      });
      if (field.placement === "header" && field.key) {
        const nextCredentialRef = {
          name: field.configPath,
          secretId: secret.id,
          version: "latest",
          placement: "header",
          key: field.key,
          prefix: field.prefix ?? null,
        } satisfies McpConnectionCredentialRef;
        const existingCredentialRefIndex = credentialRefs.findIndex((ref) => ref.name === field.configPath);
        if (existingCredentialRefIndex >= 0) credentialRefs[existingCredentialRefIndex] = nextCredentialRef;
        else credentialRefs.push(nextCredentialRef);
      }
    }

    const updated = await db.transaction(async (tx) => {
      const updatedAt = new Date();
      if (personalIdentity) {
        const grantValues = {
          credentialSecretRefs,
          status: "active" as const,
          revokedAt: null,
          revokedByAgentId: null,
          revokedByUserId: null,
          updatedAt,
        };
        if (personalIdentity.grant) {
          await tx
            .update(connectionGrants)
            .set(grantValues)
            .where(eq(connectionGrants.id, personalIdentity.grant.id));
        } else {
          await tx.insert(connectionGrants).values({
            companyId: connection.companyId,
            connectionId: connection.id,
            kind: "user",
            subjectUserId: personalIdentity.subjectUserId,
            ...grantValues,
            isDefault: false,
            createdByUserId: personalIdentity.subjectUserId,
          });
        }
      }
      const [nextConnection] = await tx
        .update(toolConnections)
        .set({
          credentialRefs,
          // Personal reconnect rotates the existing user's grant. The
          // connection-level organization slot stays exactly as it was.
          credentialSecretRefs: personalIdentity ? connection.credentialSecretRefs : credentialSecretRefs,
          lastError: null,
          updatedAt,
        })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      return nextConnection;
    });
    await syncCredentialBindings(updated, personalIdentity ? credentialSecretRefs : []);
    const health = await checkConnectionHealth(updated.id, actor);
    if (isComposioConnection(updated) && updated.enabled && updated.status === "active") {
      await restoreComposioChildren(updated);
    }
    const refresh = await refreshCatalog(updated.id, actor, { enableAllByDefault: true });
    return { ...health, connection: refresh.connection };
  }

  async function startOAuth(
    companyId: string,
    connectionId: string,
    input: {
      redirectUri: string;
      actor: ActorInfo;
      subjectUserId?: string;
      scopes?: string[];
      returnTo?: string;
      issueId?: string;
      interactionId?: string;
    },
  ): Promise<ToolOAuthStartResult> {
    let connection = await getConnectionRow(connectionId, companyId);
    if (connection.status === "archived") throw conflict("Archived app connections cannot start sign in");
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    assertOAuthRedirectConstraints(galleryEntry, input.redirectUri);
    const galleryMethod = galleryEntry ? connectionMethodForConnection(galleryEntry, connection) : null;
    const requestedScopes = (() => {
      if (!galleryMethod) return input.scopes ?? null;
      const allowed = normalizeOauthScopes(galleryMethod.defaults?.scopesHint);
      if (!input.scopes) return allowed;
      const requested = normalizeOauthScopes(input.scopes);
      const widened = requested.filter((scope) => !allowed.includes(scope));
      if (widened.length > 0) {
        throw badRequest(`Requested OAuth scopes are not allowed for ${galleryEntry?.name ?? "this app"}`, {
          code: "oauth_scope_widening_rejected",
          scopes: widened,
        });
      }
      return requested;
    })();
    const starterBinding = actorBinding(input.actor);
    const fixedPersonalIdentity = await fixedPersonalIdentityForReconnect(
      connection,
      input.subjectUserId,
      input.actor,
    );
    const authorizationSubjectUserId = fixedPersonalIdentity?.subjectUserId ?? input.subjectUserId;
    const intentLink = input.interactionId
      ? await db
          .select({
            id: issueThreadInteractions.id,
            issueId: issueThreadInteractions.issueId,
            addresseeUserId: issueThreadInteractions.addresseeUserId,
            kind: issueThreadInteractions.kind,
            status: issueThreadInteractions.status,
          })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.id, input.interactionId),
            eq(issueThreadInteractions.companyId, companyId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    if (input.interactionId && (
      !intentLink
      || intentLink.kind !== "connection_intent"
      || intentLink.status !== "pending"
      || starterBinding.actorType !== "user"
      || starterBinding.actorId !== intentLink.addresseeUserId
    )) {
      throw forbidden("Only the addressed user can authorize this connection request");
    }
    if (connection.credentialSource === "vercel_connect") {
      if (!vercelConnect) throw vercelConnectHttpError(new VercelConnectClientError("vercel_connect_unavailable", 503));
      const credential = vercelCredentialFor(connection);
      if (connection.authKind !== "oauth" || credential.principalMode !== "user") {
        throw badRequest("This Vercel connector does not use browser authorization");
      }
      const binding = starterBinding;
      if (!binding.actorType || !binding.actorId) {
        throw forbidden("Vercel Connect authorization requires an authenticated actor");
      }
      const grantKind: ConnectionGrantKind = authorizationSubjectUserId ? "user" : "organization";
      const derived = deriveVercelConnectSubject({
        credential,
        connectionId: connection.id,
        companyId,
        grantKind,
        subjectUserId: authorizationSubjectUserId,
      });
      const state = randomOauthToken();
      let authorization;
      try {
        authorization = await vercelConnect.startAuthorization({
          connector: credential.connectorUid,
          subject: derived.subject,
          scopes: credential.scopes,
          resources: vercelConnectResourcesFor(connection),
        }, vercelConnectCallbackUrl(input.redirectUri, state));
      } catch (error) {
        throw vercelConnectHttpError(error);
      }
      const remoteExpiry = authorization.expiresAt ? new Date(authorization.expiresAt) : null;
      const expiresAt = remoteExpiry && Number.isFinite(remoteExpiry.getTime())
        ? new Date(Math.min(remoteExpiry.getTime(), now().getTime() + 10 * 60 * 1000))
        : new Date(now().getTime() + 10 * 60 * 1000);
      await db.delete(toolOauthStates).where(lt(toolOauthStates.expiresAt, now()));
      await db.insert(toolOauthStates).values({
        state,
        companyId,
        connectionId: connection.id,
        // Vercel owns its verifier. This marker only dispatches the consumed
        // one-time state to the Vercel callback completion path.
        codeVerifier: "vercel-connect",
        createdByActorType: binding.actorType,
        createdByActorId: binding.actorId,
        createdBySessionId: binding.sessionId,
        subjectUserId: authorizationSubjectUserId,
        requestedScopes: [...credential.scopes],
        returnTo: input.returnTo,
        issueId: intentLink?.issueId ?? input.issueId,
        interactionId: intentLink?.id,
        expiresAt,
      });
      return {
        connectionId: connection.id,
        provider: `vercel-connect:${credential.service}`,
        authorizationUrl: authorization.url,
        expiresAt: expiresAt.toISOString(),
        issuer: "https://vercel.com/connect",
        resource: galleryMethod?.defaults?.serverUrl ?? null,
        registrationSource: null,
      };
    }
    if (galleryMethod && isPaperclipCloudConnectorStrategy(galleryMethod.oauthStrategy)) {
      const connectorProfile = galleryMethod.connectorProfile;
      if (!connectorProfile || !isGoogleWorkspaceConnectorProfileId(connectorProfile)) {
        throw badRequest("This app has an invalid Google connector profile");
      }
      const googleProfile = GOOGLE_WORKSPACE_CONNECTOR_PROFILES[connectorProfile];
      const providerName = galleryEntry?.name ?? "Google Workspace";
      const cloudConnector = currentCloudConnector();
      if (!cloudConnector) {
        throw unprocessable(`${providerName} connections through Paperclip are not available on this instance yet`, {
          code: "paperclip_cloud_connector_unavailable",
        });
      }
      const binding = starterBinding;
      if (!binding.actorType || !binding.actorId) {
        throw forbidden(`${providerName} sign-in requires an authenticated actor`);
      }
      const subjectUserId = authorizationSubjectUserId ?? (binding.actorType === "user" ? binding.actorId : null);
      if (!subjectUserId) {
        throw forbidden(`Agent-started ${providerName} sign-in requires an authorized user subject`);
      }
      if (binding.actorType === "user" && subjectUserId !== binding.actorId) {
        throw forbidden(`Board users may only authorize their own ${providerName} identity`);
      }
      await db.delete(toolOauthStates).where(lt(toolOauthStates.expiresAt, now()));
      const state = randomOauthToken();
      const returnUri = new URL(input.redirectUri);
      returnUri.pathname = "/api/tools/oauth/cloud-connector/callback";
      returnUri.search = "";
      returnUri.hash = "";
      const session = await cloudConnector.startAuthorization({
        subject: subjectUserId,
        companyId,
        profile: connectorProfile,
        returnUri: returnUri.toString(),
        returnState: state,
      });
      const remoteExpiry = new Date(session.expiresAt);
      const expiresAt = Number.isFinite(remoteExpiry.getTime())
        ? new Date(Math.min(remoteExpiry.getTime(), now().getTime() + 10 * 60 * 1000))
        : new Date(now().getTime() + 10 * 60 * 1000);
      await db.insert(toolOauthStates).values({
        state,
        companyId,
        connectionId: connection.id,
        // Paperclip Cloud owns PKCE for this flow. The local state row remains the
        // single-use browser correlator and never stores broker token material.
        codeVerifier: "paperclip-cloud-connector",
        createdByActorType: binding.actorType,
        createdByActorId: binding.actorId,
        createdBySessionId: binding.sessionId,
        subjectUserId,
        requestedScopes: [...googleProfile.scopes],
        returnTo: input.returnTo,
        issueId: intentLink?.issueId ?? input.issueId,
        interactionId: intentLink?.id,
        expiresAt,
      });
      return {
        connectionId: connection.id,
        provider: "google",
        authorizationUrl: session.authorizationUrl,
        expiresAt: expiresAt.toISOString(),
        issuer: "https://accounts.google.com",
        resource: galleryMethod.defaults?.serverUrl ?? null,
        registrationSource: null,
      };
    }
    const endpoints = await oauthEndpointsForConnection(connection, null, input.redirectUri);
    if (endpoints.grantType === "client_credentials") {
      throw unprocessable("This app uses shared machine credentials and does not need browser sign in");
    }
    const resolvedClient = await ensureOAuthClient({
      connection,
      endpoints,
      redirectUri: input.redirectUri,
      galleryEntry,
      actor: input.actor,
    });
    connection = resolvedClient.connection;
    const client = resolvedClient.client;
    if (!client.clientId) throw unprocessable(`OAuth client id is not configured for ${endpoints.provider}`);

    await db.delete(toolOauthStates).where(lt(toolOauthStates.expiresAt, new Date()));

    const state = randomOauthToken();
    const codeVerifier = randomOauthToken(48);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const binding = starterBinding;
    if (!binding.actorType || !binding.actorId) {
      throw forbidden("OAuth sign-in requires an authenticated board session");
    }
    await db.insert(toolOauthStates).values({
      state,
      companyId,
      connectionId: connection.id,
      codeVerifier,
      createdByActorType: binding.actorType,
      createdByActorId: binding.actorId,
      createdBySessionId: binding.sessionId,
      subjectUserId: authorizationSubjectUserId,
      requestedScopes: requestedScopes ?? undefined,
      returnTo: input.returnTo,
      issueId: intentLink?.issueId ?? input.issueId,
      interactionId: intentLink?.id,
      expiresAt,
    });

    // Last gate before this URL becomes a top-level browser navigation. Every
    // producer above already validates, so reaching a rejection here means a new
    // path was added without one — fail closed rather than hand the board an
    // unvetted target.
    const authorizationUrl = new URL(assertOAuthEndpointUrl("authorization", endpoints.authorizationUrl, {
      // Paperclip's own callback origin: a first-party authorization endpoint is
      // served however this deployment is served, plaintext LAN host included.
      firstPartyOrigin: originOf(input.redirectUri),
    }));
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", client.clientId);
    authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", base64UrlSha256(codeVerifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    // RFC 8707: name the MCP server the resulting token is for, so an
    // authorization server that serves several resources can audience-restrict it.
    if (endpoints.resource) authorizationUrl.searchParams.set("resource", endpoints.resource);
    // Curated definitions are an allowlist, not a suggestion. Never copy every
    // scope advertised by discovery into a provider consent screen: a curated
    // method either sends its reviewed hint or omits scope entirely. Generic
    // MCP URLs retain discovery-first behavior because Paperclip has no manifest
    // against which it could safely judge the caller's requested scope.
    const authorizationScopes = galleryMethod
      ? requestedScopes ?? []
      : input.scopes ?? endpoints.scopes;
    if (authorizationScopes.length > 0) authorizationUrl.searchParams.set("scope", authorizationScopes.join(" "));
    const reviewedAuthorizationParams = galleryMethod?.defaults?.oauthAuthorizationParams;
    if (reviewedAuthorizationParams?.access_type) authorizationUrl.searchParams.set("access_type", reviewedAuthorizationParams.access_type);
    if (reviewedAuthorizationParams?.prompt) authorizationUrl.searchParams.set("prompt", reviewedAuthorizationParams.prompt);

    if (authorizationSubjectUserId && input.issueId && binding.actorType === "agent") {
      const idempotencyKey = `connection-authorization:${connection.id}:${authorizationSubjectUserId}`;
      // Provider label for the card's copy. The gallery definition's name when we
      // have one, else the connection's own name — never a secret name or ref.
      const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string"
        ? connection.config.sourceTemplateKey
        : null;
      const providerName = (sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey)?.name : null)
        ?? connection.name;
      const [requestingAgent] = binding.actorId
        ? await db.select({ name: agents.name }).from(agents).where(and(
            eq(agents.id, binding.actorId),
            eq(agents.companyId, companyId),
          )).limit(1)
        : [undefined];
      const payload = {
        version: 1 as const,
        prompt: `Connect your ${providerName} to continue`,
        acceptLabel: `Connect ${providerName}`,
        rejectLabel: "Not now",
        detailsMarkdown: "Authorization is required before this agent can act on your behalf.",
        // Presentation metadata so the card can compose its own copy instead of
        // parsing the title string (PAP-17835 seam #6). The interaction kind and
        // the server-addressed audience are unchanged.
        connectionAuthorization: {
          version: 1 as const,
          providerName,
          connectionName: connection.name === providerName ? null : connection.name,
          requestingAgentName: requestingAgent?.name ?? null,
        },
        target: {
          type: "custom" as const,
          key: `connection:${connection.uid}:user:${authorizationSubjectUserId}`,
          revisionId: state,
          label: `Connect ${providerName}`,
          href: authorizationUrl.toString(),
        },
      };
      const [existingInteraction] = await db.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.idempotencyKey, idempotencyKey),
      )).limit(1);
      const [interaction] = existingInteraction
        ? await db.update(issueThreadInteractions).set({
            status: "pending",
            requestedResolverPolicy: "human_only",
            effectiveResolverPolicy: "human_only",
            resolverPolicyProvenance: "explicit",
            effectiveResolverPolicySource: "requested",
            addresseeUserId: authorizationSubjectUserId,
            payload,
            result: null,
            resolvedAt: null,
            updatedAt: new Date(),
          }).where(eq(issueThreadInteractions.id, existingInteraction.id)).returning()
        : await db.insert(issueThreadInteractions).values({
            companyId,
            issueId: input.issueId,
            kind: "request_confirmation",
            status: "pending",
            continuationPolicy: "none",
            requestedResolverPolicy: "human_only",
            effectiveResolverPolicy: "human_only",
            resolverPolicyProvenance: "explicit",
            effectiveResolverPolicySource: "requested",
            addresseeUserId: authorizationSubjectUserId,
            idempotencyKey,
            sourceRunId: binding.actorType === "agent" ? input.actor.sessionId ?? null : null,
            title: `Connect your ${providerName} to continue`,
            summary: `${requestingAgent?.name ?? "An agent"} needs your ${providerName} identity for work running as you.`,
            createdByAgentId: binding.actorType === "agent" ? binding.actorId : null,
            payload,
          }).returning();
      if (interaction) {
        await db.update(toolOauthStates).set({ interactionId: interaction.id }).where(eq(toolOauthStates.state, state));
      }
    }

    const nextConfig = {
      ...connection.config,
      oauth: {
        ...oauthConfig(connection),
        provider: endpoints.provider,
        authorizationUrl: endpoints.authorizationUrl,
        tokenUrl: endpoints.tokenUrl,
        registrationUrl: endpoints.registrationUrl ?? null,
        metadataUrl: endpoints.metadataUrl ?? null,
        // Curated apps persist only the reviewed scopes attached to this OAuth
        // state. Discovery metadata can advertise a provider's entire scope
        // universe and must never silently become Paperclip's requested set.
        scopes: galleryMethod ? requestedScopes ?? [] : endpoints.scopes,
        codeChallengeMethodsSupported: endpoints.codeChallengeMethodsSupported ?? [],
        tokenEndpointAuthMethodsSupported: endpoints.tokenEndpointAuthMethodsSupported ?? [],
        grantType: "authorization_code",
        clientIdEnv: client.clientIdEnv,
        clientSecretEnv: client.clientSecret ? client.clientSecretEnv : null,
        credentialScope: credentialScope(connection, input.actor),
        // Persist the issuer and resource this authorization run is bound to.
        // `iss` on the callback is validated against `expectedIssuer`, and
        // refresh/reconnect/revoke reuse the same pair rather than re-deriving it.
        issuer: endpoints.issuer ?? oauthConfig(connection).issuer ?? null,
        expectedIssuer: endpoints.issuer ?? null,
        resource: endpoints.resource ?? oauthConfig(connection).resource ?? null,
        clientIdMetadataDocumentSupported: endpoints.clientIdMetadataDocumentSupported === true,
      },
    };
    await db
      .update(toolConnections)
      .set({
        // A generic URL connection starts life as `authKind: none`. Once it has
        // completed OAuth discovery and client resolution it is an OAuth
        // connection, and refresh, reconnect, revoke and diagnostics must all
        // treat it as one.
        authKind: "oauth",
        config: nextConfig,
        transportConfig: nextConfig,
        updatedAt: new Date(),
      })
      .where(eq(toolConnections.id, connection.id));

    return {
      connectionId: connection.id,
      provider: endpoints.provider,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: expiresAt.toISOString(),
      issuer: endpoints.issuer ?? null,
      resource: endpoints.resource ?? null,
      registrationSource: resolvedClient.source,
    };
  }

  async function peekOAuthState(state: string) {
    const [row] = await db
      .select({
        companyId: toolOauthStates.companyId,
        connectionId: toolOauthStates.connectionId,
        subjectUserId: toolOauthStates.subjectUserId,
        returnTo: toolOauthStates.returnTo,
        issueId: toolOauthStates.issueId,
        interactionId: toolOauthStates.interactionId,
      })
      .from(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .limit(1);
    return row ?? null;
  }

  /** Bind a callback to its initiating actor without consuming retryable state. */
  async function validateOAuthState(state: string, actor: ActorInfo | undefined) {
    const [stateRow] = await db
      .select()
      .from(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .limit(1);
    if (!stateRow) throw badRequest("OAuth state was not found or has already been used");
    if (stateRow.expiresAt.getTime() <= Date.now()) throw badRequest("OAuth state has expired");
    if (stateRow.subjectUserId) {
      if (actor?.actorType !== "user" || actor.actorId !== stateRow.subjectUserId) {
        throw forbidden("OAuth callback user does not match the requested subject");
      }
    } else {
      assertSameOAuthActor(stateRow, actor);
    }
    return stateRow;
  }

  /**
   * Answer a terminal authorization callback exactly once. Actor validation
   * happens before the atomic delete, so an unbound callback cannot consume a
   * valid flow and concurrent callbacks cannot both complete it.
   */
  async function consumeOAuthState(state: string, actor: ActorInfo | undefined) {
    const stateRow = await validateOAuthState(state, actor);
    const [consumed] = await db
      .delete(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .returning();
    if (!consumed) throw badRequest("OAuth state was not found or has already been used");
    return consumed;
  }

  /**
   * End the board's "Connect your account" prompt when the user declines in the
   * provider's window (PAP-17109). Without this the card stays `pending`, so the
   * board keeps offering an authorization link for a flow the user just refused
   * and the requesting agent never learns the answer.
   *
   * Scoped to a still-`pending` row: a board user who already answered the card
   * directly keeps their own answer.
   */
  async function rejectPendingOAuthInteraction(
    stateRow: typeof toolOauthStates.$inferSelect,
    actor: ActorInfo | undefined,
  ) {
    if (!stateRow.interactionId) return;
    const now = new Date();
    const linked = await db
      .select({ kind: issueThreadInteractions.kind, payload: issueThreadInteractions.payload })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.id, stateRow.interactionId),
        eq(issueThreadInteractions.companyId, stateRow.companyId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (linked?.kind === "connection_intent") {
      const connectionIntentPayload = connectionIntentPayloadSchema.parse(linked.payload);
      await db
        .update(issueThreadInteractions)
        .set({ payload: { ...connectionIntentPayload, phase: "needs_retry" }, updatedAt: now })
        .where(and(
          eq(issueThreadInteractions.id, stateRow.interactionId),
          eq(issueThreadInteractions.companyId, stateRow.companyId),
          eq(issueThreadInteractions.status, "pending"),
        ));
      return;
    }
    await db
      .update(issueThreadInteractions)
      .set({
        status: "rejected",
        result: {
          version: 1,
          outcome: "rejected",
          // Paperclip's own words: the provider's explanation is untrusted and
          // this reason is rendered in the thread (PAP-17108).
          reason: "Authorization was declined or cancelled in the provider's window",
        },
        resolvedByUserId: actor?.actorType === "user" ? actor.actorId : null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(issueThreadInteractions.id, stateRow.interactionId),
        eq(issueThreadInteractions.companyId, stateRow.companyId),
        eq(issueThreadInteractions.status, "pending"),
      ));
  }

  async function finishOAuthCatalogWithRecommendedDefaults(input: {
    connection: typeof toolConnections.$inferSelect;
    catalog: ToolCatalogEntry[];
    suggestedDefaults: ConnectToolAppResult["suggestedDefaults"];
    activateQuarantined?: boolean;
    actor?: ActorInfo;
  }) {
    const installs = await db.select().from(toolConnectionInstalls).where(and(
      eq(toolConnectionInstalls.companyId, input.connection.companyId),
      eq(toolConnectionInstalls.connectionId, input.connection.id),
    ));
    const companyInstall = installs.some((install) => install.targetType === "company");
    const agentIds = installs
      .filter((install) => install.targetType === "agent")
      .map((install) => install.targetId);
    const access: FinishToolApp["access"] = companyInstall || agentIds.length === 0
      ? "all_agents"
      : { agentIds };
    const askFirstRiskLevels = new Set(
      Array.isArray(input.suggestedDefaults.askFirstRiskLevels)
        ? input.suggestedDefaults.askFirstRiskLevels.filter(
            (riskLevel): riskLevel is string => typeof riskLevel === "string",
          )
        : [],
    );
    const enabledCatalog = input.catalog.filter((entry) =>
      entry.status === "active" || (input.activateQuarantined === true && entry.status === "quarantined")
    );
    const finished = await finishGalleryAppConnection(input.connection.companyId, input.connection.id, {
      enabledCatalogEntryIds: enabledCatalog.map((entry) => entry.id),
      askFirstCatalogEntryIds: enabledCatalog
        .filter((entry) => askFirstRiskLevels.has(entry.riskLevel))
        .map((entry) => entry.id),
      reviewedCatalogEntryIds: input.activateQuarantined === true
        ? enabledCatalog.filter((entry) => entry.status === "quarantined").map((entry) => entry.id)
        : undefined,
      access,
    }, input.actor);
    if (installs.length === 0) {
      await db.insert(toolConnectionInstalls).values({
        companyId: input.connection.companyId,
        connectionId: input.connection.id,
        targetType: "company",
        targetId: input.connection.companyId,
        createdByAgentId: input.actor?.actorType === "agent" ? input.actor.actorId ?? null : null,
        createdByUserId: input.actor?.actorType === "user" ? input.actor.actorId ?? null : null,
      }).onConflictDoNothing();
    }
    return finished;
  }

  async function completePaperclipCloudConnectorCallback(input: {
    state: string;
    claimId?: string | null;
    error?: string | null;
    actor?: ActorInfo;
  }): Promise<ConnectToolAppResult> {
    // Keep the local state live until the sealed claim is in the durable vault.
    // The broker binds repeat claim requests to this stable state value, so a
    // transient broker, database, or secret-store failure can retry safely.
    const stateRow = await validateOAuthState(input.state, input.actor);
    let connection = await getConnectionRow(stateRow.connectionId, stateRow.companyId);
    // The connection lifecycle, not the incidental presence of its app profile,
    // distinguishes setup from reauthorization. New connections and connections
    // revived after removal are drafts until this callback completes. A profile
    // may legitimately survive removal because an MCP gateway retains it, or be
    // intentionally archived on an otherwise active connection; neither case
    // should invert whether recommended defaults are rebuilt.
    const shouldFinalizeManagedDefaults = connection.status === "draft";
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    const method = galleryEntry ? connectionMethodForConnection(galleryEntry, connection) : null;
    const providerName = galleryEntry?.name ?? "Google Workspace";
    if (input.error) {
      const consumedState = await consumeOAuthState(input.state, input.actor);
      await rejectPendingOAuthInteraction(consumedState, input.actor);
      throw new HttpError(400, `Google authorization did not complete. Start a new ${providerName} connection to try again.`, {
        code: input.error === "access_denied" ? "oauth_authorization_denied" : "paperclip_cloud_connector_failed",
      });
    }
    if (!input.claimId) throw badRequest(`${providerName} callback is missing a claim identifier`);
    const cloudConnector = currentCloudConnector();
    if (!cloudConnector) {
      throw unprocessable(`${providerName} connections through Paperclip are not available on this instance yet`, {
        code: "paperclip_cloud_connector_unavailable",
      });
    }
    const subjectUserId = stateRow.subjectUserId;
    if (!method || !isPaperclipCloudConnectorStrategy(method.oauthStrategy) || !subjectUserId) {
      throw badRequest("OAuth state does not belong to a Google connector flow");
    }
    const connectorProfile = method.connectorProfile;
    if (!connectorProfile || !isGoogleWorkspaceConnectorProfileId(connectorProfile)) throw badRequest("Google connector profile is invalid");
    const profile = GOOGLE_WORKSPACE_CONNECTOR_PROFILES[connectorProfile];
    const credentials = await cloudConnector.claim({
      subject: subjectUserId,
      companyId: stateRow.companyId,
      profile: connectorProfile,
      claimId: input.claimId,
      redemptionId: input.state,
    });
    const refreshToken = credentials.refreshToken;
    if (!refreshToken) {
      throw unprocessable(`Google did not return offline access. Reconnect ${providerName} and grant the requested scopes.`, {
        code: "oauth_refresh_missing",
      });
    }

    await db.transaction(async (tx) => {
      // Keep connector credential persistence serialized with membership
      // suspension, downgrade, and removal. A successful claim is only durable
      // while the initiating user still holds connection-management authority.
      const [membership] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, connection.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, subjectUserId),
        eq(companyMemberships.status, "active"),
        ne(companyMemberships.membershipRole, "viewer"),
      )).limit(1).for("update");
      if (!membership) {
        throw forbidden(`Your company membership no longer permits connection changes. Restore non-viewer access before you connect ${providerName} again.`);
      }
      const [consumedState] = await tx
        .delete(toolOauthStates)
        .where(and(
          eq(toolOauthStates.state, input.state),
          gte(toolOauthStates.expiresAt, new Date()),
        ))
        .returning({ state: toolOauthStates.state });
      if (!consumedState) throw badRequest("OAuth state was not found, expired, or has already been used");
      const txSecrets = secretService(tx);
      const txSecretContext = { dbClient: tx, secretClient: txSecrets };
      const [existingUserGrant] = await tx.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "user"),
        eq(connectionGrants.subjectUserId, subjectUserId),
      )).limit(1);
      const existingRefs = existingUserGrant?.credentialSecretRefs ?? [];
      const accessRef = await createOrRotateOAuthSecret({
        companyId: connection.companyId,
        connection,
        configPath: "oauth.access_token",
        label: `${providerName} access token`,
        value: credentials.accessToken,
        actor: input.actor,
        existingRefs,
        ownerUserId: subjectUserId,
      }, txSecretContext);
      const refreshRef = await createOrRotateOAuthSecret({
        companyId: connection.companyId,
        connection,
        configPath: "oauth.refresh_token",
        label: `${providerName} refresh token`,
        value: refreshToken,
        actor: input.actor,
        existingRefs,
        ownerUserId: subjectUserId,
      }, txSecretContext);
      const credentialSecretRefs = [
        ...existingRefs.filter((ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token"),
        accessRef,
        refreshRef,
      ];
      const grantValues = {
        providerTenant: {
          name: providerName,
          externalId: credentials.subject,
          oauth: {
            strategy: "paperclip_cloud_connector",
            accessTokenExpiresAt: credentials.accessTokenExpiresAt,
            scopes: credentials.scopes,
            tokenType: credentials.tokenType,
          },
        },
        credentialSecretRefs,
        status: "active" as const,
        revokedAt: null,
        revokedByAgentId: null,
        revokedByUserId: null,
        updatedAt: now(),
      };
      if (existingUserGrant) {
        await tx.update(connectionGrants).set(grantValues).where(eq(connectionGrants.id, existingUserGrant.id));
      } else {
        await tx.insert(connectionGrants).values({
          companyId: connection.companyId,
          connectionId: connection.id,
          kind: "user",
          subjectUserId,
          ...grantValues,
          isDefault: false,
          createdByUserId: subjectUserId,
        });
      }
      const nextConfig = {
        ...connection.config,
        oauth: {
          ...oauthConfig(connection),
          strategy: "paperclip_cloud_connector",
          provider: galleryEntry?.slug,
          connectorProfile,
          connectorSubjectUserId: subjectUserId,
          resource: method.defaults?.serverUrl,
          scopes: [...profile.scopes],
        },
      };
      [connection] = await tx.update(toolConnections).set({
        status: shouldFinalizeManagedDefaults ? "draft" : "active",
        enabled: shouldFinalizeManagedDefaults ? false : true,
        authKind: "oauth",
        config: nextConfig,
        transportConfig: nextConfig,
        updatedAt: now(),
      }).where(eq(toolConnections.id, connection.id)).returning();
      await tx.update(toolApplications).set({
        status: shouldFinalizeManagedDefaults ? "draft" : "active",
        updatedAt: now(),
      }).where(eq(toolApplications.id, connection.applicationId));
      await syncCredentialBindings(connection, credentialSecretRefs, tx);
      const linkedInteractionKind = stateRow.interactionId
        ? await tx
            .select({ kind: issueThreadInteractions.kind })
            .from(issueThreadInteractions)
            .where(eq(issueThreadInteractions.id, stateRow.interactionId))
            .limit(1)
            .then((rows) => rows[0]?.kind ?? null)
        : null;
      if (stateRow.interactionId && linkedInteractionKind === "request_confirmation") {
        await tx.update(issueThreadInteractions).set({
          status: "accepted",
          result: { version: 1, outcome: "accepted" },
          resolvedByUserId: subjectUserId,
          resolvedAt: now(),
          updatedAt: now(),
        }).where(eq(issueThreadInteractions.id, stateRow.interactionId));
      }
    });
    const refresh = await refreshCatalog(connection.id, input.actor, {
      enableAllByDefault: false,
      quarantineManagedOAuthDraft: shouldFinalizeManagedDefaults,
      skipDefaultProfileSync: true,
      credentialHeaders: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    const suggestedDefaults = recommendedDefaultsForApp(galleryEntry!, method.key);
    const finished = shouldFinalizeManagedDefaults
      ? await finishOAuthCatalogWithRecommendedDefaults({
          connection,
          catalog: refresh.catalog,
          suggestedDefaults,
          activateQuarantined: true,
          actor: input.actor,
        })
      : null;
    const activatedCatalogEntryIds = new Set(
      shouldFinalizeManagedDefaults
        ? refresh.catalog.filter((entry) => entry.status === "quarantined").map((entry) => entry.id)
        : [],
    );
    const catalog = refresh.catalog.map((entry) =>
      activatedCatalogEntryIds.has(entry.id) ? { ...entry, status: "active" as const } : entry
    );
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
    return {
      connectionId: connection.id,
      application: toApplication(application),
      connection: finished?.connection ?? refresh.connection,
      catalog,
      actions: groupedActions(catalog),
      suggestedDefaults,
      auth: null,
    };
  }

  async function completeVercelConnectCallback(input: {
    state: string;
    error?: string | null;
    actor?: ActorInfo;
  }): Promise<ConnectToolAppResult> {
    const stateRow = await consumeOAuthState(input.state, input.actor);
    if (stateRow.codeVerifier !== "vercel-connect") {
      throw badRequest("OAuth state does not belong to a Vercel Connect flow");
    }
    if (input.error) {
      await rejectPendingOAuthInteraction(stateRow, input.actor);
      throw new HttpError(400, "Vercel Connect authorization did not complete. Start a new authorization to try again.", {
        code: input.error === "access_denied" ? "oauth_authorization_denied" : "vercel_connect_authorization_required",
      });
    }
    if (!vercelConnect) throw vercelConnectHttpError(new VercelConnectClientError("vercel_connect_unavailable", 503));
    let connection = await getConnectionRow(stateRow.connectionId, stateRow.companyId);
    const credential = vercelCredentialFor(connection);
    if (credential.principalMode !== "user" || connection.authKind !== "oauth") {
      throw badRequest("Vercel Connect callback does not match this connection");
    }
    const grantKind: ConnectionGrantKind = stateRow.subjectUserId ? "user" : "organization";
    if (stateRow.subjectUserId) {
      const [membership] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, connection.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, stateRow.subjectUserId),
        eq(companyMemberships.status, "active"),
        ne(companyMemberships.membershipRole, "viewer"),
      )).limit(1);
      if (!membership) {
        throw forbidden("Your company membership no longer permits connection changes. Restore non-viewer access before authorizing this connection.");
      }
    }
    const [existingGrant] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, connection.companyId),
      eq(connectionGrants.connectionId, connection.id),
      eq(connectionGrants.kind, grantKind),
      grantKind === "user"
        ? eq(connectionGrants.subjectUserId, stateRow.subjectUserId!)
        : eq(connectionGrants.isDefault, true),
    )).limit(1);
    const derived = deriveVercelConnectSubject({
      credential,
      connectionId: connection.id,
      companyId: connection.companyId,
      grantKind,
      subjectUserId: stateRow.subjectUserId,
    });
    const request = vercelTokenRequest({
      credential,
      connectionId: connection.id,
      companyId: connection.companyId,
      resources: vercelConnectResourcesFor(connection),
      grant: {
        kind: grantKind,
        subjectUserId: stateRow.subjectUserId,
        externalCredential: existingGrant?.externalCredential,
      },
    });
    let token;
    try {
      token = await vercelConnect.getToken(request, { forceRefresh: true });
    } catch (error) {
      throw vercelConnectHttpError(error);
    }
    if (token.connector.id !== credential.connectorId && token.connector.uid !== credential.connectorUid) {
      throw new HttpError(502, "Vercel Connect returned a token for a different connector.", {
        code: "vercel_connect_connector_mismatch",
      });
    }
    const externalGrant = vercelGrantReference({
      credential,
      token,
      subjectId: derived.subjectId,
      verifiedAt: now(),
    });
    const grantValues = {
      providerTenant: token.tenantId
        ? { name: credential.service, externalId: token.tenantId }
        : { name: credential.service },
      credentialSecretRefs: [],
      externalCredential: externalGrant,
      status: "active" as const,
      isDefault: grantKind === "organization",
      revokedAt: null,
      revokedByAgentId: null,
      revokedByUserId: null,
      updatedAt: now(),
    };
    if (existingGrant) {
      await db.update(connectionGrants).set(grantValues).where(eq(connectionGrants.id, existingGrant.id));
    } else {
      await db.insert(connectionGrants).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: grantKind,
        subjectUserId: stateRow.subjectUserId,
        ...grantValues,
        createdByUserId: input.actor?.actorType === "user" ? input.actor.actorId ?? null : null,
      });
    }
    [connection] = await db.update(toolConnections).set({
      status: "active",
      enabled: true,
      credentialRefs: [],
      credentialSecretRefs: [],
      updatedAt: now(),
    }).where(and(
      eq(toolConnections.id, connection.id),
      eq(toolConnections.companyId, connection.companyId),
    )).returning();
    await db.update(toolApplications).set({ status: "active", updatedAt: now() })
      .where(eq(toolApplications.id, connection.applicationId));
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string"
      ? connection.config.sourceTemplateKey
      : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    if (!galleryEntry) throw badRequest("Vercel Connect connection is missing its reviewed app definition");
    const method = connectionMethodForConnection(galleryEntry, connection);
    const refresh = await refreshCatalog(connection.id, input.actor, {
      enableAllByDefault: true,
      credentialHeaders: {
        ...projectedConnectionHeaders(connection),
        [credential.headerName]: `${credential.headerPrefix ?? ""}${token.token}`,
      },
    });
    const suggestedDefaults = recommendedDefaultsForApp(galleryEntry, method.key);
    const finished = await finishOAuthCatalogWithRecommendedDefaults({
      connection,
      catalog: refresh.catalog,
      suggestedDefaults,
      actor: input.actor,
    });
    const [application] = await db.select().from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    return {
      connectionId: connection.id,
      application: toApplication(application),
      connection: finished.connection,
      catalog: refresh.catalog,
      actions: groupedActions(refresh.catalog),
      suggestedDefaults,
      auth: null,
    };
  }

  async function completeOAuthCallback(input: {
    state: string;
    code?: string | null;
    /**
     * RFC 6749 `error`. Untrusted, and deliberately the *only* thing read from a
     * failed callback — `error_description` and `error_uri` are not accepted as
     * input at all, so there is nothing for a hostile provider to reflect
     * through (PAP-17108).
     */
    error?: string | null;
    redirectUri: string;
    /** RFC 9207 `iss`, when the authorization server returns it. */
    iss?: string | null;
    actor?: ActorInfo;
  }): Promise<ConnectToolAppResult> {
    // Binding first, outcome second: the provider's report of a failure is only
    // acted on once the callback is bound to a state Paperclip issued and to the
    // actor that started the flow, so an unsolicited callback cannot drive any
    // path here. Consuming the state up front is what makes a denial terminal —
    // a refused request must not stay completable by a later code (PAP-17109).
    const stateRow = await consumeOAuthState(input.state, input.actor);
    if (input.error) {
      await rejectPendingOAuthInteraction(stateRow, input.actor);
      const providerError = normalizeOAuthProviderError(input.error);
      throw new HttpError(400, oauthProviderErrorMessage(providerError, "The authorization server denied the request."), {
        code: "oauth_authorization_denied",
        providerError,
      });
    }
    // Neither a code nor an error is not a usable answer either. It still spends
    // the request: the recovery is a fresh authorization, not a state left live
    // waiting for a better callback.
    if (!input.code) throw badRequest("OAuth callback is missing a code");

    let connection = await getConnectionRow(stateRow.connectionId, stateRow.companyId);
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    assertOAuthRedirectConstraints(galleryEntry, input.redirectUri);
    const endpoints = await oauthEndpointsForConnection(connection, null, input.redirectUri);
    assertOAuthCallbackIssuer(connection, endpoints, input.iss);
    const client = await oauthClientForConnection(connection, endpoints.provider, input.actor);
    if (!client.clientId) throw unprocessable(`OAuth client id is not configured for ${endpoints.provider}`);

    const token = await exchangeOAuthToken({
      tokenUrl: endpoints.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpointAuthMethod: storedOAuthTokenEndpointAuthMethod(
        oauthConfig(connection),
        client.clientSecret,
      ),
      redirectUri: input.redirectUri,
      codeVerifier: stateRow.codeVerifier,
      code: input.code,
      resource: endpoints.resource,
    });
    const connectedAt = now();
    const expiresAt = token.expiresIn
      ? new Date(connectedAt.getTime() + token.expiresIn * 1000).toISOString()
      : null;
    if (stateRow.subjectUserId) {
      let personalCredentialSecretRefs: typeof connectionGrants.$inferSelect.credentialSecretRefs = [];
      await db.transaction(async (tx) => {
        // Serialize callback persistence with suspension/removal. Those paths
        // lock this same membership row before sweeping personal credentials.
        const [membership] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
          eq(companyMemberships.companyId, connection.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, stateRow.subjectUserId!),
          eq(companyMemberships.status, "active"),
          ne(companyMemberships.membershipRole, "viewer"),
        )).limit(1).for("update");
        if (!membership) {
          throw forbidden("Your company membership no longer permits connection changes. Ask a company owner to restore non-viewer access before you authorize this connection again.");
        }
        const txSecrets = secretService(tx);
        const txSecretContext = { dbClient: tx, secretClient: txSecrets };

        const [existingUserGrant] = await tx.select().from(connectionGrants).where(and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, stateRow.subjectUserId!),
        )).limit(1);
        const subjectCredentialSecretRefs = existingUserGrant?.credentialSecretRefs ?? [];
        const accessRef = await createOrRotateOAuthSecret({
          companyId: connection.companyId,
          connection,
          configPath: "oauth.access_token",
          label: "OAuth access token",
          value: token.accessToken,
          actor: input.actor,
          existingRefs: subjectCredentialSecretRefs,
          ownerUserId: stateRow.subjectUserId!,
        }, txSecretContext);
        const nextCredentialSecretRefs = [
          ...subjectCredentialSecretRefs.filter((ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token"),
          accessRef,
        ];
        if (token.refreshToken) {
          nextCredentialSecretRefs.push(await createOrRotateOAuthSecret({
            companyId: connection.companyId,
            connection,
            configPath: "oauth.refresh_token",
            label: "OAuth refresh token",
            value: token.refreshToken,
            actor: input.actor,
            existingRefs: subjectCredentialSecretRefs,
            ownerUserId: stateRow.subjectUserId!,
          }, txSecretContext));
        } else {
          const existingRefreshRef = subjectCredentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token");
          if (existingRefreshRef) nextCredentialSecretRefs.push(existingRefreshRef);
        }

        const grantValues = {
          providerTenant: {
            ...(existingUserGrant?.providerTenant ?? {}),
            oauth: {
              ...asRecord(asRecord(existingUserGrant?.providerTenant).oauth),
              strategy: "direct_oauth",
              accessTokenExpiresAt: expiresAt ?? undefined,
              scopes: normalizeOauthScopes(token.scope ?? stateRow.requestedScopes),
              tokenType: token.tokenType,
              refreshedAt: connectedAt.toISOString(),
            },
          },
          credentialSecretRefs: nextCredentialSecretRefs,
          status: "active" as const,
          revokedAt: null,
          revokedByAgentId: null,
          revokedByUserId: null,
          updatedAt: new Date(),
        };
        if (existingUserGrant) {
          await tx.update(connectionGrants).set(grantValues).where(eq(connectionGrants.id, existingUserGrant.id));
        } else {
          await tx.insert(connectionGrants).values({
            companyId: connection.companyId,
            connectionId: connection.id,
            kind: "user",
            subjectUserId: stateRow.subjectUserId!,
            ...grantValues,
            isDefault: false,
            createdByUserId: stateRow.subjectUserId!,
          });
        }
        personalCredentialSecretRefs = nextCredentialSecretRefs;
        const nextConfig = {
          ...connection.config,
          oauth: {
            ...withoutOAuthRefreshLease(oauthConfig(connection)),
            provider: endpoints.provider,
            authorizationUrl: endpoints.authorizationUrl,
            tokenUrl: endpoints.tokenUrl,
            metadataUrl: endpoints.metadataUrl ?? null,
            scopes: galleryEntry ? normalizeOauthScopes(stateRow.requestedScopes) : endpoints.scopes,
            clientIdEnv: client.clientIdEnv,
            clientSecretEnv: client.clientSecret ? client.clientSecretEnv : null,
            credentialScope: credentialScope(connection, input.actor),
            issuer: endpoints.issuer ?? oauthConfig(connection).issuer ?? null,
            resource: endpoints.resource ?? oauthConfig(connection).resource ?? null,
            expiresAt,
            scope: token.scope,
            tokenType: token.tokenType,
            connectedAt: connectedAt.toISOString(),
          },
          providerMetadata: {
            ...asRecord(connection.config.providerMetadata),
            oauth: { expiresAt, scope: token.scope, tokenType: token.tokenType },
          },
        };
        const [updatedConnection] = await tx.update(toolConnections).set({
          status: "active",
          enabled: true,
          authKind: "oauth",
          credentialPolicy: connection.credentialPolicy,
          config: nextConfig,
          transportConfig: nextConfig,
          // A personal-only connection keeps tokens exclusively on its user
          // grant. Adding a personal identity to an existing shared/fallback
          // connection must not erase that connection's organization token.
          credentialRefs: connection.credentialPolicy === "per_user"
            ? connection.credentialRefs.filter((ref) => ref.name !== "oauth.access_token")
            : connection.credentialRefs,
          credentialSecretRefs: connection.credentialPolicy === "per_user"
            ? connection.credentialSecretRefs.filter(
                (ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token",
              )
            : connection.credentialSecretRefs,
          updatedAt: new Date(),
        })
          .where(eq(toolConnections.id, connection.id))
          .returning();
        if (!updatedConnection) throw new Error("OAuth connection was not found");
        connection = updatedConnection;
        await tx.update(toolApplications).set({
          status: "active",
          updatedAt: new Date(),
        }).where(eq(toolApplications.id, connection.applicationId));
        const linkedInteractionKind = stateRow.interactionId
          ? await tx
              .select({ kind: issueThreadInteractions.kind })
              .from(issueThreadInteractions)
              .where(eq(issueThreadInteractions.id, stateRow.interactionId))
              .limit(1)
              .then((rows) => rows[0]?.kind ?? null)
          : null;
        if (stateRow.interactionId && linkedInteractionKind === "request_confirmation") {
          await tx.update(issueThreadInteractions).set({
            status: "accepted",
            result: { version: 1, outcome: "accepted" },
            resolvedByUserId: stateRow.subjectUserId!,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          }).where(and(
            eq(issueThreadInteractions.id, stateRow.interactionId),
            eq(issueThreadInteractions.companyId, connection.companyId),
          ));
        }
        await syncCredentialBindings(
          connection,
          connection.credentialPolicy === "per_user" ? personalCredentialSecretRefs : [],
          tx,
        );
      });

      // Personal OAuth used to return immediately after saving the grant. That
      // left the connection draft/paused and its catalog empty, so the person
      // who had just consented landed on a false "Nothing to test" state.
      // Activate and discover with the just-issued token before returning.
      const refresh = await refreshCatalog(connection.id, input.actor, {
        enableAllByDefault: true,
        credentialHeaders: { Authorization: `Bearer ${token.accessToken}` },
      });
      const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
      if (!application) throw new Error("OAuth connection application was not found");
      const suggestedDefaults = galleryEntry
        ? recommendedDefaultsForApp(galleryEntry, connectionMethodForConnection(galleryEntry, connection).key)
        : { access: "all_agents" as const, askFirstRiskLevels: [] };
      const finished = await finishOAuthCatalogWithRecommendedDefaults({
        connection,
        catalog: refresh.catalog,
        suggestedDefaults,
        actor: input.actor,
      });
      return {
        connectionId: refresh.connection.id,
        application: toApplication(application),
        connection: finished.connection,
        catalog: refresh.catalog,
        actions: groupedActions(refresh.catalog),
        suggestedDefaults,
        auth: null,
      };
    }

    const organizationActorUserId = stateRow.createdByActorType === "user"
      ? stateRow.createdByActorId
      : null;
    if (!organizationActorUserId) {
      throw forbidden("Organization OAuth completion requires the user who started sign-in");
    }
    await db.transaction(async (tx) => {
      // Keep callback persistence serialized with membership suspension, role
      // downgrade, and removal. Once this row is locked, authority cannot be
      // revoked between the live check and the shared credential/grant writes.
      const [membership] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, connection.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, organizationActorUserId),
        eq(companyMemberships.status, "active"),
        ne(companyMemberships.membershipRole, "viewer"),
      )).limit(1).for("update");
      if (!membership) {
        throw forbidden("Your company membership no longer permits connection changes. Ask a company owner to restore non-viewer access before you authorize this connection again.");
      }
      const txSecrets = secretService(tx);
      const txSecretContext = { dbClient: tx, secretClient: txSecrets };

      const subjectCredentialSecretRefs = connection.credentialSecretRefs;
      const accessRef = await createOrRotateOAuthSecret({
        companyId: connection.companyId,
        connection,
        configPath: "oauth.access_token",
        label: "OAuth access token",
        value: token.accessToken,
        actor: input.actor,
      }, txSecretContext);
      const nextCredentialSecretRefs = [
        ...subjectCredentialSecretRefs.filter((ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token"),
        accessRef,
      ];
      if (token.refreshToken) {
        nextCredentialSecretRefs.push(await createOrRotateOAuthSecret({
          companyId: connection.companyId,
          connection,
          configPath: "oauth.refresh_token",
          label: "OAuth refresh token",
          value: token.refreshToken,
          actor: input.actor,
        }, txSecretContext));
      } else {
        const existingRefreshRef = subjectCredentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token");
        if (existingRefreshRef) nextCredentialSecretRefs.push(existingRefreshRef);
      }
      const nextConfig = {
        ...connection.config,
        oauth: {
          ...withoutOAuthRefreshLease(oauthConfig(connection)),
          provider: endpoints.provider,
          authorizationUrl: endpoints.authorizationUrl,
          tokenUrl: endpoints.tokenUrl,
          metadataUrl: endpoints.metadataUrl ?? null,
          scopes: galleryEntry ? normalizeOauthScopes(stateRow.requestedScopes) : endpoints.scopes,
          clientIdEnv: client.clientIdEnv,
          clientSecretEnv: client.clientSecret ? client.clientSecretEnv : null,
          credentialScope: credentialScope(connection, input.actor),
          // Keep the issuer and resource this grant was minted against so refresh,
          // reconnect, revoke and diagnostics resolve the same authorization server
          // instead of re-discovering one from a possibly-changed endpoint.
          issuer: endpoints.issuer ?? oauthConfig(connection).issuer ?? null,
          resource: endpoints.resource ?? oauthConfig(connection).resource ?? null,
          expiresAt,
          scope: token.scope,
          tokenType: token.tokenType,
          connectedAt: connectedAt.toISOString(),
        },
        providerMetadata: {
          ...asRecord(connection.config.providerMetadata),
          oauth: { expiresAt, scope: token.scope, tokenType: token.tokenType },
        },
      };
      const [updatedConnection] = await tx
        .update(toolConnections)
        .set({
          status: "active",
          enabled: true,
          authKind: "oauth",
          config: nextConfig,
          transportConfig: nextConfig,
          credentialSecretRefs: nextCredentialSecretRefs,
          credentialRefs: [
            ...connection.credentialRefs.filter((ref) => ref.name !== "oauth.access_token"),
            {
              name: "oauth.access_token",
              secretId: accessRef.secretId,
              version: "latest" as const,
              placement: "header" as const,
              key: "Authorization",
              prefix: "Bearer ",
            },
          ],
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      connection = updatedConnection;
      await tx
        .update(toolApplications)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(toolApplications.id, connection.applicationId));
      // The organization grant is created before OAuth has any secrets to attach.
      // Synchronize it after every successful callback/rotation so all real tool
      // execution paths receive the credentials that setup and catalog discovery
      // just proved.
      await ensureDefaultOrganizationGrant(connection, tx);
      await syncCredentialBindings(connection, [], tx);
    });

    await checkConnectionHealth(connection.id, input.actor);
    const refresh = await refreshCatalog(connection.id, input.actor, { enableAllByDefault: true });
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
    const suggestedDefaults = galleryEntry ? recommendedDefaultsForApp(
      galleryEntry,
      connectionMethodForConnection(galleryEntry, connection).key,
    ) : {
      access: "all_agents" as const,
      askFirstRiskLevels: [],
    };
    const finished = await finishOAuthCatalogWithRecommendedDefaults({
      connection,
      catalog: refresh.catalog,
      suggestedDefaults,
      actor: input.actor,
    });
    return {
      connectionId: refresh.connection.id,
      application: toApplication(application),
      connection: finished.connection,
      catalog: refresh.catalog,
      actions: groupedActions(refresh.catalog),
      suggestedDefaults,
      auth: null,
    };
  }

  /**
   * Finish the one decision that cannot safely be guessed for a browser OAuth
   * connection: whether the consenting identity stays personal or becomes the
   * company's shared identity. The provider callback always writes a fresh
   * token to the consenting user's grant first. Only this explicit endpoint may
   * promote it to company-scoped secrets.
   */
  async function finalizeOAuthAccess(
    companyId: string,
    connectionId: string,
    input: FinalizeOAuthAccess,
    actor?: ActorInfo,
  ): Promise<FinishToolAppResult> {
    let connection = await getConnectionRow(connectionId, companyId);
    if (connection.authKind !== "oauth") throw badRequest("This connection does not use browser sign-in");
    if (connection.status === "archived") throw conflict("Archived app connections cannot be finished");
    const actorUserId = actor?.actorType === "user" ? actor.actorId : null;
    if (!actorUserId) throw badRequest("Finishing browser sign-in requires a signed-in user");

    const [personalGrant] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, companyId),
      eq(connectionGrants.connectionId, connection.id),
      eq(connectionGrants.kind, "user"),
      eq(connectionGrants.subjectUserId, actorUserId),
    )).limit(1);

    if (connection.credentialSource === "vercel_connect") {
      const [organizationGrant] = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "organization"),
        eq(connectionGrants.isDefault, true),
      )).limit(1);
      const selectedGrant = input.grantKind === "user" ? personalGrant : organizationGrant;
      if (!selectedGrant || selectedGrant.status !== "active" || !selectedGrant.externalCredential) {
        throw conflict("The selected Vercel Connect identity is missing. Authorize this connection again.");
      }
      const expectedPolicy = input.grantKind === "user" ? "per_user" : "shared";
      if (connection.credentialPolicy !== expectedPolicy) {
        throw conflict("Vercel Connect identity scope is fixed when the connector is attached. Create a new connection to change it.");
      }
    } else if (input.grantKind === "user") {
      if (!personalGrant || personalGrant.status !== "active" || personalGrant.credentialSecretRefs.length === 0) {
        throw conflict("Your connected identity is missing. Connect this app again before choosing Just me.");
      }
      if (connection.credentialPolicy === "shared" && connection.credentialSecretRefs.length > 0) {
        throw conflict("This connection already uses a company identity");
      }
      [connection] = await db.update(toolConnections).set({
        credentialPolicy: "per_user",
        credentialRefs: connection.credentialRefs.filter((ref) => ref.name !== "oauth.access_token"),
        credentialSecretRefs: connection.credentialSecretRefs.filter(
          (ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token",
        ),
        status: "active",
        enabled: true,
        updatedAt: new Date(),
      }).where(and(
        eq(toolConnections.id, connection.id),
        eq(toolConnections.companyId, companyId),
      )).returning();
      await syncCredentialBindings(connection, personalGrant.credentialSecretRefs);
    } else if (connection.credentialPolicy !== "shared" || connection.credentialSecretRefs.length === 0) {
      if (!personalGrant || personalGrant.status !== "active" || personalGrant.credentialSecretRefs.length === 0) {
        throw conflict("Your connected identity is missing. Connect this app again before sharing it.");
      }

      const personalSecretIds = personalGrant.credentialSecretRefs.map((ref) => ref.secretId);
      const personalSecretRows = await db.select({
        id: companySecrets.id,
        scope: companySecrets.scope,
        ownerUserId: companySecrets.ownerUserId,
        userSecretDefinitionId: companySecrets.userSecretDefinitionId,
      }).from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId),
        inArray(companySecrets.id, personalSecretIds),
      ));
      const personalSecretById = new Map(personalSecretRows.map((row) => [row.id, row]));
      const promotedRefs: ToolCredentialSecretRef[] = [];
      try {
        for (const ref of personalGrant.credentialSecretRefs) {
          const secretRow = personalSecretById.get(ref.secretId);
          if (
            !secretRow
            || secretRow.scope !== "user"
            || secretRow.ownerUserId !== actorUserId
            || !secretRow.userSecretDefinitionId
          ) {
            throw forbidden("Only your own connected identity can be shared with the company");
          }
          if (
            ref.configPath !== "oauth.access_token"
            && ref.configPath !== "oauth.refresh_token"
            && ref.configPath !== "oauth.client_secret"
          ) {
            throw badRequest("The connected identity contains an unsupported OAuth credential");
          }
          const resolved = await secrets.resolveUserSecretValue(companyId, {
            definitionId: secretRow.userSecretDefinitionId,
            responsibleUserId: actorUserId,
            version: ref.versionSelector ?? "latest",
          }, {
            consumerType: "tool_connection",
            consumerId: connection.id,
            responsibleUserId: actorUserId,
            actorType: "user",
            actorId: actorUserId,
          });
          if (!resolved) throw unprocessable("The connected identity could not be read");
          const promoted = await createOrRotateOAuthSecret({
            companyId,
            connection,
            configPath: ref.configPath,
            label: ref.label ?? "OAuth credential",
            value: resolved.value,
            actor,
            existingRefs: promotedRefs,
          });
          promotedRefs.push({ ...ref, ...promoted });
        }

        const accessRef = promotedRefs.find((ref) => ref.configPath === "oauth.access_token");
        if (!accessRef) throw unprocessable("The connected identity is missing its OAuth access token");
        const connectionCredentialSecretRefs = [
          ...connection.credentialSecretRefs.filter(
            (ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token",
          ),
          ...promotedRefs,
        ];
        const nowAt = new Date();
        await db.transaction(async (tx) => {
          const [existingOrganizationGrant] = await tx.select().from(connectionGrants).where(and(
            eq(connectionGrants.companyId, companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.kind, "organization"),
            eq(connectionGrants.isDefault, true),
          )).limit(1);
          let organizationGrantId: string;
          if (existingOrganizationGrant) {
            organizationGrantId = existingOrganizationGrant.id;
            await tx.update(connectionGrants).set({
              providerTenant: personalGrant.providerTenant,
              credentialSecretRefs: connectionCredentialSecretRefs,
              status: "active",
              revokedAt: null,
              revokedByAgentId: null,
              revokedByUserId: null,
              updatedAt: nowAt,
            }).where(eq(connectionGrants.id, existingOrganizationGrant.id));
          } else {
            const [createdOrganizationGrant] = await tx.insert(connectionGrants).values({
              companyId,
              connectionId: connection.id,
              kind: "organization",
              subjectUserId: null,
              providerTenant: personalGrant.providerTenant,
              credentialSecretRefs: connectionCredentialSecretRefs,
              status: "active",
              isDefault: true,
              createdByUserId: actorUserId,
            }).returning({ id: connectionGrants.id });
            organizationGrantId = createdOrganizationGrant.id;
          }
          // Empty audience rows are the canonical "everyone in the company".
          await tx.delete(connectionGrantMembers).where(and(
            eq(connectionGrantMembers.companyId, companyId),
            eq(connectionGrantMembers.grantId, organizationGrantId),
          ));
          await tx.delete(connectionGrantDelegations).where(and(
            eq(connectionGrantDelegations.companyId, companyId),
            eq(connectionGrantDelegations.grantId, personalGrant.id),
          ));
          await tx.update(connectionGrants).set({
            credentialSecretRefs: [],
            status: "revoked",
            revokedAt: nowAt,
            revokedByUserId: actorUserId,
            updatedAt: nowAt,
          }).where(eq(connectionGrants.id, personalGrant.id));
          [connection] = await tx.update(toolConnections).set({
            credentialPolicy: "shared",
            credentialSecretRefs: connectionCredentialSecretRefs,
            credentialRefs: [{
              name: "oauth.access_token",
              secretId: accessRef.secretId,
              version: "latest",
              placement: "header",
              key: "Authorization",
              prefix: "Bearer ",
            }],
            status: "active",
            enabled: true,
            updatedAt: nowAt,
          }).where(and(
            eq(toolConnections.id, connection.id),
            eq(toolConnections.companyId, companyId),
          )).returning();
        });
      } catch (error) {
        await Promise.all(promotedRefs.map((ref) => secrets.remove(ref.secretId).catch(() => undefined)));
        throw error;
      }
      await syncCredentialBindings(connection);
      // The source values are no longer referenced by either grant or
      // connection. Removing them makes the promotion a move, not a copy.
      for (const secretId of personalSecretIds) await secrets.remove(secretId);
    }

    const catalog = await db.select().from(toolCatalogEntries).where(and(
      eq(toolCatalogEntries.companyId, companyId),
      eq(toolCatalogEntries.connectionId, connection.id),
      eq(toolCatalogEntries.status, "active"),
    ));
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string"
      ? connection.config.sourceTemplateKey
      : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    const defaults = galleryEntry
      ? recommendedDefaultsForApp(galleryEntry, connectionMethodForConnection(galleryEntry, connection).key)
      : { askFirstRiskLevels: [] };
    const askFirstRiskLevels = new Set(
      Array.isArray(defaults.askFirstRiskLevels)
        ? defaults.askFirstRiskLevels.filter((value): value is string => typeof value === "string")
        : [],
    );
    const finished = await finishGalleryAppConnection(companyId, connection.id, {
      enabledCatalogEntryIds: catalog.map((entry) => entry.id),
      askFirstCatalogEntryIds: catalog
        .filter((entry) => askFirstRiskLevels.has(entry.riskLevel))
        .map((entry) => entry.id),
      access: "all_agents",
    }, actor);
    await db.insert(toolConnectionInstalls).values({
      companyId,
      connectionId: connection.id,
      targetType: "company",
      targetId: companyId,
      createdByUserId: actorUserId,
    }).onConflictDoNothing();
    return finished;
  }

  async function preflightGalleryAppMetadata(
    galleryKey: string,
    methodKey?: string | null,
  ): Promise<ToolAppMetadataPreflightResult> {
    const app = getConnectableAppDefinition(galleryKey);
    if (!app || app.availability?.available === false) throw notFound("App not found");
    const method = connectionMethodFor(app, methodKey);
    if (method.transport !== "mcp_remote" || !method.defaults?.serverUrl) {
      throw unprocessable("This app method does not use a hosted remote MCP endpoint");
    }

    const serverUrl = await assertRemoteHttpUrlAllowed(method.defaults.serverUrl);
    const attempts: ToolAppMetadataPreflightResult["attempts"] = [];
    const endpointResponse = await fetchRemoteHttpUrl(serverUrl, {
      method: "GET",
      headers: { Accept: "application/json, text/event-stream" },
    });
    attempts.push({
      kind: "endpoint",
      url: serverUrl,
      status: endpointResponse.status,
      ok: endpointResponse.ok,
      contentType: endpointResponse.headers.get("content-type"),
    });

    if (method.auth !== "oauth") {
      return {
        galleryKey: app.slug,
        methodKey: method.key,
        serverUrl,
        endpointReachable: endpointResponse.status < 500,
        oauth: null,
        attempts,
        checkedAt: (options.now?.() ?? new Date()).toISOString(),
      };
    }

    const endpoint = new URL(serverUrl);
    const metadataQueue = [
      method.defaults.discoveryUrl ?? null,
      method.defaults.metadataUrl ?? null,
      ...protectedResourceMetadataUrls(endpoint),
      ...wellKnownMetadataUrls(endpoint.toString()),
    ].filter((url): url is string => Boolean(url));
    const visited = new Set<string>();
    let metadataFound = false;
    let registrationAdvertised = false;
    let clientIdMetadataDocumentSupported = false;

    while (metadataQueue.length > 0 && visited.size < 16) {
      const metadataUrl = metadataQueue.shift()!;
      if (visited.has(metadataUrl)) continue;
      visited.add(metadataUrl);
      const response = await fetchRemoteHttpUrl(metadataUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      attempts.push({
        kind: "oauth_metadata",
        url: metadataUrl,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
      });
      if (!response.ok) continue;
      let metadata: Record<string, unknown>;
      try {
        metadata = asRecord(await response.json() as unknown);
      } catch {
        continue;
      }
      const looksLikeOAuthMetadata = Boolean(
        metadata.authorization_endpoint
        || metadata.token_endpoint
        || metadata.authorization_servers
        || metadata.resource,
      );
      if (!looksLikeOAuthMetadata) continue;
      metadataFound = true;
      registrationAdvertised ||= typeof metadata.registration_endpoint === "string";
      clientIdMetadataDocumentSupported ||= metadata.client_id_metadata_document_supported === true;
      for (const candidate of authServerMetadataUrls(metadata)) {
        if (!visited.has(candidate.metadataUrl)) metadataQueue.push(candidate.metadataUrl);
      }
    }

    return {
      galleryKey: app.slug,
      methodKey: method.key,
      serverUrl,
      endpointReachable: endpointResponse.status < 500,
      oauth: {
        metadataFound,
        registrationAdvertised,
        clientIdMetadataDocumentSupported,
      },
      attempts,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
    };
  }

  return {
    preflightGalleryAppMetadata,
    approvedStdioTemplates: async (companyId: string): Promise<ToolStdioCommandTemplate[]> => {
      const adminTemplates = await db
        .select()
        .from(toolStdioCommandTemplates)
        .where(eq(toolStdioCommandTemplates.companyId, companyId))
        .orderBy(asc(toolStdioCommandTemplates.templateKey));
      return [
        ...Object.keys(APPROVED_STDIO_TEMPLATES).sort().map((templateId) => builtInStdioTemplate(templateId)!),
        ...adminTemplates.map(toStdioCommandTemplate),
      ];
    },

    createStdioCommandTemplate: async (
      companyId: string,
      input: CreateToolStdioCommandTemplate,
      actor?: ActorInfo,
    ): Promise<ToolStdioCommandTemplate> => {
      if (builtInStdioTemplate(input.templateId)) {
        throw conflict("A built-in stdio template already uses this templateId");
      }
      const existing = await getAdminStdioTemplate(companyId, input.templateId);
      if (existing) throw conflict("A stdio command template already uses this templateId");
      const tools = input.tools.map((tool) => normalizeToolDescriptor(tool)).filter((tool): tool is McpToolDescriptor => Boolean(tool));
      const [row] = await db.insert(toolStdioCommandTemplates).values({
        companyId,
        templateKey: input.templateId,
        name: input.name,
        description: input.description ?? null,
        status: "active",
        command: input.command,
        args: input.args,
        envKeys: input.envKeys,
        tools,
        createdByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
        createdByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
      }).returning();
      return toStdioCommandTemplate(row);
    },

    disableStdioCommandTemplate: async (
      companyId: string,
      templateId: string,
    ): Promise<ToolStdioCommandTemplate> => {
      if (builtInStdioTemplate(templateId)) throw unprocessable("Built-in stdio templates cannot be disabled");
      const existing = await getAdminStdioTemplate(companyId, templateId);
      if (!existing) throw notFound("Stdio command template not found");
      if (existing.status === "disabled") return toStdioCommandTemplate(existing);
      const at = now();
      const [row] = await db
        .update(toolStdioCommandTemplates)
        .set({ status: "disabled", disabledAt: at, updatedAt: at })
        .where(and(eq(toolStdioCommandTemplates.companyId, companyId), eq(toolStdioCommandTemplates.templateKey, templateId)))
        .returning();
      return toStdioCommandTemplate(row);
    },

    connectGalleryApp,

    finishGalleryAppConnection,

    reconnectGalleryApp,

    startOAuth,

    startAuthorizationForAgent: async (input: {
      companyId: string;
      connectionId: string;
      agentId: string;
      runId: string;
      subjectUserId: string;
      scopes?: string[];
      returnTo?: string;
      redirectUri: string;
    }) => {
      const runContext = await loadBrokerRunContext(input);
      const connection = await getConnectionRow(input.connectionId, input.companyId);
      if (!runContext.responsibleUserId || runContext.responsibleUserId !== input.subjectUserId) {
        throw new HttpError(403, "The agent run cannot start authorization for the requested user", {
          code: "subject_not_permitted",
          connection: { uid: connection.uid },
          subject: { type: "user", userId: input.subjectUserId },
        });
      }
      return startOAuth(input.companyId, connection.id, {
        redirectUri: input.redirectUri,
        actor: { actorType: "agent", actorId: input.agentId },
        subjectUserId: input.subjectUserId,
        scopes: input.scopes,
        returnTo: input.returnTo,
        issueId: runContext.issueId ?? undefined,
      });
    },

    peekOAuthState,

    completePaperclipCloudConnectorCallback,

    completeVercelConnectCallback,

    completeOAuthCallback,
    refreshOAuthGrantCredentials,
    finalizeOAuthAccess,

    listExamples: async (companyId: string): Promise<ToolExampleSummary[]> => {
      return Promise.all(TOOL_EXAMPLES.map(async (definition) => {
        const rows = await exampleRows(companyId, definition);
        return exampleSummary(definition, rows);
      }));
    },

    installExample: async (
      companyId: string,
      exampleId: string,
      actor?: ActorInfo,
    ): Promise<ToolExampleInstallResult> => {
      const definition = findExample(exampleId);
      const blocker = localStdioInstallBlocker();
      if (blocker) throw unprocessable(blocker);
      assertLocalStdioCanBeEnabled("local_stdio", true);
      await stdioTemplateId(companyId, { templateId: definition.templateId });
      const before = await exampleRows(companyId, definition);
      const application = await upsertExampleApplication(companyId, definition, before.application);
      const connection = await upsertExampleConnection(companyId, definition, application.row.id, before.connection);
      const refresh = await refreshCatalog(connection.row.id, actor);
      let catalog = refresh.catalog;
      const safeReadEntryIds = catalog
        .filter((entry) => entry.riskLevel === "read")
        .map((entry) => entry.id);
      if (safeReadEntryIds.length > 0) {
        const reviewedAt = new Date();
        await db
          .update(toolCatalogEntries)
          .set({
            status: "active",
            reviewedAt,
            reviewedByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
            reviewedByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
            quarantinedAt: null,
            quarantineReason: null,
            updatedAt: reviewedAt,
          })
          .where(and(eq(toolCatalogEntries.companyId, companyId), inArray(toolCatalogEntries.id, safeReadEntryIds)));
        catalog = catalog.map((entry) => safeReadEntryIds.includes(entry.id)
          ? { ...entry, status: "active", reviewedAt, quarantinedAt: null, quarantineReason: null, updatedAt: reviewedAt }
          : entry);
      }
      const profile = await upsertExampleProfile(companyId, definition, before.profile);
      const profileEntries = await syncExampleProfileEntries(companyId, profile.row.id, catalog);
      const profileBinding = await upsertExampleProfileBinding(companyId, profile.row.id, before.profileBinding, actor);
      const after = await exampleRows(companyId, definition);
      return {
        example: exampleSummary(definition, after),
        created: application.created || connection.created || profile.created || !before.profileBinding,
        application: toApplication(application.row),
        connection: refresh.connection,
        profile: toProfile(profile.row),
        profileEntries,
        profileBinding,
        catalog,
      };
    },

    smokeExample: async (
      companyId: string,
      exampleId: string,
      actor?: ActorInfo,
    ): Promise<ToolExampleSmokeResult> => {
      const definition = findExample(exampleId);
      const rows = await exampleRows(companyId, definition);
      if (!rows.connection || !rows.profile || !rows.profileBinding) {
        throw conflict("Install this tool example before running smoke checks");
      }
      const catalog = rows.catalog.length > 0
        ? rows.catalog.map(toCatalogEntry)
        : (await refreshCatalog(rows.connection.id, actor)).catalog;
      const readEntry = catalog.find((entry) => entry.riskLevel === "read" && entry.status === "active");
      const deniedEntry = catalog.find((entry) => entry.riskLevel === "write" || entry.riskLevel === "destructive");
      if (!readEntry || !deniedEntry) {
        throw unprocessable("Example smoke requires at least one read tool and one denied write/destructive tool");
      }
      const smokeActor = await exampleSmokeActor(companyId, actor);
      const connection = toConnection(rows.connection);
      const allowCheck = await runSmokeDecisionCheck({
        companyId,
        actor: smokeActor,
        connection,
        catalogEntry: readEntry,
        expectedDecision: "allow",
        name: "allow_read_tool",
      });
      const denyCheck = await runSmokeDecisionCheck({
        companyId,
        actor: smokeActor,
        connection,
        catalogEntry: deniedEntry,
        expectedDecision: "deny",
        name: "deny_write_tool",
      });
      const auditCheck: ToolExampleSmokeCheck = {
        name: "audit_written",
        ok: Boolean(allowCheck.auditEventId && allowCheck.toolCallEventId && denyCheck.auditEventId && denyCheck.toolCallEventId),
        details: {
          auditEventIds: [allowCheck.auditEventId, denyCheck.auditEventId],
          toolCallEventIds: [allowCheck.toolCallEventId, denyCheck.toolCallEventId],
        },
      };
      const checks = [allowCheck, denyCheck, auditCheck];
      return {
        exampleId: definition.id,
        ok: checks.every((check) => check.ok),
        actor: smokeActor,
        connection,
        profile: toProfile(rows.profile),
        checks,
      };
    },

    listApplications: async (companyId: string): Promise<ToolApplication[]> => {
      const rows = await db
        .select()
        .from(toolApplications)
        .where(eq(toolApplications.companyId, companyId))
        .orderBy(desc(toolApplications.updatedAt));
      return rows.map(toApplication);
    },

    createApplication: async (companyId: string, input: CreateToolApplication): Promise<ToolApplication> => {
      await assertOptionalPlugin(input.pluginId);
      await assertOptionalAgent(companyId, input.ownerAgentId, "Tool application owner agent");
      const [row] = await db.insert(toolApplications).values({
        companyId,
        applicationKey: input.applicationKey ?? normalizeKey(input.name),
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        status: input.status ?? "active",
        pluginId: input.pluginId ?? null,
        ownerAgentId: input.ownerAgentId ?? null,
        ownerUserId: input.ownerUserId ?? null,
        metadata: input.metadata ?? {},
      }).returning();
      return toApplication(row);
    },

    getApplication: async (applicationId: string, companyId?: string): Promise<ToolApplication> => {
      const where = companyId
        ? and(eq(toolApplications.id, applicationId), eq(toolApplications.companyId, companyId))
        : eq(toolApplications.id, applicationId);
      const [row] = await db.select().from(toolApplications).where(where);
      if (!row) throw notFound("Tool application not found");
      return toApplication(row);
    },

    updateApplication: async (applicationId: string, input: UpdateToolApplication): Promise<ToolApplication> => {
      const [existing] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationId));
      if (!existing) throw notFound("Tool application not found");
      await assertOptionalPlugin(input.pluginId);
      await assertOptionalAgent(existing.companyId, input.ownerAgentId, "Tool application owner agent");
      if (input.name && input.name !== existing.name) {
        const [duplicate] = await db
          .select({ id: toolApplications.id })
          .from(toolApplications)
          .where(
            and(
              eq(toolApplications.companyId, existing.companyId),
              eq(toolApplications.name, input.name),
              ne(toolApplications.id, applicationId),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw conflict("A tool access record with that name already exists", {
            code: "tool_access_name_conflict",
          });
        }
      }
      const [row] = await db
        .update(toolApplications)
        .set({
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          status: input.status ?? existing.status,
          pluginId: input.pluginId ?? existing.pluginId,
          ownerAgentId: input.ownerAgentId ?? existing.ownerAgentId,
          ownerUserId: input.ownerUserId ?? existing.ownerUserId,
          metadata: input.metadata ?? existing.metadata,
          updatedAt: new Date(),
        })
        .where(eq(toolApplications.id, applicationId))
        .returning();
      return toApplication(row);
    },

    deleteApplication: async (applicationId: string): Promise<ToolApplication> => {
      const [existing] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationId));
      if (!existing) throw notFound("Tool application not found");
      // Guard: never orphan connections. The caller must remove the connections
      // or archive the application instead — there is no force-cascade in v1.
      const linkedConnections = await db
        .select({ id: toolConnections.id })
        .from(toolConnections)
        .where(eq(toolConnections.applicationId, applicationId));
      if (linkedConnections.length > 0) {
        throw conflict(
          "This application still has connections. Remove its connections or archive the application instead of deleting it.",
          { connectionCount: linkedConnections.length },
        );
      }
      // The pre-check above gives a friendly 409 in the common case, but it cannot close the
      // race where a connection is created in the gap before this delete runs. The FK is now
      // ON DELETE RESTRICT, so such a delete fails closed with a foreign_key_violation instead
      // of silently cascading the new connection away. Translate that into the same 409 so the
      // endpoint keeps its contract instead of surfacing a 500.
      let row: typeof toolApplications.$inferSelect | undefined;
      try {
        [row] = await db.delete(toolApplications).where(eq(toolApplications.id, applicationId)).returning();
      } catch (error) {
        if (isToolConnectionForeignKeyViolation(error)) {
          throw conflict(
            "This application still has connections. Remove its connections or archive the application instead of deleting it.",
          );
        }
        throw error;
      }
      if (!row) throw notFound("Tool application not found");
      return toApplication(row);
    },

    listConnections: async (companyId: string): Promise<ToolConnection[]> => {
      const rows = await db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.companyId, companyId))
        .orderBy(desc(toolConnections.updatedAt));
      const connections = rows.map(toConnection);
      if (connections.length === 0) return connections;
      const installRows = await db
        .select()
        .from(toolConnectionInstalls)
        .where(eq(toolConnectionInstalls.companyId, companyId))
        .orderBy(asc(toolConnectionInstalls.targetType), asc(toolConnectionInstalls.targetId));
      const installsByConnection = new Map<string, ToolConnectionInstall[]>();
      for (const row of installRows) {
        const installs = installsByConnection.get(row.connectionId) ?? [];
        installs.push(toConnectionInstall(row));
        installsByConnection.set(row.connectionId, installs);
      }
      for (const connection of connections) connection.installs = installsByConnection.get(connection.id) ?? [];
      // Enrich with "last used" = most recent tool-call event per connection so the
      // prosumer Apps list can surface a staleness signal without an N+1 fan-out.
      const lastUsedRows = await db
        .select({
          connectionId: toolCallEvents.connectionId,
          lastUsedAt: max(toolCallEvents.createdAt),
        })
        .from(toolCallEvents)
        .where(
          and(
            eq(toolCallEvents.companyId, companyId),
            inArray(
              toolCallEvents.connectionId,
              connections.map((connection) => connection.id),
            ),
          ),
        )
        .groupBy(toolCallEvents.connectionId);
      const lastUsedByConnection = new Map(
        lastUsedRows.map((row) => [row.connectionId, row.lastUsedAt]),
      );
      for (const connection of connections) {
        connection.lastUsedAt = lastUsedByConnection.get(connection.id) ?? null;
      }
      return connections;
    },

    listComposioServices,

    startComposioServiceConnect,

    pollComposioService: async (parentConnectionId: string, toolkitSlug: string, actor?: ActorInfo) => {
      const parent = await getConnectionRow(parentConnectionId);
      return syncComposioToolkit(parent, toolkitSlug, actor);
    },

    disconnectComposioService,

    createConnection: async (companyId: string, input: CreateToolConnection, actor?: ActorInfo): Promise<ToolConnection> => {
      let applicationId = input.applicationId;
      let applicationNamespace = input.applicationName ?? input.name;
      const transport = input.transport;
      if (!transport) throw badRequest("Tool connection transport is required");
      const config = normalizeGoogleSheetsConnectionConfig(input.config ?? input.transportConfig ?? {});
      // Validate company-scoped references before touching a caller-supplied
      // network endpoint. Besides failing fast, this keeps cross-company
      // authorization errors from being masked by DNS or SSRF validation.
      await assertSecretRefs(companyId, [...(input.credentialRefs ?? []), ...(input.credentialSecretRefs ?? [])]);
      if (transport === "mcp_remote") await assertRemoteConnectionEndpointsAllowed(config);
      if (transport === "local_stdio") await stdioTemplateId(companyId, config);
      assertLocalStdioCanBeEnabled(transport, input.enabled ?? false);
      await assertGoogleSheetsSpreadsheetOwnership(companyId, config);
      if (applicationId) {
        const app = await assertApplication(companyId, applicationId);
        applicationNamespace = app.applicationKey ?? app.name;
        if ((transport === "mcp_remote" && app.type !== "mcp_http") || (transport === "local_stdio" && app.type !== "mcp_stdio")) {
          throw unprocessable("Connection transport must match application type");
        }
      } else {
        const [app] = await db.insert(toolApplications).values({
          companyId,
          applicationKey: normalizeKey(input.applicationName ?? input.name),
          name: input.applicationName ?? input.name,
          type: transport === "mcp_remote" ? "mcp_http" : "mcp_stdio",
          status: "active",
          metadata: {},
        }).returning();
        applicationId = app.id;
      }
      const connectionId = randomUUID();
      const binding = actorBinding(actor);
      const [row] = await db.insert(toolConnections).values({
        id: connectionId,
        companyId,
        applicationId,
        name: input.name,
        uid: connectionUid(applicationNamespace, input.name, connectionId),
        connectionKind: input.connectionKind ?? "managed",
        ownership: input.ownership ?? "customer",
        transport,
        authKind: input.authKind ?? "none",
        credentialPolicy: input.credentialPolicy ?? (input.authKind === "oauth" ? "per_user" : "shared"),
        status: input.status ?? "draft",
        enabled: input.enabled ?? false,
        config,
        transportConfig: isGoogleSheetsConnectionConfig(config) ? config : input.transportConfig ?? config,
        credentialRefs: input.credentialRefs ?? [],
        credentialSecretRefs: input.credentialSecretRefs ?? [],
        createdByAgentId: binding.actorType === "agent" ? binding.actorId : null,
        createdByUserId: binding.actorType === "user" ? binding.actorId : null,
      }).returning();
      await ensureDefaultOrganizationGrant(row);
      await syncCredentialBindings(row);
      await ensureRuntimeSlot(row);
      if (isComposioConnection(row) && (input.enabled !== undefined || input.status !== undefined)) {
        if (!row.enabled || row.status !== "active") await disableComposioChildren(row);
        else await restoreComposioChildren(row);
      }
      return toConnection(row);
    },

    getConnection: async (connectionId: string, companyId?: string): Promise<ToolConnection> => {
      const connection = toConnection(await getConnectionRow(connectionId, companyId));
      connection.installs = await listConnectionInstalls(connection.id, connection.companyId);
      return connection;
    },

    listConnectionGrants: async (idOrUid: string, companyId?: string) => {
      const connection = await getConnectionRow(idOrUid, companyId);
      const grants = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
      )).orderBy(desc(connectionGrants.isDefault), desc(connectionGrants.updatedAt));
      const grantIds = grants.map((grant) => grant.id);
      const [members, delegations] = grantIds.length === 0 ? [[], []] : await Promise.all([
        db.select().from(connectionGrantMembers).where(and(
          eq(connectionGrantMembers.companyId, connection.companyId),
          inArray(connectionGrantMembers.grantId, grantIds),
        )),
        db.select().from(connectionGrantDelegations).where(and(
          eq(connectionGrantDelegations.companyId, connection.companyId),
          inArray(connectionGrantDelegations.grantId, grantIds),
        )),
      ]);
      return {
        connection: { id: connection.id, uid: connection.uid },
        grants: grants.map((grant) => ({
          ...toConnectionGrant(grant),
          members: members.filter((member) => member.grantId === grant.id),
          delegations: delegations.filter((delegation) => delegation.grantId === grant.id),
        })),
      };
    },

    /**
     * Company members eligible to appear in an organization grant's audience.
     * The audience editor needs display names, and the client must not have to
     * cross-reference a second endpoint to render "12 selected members".
     */
    listConnectionAudienceMembers: async (companyId: string) => {
      const rows = await db
        .select({
          userId: companyMemberships.principalId,
          name: authUsers.name,
          email: authUsers.email,
        })
        .from(companyMemberships)
        .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ));
      return rows
        .map((row) => ({ userId: row.userId, name: row.name ?? null, email: row.email ?? null }))
        .sort((a, b) => (a.name ?? a.email ?? a.userId).localeCompare(b.name ?? b.email ?? b.userId));
    },

    /**
     * Replace an organization grant's audience atomically (PAP-17835).
     *
     * An empty `memberUserIds` persists as zero rows, which the resolver already
     * treats as "every organization member". Replacement is delete-then-insert
     * inside one transaction so a partially-applied audience can never widen or
     * narrow access, and every member id is checked against active company
     * membership first so an audience cannot name an outsider. Existing audience
     * members are locked too: membership cleanup deliberately retains a sole
     * inactive audience row, and a concurrent empty replacement must not erase
     * that fail-closed marker after cleanup wins. Once cleanup has retained that
     * marker, callers must restore the member or replace it with an active named
     * audience before widening access to the whole company.
     */
    replaceConnectionGrantMembers: async (
      idOrUid: string,
      grantId: string,
      memberUserIds: string[],
      actor?: ActorInfo,
    ) => {
      const connection = await getConnectionRow(idOrUid);
      const [grant] = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.id, grantId),
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
      )).limit(1);
      if (!grant) throw notFound("Connection grant not found");
      if (grant.kind !== "organization") {
        throw badRequest("Only an organization identity has an audience; a personal identity belongs to its owner");
      }
      const requested = [...new Set(memberUserIds.map((id) => id.trim()).filter(Boolean))];
      const binding = actorBinding(actor);
      const members = await db.transaction(async (tx) => {
        // Serialize replacements before taking the current audience snapshot.
        // Otherwise a second replacement could read the old rows, wait behind
        // an in-flight replacement, and then miss locking a newly-added member.
        await tx
          .select({ id: connectionGrants.id })
          .from(connectionGrants)
          .where(and(
            eq(connectionGrants.id, grant.id),
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
          ))
          .for("update");
        const existingAudience = await tx
          .select({ subjectId: connectionGrantMembers.subjectId })
          .from(connectionGrantMembers)
          .where(and(
            eq(connectionGrantMembers.companyId, connection.companyId),
            eq(connectionGrantMembers.grantId, grant.id),
            eq(connectionGrantMembers.subjectType, "user"),
          ));
        const existingUserIds = [...new Set(existingAudience.map((row) => row.subjectId))];
        const membershipUserIds = [...new Set([...existingUserIds, ...requested])];
        if (membershipUserIds.length > 0) {
          // Membership suspension/archive/removal takes the same row lock before
          // sweeping grant audiences. Lock both the old and new audience so an
          // empty replacement also serializes with cleanup of its existing sole
          // member. Whichever transaction wins is then authoritative.
          const memberships = await tx
            .select({
              principalId: companyMemberships.principalId,
              status: companyMemberships.status,
            })
            .from(companyMemberships)
            .where(and(
              eq(companyMemberships.companyId, connection.companyId),
              eq(companyMemberships.principalType, "user"),
              inArray(companyMemberships.principalId, membershipUserIds),
            ))
            .orderBy(asc(companyMemberships.id))
            .for("update");
          const active = new Set(
            memberships.filter((row) => row.status === "active").map((row) => row.principalId),
          );
          const unknown = requested.filter((id) => !active.has(id));
          if (unknown.length > 0) {
            throw unprocessable("Every audience member must be an active member of this company", {
              code: "audience_member_not_in_company",
              unknownUserIds: unknown,
            });
          }
          const inactiveExisting = existingUserIds.filter((id) => !active.has(id));
          if (requested.length === 0 && inactiveExisting.length > 0) {
            throw conflict("Replace inactive audience members before widening access to the whole company", {
              code: "audience_widening_blocked",
              inactiveUserIds: inactiveExisting,
            });
          }
        }
        await tx.delete(connectionGrantMembers).where(and(
          eq(connectionGrantMembers.companyId, connection.companyId),
          eq(connectionGrantMembers.grantId, grant.id),
        ));
        const inserted = requested.length === 0
          ? []
          : await tx.insert(connectionGrantMembers).values(requested.map((subjectId) => ({
              companyId: connection.companyId,
              grantId: grant.id,
              subjectType: "user" as const,
              subjectId,
            }))).returning();
        await tx.update(connectionGrants)
          .set({ updatedAt: new Date() })
          .where(eq(connectionGrants.id, grant.id));
        return inserted;
      });
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection_grant.audience_replaced",
        outcome: "success",
        reasonCode: "audience_replaced",
        details: { grantId: grant.id, memberCount: members.length, memberUserIds: requested },
      });
      return { ...toConnectionGrant(grant), members };
    },

    createConnectionGrantDelegation: async (
      idOrUid: string,
      grantId: string,
      agentId: string,
      ownerUserId: string,
    ) => {
      const connection = await getConnectionRow(idOrUid);
      return db.transaction(async (tx) => {
        // Membership removal/suspension takes this same row lock before sweeping
        // personal grants. Whichever operation wins is therefore authoritative:
        // removal deletes a delegation committed first, while creation that runs
        // second observes the inactive membership and fails closed.
        const [membership] = await tx.select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, connection.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, ownerUserId),
            eq(companyMemberships.status, "active"),
          ))
          .for("update")
          .limit(1);
        if (!membership) {
          throw forbidden("Only an active company member can delegate their personal grant");
        }

        const [grant] = await tx.select().from(connectionGrants).where(and(
          eq(connectionGrants.id, grantId),
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, ownerUserId),
          eq(connectionGrants.status, "active"),
        )).limit(1);
        if (!grant) throw forbidden("Only the active personal grant owner can create a delegation");
        const [targetAgent] = await tx.select({ id: agents.id }).from(agents).where(and(
          eq(agents.id, agentId),
          eq(agents.companyId, connection.companyId),
        )).limit(1);
        if (!targetAgent) throw notFound("Agent not found");
        const [existing] = await tx.select().from(connectionGrantDelegations).where(and(
          eq(connectionGrantDelegations.grantId, grant.id),
          eq(connectionGrantDelegations.agentId, agentId),
        )).limit(1);
        if (existing) return existing;
        const [delegation] = await tx.insert(connectionGrantDelegations).values({
          companyId: connection.companyId,
          grantId: grant.id,
          agentId,
          createdByUserId: ownerUserId,
        }).returning();
        await tx.insert(toolAccessAuditEvents).values({
          companyId: connection.companyId,
          connectionId: connection.id,
          actorType: "user",
          actorId: ownerUserId,
          action: "connection_grant.delegated",
          outcome: "success",
          reasonCode: "delegation_created",
          details: { grantId: grant.id, delegationId: delegation!.id, agentId },
        });
        return delegation!;
      });
    },

    revokeConnectionGrantDelegation: async (idOrUid: string, grantId: string, delegationId: string, actor?: ActorInfo) => {
      const connection = await getConnectionRow(idOrUid);
      const [delegation] = await db.delete(connectionGrantDelegations).where(and(
        eq(connectionGrantDelegations.id, delegationId),
        eq(connectionGrantDelegations.companyId, connection.companyId),
        eq(connectionGrantDelegations.grantId, grantId),
      )).returning();
      if (!delegation) throw notFound("Connection grant delegation not found");
      const binding = actorBinding(actor);
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection_grant.delegation_revoked",
        outcome: "success",
        reasonCode: "delegation_revoked",
        details: { grantId, delegationId, agentId: delegation.agentId },
      });
      return delegation;
    },

    addConnectionInstallation: async (idOrUid: string, input: {
      providerTenant?: { name?: string; externalId?: string };
      credentialSecretRefs?: typeof connectionGrants.$inferInsert.credentialSecretRefs;
      isDefault?: boolean;
    }, actor?: ActorInfo) => {
      const connection = await getConnectionRow(idOrUid);
      await assertSecretRefs(connection.companyId, input.credentialSecretRefs ?? []);
      if (input.isDefault) {
        await db.update(connectionGrants).set({ isDefault: false, updatedAt: new Date() }).where(and(
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "organization"),
        ));
      }
      const binding = actorBinding(actor);
      const [grant] = await db.insert(connectionGrants).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: "organization",
        providerTenant: input.providerTenant,
        credentialSecretRefs: input.credentialSecretRefs ?? [],
        status: "active",
        isDefault: input.isDefault ?? false,
        createdByAgentId: binding.actorType === "agent" ? binding.actorId : null,
        createdByUserId: binding.actorType === "user" ? binding.actorId : null,
      }).returning();
      if (!grant) throw new Error("Failed to create connection installation");
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection_grant.created",
        outcome: "success",
        reasonCode: "grant_created",
        details: { grantId: grant.id, kind: grant.kind, isDefault: grant.isDefault },
      });
      return toConnectionGrant(grant);
    },

    revokeConnectionGrant: async (idOrUid: string, grantId: string, actor?: ActorInfo) => {
      const connection = await getConnectionRow(idOrUid);
      const binding = actorBinding(actor);
      const [currentGrant] = await db.select().from(connectionGrants).where(and(
        eq(connectionGrants.id, grantId),
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
      )).limit(1);
      if (!currentGrant) throw notFound("Connection grant not found");
      let providerRevocation = "not_applicable";
      if (connection.credentialSource === "vercel_connect" && connection.externalCredential) {
        const request = vercelTokenRequest({
          credential: connection.externalCredential,
          grant: currentGrant,
          connectionId: connection.id,
          companyId: connection.companyId,
          resources: vercelConnectResourcesFor(connection),
        });
        vercelConnect?.evict(request);
        if (currentGrant.externalCredential?.subjectType === "app") {
          providerRevocation = "manage_in_vercel";
        } else if (currentGrant.externalCredential?.subjectType === "user") {
          try {
            if (!vercelConnect) throw new Error("Vercel Connect unavailable");
            await vercelConnect.revoke(request);
            providerRevocation = "success";
          } catch {
            providerRevocation = "failed";
          }
        }
      } else if (isPaperclipCloudConnectorStrategy(oauthConfig(connection).strategy)) {
        // Google revocation is client-wide for a user. The managed Workspace
        // profiles intentionally share one Paperclip-owned client, so revoking
        // one token here could invalidate unrelated Gmail, Drive, and Calendar
        // grants. A per-profile removal is therefore local-only. A future
        // provider-level disconnect must warn that it removes every profile.
        providerRevocation = "local_only_shared_client";
      }
      const grant = await db.transaction(async (tx) => {
        const removedDelegations = await tx.delete(connectionGrantDelegations).where(and(
          eq(connectionGrantDelegations.companyId, connection.companyId),
          eq(connectionGrantDelegations.grantId, grantId),
        )).returning();
        const [updated] = await tx.update(connectionGrants).set({
          status: "revoked",
          isDefault: false,
          revokedAt: new Date(),
          revokedByAgentId: binding.actorType === "agent" ? binding.actorId : null,
          revokedByUserId: binding.actorType === "user" ? binding.actorId : null,
          updatedAt: new Date(),
        }).where(and(
          eq(connectionGrants.id, grantId),
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
        )).returning();
        if (!updated) throw notFound("Connection grant not found");
        if (removedDelegations.length > 0) {
          await tx.insert(toolAccessAuditEvents).values(removedDelegations.map((delegation) => ({
            companyId: connection.companyId,
            connectionId: connection.id,
            actorType: binding.actorType ?? "system",
            actorId: binding.actorId,
            action: "connection_grant.delegation_revoked",
            outcome: "success",
            reasonCode: "grant_revoked",
            details: { grantId, delegationId: delegation.id, agentId: delegation.agentId },
          })));
        }
        return updated;
      });
      if (!grant) throw notFound("Connection grant not found");
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection_grant.revoked",
        outcome: "success",
        reasonCode: "grant_revoked",
        details: { grantId: grant.id, kind: grant.kind, providerRevocation },
      });
      return toConnectionGrant(grant);
    },

    getConnectionUsage: async (idOrUid: string, range: "7d" | "30d", companyId?: string) => {
      const connection = await getConnectionRow(idOrUid, companyId);
      const days = range === "30d" ? 30 : 7;
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - days + 1);
      const [issuances, invocations] = await Promise.all([
        db.select({ createdAt: connectionTokenIssuances.createdAt, outcome: connectionTokenIssuances.outcome, path: connectionTokenIssuances.path })
          .from(connectionTokenIssuances).where(and(
            eq(connectionTokenIssuances.companyId, connection.companyId),
            eq(connectionTokenIssuances.connectionId, connection.id),
            gte(connectionTokenIssuances.createdAt, start),
          )),
        db.select({ createdAt: toolInvocations.createdAt, riskLevel: toolInvocations.riskLevel })
          .from(toolInvocations).where(and(
            eq(toolInvocations.companyId, connection.companyId),
            eq(toolInvocations.connectionId, connection.id),
            gte(toolInvocations.createdAt, start),
          )),
      ]);
      const buckets = Array.from({ length: days }, (_, offset) => {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + offset);
        return {
          date: date.toISOString().slice(0, 10),
          issuances: { total: 0, byOutcome: {} as Record<string, number>, byPath: {} as Record<string, number> },
          invocations: { total: 0, byRiskLevel: {} as Record<string, number> },
          deliveries: { received: 0, forwarded: 0 },
        };
      });
      const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
      for (const row of issuances) {
        const bucket = byDate.get(row.createdAt.toISOString().slice(0, 10));
        if (!bucket) continue;
        bucket.issuances.total += 1;
        bucket.issuances.byOutcome[row.outcome] = (bucket.issuances.byOutcome[row.outcome] ?? 0) + 1;
        bucket.issuances.byPath[row.path] = (bucket.issuances.byPath[row.path] ?? 0) + 1;
      }
      for (const row of invocations) {
        const bucket = byDate.get(row.createdAt.toISOString().slice(0, 10));
        if (!bucket) continue;
        const riskLevel = row.riskLevel ?? "unknown";
        bucket.invocations.total += 1;
        bucket.invocations.byRiskLevel[riskLevel] = (bucket.invocations.byRiskLevel[riskLevel] ?? 0) + 1;
      }
      return { connection: { id: connection.id, uid: connection.uid }, range, buckets };
    },

    listConnectionInstalls,

    putConnectionInstalls: async (
      connectionId: string,
      input: PutToolConnectionInstalls,
      actor?: ActorInfo,
    ): Promise<ToolConnectionInstallSnapshot> => {
      const connection = await getConnectionRow(connectionId);
      const requested = new Map(input.installs.map((install) => [`${install.targetType}:${install.targetId}`, install]));
      for (const install of requested.values()) {
        if (install.targetType === "company") {
          if (install.targetId !== connection.companyId) throw unprocessable("Company installs must target the connection company");
        } else {
          await assertOptionalAgent(connection.companyId, install.targetId, "Tool connection install agent");
        }
      }
      const accessExtensions: Array<{ targetType: "company" | "agent"; targetId: string; profileId: string }> = [];
      await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(toolConnectionInstalls)
          .where(and(
            eq(toolConnectionInstalls.companyId, connection.companyId),
            eq(toolConnectionInstalls.connectionId, connection.id),
          ));
        const existingKeys = new Set(existing.map((install) => `${install.targetType}:${install.targetId}`));
        const removals = existing
          .filter((install) => !requested.has(`${install.targetType}:${install.targetId}`));
        const removeIds = removals.map((install) => install.id);
        if (removeIds.length > 0) {
          await tx.delete(toolConnectionInstalls).where(inArray(toolConnectionInstalls.id, removeIds));
          // Uninstalling must also drop the binding this path created. Installing
          // writes both an install row and a profile binding, so deleting only the
          // install row leaves a binding that no surface can see or remove. The
          // install row is the reach gate (`mintConnectionTokenForAgent` fails with
          // `installation_required`, and the heartbeat only hands over installed
          // connections), so a stale binding grants no reach on its own — but it
          // still makes `finishApp`, which rebuilds `access` from the bindings,
          // read a target the operator already removed.
          //
          // Only bindings tagged `source: "tool_connection_install"` are removed.
          // A binding the operator authored through the access model carries a
          // different source and must survive an uninstall.
          const [installProfile] = await tx
            .select({ id: toolProfiles.id })
            .from(toolProfiles)
            .where(and(
              eq(toolProfiles.companyId, connection.companyId),
              eq(toolProfiles.profileKey, `app:${connection.id}`),
            ))
            .limit(1);
          if (installProfile) {
            for (const install of removals) {
              await tx.delete(toolProfileBindings).where(and(
                eq(toolProfileBindings.companyId, connection.companyId),
                eq(toolProfileBindings.profileId, installProfile.id),
                eq(toolProfileBindings.targetType, install.targetType),
                eq(toolProfileBindings.targetId, install.targetId),
                sql`${toolProfileBindings.metadata}->>'source' = 'tool_connection_install'`,
              ));
            }
          }
        }
        const additions = [...requested.entries()].filter(([key]) => !existingKeys.has(key)).map(([, install]) => install);
        if (additions.length > 0) {
          await tx.insert(toolConnectionInstalls).values(additions.map((install) => ({
            companyId: connection.companyId,
            connectionId: connection.id,
            targetType: install.targetType,
            targetId: install.targetId,
            createdByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
            createdByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
          })));
        }
        if (requested.size > 0) {
          const profile = await appProfileForConnection(tx, connection);
          for (const install of requested.values()) {
            const [binding] = await tx
              .insert(toolProfileBindings)
              .values({
                companyId: connection.companyId,
                profileId: profile.id,
                targetType: install.targetType,
                targetId: install.targetId,
                priority: 100,
                metadata: { source: "tool_connection_install", connectionId: connection.id },
                createdByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
                createdByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
              })
              .onConflictDoNothing()
              .returning({ id: toolProfileBindings.id });
            if (binding) accessExtensions.push({ targetType: install.targetType, targetId: install.targetId, profileId: profile.id });
          }
        }
        if (removeIds.length > 0 || additions.length > 0) {
          const binding = actorBinding(actor);
          await tx.insert(toolAccessAuditEvents).values({
            companyId: connection.companyId,
            connectionId: connection.id,
            actorType: binding.actorType ?? "system",
            actorId: binding.actorId,
            action: "connection_installs.changed",
            outcome: "success",
            reasonCode: "installs_changed",
            details: {
              added: additions.map((install) => ({ targetType: install.targetType, targetId: install.targetId })),
              removed: existing
                .filter((install) => removeIds.includes(install.id))
                .map((install) => ({ targetType: install.targetType, targetId: install.targetId })),
            },
          });
        }
      });
      for (const extension of accessExtensions) {
        await logActivity(db, {
          companyId: connection.companyId,
          actorType: actor?.actorType ?? "system",
          actorId: actor?.actorId ?? "system",
          action: "tool_connection.install_access_extended",
          entityType: "tool_connection",
          entityId: connection.id,
          details: extension,
        });
      }
      return { connectionId: connection.id, installs: await listConnectionInstalls(connection.id, connection.companyId) };
    },

    updateConnection: async (connectionId: string, input: UpdateToolConnection): Promise<ToolConnection> => {
      const existing = await getConnectionRow(connectionId);
      const config = normalizeGoogleSheetsConnectionConfig(input.config ?? input.transportConfig ?? existing.config);
      if (existing.transport === "mcp_remote") await assertRemoteConnectionEndpointsAllowed(config);
      if (existing.transport === "local_stdio") await stdioTemplateId(existing.companyId, config);
      assertLocalStdioCanBeEnabled(existing.transport, input.enabled ?? existing.enabled);
      await assertGoogleSheetsSpreadsheetOwnership(existing.companyId, config, { excludeConnectionId: existing.id });
      await assertSecretRefs(existing.companyId, [...(input.credentialRefs ?? existing.credentialRefs), ...(input.credentialSecretRefs ?? existing.credentialSecretRefs)]);
      const [row] = await db
        .update(toolConnections)
        .set({
          name: input.name ?? existing.name,
          status: input.status ?? existing.status,
          enabled: input.enabled ?? existing.enabled,
          config,
          transportConfig: isGoogleSheetsConnectionConfig(config) ? config : input.transportConfig ?? config,
          credentialRefs: input.credentialRefs ?? existing.credentialRefs,
          credentialSecretRefs: input.credentialSecretRefs ?? existing.credentialSecretRefs,
          credentialPolicy: input.credentialPolicy ?? existing.credentialPolicy,
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, connectionId))
        .returning();
      await syncCredentialBindings(row);
      await ensureRuntimeSlot(row);
      if (isComposioConnection(row)) {
        if (row.enabled) await restoreComposioChildren(row);
        else await disableComposioChildren(row);
      }
      return toConnection(row);
    },

    archiveConnection: removeConnection,

    checkHealth: checkConnectionHealth,

    refreshCatalog,

    listAppsNeedingAttention,

    sweepConnectionHealth,

    listCatalog: async (connectionId: string, companyId?: string): Promise<ToolCatalogEntry[]> => {
      const connection = await getConnectionRow(connectionId, companyId);
      let rows = await db
        .select()
        .from(toolCatalogEntries)
        .where(eq(toolCatalogEntries.connectionId, connection.id))
        .orderBy(desc(toolCatalogEntries.updatedAt));
      const cacheExpired = connection.transport === "mcp_remote"
        && connection.status !== "archived"
        && (
          rows.length === 0
          || !connection.lastCatalogRefreshAt
          || connection.lastCatalogRefreshAt.getTime() <= now().getTime() - catalogCacheTtlMs
        );
      if (cacheExpired) {
        try {
          await singleFlight(
            catalogRefreshFlights,
            connection.id,
            () => refreshCatalog(connection.id, { actorType: "system", actorId: "tool_catalog_cache" }),
          );
          rows = await db
            .select()
            .from(toolCatalogEntries)
            .where(eq(toolCatalogEntries.connectionId, connection.id))
            .orderBy(desc(toolCatalogEntries.updatedAt));
        } catch (error) {
          // A stale catalog remains useful when the remote server is temporarily
          // unavailable. Empty caches still fail so callers never mistake “no
          // actions discovered” for a successful lookup.
          if (rows.length === 0) throw error;
        }
      }
      return rows.map((row) => toCatalogEntryForConnection(row, connection));
    },

    /** Recent tool-call events for one connection — drives App detail · Recent activity. */
    listConnectionActivity: async (
      connectionId: string,
      companyId?: string,
      limit = 20,
    ): Promise<ToolConnectionActivityResponse> => {
      const connection = await getConnectionRow(connectionId, companyId);
      const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      const rows = await db
        .select()
        .from(toolCallEvents)
        .where(
          and(
            eq(toolCallEvents.companyId, connection.companyId),
            eq(toolCallEvents.connectionId, connection.id),
          ),
        )
        .orderBy(desc(toolCallEvents.createdAt))
        .limit(safeLimit);
      const events = rows.map(toToolCallEvent);

      const issueIds = [...new Set(rows.map((row) => row.issueId).filter(Boolean))] as string[];
      const issueRows = issueIds.length
        ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
          })
          .from(issues)
          .where(and(eq(issues.companyId, connection.companyId), inArray(issues.id, issueIds)))
        : [];
      const issueMap = Object.fromEntries(
        issueRows.map((issue) => [
          issue.id,
          {
            identifier: issue.identifier ?? issue.id,
            title: issue.title,
          },
        ]),
      );

      const actionRequestIds = [...new Set(rows.map((row) => row.actionRequestId).filter(Boolean))] as string[];
      const requestRows = actionRequestIds.length
        ? await db
          .select({
            id: toolActionRequests.id,
            status: toolActionRequests.status,
            resolvedByAgentId: toolActionRequests.resolvedByAgentId,
            resolvedByUserId: toolActionRequests.resolvedByUserId,
          })
          .from(toolActionRequests)
          .where(and(
            eq(toolActionRequests.companyId, connection.companyId),
            inArray(toolActionRequests.id, actionRequestIds),
          ))
        : [];

      const resolverAgentIds = [...new Set(requestRows.map((row) => row.resolvedByAgentId).filter(Boolean))] as string[];
      const resolverUserIds = [...new Set(requestRows.map((row) => row.resolvedByUserId).filter(Boolean))] as string[];
      const resolverAgents = resolverAgentIds.length
        ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, connection.companyId), inArray(agents.id, resolverAgentIds)))
        : [];
      const resolverUsers = resolverUserIds.length
        ? await db
          .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
          .from(authUsers)
          .where(inArray(authUsers.id, resolverUserIds))
        : [];
      const resolverAgentNames = new Map(resolverAgents.map((agent) => [agent.id, agent.name]));
      const resolverUserNames = new Map(
        resolverUsers.map((user) => [user.id, user.name?.trim() || user.email?.trim() || user.id]),
      );
      const actionRequestMap = Object.fromEntries(
        requestRows.map((request) => [
          request.id,
          {
            status: request.status,
            resolverDisplayName: request.resolvedByAgentId
              ? resolverAgentNames.get(request.resolvedByAgentId) ?? request.resolvedByAgentId
              : request.resolvedByUserId
                ? resolverUserNames.get(request.resolvedByUserId) ?? userFallbackName(request.resolvedByUserId)
                : null,
            resolvedByAgentId: request.resolvedByAgentId,
            resolvedByUserId: request.resolvedByUserId,
          },
        ]),
      );

      const lifecycleEvents = await listConnectionLifecycleEvents(db, {
        companyId: connection.companyId,
        connectionIds: [connection.id],
        limit: safeLimit,
      });

      return {
        connectionId: connection.id,
        events,
        lifecycleEvents,
        issues: issueMap,
        actionRequests: actionRequestMap,
      };
    },

    /**
     * List "Ask first" action requests for the review queue, enriched with the
     * connection/app context the prosumer card renders. Defaults to pending.
     */
    listActionRequests: async (
      companyId: string,
      status: ToolActionRequestStatus = "pending",
    ): Promise<ToolActionRequestListItem[]> => {
      const requests = await db
        .select()
        .from(toolActionRequests)
        .where(and(eq(toolActionRequests.companyId, companyId), eq(toolActionRequests.status, status)))
        .orderBy(desc(toolActionRequests.createdAt));
      if (requests.length === 0) return [];

      const invocationIds = [...new Set(requests.map((request) => request.invocationId))];
      const invocations = await db
        .select()
        .from(toolInvocations)
        .where(and(eq(toolInvocations.companyId, companyId), inArray(toolInvocations.id, invocationIds)));
      const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
      let visibleRequests = requests;
      if (status === "pending") {
        // A pending request that the creator has not signed yet is still being
        // set up. The gateway creates the row (signedArguments = null) and signs
        // it in a second step, so a review-queue read can observe the row inside
        // that window. Hide such a request from the queue, but do not cancel it —
        // cancelling here races the two-step create and makes the later approve
        // fail with action_not_pending. Only cancel a request that carries a
        // signature we cannot verify (secret rotation or tampering).
        const unsignedRequestIds = new Set<string>();
        const invalidRequestIds: string[] = [];
        for (const request of requests) {
          const invocation = invocationById.get(request.invocationId);
          if (!invocation) {
            invalidRequestIds.push(request.id);
            continue;
          }
          if (request.signedArguments === null) {
            unsignedRequestIds.add(request.id);
            continue;
          }
          let readable = false;
          try {
            readable = Boolean(readSignedToolArgumentsPayload({
              signedArguments: request.signedArguments,
              invocationId: invocation.id,
              toolName: invocation.toolName,
            }));
          } catch {
            readable = false;
          }
          if (!readable) invalidRequestIds.push(request.id);
        }
        if (invalidRequestIds.length > 0) {
          await db
            .update(toolActionRequests)
            .set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date() })
            .where(and(
              eq(toolActionRequests.companyId, companyId),
              eq(toolActionRequests.status, "pending"),
              inArray(toolActionRequests.id, invalidRequestIds),
            ));
        }
        const hiddenIds = new Set([...invalidRequestIds, ...unsignedRequestIds]);
        if (hiddenIds.size > 0) {
          visibleRequests = requests.filter((request) => !hiddenIds.has(request.id));
        }
      }
      if (visibleRequests.length === 0) return [];

      const visibleInvocations = visibleRequests
        .map((request) => invocationById.get(request.invocationId))
        .filter((invocation): invocation is typeof toolInvocations.$inferSelect => Boolean(invocation));
      const connectionIds = [...new Set(visibleInvocations.map((invocation) => invocation.connectionId).filter(Boolean))] as string[];
      const connections = connectionIds.length
        ? await db.select().from(toolConnections).where(inArray(toolConnections.id, connectionIds))
        : [];
      const connectionById = new Map(connections.map((connection) => [connection.id, connection]));

      const applicationIds = [...new Set(connections.map((connection) => connection.applicationId).filter(Boolean))] as string[];
      const applications = applicationIds.length
        ? await db.select().from(toolApplications).where(inArray(toolApplications.id, applicationIds))
        : [];
      const applicationById = new Map(applications.map((application) => [application.id, application]));

      const catalogEntryIds = [...new Set(visibleInvocations.map((invocation) => invocation.catalogEntryId).filter(Boolean))] as string[];
      const catalogEntries = catalogEntryIds.length
        ? await db.select().from(toolCatalogEntries).where(inArray(toolCatalogEntries.id, catalogEntryIds))
        : [];
      const catalogById = new Map(catalogEntries.map((entry) => [entry.id, entry]));

      return visibleRequests.map((request) => {
        const invocation = invocationById.get(request.invocationId);
        const connection = invocation?.connectionId ? connectionById.get(invocation.connectionId) : undefined;
        const application = connection?.applicationId ? applicationById.get(connection.applicationId) : undefined;
        const catalogEntry = invocation?.catalogEntryId ? catalogById.get(invocation.catalogEntryId) : undefined;
        return {
          request: toToolActionRequest(request),
          toolName: invocation?.toolName ?? catalogEntry?.toolName ?? "",
          toolTitle: catalogEntry?.title ?? null,
          connectionId: connection?.id ?? invocation?.connectionId ?? null,
          connectionName: connection?.name ?? null,
          applicationName: application?.name ?? null,
          riskLevel: catalogEntry?.riskLevel ?? null,
          requestedByAgentId: request.requestedByAgentId ?? null,
        };
      });
    },

    listProfiles: async (companyId: string): Promise<ToolProfileWithDetails[]> => {
      const profiles = await db
        .select()
        .from(toolProfiles)
        .where(eq(toolProfiles.companyId, companyId))
        .orderBy(desc(toolProfiles.updatedAt));
      if (profiles.length === 0) return [];
      const profileIds = profiles.map((profile) => profile.id);
      const [entries, bindings, catalog, companyAgents, applications, connections] = await Promise.all([
        db
          .select()
          .from(toolProfileEntries)
          .where(and(eq(toolProfileEntries.companyId, companyId), inArray(toolProfileEntries.profileId, profileIds)))
          .orderBy(asc(toolProfileEntries.createdAt)),
        db
          .select()
          .from(toolProfileBindings)
          .where(and(eq(toolProfileBindings.companyId, companyId), inArray(toolProfileBindings.profileId, profileIds)))
          .orderBy(asc(toolProfileBindings.priority), asc(toolProfileBindings.createdAt)),
        db
          .select()
          .from(toolCatalogEntries)
          .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.status, "active"))),
        db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
        db
          .select()
          .from(toolApplications)
          .where(eq(toolApplications.companyId, companyId)),
        db
          .select()
          .from(toolConnections)
          .where(eq(toolConnections.companyId, companyId)),
      ]);
      const entriesByProfile = new Map<string, Array<typeof toolProfileEntries.$inferSelect>>();
      const bindingsByProfile = new Map<string, Array<typeof toolProfileBindings.$inferSelect>>();
      for (const entry of entries) {
        const list = entriesByProfile.get(entry.profileId) ?? [];
        list.push(entry);
        entriesByProfile.set(entry.profileId, list);
      }
      for (const binding of bindings) {
        const list = bindingsByProfile.get(binding.profileId) ?? [];
        list.push(binding);
        bindingsByProfile.set(binding.profileId, list);
      }
      const agentIds = companyAgents.map((agent) => agent.id);
      const applicationsById = new Map(applications.map((application) => [application.id, application]));
      const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
      return profiles.map((profile) => buildProfileDetails({
        profile,
        entries: entriesByProfile.get(profile.id) ?? [],
        bindings: bindingsByProfile.get(profile.id) ?? [],
        catalog,
        agentIds,
        applicationsById,
        connectionsById,
      }));
    },

    createProfile: async (companyId: string, input: CreateToolProfileWithEntries): Promise<ToolProfileWithDetails> => {
      for (const entry of input.entries ?? []) {
        await assertProfileEntryInput(companyId, entry);
      }
      const [row] = await db.insert(toolProfiles).values({
        companyId,
        profileKey: input.profileKey,
        name: input.name,
        description: input.description ?? null,
        status: input.status ?? "active",
        defaultAction: input.defaultAction ?? "deny",
        metadata: input.metadata ?? {},
      }).returning();
      await createProfileEntries(companyId, row.id, input.entries ?? []);
      return profileDetails(row.id, companyId);
    },

    getProfile: profileDetails,

    listProfileNewTools,

    reviewProfileNewTools,

    updateProfile: async (profileId: string, input: UpdateToolProfileWithEntries): Promise<ToolProfileWithDetails> => {
      const existing = await getProfileRow(profileId);
      if (input.entries) {
        for (const entry of input.entries) {
          await assertProfileEntryInput(existing.companyId, entry);
        }
      }
      await db
        .update(toolProfiles)
        .set({
          profileKey: input.profileKey ?? existing.profileKey,
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          status: input.status ?? existing.status,
          defaultAction: input.defaultAction ?? existing.defaultAction,
          metadata: input.metadata ?? existing.metadata,
          updatedAt: new Date(),
        })
        .where(eq(toolProfiles.id, profileId));
      if (input.entries) {
        await replaceProfileEntries(existing.companyId, profileId, input.entries);
      }
      return profileDetails(profileId, existing.companyId);
    },

    duplicateProfile: async (profileId: string, input: DuplicateToolProfile): Promise<ToolProfileWithDetails> => {
      const existing = await getProfileRow(profileId);
      const [entries, bindings] = await Promise.all([
        db
          .select()
          .from(toolProfileEntries)
          .where(and(eq(toolProfileEntries.companyId, existing.companyId), eq(toolProfileEntries.profileId, existing.id)))
          .orderBy(asc(toolProfileEntries.createdAt)),
        db
          .select()
          .from(toolProfileBindings)
          .where(and(eq(toolProfileBindings.companyId, existing.companyId), eq(toolProfileBindings.profileId, existing.id)))
          .orderBy(asc(toolProfileBindings.priority), asc(toolProfileBindings.createdAt)),
      ]);
      const [created] = await db.insert(toolProfiles).values({
        companyId: existing.companyId,
        profileKey: normalizeKey(`${input.name}-${randomUUID().slice(0, 8)}`),
        name: input.name,
        description: existing.description,
        status: "active",
        defaultAction: existing.defaultAction,
        newToolsReviewedAt: existing.newToolsReviewedAt,
        metadata: existing.metadata ?? {},
      }).returning();
      if (entries.length > 0) {
        await db.insert(toolProfileEntries).values(entries.map((entry) => ({
          companyId: entry.companyId,
          profileId: created.id,
          selectorType: entry.selectorType,
          effect: entry.effect,
          applicationId: entry.applicationId,
          connectionId: entry.connectionId,
          catalogEntryId: entry.catalogEntryId,
          toolName: entry.toolName,
          riskLevel: entry.riskLevel,
          conditions: entry.conditions,
        })));
      }
      if (input.includeAssignments && bindings.length > 0) {
        await db.insert(toolProfileBindings).values(bindings.map((binding) => ({
          companyId: binding.companyId,
          profileId: created.id,
          targetType: binding.targetType,
          targetId: binding.targetId,
          priority: binding.priority,
          metadata: binding.metadata ?? {},
          createdByAgentId: binding.createdByAgentId,
          createdByUserId: binding.createdByUserId,
        })));
      }
      return profileDetails(created.id, existing.companyId);
    },

    deleteProfile: async (
      profileId: string,
      input: DeleteToolProfile,
    ): Promise<{
      profile: ToolProfile;
      summary: ToolProfileSummary;
      reassignedToProfileId: string | null;
      reassignedBindingCount: number;
    }> => {
      const existing = await getProfileRow(profileId);
      if (input.force && input.reassignToProfileId) {
        throw badRequest("Use either force or reassignToProfileId when deleting a tool profile, not both");
      }
      const details = await profileDetails(existing.id, existing.companyId);
      if (details.summary.isCompanyDefault && !input.force && !input.reassignToProfileId) {
        throw unprocessable(
          "Cannot delete the company default tool profile. Reassign the default profile or pass force=true to delete it.",
          { summary: details.summary },
        );
      }

      let reassignedBindingCount = 0;
      if (input.reassignToProfileId) {
        if (input.reassignToProfileId === existing.id) {
          throw badRequest("reassignToProfileId must reference a different tool profile");
        }
        const target = await getProfileRow(input.reassignToProfileId, existing.companyId);
        if (target.status !== "active") {
          throw unprocessable("Tool profile assignments can only be reassigned to an active profile");
        }
        const targetBindings = await db
          .select()
          .from(toolProfileBindings)
          .where(and(eq(toolProfileBindings.companyId, existing.companyId), eq(toolProfileBindings.profileId, target.id)));
        const targetKeys = new Set(
          targetBindings.map((binding) => `${binding.targetType}:${binding.targetId}`),
        );
        const copiedBindings = details.bindings.filter((binding) => !targetKeys.has(`${binding.targetType}:${binding.targetId}`));
        if (copiedBindings.length > 0) {
          await db.insert(toolProfileBindings).values(copiedBindings.map((binding) => ({
            companyId: binding.companyId,
            profileId: target.id,
            targetType: binding.targetType,
            targetId: binding.targetId,
            priority: binding.priority,
            metadata: binding.metadata ?? {},
            createdByAgentId: binding.createdByAgentId,
            createdByUserId: binding.createdByUserId,
          })));
          reassignedBindingCount = copiedBindings.length;
          await db.update(toolProfiles).set({ updatedAt: new Date() }).where(eq(toolProfiles.id, target.id));
        }
      }

      const [deleted] = await db.delete(toolProfiles).where(eq(toolProfiles.id, existing.id)).returning();
      if (!deleted) throw notFound("Tool profile not found");
      return {
        profile: toProfile(deleted),
        summary: details.summary,
        reassignedToProfileId: input.reassignToProfileId ?? null,
        reassignedBindingCount,
      };
    },

    addProfileEntry: async (
      profileId: string,
      input: CreateToolProfileEntryForProfile,
    ): Promise<ToolProfileEntry> => {
      const profile = await getProfileRow(profileId);
      await assertProfileEntryInput(profile.companyId, input);
      const [row] = await db.insert(toolProfileEntries).values({
        companyId: profile.companyId,
        profileId: profile.id,
        selectorType: input.selectorType,
        effect: input.effect ?? "include",
        applicationId: input.applicationId ?? null,
        connectionId: input.connectionId ?? null,
        catalogEntryId: input.catalogEntryId ?? null,
        toolName: input.toolName ?? null,
        riskLevel: input.riskLevel ?? null,
        conditions: input.conditions ?? null,
      }).returning();
      await db.update(toolProfiles).set({ updatedAt: new Date() }).where(eq(toolProfiles.id, profile.id));
      return toProfileEntry(row);
    },

    getProfileEntry: async (entryId: string): Promise<ToolProfileEntry> => {
      const [row] = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.id, entryId));
      if (!row) throw notFound("Tool profile entry not found");
      return toProfileEntry(row);
    },

    updateProfileEntry: async (entryId: string, input: UpdateToolProfileEntry): Promise<ToolProfileEntry> => {
      const [existing] = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.id, entryId));
      if (!existing) throw notFound("Tool profile entry not found");
      const next: CreateToolProfileEntryForProfile = {
        selectorType: input.selectorType ?? existing.selectorType,
        effect: input.effect ?? existing.effect,
        applicationId: input.applicationId ?? existing.applicationId,
        connectionId: input.connectionId ?? existing.connectionId,
        catalogEntryId: input.catalogEntryId ?? existing.catalogEntryId,
        toolName: input.toolName ?? existing.toolName,
        riskLevel: input.riskLevel ?? existing.riskLevel,
        conditions: input.conditions ?? existing.conditions,
      };
      await assertProfileEntryInput(existing.companyId, next);
      const [row] = await db
        .update(toolProfileEntries)
        .set({
          selectorType: next.selectorType,
          effect: next.effect ?? "include",
          applicationId: next.applicationId ?? null,
          connectionId: next.connectionId ?? null,
          catalogEntryId: next.catalogEntryId ?? null,
          toolName: next.toolName ?? null,
          riskLevel: next.riskLevel ?? null,
          conditions: next.conditions ?? null,
          updatedAt: new Date(),
        })
        .where(eq(toolProfileEntries.id, entryId))
        .returning();
      await db.update(toolProfiles).set({ updatedAt: new Date() }).where(eq(toolProfiles.id, existing.profileId));
      return toProfileEntry(row);
    },

    deleteProfileEntry: async (entryId: string): Promise<ToolProfileEntry> => {
      const [row] = await db.delete(toolProfileEntries).where(eq(toolProfileEntries.id, entryId)).returning();
      if (!row) throw notFound("Tool profile entry not found");
      await db.update(toolProfiles).set({ updatedAt: new Date() }).where(eq(toolProfiles.id, row.profileId));
      return toProfileEntry(row);
    },

    bindProfile: async (
      profileId: string,
      input: CreateToolProfileBindingForProfile,
      actor?: ActorInfo,
    ): Promise<ToolProfileBinding> => {
      const profile = await getProfileRow(profileId);
      await assertTargetExists(profile.companyId, input.targetType, input.targetId);
      const [row] = await db.insert(toolProfileBindings).values({
        companyId: profile.companyId,
        profileId: profile.id,
        targetType: input.targetType,
        targetId: input.targetId,
        priority: input.priority ?? 100,
        metadata: input.metadata ?? {},
        createdByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
        createdByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
      }).returning();
      await db.update(toolProfiles).set({ updatedAt: new Date() }).where(eq(toolProfiles.id, profile.id));
      return toProfileBinding(row);
    },

    unbindProfile: async (profileId: string, input: UnbindToolProfileBinding): Promise<{ unbound: number }> => {
      const profile = await getProfileRow(profileId);
      await assertTargetExists(profile.companyId, input.targetType, input.targetId);
      const rows = await db
        .delete(toolProfileBindings)
        .where(and(
          eq(toolProfileBindings.companyId, profile.companyId),
          eq(toolProfileBindings.profileId, profile.id),
          eq(toolProfileBindings.targetType, input.targetType),
          eq(toolProfileBindings.targetId, input.targetId),
        ))
        .returning({ id: toolProfileBindings.id });
      if (rows.length > 0) {
        await db.update(toolProfiles).set({ updatedAt: new Date() }).where(eq(toolProfiles.id, profile.id));
      }
      return { unbound: rows.length };
    },

    getEffectiveProfilesForAgent: async (companyId: string, agentId: string): Promise<ToolProfileEffectiveSummary> => {
      await assertOptionalAgent(companyId, agentId, "Tool profile effective agent");
      const allBindings = await db
        .select()
        .from(toolProfileBindings)
        .where(eq(toolProfileBindings.companyId, companyId))
        .orderBy(asc(toolProfileBindings.priority), asc(toolProfileBindings.createdAt));
      const matchingBindings = allBindings.filter((binding) =>
        (binding.targetType === "company" && binding.targetId === companyId)
        || (binding.targetType === "agent" && binding.targetId === agentId)
      );
      if (matchingBindings.length === 0) {
        return {
          agentId,
          profiles: [],
          entries: [],
          bindings: [],
          allowedTools: [],
          allowedToolNames: [],
          installedConnections: await resolveInstalledConnectionsForAgent(companyId, agentId),
        };
      }
      const candidateProfileIds = profileIdsInBindingOrder(matchingBindings);
      const candidateProfiles = await db
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, companyId), inArray(toolProfiles.id, candidateProfileIds)));
      const bindings = effectiveToolProfileBindings(matchingBindings, candidateProfiles);
      const profileIds = profileIdsInBindingOrder(bindings);
      const profilesById = new Map(candidateProfiles.map((profile) => [profile.id, profile]));
      const activeProfiles = profileIds
        .map((profileId) => profilesById.get(profileId) ?? null)
        .filter((profile): profile is typeof toolProfiles.$inferSelect => Boolean(profile && profile.status === "active"));
      if (activeProfiles.length === 0) {
        return {
          agentId,
          profiles: [],
          entries: [],
          bindings: bindings.map(toProfileBinding),
          allowedTools: [],
          allowedToolNames: [],
          installedConnections: await resolveInstalledConnectionsForAgent(companyId, agentId),
        };
      }
      const activeProfileIds = activeProfiles.map((profile) => profile.id);
      const [entries, catalog, companyAgents] = await Promise.all([
        db
          .select()
          .from(toolProfileEntries)
          .where(and(eq(toolProfileEntries.companyId, companyId), inArray(toolProfileEntries.profileId, activeProfileIds)))
          .orderBy(asc(toolProfileEntries.createdAt)),
        db
          .select()
          .from(toolCatalogEntries)
          .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.status, "active")))
          .orderBy(asc(toolCatalogEntries.toolName)),
        db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
      ]);
      const entriesByProfile = new Map<string, Array<typeof toolProfileEntries.$inferSelect>>();
      for (const entry of entries) {
        const list = entriesByProfile.get(entry.profileId) ?? [];
        list.push(entry);
        entriesByProfile.set(entry.profileId, list);
      }
      const allowedCatalogIds = new Set<string>();
      const allowedToolNames = new Set<string>();
      for (const profile of activeProfiles) {
        const profileEntries = entriesByProfile.get(profile.id) ?? [];
        const includes = profileEntries.filter((entry) => entry.effect === "include");
        const excludes = profileEntries.filter((entry) => entry.effect === "exclude");
        for (const catalogEntry of catalog) {
          if (excludes.some((entry) => profileEntryMatchesCatalog(entry, catalogEntry))) continue;
          if (profile.defaultAction === "allow" || includes.some((entry) => profileEntryMatchesCatalog(entry, catalogEntry))) {
            allowedCatalogIds.add(catalogEntry.id);
            allowedToolNames.add(catalogEntry.toolName);
          }
        }
        for (const entry of includes.filter((item) => item.selectorType === "tool_name" && item.toolName)) {
          const matchingExclude = excludes.some((item) => item.selectorType === "tool_name" && item.toolName === entry.toolName);
          if (!matchingExclude) allowedToolNames.add(entry.toolName!);
        }
      }
      const agentIds = companyAgents.map((agent) => agent.id);
      const details: ToolProfileWithDetails[] = activeProfiles.map((profile) => buildProfileDetails({
        profile,
        entries: entriesByProfile.get(profile.id) ?? [],
        bindings: bindings.filter((binding) => binding.profileId === profile.id),
        catalog,
        agentIds,
      }));
      const allowedTools = catalog
        .filter((entry) => allowedCatalogIds.has(entry.id))
        .map(toCatalogEntry);
      return {
        agentId,
        profiles: details,
        entries: entries.map(toProfileEntry),
        bindings: bindings.map(toProfileBinding),
        allowedTools,
        allowedToolNames: [...allowedToolNames].sort((a, b) => a.localeCompare(b)),
        installedConnections: await resolveInstalledConnectionsForAgent(companyId, agentId),
      };
    },

    mintConnectionTokenForAgent: async (input: {
      connectionId: string;
      companyId: string;
      agentId: string;
      runId: string;
      body: ConnectionTokenRequest;
    }): Promise<ConnectionTokenResponse> => {
      const runContext = await loadBrokerRunContext({ companyId: input.companyId, agentId: input.agentId, runId: input.runId });
      const connection = await getConnectionRow(input.connectionId, input.companyId);
      const application = await getConnectionApplication(connection);
      const brokerEnabled = connectionTokenBrokerEnabled(connection);
      const path = brokerEnabled ? inferConnectionTokenPath(connection, application) : "static";
      const requestedScope = normalizeConnectionTokenScopes(input.body.scope);
      const parentScopes = parentScopesForConnection(connection);
      const fallbackScopes = defaultScopesForConnection(connection);
      const issuedScope = requestedScope.length > 0
        ? requestedScope
        : fallbackScopes.length > 0
          ? fallbackScopes
          : parentScopes;
      const ttlSeconds = requestedTtlSeconds(input.body, connection);
      const attribution = {
        agentId: input.agentId,
        runId: input.runId,
        issueId: runContext.issueId,
        projectId: runContext.projectId,
        responsibleUserId: runContext.responsibleUserId,
      };

      const recordFailure = async (outcome: ConnectionTokenIssuanceOutcome, errorCode: string, details: Record<string, unknown> = {}) => {
        await recordConnectionTokenIssuance({
          companyId: connection.companyId,
          applicationId: connection.applicationId,
          connectionId: connection.id,
          agentId: input.agentId,
          runId: input.runId,
          issueId: runContext.issueId,
          projectId: runContext.projectId,
          responsibleUserId: runContext.responsibleUserId,
          path,
          requestedScope,
          issuedScope,
          ttlSeconds: outcome === "use_env_lease" ? null : ttlSeconds,
          expiresAt: null,
          tokenHash: null,
          outcome,
          errorCode,
          metadata: details,
        });
        await auditConnectionTokenIssuance({
          companyId: connection.companyId,
          connectionId: connection.id,
          agentId: input.agentId,
          runId: input.runId,
          path,
          outcome,
          reasonCode: errorCode,
          details,
        });
      };

      const fail = async (status: number, message: string, outcome: ConnectionTokenIssuanceOutcome, errorCode: string, details: Record<string, unknown> = {}): Promise<never> => {
        await recordFailure(outcome, errorCode, details);
        throw new HttpError(status, message, { code: errorCode, path, ...details });
      };

      const [install] = await db
        .select({ id: toolConnectionInstalls.id })
        .from(toolConnectionInstalls)
        .where(and(
          eq(toolConnectionInstalls.companyId, connection.companyId),
          eq(toolConnectionInstalls.connectionId, connection.id),
          sql`((${toolConnectionInstalls.targetType} = 'company' and ${toolConnectionInstalls.targetId} = ${connection.companyId}) or (${toolConnectionInstalls.targetType} = 'agent' and ${toolConnectionInstalls.targetId} = ${input.agentId}))`,
        ))
        .limit(1);
      if (!install) {
        await fail(
          403,
          `Connection ${connection.name} must be installed for this agent before it can mint a token`,
          "denied",
          "installation_required",
          {
            connection: { id: connection.id, uid: connection.uid, name: connection.name },
            agentId: input.agentId,
            remediation: { action: "install_connection", targetType: "agent", targetId: input.agentId },
          },
        );
      }

      const requestedSubject = input.body.subject;
      if (requestedSubject?.type === "user" && requestedSubject.userId !== runContext.responsibleUserId) {
        await fail(403, "The agent run cannot act as the requested user", "denied", "subject_not_permitted", {
          connection: { uid: connection.uid },
          subject: requestedSubject,
        });
      }

      const actingUserId = runContext.responsibleUserId;
      const autonomous = runContext.run.invocationSource === "automation" || runContext.run.invocationSource === "timer";
      const subject = connection.credentialPolicy === "shared" || !actingUserId
        ? { type: "app" as const }
        : { type: "user" as const, userId: actingUserId };
      let grant: typeof connectionGrants.$inferSelect | undefined;
      if (connection.credentialPolicy !== "shared" && actingUserId) {
        const [membership] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
          eq(companyMemberships.companyId, connection.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, actingUserId),
          eq(companyMemberships.status, "active"),
        )).limit(1);
        if (!membership) {
          await fail(403, "The personal grant owner is not an active company member", "denied", "grant_owner_membership_inactive", {
            connection: { id: connection.id, uid: connection.uid, name: connection.name },
            subject: { type: "user", userId: actingUserId },
            remediation: { action: "restore_membership_or_reconnect" },
          });
        }
        [grant] = await db.select().from(connectionGrants).where(and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, actingUserId),
        )).limit(1);
      }
      if (!grant && connection.credentialPolicy === "per_user") {
        await fail(409, "User authorization is required", "denied", "user_authorization_required", {
          connection: { uid: connection.uid },
          subject: actingUserId ? { type: "user", userId: actingUserId } : { type: "app" },
          remediation: { action: "start_authorization" },
        });
      }
      if (!grant) {
        grant = await ensureDefaultOrganizationGrant(connection);
      }

      if (grant.kind === "user" && autonomous) {
        const [delegation] = await db.select({ id: connectionGrantDelegations.id }).from(connectionGrantDelegations).where(and(
          eq(connectionGrantDelegations.companyId, connection.companyId),
          eq(connectionGrantDelegations.grantId, grant.id),
          eq(connectionGrantDelegations.agentId, input.agentId),
        )).limit(1);
        if (!delegation) {
          if (actingUserId) {
            await createStandingDelegationAsk({
              connection,
              issueId: runContext.issueId,
              runId: input.runId,
              agentId: input.agentId,
              ownerUserId: actingUserId,
            });
          }
          await fail(409, "Standing delegation is required for this autonomous run", "denied", "standing_delegation_required", {
            connection: { id: connection.id, uid: connection.uid, name: connection.name },
            grantId: grant.id,
            subject: actingUserId ? { type: "user", userId: actingUserId } : { type: "app" },
            agentId: input.agentId,
            remediation: { action: "delegate_personal_grant", grantId: grant.id, agentId: input.agentId },
          });
        }
      }

      if (grant.kind === "organization") {
        const activeAudienceMember = actingUserId ? await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
          eq(companyMemberships.companyId, connection.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, actingUserId),
          eq(companyMemberships.status, "active"),
        )).limit(1).then((rows) => rows[0] ?? null) : null;
        const audience = await db.select({ subjectId: connectionGrantMembers.subjectId }).from(connectionGrantMembers).where(and(
          eq(connectionGrantMembers.companyId, connection.companyId),
          eq(connectionGrantMembers.grantId, grant.id),
          eq(connectionGrantMembers.subjectType, "user"),
        ));
        if (
          (actingUserId !== null && !activeAudienceMember)
          || (audience.length > 0 && (!actingUserId || !audience.some((member) => member.subjectId === actingUserId)))
        ) {
          await fail(403, "The acting user is not in this grant's audience", "denied", "grant_audience_denied", {
            connection: { uid: connection.uid },
            subject,
            grantId: grant.id,
          });
        }
      }

      if (grant.status !== "active") {
        const code = grant.status === "needs_reauthorization" ? "needs_reauthorization" : "grant_revoked";
        await fail(409, "The selected connection grant is not active", "denied", code, {
          connection: { uid: connection.uid },
          subject,
          grantId: grant.id,
          remediation: { action: "reauthorize" },
        });
      }
      const requestedScopeSelectors = new Set(requestedScope);
      const matchingScopedRefs = grant.credentialSecretRefs.filter(
        (ref) => ref.keyScope && requestedScopeSelectors.has(ref.keyScope),
      );
      const selectedCredentialSecretRefs = matchingScopedRefs.length > 0
        ? grant.credentialSecretRefs.filter((ref) => !ref.keyScope || requestedScopeSelectors.has(ref.keyScope))
        : grant.credentialSecretRefs.filter((ref) => !ref.keyScope);
      const rotateBefore = Date.now() + 14 * 24 * 60 * 60 * 1000;
      const expiringRef = selectedCredentialSecretRefs.find((ref) => ref.expiresAt && Date.parse(ref.expiresAt) <= rotateBefore);
      if (expiringRef && connection.healthStatus !== "degraded") {
        await db.update(toolConnections).set({
          healthStatus: "degraded",
          healthMessage: `Rotate ${expiringRef.label ?? expiringRef.configPath} before it expires.`,
          updatedAt: new Date(),
        }).where(eq(toolConnections.id, connection.id));
      }
      const credentialConnection = { ...connection, credentialSecretRefs: selectedCredentialSecretRefs };

      if (!connection.enabled || connection.status !== "active") {
        await fail(409, "Connection is not active", "denied", "connection_not_active", {
          connectionStatus: connection.status,
          enabled: connection.enabled,
        });
      }
      if (["failed", "error", "missing_secret"].includes(connection.healthStatus)) {
        await fail(409, "Connection credential needs attention", "denied", "credential_revoked", {
          healthStatus: connection.healthStatus,
          healthMessage: connection.healthMessage ?? null,
        });
      }
      if (!brokerEnabled) {
        await fail(403, "Connection token broker is not enabled for this connection", "denied", "broker_not_enabled", {
          reason: "Connections must explicitly opt in with tokenBroker.enabled before agents can request brokered tokens.",
        });
      }
      try {
        assertScopeSubset({ requestedScope: issuedScope, parentScopes });
      } catch {
        await fail(403, "Requested token scope exceeds the connection parent scope", "denied", "scope_exceeds_parent", {
          parentScopeCount: parentScopes.length,
        });
      }

      const hasBrokerGrant = await hasExplicitConnectionTokenMintProfileGrant({
        companyId: connection.companyId,
        agentId: input.agentId,
        issueId: runContext.issueId,
        projectId: runContext.projectId,
        routineId: runContext.routineId,
      });
      if (!hasBrokerGrant) {
        await fail(403, "Connection token minting requires an explicit broker profile grant", "denied", "broker_mint_not_granted", {
          reason: "A connection-level profile grant is not sufficient for connection_token.mint.",
        });
      }

      const decisionInput = {
        companyId: connection.companyId,
        actor: {
          actorType: "agent" as const,
          actorId: input.agentId,
          agentId: input.agentId,
        },
        runContext: {
          heartbeatRunId: input.runId,
          issueId: runContext.issueId,
          projectId: runContext.projectId,
          routineId: runContext.routineId,
        },
        request: {
          applicationId: connection.applicationId,
          connectionId: connection.id,
          providerType: "connection_token_broker",
          applicationKey: application?.applicationKey ?? null,
          upstreamToolName: CONNECTION_TOKEN_MINT_TOOL_NAME,
          riskLevel: "write",
          toolName: CONNECTION_TOKEN_MINT_TOOL_NAME,
          arguments: {
            path,
            scope: issuedScope,
            requestedTtlSeconds: input.body.requestedTtlSeconds ?? null,
          },
        },
        consumeRateLimit: true,
      };
      const decision = await policySvc.decide(decisionInput);
      await policySvc.writeAudit(decisionInput, decision);
      if (!decision.allowed) {
        await fail(
          decision.decision === "rate_limited" ? 429 : 403,
          decision.explanation,
          decision.decision === "rate_limited" ? "rate_limited" : "denied",
          decision.reasonCode,
          {
            decision: decision.decision,
            effectiveProfileIds: decision.effectiveProfileIds,
            matchedPolicyIds: decision.matchedPolicyIds,
            rateLimitState: decision.rateLimitState ?? null,
          },
        );
      }

      try {
        await enforceDefaultConnectionTokenRateLimit({ connection, agentId: input.agentId, path });
      } catch (error) {
        if (error instanceof HttpError && error.status === 429) {
          await fail(429, error.message, "rate_limited", "rate_limited", asRecord(error.details));
        }
        throw error;
      }

      if (path === "static") {
        await recordFailure("use_env_lease", "use_env_lease", {
          reason: "Connection uses durable static credentials; broker token delivery is refused.",
        });
        return {
          status: "use_env_lease",
          code: "use_env_lease",
          connectionId: connection.id,
          connection: { id: connection.id, uid: connection.uid },
          grantId: grant.id,
          path: "static",
          message: "This connection uses static credentials. Use an audited environment lease projection instead.",
          scope: issuedScope,
          attribution,
        };
      }
      if (path === "oauth_access") {
        await fail(422, "OAuth access-token projection is disabled; configure a short-lived exchange mint path instead", "denied", "oauth_access_projection_disabled", {
          reason: "The broker must not return stored upstream OAuth bearer tokens directly.",
        });
      }

      const selectedGrant = grant;
      try {
        const mintResult = await db.transaction(async (tx) => {
          await lockAuthorizedBrokerResponsibleMembership({
            companyId: connection.companyId,
            responsibleUserId: runContext.responsibleUserId,
          }, tx);
          const minted = await mintExchangeConnectionToken({
            connection: credentialConnection,
            application,
            agentId: input.agentId,
            runId: input.runId,
            issueId: runContext.issueId,
            responsibleUserId: runContext.responsibleUserId,
            scope: issuedScope,
            ttlSeconds,
          }, secretService(tx));
          const expiresAt = minted.expiresAt;
          const mintedScope = "scope" in minted ? minted.scope : issuedScope;
          const effectiveTtlSeconds = Math.max(1, Math.min(900, Math.ceil((expiresAt.getTime() - now().getTime()) / 1000)));
          const tokenHash = bearerTokenHash(minted.token);
          await recordConnectionTokenIssuance({
            companyId: connection.companyId,
            applicationId: connection.applicationId,
            connectionId: connection.id,
            agentId: input.agentId,
            runId: input.runId,
            issueId: runContext.issueId,
            projectId: runContext.projectId,
            responsibleUserId: runContext.responsibleUserId,
            path,
            requestedScope,
            issuedScope: mintedScope,
            ttlSeconds: effectiveTtlSeconds,
            expiresAt,
            tokenHash,
            outcome: "success",
            metadata: { tokenRef: tokenHash, tokenType: minted.tokenType },
          }, tx);
          await tx
            .update(connectionGrants)
            .set({ lastUsedAt: new Date(), updatedAt: new Date() })
            .where(eq(connectionGrants.id, selectedGrant.id));
          return { minted, expiresAt, mintedScope, effectiveTtlSeconds, tokenHash };
        });
        await auditConnectionTokenIssuance({
          companyId: connection.companyId,
          connectionId: connection.id,
          agentId: input.agentId,
          runId: input.runId,
          path,
          outcome: "success",
          details: {
            ttlSeconds: mintResult.effectiveTtlSeconds,
            scopeCount: mintResult.mintedScope.length,
            tokenRef: mintResult.tokenHash,
          },
        });
        return {
          status: "minted",
          connectionId: connection.id,
          connection: { id: connection.id, uid: connection.uid },
          grantId: selectedGrant.id,
          providerTenantId: selectedGrant.providerTenant?.externalId,
          path: "exchange",
          token: mintResult.minted.token,
          tokenType: mintResult.minted.tokenType,
          expiresAt: mintResult.expiresAt.toISOString(),
          ttlSeconds: mintResult.effectiveTtlSeconds,
          scope: mintResult.mintedScope,
          attribution,
        };
      } catch (error) {
        const details = error instanceof HttpError && asRecord(error.details).code
          ? asRecord(error.details)
          : {};
        const errorCode = typeof details.code === "string" ? details.code : "mint_failed";
        const outcome: ConnectionTokenIssuanceOutcome = errorCode === "upstream_error" || errorCode === "upstream_token_missing"
          ? "upstream_error"
          : "failure";
        await recordFailure(outcome, errorCode, { ...details, message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },

    listRuntimeSlots: async (companyId: string): Promise<ToolRuntimeSlot[]> => {
      const rows = await db
        .select()
        .from(toolRuntimeSlots)
        .where(eq(toolRuntimeSlots.companyId, companyId))
        .orderBy(desc(toolRuntimeSlots.updatedAt));
      return rows.map(toRuntimeSlot);
    },

    stopRuntimeSlot: (companyId: string, slotId: string, actor?: ActorInfo): Promise<ToolRuntimeSlot> =>
      controlRuntimeSlot({ companyId, slotId, action: "stop", actor }),

    restartRuntimeSlot: (companyId: string, slotId: string, actor?: ActorInfo): Promise<ToolRuntimeSlot> =>
      controlRuntimeSlot({ companyId, slotId, action: "restart", actor }),

    getRuntimeHealth: runtimeHealth,

    getRunDecisionLookup: async (companyId: string, runId: string): Promise<ToolRunDecisionLookup> => {
      const [run] = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
        .limit(1);
      if (!run) throw notFound("Run not found");

      const invocationRows = await db
        .select()
        .from(toolInvocations)
        .where(and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.runId, runId)))
        .orderBy(desc(toolInvocations.createdAt));
      const invocationIds = invocationRows.map((row) => row.id);
      const [actionRequestRows, auditEventRows] = invocationIds.length > 0
        ? await Promise.all([
          db
            .select()
            .from(toolActionRequests)
            .where(and(eq(toolActionRequests.companyId, companyId), inArray(toolActionRequests.invocationId, invocationIds))),
          db
            .select()
            .from(toolCallEvents)
            .where(and(eq(toolCallEvents.companyId, companyId), eq(toolCallEvents.runId, runId), inArray(toolCallEvents.invocationId, invocationIds)))
            .orderBy(desc(toolCallEvents.createdAt)),
        ])
        : [[], []];

      const actionRequestByInvocation = new Map(actionRequestRows.map((row) => [row.invocationId, row]));
      const auditEventsByInvocation = new Map<string, typeof toolCallEvents.$inferSelect[]>();
      for (const event of auditEventRows) {
        if (!event.invocationId) continue;
        const events = auditEventsByInvocation.get(event.invocationId) ?? [];
        events.push(event);
        auditEventsByInvocation.set(event.invocationId, events);
      }

      const decisions: ToolRunDecision[] = invocationRows.map((invocation) => {
        const actionRequest = actionRequestByInvocation.get(invocation.id) ?? null;
        const auditEvents = auditEventsByInvocation.get(invocation.id) ?? [];
        const latestAuditEvent = auditEvents[0] ?? null;
        const apiInvocation = toToolInvocation(invocation);
        const apiActionRequest = actionRequest ? toToolActionRequest(actionRequest) : null;
        const apiAuditEvents = auditEvents.map(toToolCallEvent);
        const apiLatestAuditEvent = latestAuditEvent ? toToolCallEvent(latestAuditEvent) : null;
        const pendingAction = actionRequest && actionRequest.status === "pending"
          ? {
            actionRequestId: actionRequest.id,
            issueId: actionRequest.issueId,
            interactionId: actionRequest.interactionId,
            approvalId: actionRequest.approvalId,
            status: actionRequest.status,
            previewMarkdown: actionRequest.previewMarkdown,
          }
          : null;
        return {
          invocation: apiInvocation,
          actionRequest: apiActionRequest,
          auditEvents: apiAuditEvents,
          latestAuditEvent: apiLatestAuditEvent,
          decision: latestAuditEvent?.decision ?? invocation.policyDecision,
          outcome: latestAuditEvent?.outcome ?? null,
          reasonCode: latestAuditEvent?.reasonCode ?? invocation.errorCode,
          denialReason: denialReasonForDecision(invocation, latestAuditEvent),
          pendingAction,
        } satisfies ToolRunDecision;
      });

      return { runId, decisions };
    },

    previewMcpJsonImport: async (input: ImportMcpJson): Promise<McpJsonImportPreview> => {
      let raw: unknown;
      try {
        raw = typeof input.mcpJson === "string" ? JSON.parse(input.mcpJson) as unknown : input.mcpJson;
      } catch {
        throw badRequest("mcp.json must be valid JSON");
      }
      const mcpServers = asRecord(asRecord(raw).mcpServers);
      const drafts = Object.entries(mcpServers).map(([name, rawServer]) => {
        const server = asRecord(rawServer);
        const warnings: string[] = [];
        if (typeof server.url === "string" || typeof server.endpoint === "string") {
          const headers = asRecord(server.headers);
          const credentialFields = Object.keys(headers).sort().map((key) => {
            warnings.push(`Header ${key} will be stored as a Paperclip secret before activation.`);
            return {
              configPath: `headers.${key}`,
              label: key,
              placement: "header" as const,
              key,
              prefix: null,
              required: true,
            };
          });
          return {
            name,
            transport: "mcp_remote" as const,
            status: "draft" as const,
            config: { url: server.url ?? server.endpoint },
            credentialRefs: [] as McpConnectionCredentialRef[],
            credentialFields,
            warnings,
          };
        }
        if (typeof server.command === "string") {
          warnings.push("Imported stdio commands stay draft-only unless mapped to an approved Paperclip template.");
          return {
            name,
            transport: "local_stdio" as const,
            status: "draft" as const,
            config: { importedCommand: server.command, importedArgs: Array.isArray(server.args) ? server.args : [] },
            credentialRefs: [],
            credentialFields: [],
            warnings,
          };
        }
        warnings.push("Unsupported MCP server entry.");
        return {
          name,
          transport: "mcp_remote" as const,
          status: "draft" as const,
          config: {},
          credentialRefs: [],
          credentialFields: [],
          warnings,
        };
      });
      if (drafts.length === 0) throw badRequest("mcp.json must include an mcpServers object");
      return { drafts };
    },

    assertConnectionCompany: async (connectionId: string, companyId: string) => {
      const connection = await getConnectionRow(connectionId, companyId);
      return toConnection(connection);
    },

    ensureNoDuplicateNameError: (error: unknown) => {
      const maybeRecord = typeof error === "object" && error !== null ? error as Record<string, unknown> : null;
      const cause = maybeRecord?.cause;
      const maybeCause = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : null;
      const message = [
        error instanceof Error ? error.message : String(error),
        maybeRecord && typeof maybeRecord.detail === "string" ? maybeRecord.detail : null,
        maybeCause instanceof Error ? maybeCause.message : null,
        maybeCause && typeof maybeCause.detail === "string" ? maybeCause.detail : null,
      ].filter(Boolean).join("\n");
      const code =
        maybeRecord && typeof maybeRecord.code === "string"
          ? maybeRecord.code
          : maybeCause && typeof maybeCause.code === "string"
            ? maybeCause.code
            : null;
      const constraint =
        maybeRecord && typeof maybeRecord.constraint === "string"
          ? maybeRecord.constraint
          : maybeRecord && typeof maybeRecord.constraint_name === "string"
            ? maybeRecord.constraint_name
            : maybeCause && typeof maybeCause.constraint === "string"
              ? maybeCause.constraint
              : maybeCause && typeof maybeCause.constraint_name === "string"
                ? maybeCause.constraint_name
                : null;
      if (
        code === "23505" ||
        constraint?.includes("tool_applications") ||
        /duplicate key value|unique constraint|tool_applications_company_id_name_unique/i.test(message)
      ) {
        throw conflict("A tool access record with that name already exists", {
          code: "tool_access_name_conflict",
        });
      }
      throw error;
    },
  };
}
