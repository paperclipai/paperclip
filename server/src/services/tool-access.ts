import type { ConnectionManagementContext } from "./connection-management.js";
import { connectionActorUserId } from "./tool-access/actor.js";
import { restConnectorFor } from "./connectors/rest-registry.js";
import { createConnectionCredentialValidation } from "./tool-access/connections/credential-validation.js";
import { createConnectionGrants } from "./tool-access/connections/grants.js";
import { createConnectionInstalls } from "./tool-access/connections/installs.js";
import { createConnectionRemoval } from "./tool-access/connections/removal.js";
import { createToolRemoteHttp } from "./tool-access/remote-http.js";
import { classifyRisk, normalizeToolDescriptor, type McpToolDescriptor } from "./tool-access/catalog/descriptors.js";
export { classifyRisk, isGmailToolPermanentlyBlocked, isGoogleWorkspaceToolAllowed, type McpToolDescriptor } from "./tool-access/catalog/descriptors.js";
import { toCatalogEntry } from "./tool-access/catalog/projection.js";
import { toConnection, toConnectionInstall } from "./tool-access/connections/projection.js";
import { isOAuthEndpointRejection } from "./tool-access/catalog/failures.js";
import { createCatalogDefaultAccess, toPolicy } from "./tool-access/catalog/default-access.js";
import { createToolCatalogDiscovery } from "./tool-access/catalog/discovery.js";
import { createConnectionHealth } from "./tool-access/catalog/health.js";
import { createToolAppAttention } from "./tool-access/catalog/attention.js";
import { createToolCatalogPublication } from "./tool-access/catalog/publication.js";
import { createToolCatalogReader } from "./tool-access/catalog/reader.js";
import { createAggregatorAccounts } from "./tool-access/catalog/aggregator-accounts.js";
import { actorBinding } from "./tool-access/actor.js";
import { toApplication } from "./tool-access/applications/projection.js";
import { groupedActions } from "./tool-access/catalog/action-summary.js";
import { createConnectionSetupPolicy, assertSupportedConnection } from "./tool-access/connections/setup-policy.js";
import { createOrganizationGrantStore } from "./tool-access/connections/organization-grant.js";
import { createPersonalConnectionIdentity } from "./tool-access/connections/personal-identity.js";
import { createOAuthStateStore } from "./tool-access/oauth/state.js";
import { createOAuthCatalogCompletion } from "./tool-access/oauth/catalog-completion.js";
import { createOAuthAuthorizationStart } from "./tool-access/oauth/authorization-start.js";
import { createDirectOAuthCallback } from "./tool-access/oauth/direct-callback.js";
import { createCloudOAuthCallback } from "./tool-access/oauth/cloud-callback.js";
import { createVercelOAuthCallback } from "./tool-access/oauth/vercel-callback.js";
import { createOAuthAccessFinalization } from "./tool-access/oauth/access-finalization.js";
import { createVercelCredentialService, vercelConnectHttpError } from "./tool-access/vercel-credentials.js";
import { createConnectionCredentialAccess } from "./tool-access/credential-access.js";

import { createOAuthCredentialStore, actorForSecret } from "./tool-access/oauth/credential-store.js";
import { managedConnectorProfile } from "./tool-access/oauth/client-settings.js";
import { createOAuthClientRegistration } from "./tool-access/oauth/client-registration.js";
import { createOAuthRefreshLeases } from "./tool-access/oauth/refresh-leases.js";
import { createLegacyOAuthRefresh } from "./tool-access/oauth/connection-refresh.js";
import { createOAuthGrantRefresh } from "./tool-access/oauth/grant-refresh.js";
import { createGitHubGrantContinuity } from "./tool-access/github-grant-continuity.js";
import { createToolRuntimeHealth } from "./tool-access/runtime/health.js";
import { createToolRuntimeSlots } from "./tool-access/runtime/slots.js";
import { createToolActivityService } from "./tool-access/activity/service.js";
import { createToolActionReviewQueue } from "./tool-access/activity/review-queue.js";
import { createToolAccessAudit } from "./tool-access/audit.js";
import { createConnectionTokenBroker } from "./tool-access/token-broker/service.js";

import { createToolProfileService } from "./tool-access/profiles/service.js";
import { createToolProfileResolver } from "./tool-access/profiles/resolution.js";
import { toProfile, toProfileEntry, toProfileBinding } from "./tool-access/profiles/projection.js";
import { lockManagedAppPolicies, lockToolAssignmentAgents } from "./tool-access/assignment-locks.js";
export { lockToolConnectionRuntimeInputs } from "./tool-access/assignment-locks.js";
import type { ActorInfo } from "./tool-access/types.js";
import { normalizeKey, connectionUid } from "./tool-access/identifiers.js";
import { createOAuthEndpointPolicy } from "./tool-access/oauth/endpoint-policy.js";
import { createOAuthDiscovery } from "./tool-access/oauth/discovery.js";
import { createOAuthClientProtocol } from "./tool-access/oauth/client.js";

import type { OAuthClientRegistrationSource } from "./tool-access/oauth/types.js";
export { OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH, resolveOAuthClientIdMetadataDocumentUrl, oauthClientIdMetadataDocument } from "./tool-access/oauth/client-metadata.js";
import { connectionMethodFor, connectionMethodForConnection, credentialFieldsFor, normalizeConnectionMethodConfig, projectedConnectionToolInputSchema } from "./tool-access/connection-methods.js";
export {
  normalizeConnectionMethodConfig,
  projectedConnectionHeaders,
  projectConnectionMethodToolArguments,
  projectConnectionMethodToolInputSchema,
  projectedConnectionToolArguments,
  projectedConnectionToolInputSchema,
} from "./tool-access/connection-methods.js";
import { loadGitHubTokenRepositories } from "./tool-access/github-access-discovery.js";
export { loadGitHubGrantMetadata, loadGitHubTokenRepositories } from "./tool-access/github-access-discovery.js";

import { stableHash } from "./tool-catalog-hash.js";

import { NATIVE_PROVIDER_SLUGS, nativeProviderCatalogFor } from "./native-provider-catalogs.js";
import { connectorToolPolicy } from "./connectors/tool-policy.js";

import { notifyChatEndpointWork } from "./chat-work-notifications.js";

import { defaultConnectionAgentInstructions } from "@paperclipai/shared";

import { isBrowserUseConnection } from "./browser-use-client.js";

import { COGNEE_STDIO_TEMPLATE } from "./cognee-connection.js";
import { isRemoteMcpConnectorMethod } from "@paperclipai/shared";

import { githubBotRequest } from "./chat-github-client.js";
import { syncConnectionCredentialBindings } from "./connection-credential-bindings.js";
import {
  emitConnectionCreated,
  emitConnectionUpdated,
} from "./connector-telemetry.js";
import { canBrowseProjectRepositoryGrant, mergeProjectRepository } from "./project-repositories.js";

import { measureRunPhase } from "./execution-preparation-timing.js";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, desc, eq, inArray, max, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, connectionGrantMembers, connectionGrants, companyMemberships, principalPermissionGrants, userSecretDefinitions, plugins, toolAccessAuditEvents, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolStdioCommandTemplates, toolCallEvents, toolPolicies, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { AppDefinition, ConnectionGrantKind, CreateToolApplication, CreateToolConnection, ConnectToolApp, ConnectToolAppResult, CreateToolStdioCommandTemplate, FinishToolApp, FinishToolAppResult, CreateToolProfileBindingForProfile, CreateToolProfileEntryForProfile, DeploymentExposure, DeploymentMode, ImportMcpJson, McpConnectionCredentialRef, McpJsonImportPreview, ToolApplication, ToolCatalogEntry, ToolCatalogRefreshResult, ToolConnection, ToolConnectionInstall, ToolConnectionHealthCheckResult, ToolConnectionAuthKind, ToolConnectionCredentialPolicy, ToolConnectionCredentialSource, ToolConnectionTransport, ToolAppMetadataPreflightResult, ToolExampleInstallResult, ToolExampleSmokeCheck, ToolExampleSmokeResult, ToolExampleSummary, ToolProfileBinding, ToolProfileEntry, ToolPolicyDecision, ToolStdioCommandTemplate, UpdateToolApplication, UpdateToolConnection, VercelConnectCredentialReference } from "@paperclipai/shared";
import { getAppDefinitionForUrl, getAvailableConnectionMethods, getConnectableAppDefinition, recommendedDefaultsForApp } from "@paperclipai/shared";
import {
  checkMcpRemoteHeaderName,
  checkMcpRemoteHeaderValue,
  mcpRemoteHeaderNameFromConfigPath,
  mcpRemoteHeaderRejectionMessage,
} from "@paperclipai/shared";
import {
  badRequest,
  conflict,
  forbidden,
  HttpError,
  notFound,
  unprocessable,
} from "../errors.js";
import { isUniqueViolation } from "../db-errors.js";

import { forgetMcpHttpSessions } from "./mcp-http.js";
import { type RemoteHttpEndpointLookup } from "./remote-http-endpoint-guard.js";

import {
  REMOTE_URL_SECRET_CONFIG_PATH,
  remoteUrlCredentialMatchesPublicUrl,
  splitRemoteUrlCredential,
} from "./remote-url-credentials.js";
import { secretService } from "./secrets.js";
import { connectionCredentialConfigPath as credentialRefConfigPath, validateConnectionGrantSecretOwnership, writeConnectionCredential } from "./connection-credentials.js";

import type { ConfigureRailwaySsh, RailwaySshSetup } from "@paperclipai/shared";
import { generateRailwaySshKey, RAILWAY_SSH_SECRET_PATH, validateRailwayKnownHosts } from "./railway-ssh.js";
import { isRailwayConnection } from "./railway.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";

import { googleChatToolDescription } from "./google-chat-tool-policy.js";
import { gmailArchiveToolDescription } from "./gmail-archive-tool-policy.js";

import { createToolRuntimeSupervisor } from "./tool-runtime-supervisor.js";

import { appWithPaperclipCloudConnectorAvailability, paperclipCloudConnectorCapabilitiesFromEnv, createPaperclipCloudConnector, isPaperclipCloudConnectorStrategy, paperclipCloudConnectorConfigFromEnv, type PaperclipCloudConnector } from "./paperclip-cloud-connector.js";
import { createVercelConnectClient, deriveVercelConnectSubject, vercelConnectIntegrationStatus, type VercelConnectClient } from "./vercel-connect.js";

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
  /** Smaller reviewed catalog for deterministic discovery fixtures. */
  composioAppToolkits?: readonly string[];
  /** Test seam for the centrally registered Gmail OAuth broker. */
  paperclipCloudConnector?: PaperclipCloudConnector | null;
  /** @deprecated Use paperclipCloudConnector. */
  paperclipIdGmailConnector?: PaperclipCloudConnector | null;
  /** Test seam for Vercel Connect without live vendor traffic. */
  vercelConnectClient?: VercelConnectClient | null;
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
    valueInputOption: {
      type: "string",
      enum: ["RAW", "USER_ENTERED"],
      default: "RAW",
    },
  },
  required: ["spreadsheetId", "range", "values"],
};

function schemaHasInputProperties(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return false;
  const properties = (schema as Record<string, unknown>).properties;
  return Boolean(
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.keys(properties).length > 0,
  );
}

const APPROVED_STDIO_TEMPLATES: Record<
  string,
  {
    name: string;
    command?: string | null;
    args?: string[];
    envKeys?: string[];
    tools: McpToolDescriptor[];
  }
> = {
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
      {
        name: "list_items",
        description: "List synthetic todo items.",
        annotations: { readOnlyHint: true },
      },
      {
        name: "create_item",
        description: "Create a synthetic todo item.",
        annotations: { readOnlyHint: false },
      },
      {
        name: "mark_done",
        description: "Mark a synthetic todo item done.",
        annotations: { readOnlyHint: false },
      },
      {
        name: "delete_item",
        description: "Delete a synthetic todo item.",
        annotations: { destructiveHint: true },
      },
      {
        name: "get_value",
        description: "Read a synthetic KV value.",
        annotations: { readOnlyHint: true },
      },
      {
        name: "set_value",
        description: "Write a synthetic KV value.",
        annotations: { readOnlyHint: false },
      },
    ],
  },
  "paperclip.cognee-cloud": COGNEE_STDIO_TEMPLATE,
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
        description:
          "List the Google Sheets spreadsheets configured in this connection allowlist.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_spreadsheet_info",
        description:
          "Get spreadsheet metadata and sheet tab information for an allowlisted spreadsheet.",
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
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: 500,
              default: 50,
            },
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
const GOOGLE_SHEETS_TEMPLATE_ID = "paperclip.google-sheets";
const GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS_ENV =
  "GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS";

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
    description:
      "Installs a deterministic local MCP fixture and grants only its read-only catalog entries.",
    applicationKey: "paperclip.examples.safe-read-only-todo-kv",
    applicationName: "Paperclip example: Safe read-only Todo / KV",
    applicationDescription:
      "Deterministic MCP fixture for first-run tool governance checks.",
    connectionName: "Paperclip example: Safe read-only Todo / KV",
    templateId: "paperclip.synthetic-todo-kv",
    profileKey: "paperclip.examples.safe-read-only-todo-kv.profile",
    profileName: "Example safe read-only tools",
    profileDescription:
      "Allows only the read-only tools from the Paperclip Todo / KV example fixture.",
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function googleSheetsRobotEmailFromEnv(
  env: NodeJS.ProcessEnv = process.env,
):
  | { available: true; robotEmail: string }
  | { available: false; reason: string } {
  const inlineOrPath = env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON?.trim();
  const explicitPath = env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH?.trim();
  if (!inlineOrPath && !explicitPath) {
    return {
      available: false,
      reason: "Google Sheets is not available on this instance yet.",
    };
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
    return {
      available: false,
      reason: "Google Sheets is not available on this instance yet.",
    };
  }
  return {
    available: false,
    reason: "Google Sheets is not available on this instance yet.",
  };
}

function googleSheetsAllowedSpreadsheetIds(
  configValues: Record<string, unknown> | undefined,
): string[] {
  const raw = configValues?.allowedSpreadsheetIds;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\n,]/g)
      : [];
  return Array.from(
    new Set(values.map((value) => String(value).trim()).filter(Boolean)),
  );
}

function isGoogleSheetsConnectionConfig(
  configValues: Record<string, unknown> | undefined,
): boolean {
  return (
    configValues?.sourceTemplateKey === GOOGLE_SHEETS_GALLERY_KEY ||
    configValues?.templateId === GOOGLE_SHEETS_TEMPLATE_ID
  );
}

function normalizeGoogleSheetsConnectionConfig(
  configValues: Record<string, unknown>,
): Record<string, unknown> {
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
      [GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS_ENV]:
        allowedSpreadsheetIds.join(","),
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
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth += 1
  ) {
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
      (constraint ===
        "tool_connections_application_id_tool_applications_id_fk" ||
        /tool_connections/.test(constraint ?? "") ||
        /tool_connections/.test(message))
    );
  });
}

function toCatalogEntryForConnection(
  row: typeof toolCatalogEntries.$inferSelect,
  connection: typeof toolConnections.$inferSelect,
): ToolCatalogEntry {
  const rawCatalogEntry = toCatalogEntry(row);
  const catalogEntry = {
    ...rawCatalogEntry,
    inputSchema: projectedConnectionToolInputSchema(
      connection,
      rawCatalogEntry.inputSchema ?? {},
      row.toolName,
    ),
    description: gmailArchiveToolDescription(
      connection,
      row.toolName,
      googleChatToolDescription(connection, row.toolName, rawCatalogEntry.description),
    ),
  };
  if (
    connection.transport === "local_stdio" &&
    asRecord(connection.config).templateId === GOOGLE_SHEETS_TEMPLATE_ID &&
    !schemaHasInputProperties(catalogEntry.inputSchema)
  ) {
    const templateTool = APPROVED_STDIO_TEMPLATES[
      GOOGLE_SHEETS_TEMPLATE_ID
    ].tools.find((tool) => tool.name === row.toolName);
    if (schemaHasInputProperties(templateTool?.inputSchema)) {
      return { ...catalogEntry, inputSchema: templateTool!.inputSchema! };
    }
  }
  return catalogEntry;
}

function builtInStdioTemplate(
  templateId: string,
): ToolStdioCommandTemplate | null {
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

function toStdioCommandTemplate(
  row: typeof toolStdioCommandTemplates.$inferSelect,
): ToolStdioCommandTemplate {
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

function connectionSetupMutationFingerprint(
  row: typeof toolConnections.$inferSelect,
): string {
  return stableHash({
    name: row.name,
    transport: row.transport,
    status: row.status,
    enabled: row.enabled,
    agentInstructions: row.agentInstructions,
    config: row.config,
    transportConfig: row.transportConfig,
    credentialRefs: row.credentialRefs,
    credentialSecretRefs: row.credentialSecretRefs,
    credentialSource: row.credentialSource,
    externalCredential: row.externalCredential,
    credentialPolicy: row.credentialPolicy,
  });
}

function readStdioTemplateId(config: Record<string, unknown>): string {
  const templateId = config.templateId;
  if (typeof templateId !== "string" || templateId.trim().length === 0) {
    throw badRequest(
      "Local stdio MCP connections must use an approved templateId",
    );
  }
  return templateId.trim();
}

async function gitHubReadGrantAccess(db: Db, companyId: string, connectionId: string, userId: string | null, localTrusted: boolean) {
  const [connection] = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, connectionId)));
  if (!connection || !connection.enabled || connection.status !== "active" || asRecord(connection.config).sourceTemplateKey !== "github") {
    throw forbidden("GitHub connection is unavailable. Choose a connection you can use.");
  }
  const [membership] = userId ? await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active"))) : [];
  if (!localTrusted && (!membership || membership.membershipRole === "viewer")) throw forbidden("GitHub access requires an active company member.");
  const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.connectionId, connectionId)));
  const members = await db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.companyId, companyId));
  const candidates = grants.filter(grant => !(grant.kind === "organization" && ["per_user", "per_agent"].includes(connection.credentialPolicy)) && canBrowseProjectRepositoryGrant({
    grant, userId, activeMember: localTrusted || Boolean(membership), audience: members.filter(member => member.grantId === grant.id).map(member => member.subjectId),
  }));
  const allowed: typeof candidates = [];
  for (const grant of candidates) {
    const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "oauth.access_token" || /authorization|token|api_key/i.test(ref.configPath));
    if (!ref) continue;
    try {
      await validateConnectionGrantSecretOwnership(db, connection, grant, ref);
      allowed.push(grant);
    } catch (error) {
      if (!(error instanceof HttpError && asRecord(error.details).code === "grant_credential_invalid")) throw error;
    }
  }
  const legacyShared = !grants.length && connection.credentialPolicy === "shared";
  if (!allowed.length && !legacyShared) throw forbidden("Choose a GitHub connection with an active authorization you can use.");
  return { connection, allowed, legacyShared };
}

export function toolAccessService(
  db: Db,
  options: ToolAccessServiceOptions = {},
) {
  const secrets = secretService(db);
  const remoteHttp = createToolRemoteHttp(options);
  const { allowPrivateRemoteEndpoints, assertRemoteHttpUrlAllowed, fetchRemoteHttpUrl, assertRemoteEndpointAllowed, assertRemoteConnectionEndpointsAllowed, requestRemoteHttpEndpoint } = remoteHttp;
  const { assertOAuthEndpointUrl, safeOAuthEndpointUrl } = createOAuthEndpointPolicy(allowPrivateRemoteEndpoints);
  const { oauthEndpointsForConnection, discoverOAuthEndpoints, preflightConnectionMetadata } = createOAuthDiscovery({
    fetchRemoteHttpUrl, assertRemoteEndpointAllowed, assertOAuthEndpointUrl, safeOAuthEndpointUrl,
  });
  const { requestOAuthClientRegistration, exchangeOAuthToken } = createOAuthClientProtocol({
    fetchRemoteHttpUrl, assertOAuthEndpointUrl,
  });
  const policySvc = toolAccessPolicyService(db);
  const now = options.now ?? (() => new Date());
  const assertSecretRefs = createConnectionCredentialValidation(db);
  const connectionInstalls = createConnectionInstalls(db, { now, getConnectionRow, assertOptionalAgent });
  const { resolveInstalledConnectionsForAgent, listConnectionInstalls } = connectionInstalls;
  const audit = createToolAccessAudit(db);
  const ensureDefaultOrganizationGrant = createOrganizationGrantStore(db);
  const { mintConnectionTokenForAgent, loadBrokerRunContext } = createConnectionTokenBroker(db, { now, secrets, policySvc, audit, getConnectionRow, ensureDefaultOrganizationGrant });
  const profileService = createToolProfileService(db, now);
  const profileDetails = profileService.getProfile;
  const profileResolver = createToolProfileResolver(db, { assertOptionalAgent, resolveInstalledConnectionsForAgent, toCatalogEntry });
  const configuredCloudConnector =
    options.paperclipCloudConnector ?? options.paperclipIdGmailConnector;
  const connectorWasProvided =
    options.paperclipCloudConnector !== undefined ||
    options.paperclipIdGmailConnector !== undefined;
  let cachedCloudConnector = configuredCloudConnector ?? null;
  const currentCloudConnector = (): PaperclipCloudConnector | null => {
    if (cachedCloudConnector || connectorWasProvided)
      return cachedCloudConnector;
    const config = paperclipCloudConnectorConfigFromEnv();
    cachedCloudConnector = config
      ? createPaperclipCloudConnector({ config, now: () => now().getTime() })
      : null;
    return cachedCloudConnector;
  };
  async function appForConnectionSetup(app: AppDefinition): Promise<AppDefinition> {
    if (!app.methods.some((method) => isPaperclipCloudConnectorStrategy(method.oauthStrategy))) {
      return app;
    }
    const profiles = connectorWasProvided
      ? (await currentCloudConnector()?.getCapabilities() ?? [])
      : await paperclipCloudConnectorCapabilitiesFromEnv();
    return appWithPaperclipCloudConnectorAvailability(app, profiles);
  }
  const vercelConnect =
    options.vercelConnectClient === undefined
      ? createVercelConnectClient()
      : options.vercelConnectClient;
  const runtimeSupervisor = createToolRuntimeSupervisor(db, options);
  const connectionGrantsService = createConnectionGrants(db, { getConnectionRow, assertSecretRefs, vercelConnect });
  const removeConnection = createConnectionRemoval(db, { options, secrets, runtimeSupervisor, vercelConnect, getConnectionRow });
  const credentialStore = createOAuthCredentialStore(db, secrets);
  const { syncCredentialBindings, annotateSavedOAuthClientSecret, oauthClientForConnection, createOrRotateOAuthSecret, getOAuthGrantRow, resolveOAuthGrantSecret } = credentialStore;
  const ensureOAuthClient = createOAuthClientRegistration(db, { now, options, store: credentialStore, getConnectionRow, requestOAuthClientRegistration });
  const refreshLeases = createOAuthRefreshLeases(db, now, getConnectionRow, getOAuthGrantRow);
  const maybeRefreshOAuthCredentials = createLegacyOAuthRefresh(db, { now, secrets, store: credentialStore, leases: refreshLeases, getConnectionRow, exchangeOAuthToken });
  const refreshOAuthGrantCredentials = createOAuthGrantRefresh(db, { now, store: credentialStore, leases: refreshLeases, currentCloudConnector, getConnectionRow, exchangeOAuthToken });
  const { refreshManagedGitHubGrantAccess, sweepGitHubConnectionContinuity } = createGitHubGrantContinuity(db, { now, currentCloudConnector, refreshOAuthGrantCredentials, resolveOAuthGrantSecret });
  const vercelCredentials = createVercelCredentialService(db, now, vercelConnect);
  const { resolveVercelCredentialHeaders, vercelGrantForConnection } = vercelCredentials;
  const credentialAccess = createConnectionCredentialAccess(db, { secrets, audit, vercel: vercelCredentials, resolveOAuthGrantSecret, maybeRefreshOAuthCredentials, refreshOAuthGrantCredentials });
  const { vaultGrantForConnection, resolveCredentialHeaders, resolvedRemoteEndpoint } = credentialAccess;
  const setupPolicy = createConnectionSetupPolicy(db);
  const { assertConnectorConnectionSetupEnabled, assertExperimentalConnectorSetupEnabled } = setupPolicy;
  const fixedPersonalIdentityForReconnect = createPersonalConnectionIdentity(db);
  const runtimeSlots = createToolRuntimeSlots(db, runtimeSupervisor);
  const { ensureRuntimeSlot } = runtimeSlots;
  const defaultCatalogAccess = createCatalogDefaultAccess(db);
  const { enableCatalogEntriesByDefault, upsertAskFirstPolicies } = defaultCatalogAccess;
  const catalogDiscovery = createToolCatalogDiscovery(db, { now, audit, secrets, credentials: credentialAccess, vercel: vercelCredentials, vercelConnect, setupPolicy, requestRemoteHttpEndpoint, resolveOAuthGrantSecret, discoverOAuthEndpoints, localTools });
  const connectionHealth = createConnectionHealth(db, { now, audit, getConnectionRow, discovery: catalogDiscovery, setupPolicy, resolveCredentialHeaders, refreshManagedGitHubGrantAccess, ensureRuntimeSlot, stdioTemplateId });
  const { updateConnectionHealth, checkConnectionHealth, sweepConnectionHealth } = connectionHealth;
  const refreshCatalog = createToolCatalogPublication(db, { now, audit, getConnectionRow, discoverTools: catalogDiscovery.discoverTools, assertConnectorConnectionSetupEnabled, updateConnectionHealth, vaultGrantForConnection, ensureRuntimeSlot, enableCatalogEntriesByDefault });
  const catalogReader = createToolCatalogReader(db, options, now, getConnectionRow, refreshCatalog, toCatalogEntryForConnection);
  const listAppsNeedingAttention = createToolAppAttention(db, now);
  const aggregatorAccounts = createAggregatorAccounts(db, { options, secrets, audit, credentials: credentialAccess, getConnectionRow, requestRemoteHttpEndpoint, remoteTools: catalogDiscovery.remoteTools });
  const oauthState = createOAuthStateStore(db);
  const { peekOAuthState } = oauthState;
  const finishOAuthCatalogWithRecommendedDefaults = createOAuthCatalogCompletion(db, finishGalleryAppConnection);
  const startOAuth = createOAuthAuthorizationStart(db, { now, getConnectionRow, setupPolicy, fixedPersonalIdentityForReconnect, currentCloudConnector, vercelConnect, ensureOAuthClient, oauthEndpointsForConnection, assertOAuthEndpointUrl });
  const completeOAuthCallback = createDirectOAuthCallback(db, { now, getConnectionRow, state: oauthState, store: credentialStore, setupPolicy, refreshCatalog, finishOAuthCatalogWithRecommendedDefaults, checkConnectionHealth, ensureDefaultOrganizationGrant, oauthEndpointsForConnection, exchangeOAuthToken });
  const completePaperclipCloudConnectorCallback = createCloudOAuthCallback(db, { now, getConnectionRow, state: oauthState, store: credentialStore, refreshCatalog, finishOAuthCatalogWithRecommendedDefaults, currentCloudConnector });
  const completeVercelConnectCallback = createVercelOAuthCallback(db, { now, getConnectionRow, state: oauthState, refreshCatalog, finishOAuthCatalogWithRecommendedDefaults, vercelConnect });
  const finalizeOAuthAccess = createOAuthAccessFinalization(db, { getConnectionRow, secrets, store: credentialStore, assertAgentsInCompany, finishGalleryAppConnection });
  const runtimeHealth = createToolRuntimeHealth(db, options, now, trustedRuntimeHost);
  const toolActivity = createToolActivityService(db, getConnectionRow);
  const toolActionReviewQueue = createToolActionReviewQueue(db);

  function trustedRuntimeHost() {
    return (
      options.trustedLocalStdioRuntimeHost ??
      process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST ??
      process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST ??
      null
    );
  }

  function assertLocalStdioCanBeEnabled(
    transport: ToolConnectionTransport,
    enabled: boolean,
    config: Record<string, unknown> = {},
  ) {
    if (config.templateId === "paperclip.cognee-cloud") return;
    if (
      transport === "local_stdio" &&
      enabled &&
      options.deploymentMode === "authenticated" &&
      options.deploymentExposure === "public" &&
      !trustedRuntimeHost()
    ) {
      throw unprocessable(
        "Local stdio MCP connections cannot be enabled in authenticated public deployments without a trusted runtime host",
      );
    }
  }

  async function getAdminStdioTemplate(companyId: string, templateId: string) {
    return db
      .select()
      .from(toolStdioCommandTemplates)
      .where(
        and(
          eq(toolStdioCommandTemplates.companyId, companyId),
          eq(toolStdioCommandTemplates.templateKey, templateId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveStdioTemplate(
    companyId: string,
    configOrTemplateId: Record<string, unknown> | string,
  ) {
    const templateId =
      typeof configOrTemplateId === "string"
        ? configOrTemplateId.trim()
        : readStdioTemplateId(configOrTemplateId);
    const builtIn = builtInStdioTemplate(templateId);
    if (builtIn) return builtIn;
    const adminTemplate = await getAdminStdioTemplate(companyId, templateId);
    if (!adminTemplate || adminTemplate.status !== "active") {
      throw badRequest(
        "Local stdio MCP connections must use an approved templateId",
      );
    }
    return toStdioCommandTemplate(adminTemplate);
  }

  async function stdioTemplateId(
    companyId: string,
    config: Record<string, unknown>,
  ): Promise<string> {
    return (await resolveStdioTemplate(companyId, config)).templateId;
  }

  async function assertApplication(companyId: string, applicationId: string) {
    const [row] = await db
      .select()
      .from(toolApplications)
      .where(
        and(
          eq(toolApplications.id, applicationId),
          eq(toolApplications.companyId, companyId),
        ),
      );
    if (!row) throw notFound("Tool application not found");
    return row;
  }

  async function assertOptionalAgent(
    companyId: string,
    agentId: string | null | undefined,
    label: string,
  ) {
    if (!agentId) return;
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!row) throw unprocessable(`${label} must belong to the same company`);
  }

  async function assertOptionalPlugin(pluginId: string | null | undefined) {
    if (!pluginId) return;
    const [row] = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    if (!row) throw unprocessable("Tool application plugin was not found");
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
      if (row.id === options.excludeConnectionId || row.companyId === companyId)
        continue;
      if (!isGoogleSheetsConnectionConfig(row.config)) continue;
      for (const spreadsheetId of googleSheetsAllowedSpreadsheetIds(
        row.config,
      )) {
        if (allowed.has(spreadsheetId))
          conflictingSpreadsheetIds.add(spreadsheetId);
      }
    }

    if (conflictingSpreadsheetIds.size > 0) {
      throw conflict(
        "Google Sheets spreadsheet is already connected to another company.",
        {
          code: "google_sheets_spreadsheet_already_bound",
          spreadsheetIds: Array.from(conflictingSpreadsheetIds).sort(),
        },
      );
    }
  }

  async function assertCatalogEntry(
    companyId: string,
    catalogEntryId: string | null | undefined,
  ) {
    if (!catalogEntryId) return;
    const [row] = await db
      .select({ id: toolCatalogEntries.id })
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.id, catalogEntryId),
          eq(toolCatalogEntries.companyId, companyId),
        ),
      );
    if (!row)
      throw unprocessable(
        "Tool profile catalog entry selector must belong to the same company",
      );
  }

  async function getConnectionRow(idOrUid: string, companyId?: string) {
    const identifier =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        idOrUid,
      )
        ? eq(toolConnections.id, idOrUid)
        : eq(toolConnections.uid, idOrUid);
    const where = companyId
      ? and(identifier, eq(toolConnections.companyId, companyId))
      : identifier;
    const [row] = await db.select().from(toolConnections).where(where);
    if (!row) throw notFound("Tool connection not found");
    return row;
  }

  async function localTools(
    connection: typeof toolConnections.$inferSelect,
  ): Promise<McpToolDescriptor[]> {
    const template = await resolveStdioTemplate(
      connection.companyId,
      connection.config,
    );
    return template.tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: tool.annotations ?? {},
    }));
  }

  async function annotateAiGrantHealth(connections: ToolConnection[]) {
    const aiConnections = connections.filter(connection => connection.connectionPurpose === "ai");
    if (!aiConnections.length) return;
    const grants = await db.select({ connectionId: connectionGrants.connectionId, status: connectionGrants.status })
      .from(connectionGrants).where(and(eq(connectionGrants.companyId, aiConnections[0].companyId),
        inArray(connectionGrants.connectionId, aiConnections.map(connection => connection.id))));
    for (const connection of aiConnections) {
      const identities = grants.filter(grant => grant.connectionId === connection.id);
      if (identities.length && identities.every(grant => grant.status === "revoked")) {
        connection.healthStatus = "missing_secret";
        connection.healthMessage = "This credential was revoked. Reconnect the account to restore access.";
        connection.requiresReauthorization = true;
      }
    }
  }

  async function annotateGitHubAuthorization(
    connections: ToolConnection[],
    viewerUserId?: string,
  ) {
    const github = connections.filter(
      (connection) =>
        asRecord(connection.config).sourceTemplateKey === "github",
    );
    if (!github.length) return;
    const grants = await db
      .select({
        connectionId: connectionGrants.connectionId,
        status: connectionGrants.status,
        kind: connectionGrants.kind,
        subjectUserId: connectionGrants.subjectUserId,
      })
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, github[0].companyId),
          inArray(
            connectionGrants.connectionId,
            github.map((connection) => connection.id),
          ),
        ),
      );
    for (const connection of github) {
      const userId = viewerUserId ?? connection.createdByUserId;
      const eligible = grants.filter(
        (grant) =>
          grant.connectionId === connection.id &&
          (connection.credentialPolicy !== "per_user" ||
            (grant.kind === "user" && grant.subjectUserId === userId)),
      );
      connection.requiresReauthorization = !eligible.some(
        (grant) => grant.status === "active",
      );
    }
  }

  function findExample(exampleId: string): ToolExampleDefinition {
    const definition = TOOL_EXAMPLES.find(
      (example) => example.id === exampleId,
    );
    if (!definition) throw notFound("Tool example not found");
    return definition;
  }

  function localStdioInstallBlocker(): string | null {
    return options.deploymentMode === "authenticated" &&
      options.deploymentExposure === "public" &&
      !trustedRuntimeHost()
      ? "Local stdio examples require a trusted MCP runtime host in authenticated public deployments."
      : null;
  }

  function exampleToolSummaries(
    definition: ToolExampleDefinition,
  ): ToolExampleSummary["fixture"]["tools"] {
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

  async function exampleRows(
    companyId: string,
    definition: ToolExampleDefinition,
  ) {
    const [application] = await db
      .select()
      .from(toolApplications)
      .where(
        and(
          eq(toolApplications.companyId, companyId),
          eq(toolApplications.applicationKey, definition.applicationKey),
        ),
      );
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.name, definition.connectionName),
        ),
      );
    const [profile] = await db
      .select()
      .from(toolProfiles)
      .where(
        and(
          eq(toolProfiles.companyId, companyId),
          eq(toolProfiles.profileKey, definition.profileKey),
        ),
      );
    const [profileBinding] = profile
      ? await db
          .select()
          .from(toolProfileBindings)
          .where(
            and(
              eq(toolProfileBindings.companyId, companyId),
              eq(toolProfileBindings.profileId, profile.id),
              eq(toolProfileBindings.targetType, "company"),
              eq(toolProfileBindings.targetId, companyId),
            ),
          )
      : [];
    const catalog = connection
      ? await db
          .select()
          .from(toolCatalogEntries)
          .where(
            and(
              eq(toolCatalogEntries.companyId, companyId),
              eq(toolCatalogEntries.connectionId, connection.id),
            ),
          )
          .orderBy(asc(toolCatalogEntries.toolName))
      : [];
    return {
      application: application ?? null,
      connection: connection ?? null,
      profile: profile ?? null,
      profileBinding: profileBinding ?? null,
      catalog,
    };
  }

  function exampleSummary(
    definition: ToolExampleDefinition,
    rows: Awaited<ReturnType<typeof exampleRows>>,
  ): ToolExampleSummary {
    const blocker = localStdioInstallBlocker();
    const tools = exampleToolSummaries(definition);
    const installed = Boolean(
      rows.application &&
      rows.connection &&
      rows.profile &&
      rows.profileBinding &&
      rows.connection.status !== "archived" &&
      rows.profile.status !== "archived",
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
        allowedToolNames: tools
          .filter((tool) => tool.readOnly)
          .map((tool) => tool.name),
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
    const metadata = {
      ...(existing?.metadata ?? {}),
      source: "paperclip_example",
      exampleId: definition.id,
      safeDefault: true,
    };
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
    const [created] = await db
      .insert(toolApplications)
      .values({
        companyId,
        applicationKey: definition.applicationKey,
        name: definition.applicationName,
        description: definition.applicationDescription,
        type: "mcp_stdio",
        status: "active",
        metadata,
      })
      .returning();
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
      emitConnectionUpdated(updated, existing, "example");
      return { row: updated, created: false };
    }
    const connectionId = randomUUID();
    const [created] = await db
      .insert(toolConnections)
      .values({
        id: connectionId,
        companyId,
        applicationId,
        name: definition.connectionName,
        uid: connectionUid(
          "paperclip",
          definition.connectionName,
          connectionId,
        ),
        connectionKind: "managed",
        transport: "local_stdio",
        status: "active",
        enabled: true,
        config,
        transportConfig: config,
        credentialRefs: [],
        credentialSecretRefs: [],
      })
      .returning();
    await ensureDefaultOrganizationGrant(created);
    await syncCredentialBindings(created);
    await ensureRuntimeSlot(created);
    emitConnectionCreated(created, "example");
    return { row: created, created: true };
  }

  async function upsertExampleProfile(
    companyId: string,
    definition: ToolExampleDefinition,
    existing: typeof toolProfiles.$inferSelect | null,
  ) {
    const metadata = {
      ...(existing?.metadata ?? {}),
      source: "paperclip_example",
      exampleId: definition.id,
      safeDefault: true,
    };
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
    const [created] = await db
      .insert(toolProfiles)
      .values({
        companyId,
        profileKey: definition.profileKey,
        name: definition.profileName,
        description: definition.profileDescription,
        status: "active",
        defaultAction: "deny",
        metadata,
      })
      .returning();
    return { row: created, created: true };
  }

  async function syncExampleProfileEntries(
    companyId: string,
    profileId: string,
    catalog: ToolCatalogEntry[],
  ): Promise<ToolProfileEntry[]> {
    await db
      .delete(toolProfileEntries)
      .where(
        and(
          eq(toolProfileEntries.companyId, companyId),
          eq(toolProfileEntries.profileId, profileId),
        ),
      );
    const readEntries = catalog.filter(
      (entry) => entry.riskLevel === "read" && entry.status === "active",
    );
    if (readEntries.length === 0) return [];
    const rows = await db
      .insert(toolProfileEntries)
      .values(
        readEntries.map((entry) => ({
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
        })),
      )
      .returning();
    return rows.map(toProfileEntry);
  }

  async function upsertExampleProfileBinding(
    companyId: string,
    profileId: string,
    existing: typeof toolProfileBindings.$inferSelect | null,
    actor?: ActorInfo,
  ): Promise<ToolProfileBinding> {
    const metadata = {
      ...(existing?.metadata ?? {}),
      source: "paperclip_example",
      safeDefault: true,
    };
    if (existing) {
      const [updated] = await db
        .update(toolProfileBindings)
        .set({ priority: 100, metadata, updatedAt: new Date() })
        .where(eq(toolProfileBindings.id, existing.id))
        .returning();
      return toProfileBinding(updated);
    }
    const [created] = await db
      .insert(toolProfileBindings)
      .values({
        companyId,
        profileId,
        targetType: "company",
        targetId: companyId,
        priority: 100,
        metadata,
        createdByAgentId:
          actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
        createdByUserId:
          connectionActorUserId(actor),
      })
      .returning();
    return toProfileBinding(created);
  }

  async function exampleSmokeActor(companyId: string, actor?: ActorInfo) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .limit(1);
    if (agent) {
      return {
        actorType: "agent" as const,
        actorId: agent.id,
        agentId: agent.id,
      };
    }
    const actorType =
      actor?.actorType === "user" ? ("user" as const) : ("system" as const);
    return {
      actorType,
      actorId: actor?.actorId ?? "example-smoke",
      agentId: null,
    };
  }

  function sampleArguments(toolName: string): Record<string, unknown> {
    if (toolName === "get_value") return { key: "project" };
    if (toolName === "set_value") return { key: "project", value: "paperclip" };
    if (toolName === "create_item") return { title: "Smoke test item" };
    if (toolName === "mark_done" || toolName === "delete_item")
      return { id: "todo-1" };
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
    const auditResult = await policySvc.writeAudit(
      decisionInput,
      decision,
      "policy_decision",
    );
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
      if (!headerName)
        throw badRequest("Header names cannot be blank.", {
          code: "mcp_header_rejected",
        });
      // The API schema already rejected unsafe headers, but this is the last
      // point before a name becomes a real outbound request header — and the
      // normalized paste-config path lands here too — so re-check rather than
      // trust the caller.
      const nameCheck = checkMcpRemoteHeaderName(headerName);
      if (!nameCheck.ok) {
        throw badRequest(
          mcpRemoteHeaderRejectionMessage(headerName, nameCheck.reason!),
          {
            code: "mcp_header_rejected",
            headerName,
          },
        );
      }
      const valueCheck = checkMcpRemoteHeaderValue(
        credentialValues[configPath] ?? "",
      );
      if (!valueCheck.ok) {
        throw badRequest(
          mcpRemoteHeaderRejectionMessage(headerName, valueCheck.reason!),
          {
            code: "mcp_header_rejected",
            headerName,
          },
        );
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

  function nextAvailableConnectionName(
    requestedName: string,
    existingNames: readonly string[],
  ): string {
    const base = requestedName.trim() || "Custom app";
    const used = new Set(
      existingNames.map((candidate) => candidate.trim().toLocaleLowerCase()),
    );
    const unsuffixed = base.slice(0, 160);
    if (!used.has(unsuffixed.toLocaleLowerCase())) return unsuffixed;
    for (let index = 2; index < 10_000; index += 1) {
      const suffix = ` (${index})`;
      const candidate = `${base.slice(0, 160 - suffix.length).trimEnd()}${suffix}`;
      if (!used.has(candidate.toLocaleLowerCase())) return candidate;
    }
    return `${base.slice(0, 151).trimEnd()} (${randomUUID().slice(0, 6)})`;
  }

  async function connectGalleryApp(
    companyId: string,
    input: ConnectToolApp,
    actor?: ActorInfo,
  ): Promise<ConnectToolAppResult> {
    await actor?.managementContext?.reauthorize();
    const definition = input.galleryKey
      ? getConnectableAppDefinition(input.galleryKey)
      : null;
    if (input.galleryKey && !definition)
      throw notFound("Tool app gallery entry not found");

    const galleryEntry = definition ? await appForConnectionSetup(definition) : null;

    let existingApplication: typeof toolApplications.$inferSelect | null = null;
    let requestedResumeConnection: typeof toolConnections.$inferSelect | null =
      null;
    const requestedConnectionId =
      input.resumeConnectionId ?? input.reconnectConnectionId;
    if (requestedConnectionId) {
      const [connection] = await db
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.id, requestedConnectionId),
            eq(toolConnections.companyId, companyId),
          ),
        );
      if (!connection) throw notFound("Incomplete app connection not found");
      assertSupportedConnection(connection);
      if (input.resumeConnectionId && connection.status !== "draft") {
        throw conflict("Only an incomplete app connection can resume setup", {
          code: "connection_setup_not_incomplete",
        });
      }
      if (
        input.applicationId &&
        input.applicationId !== connection.applicationId
      ) {
        throw badRequest("The app and draft connection do not match");
      }
      const [application] = await db
        .select()
        .from(toolApplications)
        .where(
          and(
            eq(toolApplications.id, connection.applicationId),
            eq(toolApplications.companyId, companyId),
          ),
        );
      if (!application) throw notFound("App not found");
      const source =
        asRecord(connection.config).sourceTemplateKey ??
        asRecord(connection.transportConfig).sourceTemplateKey ??
        asRecord(application.metadata).sourceTemplateKey ??
        asRecord(application.metadata).source;
      if (
        input.reconnectConnectionId &&
        ((galleryEntry && source !== galleryEntry.slug) ||
          (!galleryEntry &&
            typeof source === "string" &&
            getConnectableAppDefinition(source)))
      ) {
        throw badRequest("Reconnect must preserve the configured provider");
      }
      requestedResumeConnection = connection;
      existingApplication = application;
    } else if (input.applicationId) {
      const [row] = await db
        .select()
        .from(toolApplications)
        .where(
          and(
            eq(toolApplications.id, input.applicationId),
            eq(toolApplications.companyId, companyId),
          ),
        );
      if (!row) throw notFound("App not found");
      existingApplication = row;
    } else {
      // Removal and interrupted setup intentionally retain their
      // application/connection rows. A fresh gallery click has no
      // applicationId, so recover that retained identity by its company-unique
      // name and source instead of inserting a duplicate application that the
      // unique index rejects. Active applications are excluded: connecting a
      // second account still requires its own name/application identity.
      const requestedName =
        input.name ?? galleryEntry?.name ?? defaultLinkName(input.link ?? "");
      const recoverableApplicationStatuses = galleryEntry
        ? (["draft", "archived"] as const)
        : (["archived"] as const);
      const [recoverableApplication] = await db
        .select()
        .from(toolApplications)
        .where(
          and(
            eq(toolApplications.companyId, companyId),
            eq(toolApplications.name, requestedName),
            inArray(toolApplications.status, recoverableApplicationStatuses),
          ),
        )
        .orderBy(desc(toolApplications.updatedAt))
        .limit(1);
      const recoverableSource = recoverableApplication?.metadata
        ? (recoverableApplication.metadata.sourceTemplateKey ??
          recoverableApplication.metadata.galleryKey ??
          recoverableApplication.metadata.source)
        : null;
      const requestedSource =
        galleryEntry?.slug ?? (input.link ? "link" : null);
      if (
        recoverableApplication &&
        requestedSource &&
        recoverableSource === requestedSource
      ) {
        existingApplication = recoverableApplication;
      }
    }

    await assertConnectorConnectionSetupEnabled(requestedResumeConnection ?? {}, existingApplication?.applicationKey);
    const requestedName =
      input.name ??
      existingApplication?.name ??
      galleryEntry?.name ??
      defaultLinkName(input.link ?? "");
    // Compatibility for the original Sheets robot flow, whose clients predate
    // method selection and identify the method by its spreadsheet allowlist.
    const inferredMethodKey =
      !input.connectionMethodKey &&
      galleryEntry?.slug === "google-sheets" &&
      Array.isArray(input.configValues?.allowedSpreadsheetIds)
        ? "local"
        : input.connectionMethodKey;
    if (!galleryEntry && input.connectionMethodKey)
      throw badRequest("Connection method selection requires a gallery app");
    if (
      galleryEntry &&
      getAvailableConnectionMethods(galleryEntry).filter(
        (candidate) =>
          candidate.purpose !== "channel" && candidate.purpose !== "ai"
          && candidate.transport !== "chat_sdk" && candidate.transport !== "runtime_auth",
      ).length > 1 &&
      !inferredMethodKey
    ) {
      throw badRequest("Choose a connection method for this app");
    }
    const method = galleryEntry
      ? connectionMethodFor(galleryEntry, inferredMethodKey)
      : null;
    const remoteMcpConnector = isRemoteMcpConnectorMethod(galleryEntry?.slug, method?.key);
    await assertExperimentalConnectorSetupEnabled(galleryEntry?.slug, Boolean(
      input.reconnectConnectionId && requestedResumeConnection?.status !== "draft"
      && requestedResumeConnection?.config.sourceTemplateKey === galleryEntry?.slug,
    ));
    if (galleryEntry && input.link) {
      const acceptsProviderGeneratedUrl =
        method?.transport === "mcp_remote" &&
        method.auth === "none" &&
        !method.defaults?.serverUrl &&
        !method.defaults?.serverUrlTemplate;
      if (!acceptsProviderGeneratedUrl && !remoteMcpConnector) {
        throw badRequest(
          `${galleryEntry.name} does not accept a provider-generated connection URL`,
        );
      }
      if (!(remoteMcpConnector && galleryEntry.slug === "executor") && !getAppDefinitionForUrl(input.link, [galleryEntry])) {
        throw badRequest(
          `That connection URL does not belong to ${galleryEntry.name}`,
        );
      }
    }
    if (requestedResumeConnection && galleryEntry) {
      const storedConnectionSource =
        requestedResumeConnection.config?.sourceTemplateKey ??
        requestedResumeConnection.transportConfig?.sourceTemplateKey;
      const storedApplicationSource =
        existingApplication?.metadata?.sourceTemplateKey ??
        existingApplication?.metadata?.galleryKey;
      if (
        storedConnectionSource !== galleryEntry.slug &&
        storedApplicationSource !== galleryEntry.slug
      ) {
        throw badRequest(
          "The selected provider does not match this incomplete connection",
        );
      }
    }
    // Reconnect is not a second identity decision. Removed connections retain
    // their row precisely so the next credential can be attached to the same
    // identity and history. Resolve that retained row before interpreting the
    // request so a client default cannot silently turn a personal connection
    // into an organization connection (or vice versa).
    const canResumeInterruptedDraft =
      Boolean(requestedResumeConnection) ||
      (!input.applicationId &&
        Boolean(galleryEntry) &&
        existingApplication?.status === "draft");
    const retainedConnectionStatuses = canResumeInterruptedDraft
      ? (["draft", "archived"] as const)
      : (["archived"] as const);
    const [recoveredConnection] =
      !requestedResumeConnection && existingApplication
        ? await db
            .select()
            .from(toolConnections)
            .where(
              and(
                eq(toolConnections.companyId, companyId),
                eq(toolConnections.applicationId, existingApplication.id),
                inArray(toolConnections.status, retainedConnectionStatuses),
              ),
            )
            .orderBy(desc(toolConnections.updatedAt))
            .limit(1)
        : [undefined];
    let retainedConnection = requestedResumeConnection ?? recoveredConnection;
    const transport = method?.transport ?? "mcp_remote";
    const applicationType = transport === "rest_api" ? "rest_api"
      : transport === "mcp_remote" ? "mcp_http"
        : transport === "local_stdio" ? "mcp_stdio" : null;
    if ((retainedConnection && retainedConnection.transport !== transport)
      || (existingApplication && applicationType && existingApplication.type !== applicationType)) {
      if (requestedResumeConnection || input.applicationId) {
        throw conflict("Create a separate app connection to change its connection method transport.", {
          code: "connection_transport_change_not_supported",
        });
      }
      // A new gallery connection may use another transport for the same app.
      // Do not revive an archived MCP identity as REST (or the reverse): the
      // application's type and any sibling connections belong to that identity.
      retainedConnection = undefined;
      existingApplication = null;
    }
    let applicationName = existingApplication?.name ?? requestedName;
    let name = retainedConnection?.name ?? requestedName;
    if (!existingApplication) {
      const applicationNames = await db
        .select({ name: toolApplications.name })
        .from(toolApplications)
        .where(eq(toolApplications.companyId, companyId));
      applicationName = nextAvailableConnectionName(
        requestedName,
        applicationNames.map((row) => row.name),
      );
      name = applicationName;
    } else if (!retainedConnection) {
      const connectionNames = await db
        .select({ name: toolConnections.name })
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, companyId),
            eq(toolConnections.applicationId, existingApplication.id),
          ),
        );
      name = nextAvailableConnectionName(
        requestedName,
        connectionNames.map((row) => row.name),
      );
    }
    const previousGrantKind: ConnectionGrantKind | null = retainedConnection
      ? retainedConnection.credentialPolicy === "per_user"
        ? "user"
        : retainedConnection.credentialPolicy === "per_agent"
          ? "agent"
          : "organization"
      : null;
    // An explicit resume/application reconnect continues the retained identity.
    // A fresh gallery connect may still reuse an archived row for stable history
    // and company-unique naming, but an explicit Access choice is a new identity
    // decision and must replace the archived policy. Without this distinction,
    // removing a dedicated-agent connection and reconnecting the default personal
    // account leaves `per_agent` behind and the OAuth callback cannot persist its
    // user grant.
    const retainsIdentity = Boolean(
      retainedConnection &&
      (retainedConnection.status === "draft" ||
        requestedResumeConnection ||
        input.applicationId),
    );
    const retainedGrantKind = retainsIdentity ? previousGrantKind : null;
    // The route can authorize an explicit resume before entering the service,
    // but name/source recovery happens here. Do not let a caller submit a
    // personal grant choice to pass the route and then inherit an implicitly
    // recovered organization identity. Local implicit mode is already the
    // unrestricted instance operator; every authenticated user must still hold
    // current connection-manager authority before this retained row is touched.
    if (
      previousGrantKind &&
      input.grantKind &&
      previousGrantKind !== input.grantKind &&
      Boolean(connectionActorUserId(actor)) &&
      actor?.actorSource !== "local_implicit"
    ) {
      const actorUserId = connectionActorUserId(actor);
      const [membership] = actorUserId
        ? await db
            .select({
              membershipRole: companyMemberships.membershipRole,
            })
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.companyId, companyId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalId, actorUserId),
                eq(companyMemberships.status, "active"),
              ),
            )
            .limit(1)
        : [];
      const roleCanManage =
        membership?.membershipRole === "owner" ||
        membership?.membershipRole === "admin";
      const [explicitManagerGrant] =
        roleCanManage || !actorUserId
          ? []
          : await db
              .select({
                id: principalPermissionGrants.id,
              })
              .from(principalPermissionGrants)
              .where(
                and(
                  eq(principalPermissionGrants.companyId, companyId),
                  eq(principalPermissionGrants.principalType, "user"),
                  eq(principalPermissionGrants.principalId, actorUserId),
                  eq(
                    principalPermissionGrants.permissionKey,
                    "tools:manage_connections",
                  ),
                ),
              )
              .limit(1);
      if (!roleCanManage && !explicitManagerGrant) {
        throw forbidden(
          "Only a company owner, admin, or member with connection-manager permission can change this connection's credential identity.",
        );
      }
    }
    const requestedGrantKind =
      retainedGrantKind ?? input.grantKind ?? (method?.grantKinds?.length === 1 ? method.grantKinds[0]! : "organization");
    if (method?.grantKinds && !method.grantKinds.includes(requestedGrantKind)) {
      throw badRequest(
        `${galleryEntry?.name ?? "This app"} supports only ${method.grantKinds.join(" or ")} credentials`,
      );
    }
    const dedicatedAgentId =
      requestedGrantKind === "agent" ? (input.subjectAgentId ?? null) : null;
    if (dedicatedAgentId) {
      const [subjectAgent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.id, dedicatedAgentId), eq(agents.companyId, companyId)),
        )
        .limit(1);
      if (!subjectAgent)
        throw badRequest(
          "Dedicated GitHub identity requires an agent in this company",
        );
    }
    const credentialSource: ToolConnectionCredentialSource =
      input.credentialSource ?? "paperclip_vault";
    if (
      retainedConnection &&
      retainedConnection.credentialSource !== credentialSource
    ) {
      throw conflict(
        "Changing credential source requires a new app connection",
        {
          code: "credential_source_migration_not_supported",
        },
      );
    }
    let externalCredential: VercelConnectCredentialReference | null = null;
    if (credentialSource === "vercel_connect") {
      const integration = vercelConnectIntegrationStatus();
      if (!integration.enabled || !integration.configured || !vercelConnect) {
        throw unprocessable(
          "Vercel Connect setup is not available on this Paperclip instance",
          {
            code: "vercel_connect_unavailable",
          },
        );
      }
      if (
        !galleryEntry ||
        !method ||
        method.transport !== "mcp_remote" ||
        method.auth === "none"
      ) {
        throw badRequest(
          "Vercel Connect is available only for reviewed remote MCP app methods",
        );
      }
      const reviewed = method.credentialSources?.vercelConnect;
      if (!reviewed) {
        throw unprocessable(
          `${galleryEntry.name} has not been reviewed for Vercel Connect`,
          {
            code: "vercel_connect_method_not_reviewed",
          },
        );
      }
      const expectedPrincipalMode = method.auth === "oauth" ? "user" : "app";
      if (!reviewed.principalModes.includes(expectedPrincipalMode)) {
        throw unprocessable(
          "This connector principal mode has not been reviewed for this app",
          {
            code: "vercel_connect_principal_not_reviewed",
          },
        );
      }
      if (
        expectedPrincipalMode === "app" &&
        requestedGrantKind !== "organization"
      ) {
        throw badRequest(
          "App-subject Vercel connectors can only back an organization identity",
        );
      }
      let metadata;
      try {
        metadata = await vercelConnect.getConnectorMetadata(
          input.vercelConnect!.connector,
        );
      } catch (error) {
        throw vercelConnectHttpError(error);
      }
      const service = metadata.service.trim().toLowerCase();
      if (
        !reviewed.services.map((value) => value.toLowerCase()).includes(service)
      ) {
        throw badRequest(
          `That Vercel connector is for ${metadata.service}, not ${galleryEntry.name}`,
          {
            code: "vercel_connect_service_mismatch",
          },
        );
      }
      if (expectedPrincipalMode === "app") {
        const [connectorInUse] = await db
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.credentialSource, "vercel_connect"),
              ne(toolConnections.status, "archived"),
              sql`${toolConnections.externalCredential}->>'connectorUid' = ${metadata.uid}`,
              ...(retainedConnection
                ? [ne(toolConnections.id, retainedConnection.id)]
                : []),
            ),
          )
          .limit(1);
        if (connectorInUse) {
          throw conflict(
            "App-subject Vercel connectors are dedicated to one Paperclip connection. Create or attach a separate connector in Vercel.",
            {
              code: "vercel_connect_app_connector_in_use",
            },
          );
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
    const isGoogleSheetsRobotMethod =
      galleryEntry?.slug === GOOGLE_SHEETS_GALLERY_KEY &&
      method?.key === "local";
    const normalizedMethodConfig =
      isGoogleSheetsRobotMethod || !method
        ? null
        : normalizeConnectionMethodConfig(method, input.configValues ?? asRecord(asRecord(retainedConnection?.config).methodConfig));
    const remoteUrlCredential =
      transport === "mcp_remote" && input.link
        ? splitRemoteUrlCredential(input.link)
        : null;
    const baseConfig =
      (transport === "mcp_remote" || transport === "rest_api")
        ? {
            url:
              (remoteMcpConnector ? remoteUrlCredential?.publicUrl : undefined) ??
              normalizedMethodConfig?.url ??
              method?.defaults?.serverUrl ??
              remoteUrlCredential?.publicUrl ??
              input.link ??
              "",
          }
        : { templateId: method?.defaults?.templateKey };
    let config: Record<string, unknown> = galleryEntry
      ? {
          ...baseConfig,
          sourceTemplateKey: galleryEntry.slug,
          connectionMethodKey: method?.key,
          methodConfig: normalizedMethodConfig?.values ?? {},
          ...(method?.defaults?.mcpSessionRequired === true
            ? { mcpSessionRequired: true }
            : {}),
          // Grant-backed setup keeps the full discovered catalog selectable;
          // the wizard projects the app's action defaults into policies at
          // finish time instead of using catalog quarantine as access state.
          quarantineNewEntries: connectorToolPolicy(galleryEntry.slug).quarantineNewEntries,
          ...(remoteMcpConnector ? {
            mcpSessionRequired: true,
            mcpAuthMode: input.authMode ?? "auto",
            mcpPreserveAccess: Boolean(retainedConnection && (retainedConnection.status === "active" || asRecord(retainedConnection.config).mcpPreserveAccess === true)),
          } : {}),
          ...(galleryEntry.slug === "posthog" ? { safeDefault: true } : {}),
          // Telem.AI attributes each search to the Paperclip company, agent,
          // run and issue, so its catalog connection forwards those context
          // headers by default (the gateway still drops empty values). A
          // reconnect keeps the policy the operator saved on the connection.
          ...(galleryEntry.slug === "telem"
            ? {
                headerPolicy: asRecord(retainedConnection?.config).headerPolicy ?? {
                  metadata: {
                    forward: ["company_id", "issue_id", "agent_id", "run_id", "project_id", "correlation_id"],
                  },
                },
              }
            : {}),
        }
      : { ...baseConfig, quarantineNewEntries: false, unverifiedServer: true };
    if (method && isPaperclipCloudConnectorStrategy(method.oauthStrategy)) {
      const connectorProfile = method.connectorProfile;
      const profile = managedConnectorProfile(connectorProfile);
      if (!profile)
        throw badRequest("This app has an invalid managed connector profile");
      config.oauth = {
        strategy: method.oauthStrategy,
        provider: profile.provider,
        connectorProfile: profile.id,
        resource: method.defaults?.serverUrl,
        scopes: [...profile.scopes],
      };
      config.quarantineNewEntries = true;
    }
    const acceptsCustomerOAuthClient =
      remoteMcpConnector || (method?.auth === "oauth" && method.ownershipModes.includes("customer"));
    if (galleryEntry && input.oauthClient && !acceptsCustomerOAuthClient) {
      throw badRequest(
        `${galleryEntry.name} does not accept customer-owned OAuth client credentials`,
      );
    }
    // A pasted URL or an explicitly customer-owned curated method may arrive
    // with a client the operator preregistered in the provider's console. Record
    // the client id now; the secret becomes an encrypted Paperclip secret below.
    if (input.oauthClient) {
      config.oauth = {
        clientId: input.oauthClient.clientId.trim(),
        clientRegistrationSource:
          "manual" satisfies OAuthClientRegistrationSource,
        clientCompanyId: companyId,
      };
    }
    if (isGoogleSheetsRobotMethod) {
      const availability = googleSheetsRobotEmailFromEnv();
      if (!availability.available) {
        throw unprocessable(availability.reason, {
          code: "google_sheets_unavailable",
        });
      }
      const allowedSpreadsheetIds = googleSheetsAllowedSpreadsheetIds(
        input.configValues,
      );
      if (allowedSpreadsheetIds.length === 0) {
        throw badRequest("Paste at least one Google Sheets link.");
      }
      config.allowedSpreadsheetIds = allowedSpreadsheetIds;
      config.robotEmail = availability.robotEmail;
      config.env = {
        [GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS_ENV]:
          allowedSpreadsheetIds.join(","),
      };
      config = normalizeGoogleSheetsConnectionConfig(config);
      await assertGoogleSheetsSpreadsheetOwnership(companyId, config);
    }
    if (transport === "mcp_remote")
      await assertRemoteConnectionEndpointsAllowed(config);
    if (transport === "local_stdio") await stdioTemplateId(companyId, config);
    assertLocalStdioCanBeEnabled(transport, false);

    const credentialValues = input.credentialValues ?? {};
    // A curated method declares its auth kind. A pasted URL declares one only
    // under Advanced authentication; on the simple path it starts from what the
    // operator supplied and is upgraded to `oauth` when discovery proves the
    // endpoint needs sign-in (see `remoteTools` and `startOAuth`).
    const genericAuthKind: ToolConnectionAuthKind =
      (remoteMcpConnector ? undefined : method?.auth) ??
      (input.authMode === "oauth" || input.oauthClient
        ? "oauth"
        : input.authMode === "bearer" || input.authMode === "custom_headers"
          ? "api_key"
          : input.authMode === "none"
            ? "none"
            : Object.keys(credentialValues).length > 0
              ? "api_key"
              : "none");
    const credentialSecretRefs: CreateToolConnection["credentialSecretRefs"] =
      [];
    const credentialRefs: McpConnectionCredentialRef[] = [];
    const createdSecretIds: string[] = [];
    const createdDefinitionIds: string[] = [];
    // Personal consent belongs to the authenticated responsible user. A delegated
    // agent is recorded separately and never becomes the account owner.
    const personalIdentityUserId = requestedGrantKind === "user" ? connectionActorUserId(actor) : null;
    if (requestedGrantKind === "user" && !personalIdentityUserId) {
      throw badRequest(
        "Connecting an app as yourself requires a signed-in user",
      );
    }
    const retainedPersonalIdentity =
      retainedConnection?.credentialPolicy === "per_user"
        ? await fixedPersonalIdentityForReconnect(
            retainedConnection,
            personalIdentityUserId ?? undefined,
            actor,
          )
        : null;
    const retainedConfig = asRecord(retainedConnection?.config);
    const retainedMethodKey = retainedConfig.connectionMethodKey;
    const retainedSource =
      retainedConfig.sourceTemplateKey ??
      asRecord(retainedConnection?.transportConfig).sourceTemplateKey;
    // Setup forms never receive stored secret values. Treat an omitted value as
    // "keep the existing secret" only while resuming the exact same curated
    // provider and method. This prevents a retry from detaching a client secret
    // or API key, without carrying credentials across a method/provider change.
    const canRetainCredentialMaterial = Boolean(
      retainedConnection &&
      previousGrantKind === requestedGrantKind &&
      galleryEntry &&
      retainedSource === galleryEntry.slug &&
      retainedMethodKey === method?.key &&
      (!remoteMcpConnector || (baseConfig.url === retainedConfig.url && genericAuthKind === retainedConnection.authKind)),
    );
    const retainedCredentialSecretRefs = canRetainCredentialMaterial
      ? (retainedPersonalIdentity?.grant?.credentialSecretRefs ??
        retainedConnection?.credentialSecretRefs ??
        [])
      : [];
    const credentialPolicy: ToolConnectionCredentialPolicy =
      requestedGrantKind === "user"
        ? "per_user"
        : requestedGrantKind === "agent"
          ? "per_agent"
          : "shared";
    const connectionOwnership = isPaperclipCloudConnectorStrategy(
      method?.oauthStrategy,
    )
      ? "platform_shared"
      : "customer";
    let applicationRow: typeof toolApplications.$inferSelect | null = null;
    let connectionRow: typeof toolConnections.$inferSelect | null = null;
    let revivedConnectionPrevious: typeof toolConnections.$inferSelect | null =
      retainedConnection ?? null;
    let revivedGrantMutation: {
      previous: typeof connectionGrants.$inferSelect | null;
      current: typeof connectionGrants.$inferSelect;
    } | null = null;
    let personalPublicSetupEstablished = false;

    try {
      const credentialFields =
        credentialSource === "vercel_connect"
          ? []
          : galleryEntry && !remoteMcpConnector
            ? credentialFieldsFor(galleryEntry, method?.key)
            : linkCredentialFields({ ...Object.fromEntries(retainedCredentialSecretRefs.filter((ref) => ref.configPath.startsWith("headers.") || ref.configPath === "credentials.authorization").map((ref) => [ref.configPath, "retained"])), ...credentialValues });
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
        const written = await db.transaction((tx) => writeConnectionCredential(tx, {
          companyId, connectionName: name, configPath: field.configPath,
          label: field.label, value, ownerUserId: personalIdentityUserId,
          actor: actorForSecret(actor),
        }));
        const { secret } = written;
        if (written.definitionId) createdDefinitionIds.push(written.definitionId);
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

      if (!remoteUrlCredential?.secretUrl && canRetainCredentialMaterial && baseConfig.url === retainedConfig.url) {
        const retainedUrl = retainedCredentialSecretRefs.find((ref) => ref.configPath === REMOTE_URL_SECRET_CONFIG_PATH);
        if (retainedUrl) {
          credentialSecretRefs.push(retainedUrl);
          credentialRefs.push({ name: REMOTE_URL_SECRET_CONFIG_PATH, secretId: retainedUrl.secretId, version: retainedUrl.versionSelector ?? "latest", placement: "url", key: "url", prefix: null });
        }
      }
      if (remoteUrlCredential?.secretUrl) {
        const written = await db.transaction((tx) => writeConnectionCredential(tx, {
          companyId, connectionName: name, configPath: REMOTE_URL_SECRET_CONFIG_PATH,
          label: "MCP server URL", value: remoteUrlCredential.secretUrl!,
          ownerUserId: personalIdentityUserId, actor: actorForSecret(actor),
        }));
        const { secret } = written;
        if (written.definitionId) createdDefinitionIds.push(written.definitionId);
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
        const secret = await secrets.create(
          companyId,
          {
            name: `${name} OAuth client secret ${randomUUID().slice(0, 8)}`,
            key: `tool_app.${randomUUID()}.oauth_client_secret`,
            provider: "local_encrypted",
            value: input.oauthClient.clientSecret,
            description: `OAuth client secret for ${name}.`,
          },
          actorForSecret(actor),
        );
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
        const clientIdUnchanged =
          retainedOAuth.clientId === input.oauthClient.clientId.trim();
        const retainedClientSecretRef = clientIdUnchanged
          ? retainedCredentialSecretRefs.find(
              (ref) => ref.configPath === "oauth.client_secret",
            )
          : undefined;
        if (retainedClientSecretRef)
          credentialSecretRefs.push(retainedClientSecretRef);
      }

      const safeApplicationDescription =
        galleryEntry?.description ??
        `Connected app at ${remoteUrlCredential?.publicUrl ?? input.link}`;
      if (existingApplication) {
        if (existingApplication.status !== "active") {
          [applicationRow] = await db
            .update(toolApplications)
            .set({
              status: "draft",
              archivedAt: null,
              ...(!galleryEntry
                ? { description: safeApplicationDescription }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(toolApplications.id, existingApplication.id))
            .returning();
        } else {
          applicationRow = existingApplication;
        }
      } else {
        // Name selection is optimistic because multiple setup requests can
        // legitimately begin at the same time. The company/name unique index
        // is the authority: if another request wins after our read, refresh the
        // names and retry with the next suffix instead of surfacing a conflict
        // the user never asked to resolve.
        for (let attempt = 0; attempt < 10 && !applicationRow; attempt += 1) {
          try {
            [applicationRow] = await db
              .insert(toolApplications)
              .values({
                companyId,
                applicationKey: `app-gallery:${galleryEntry?.slug ?? "link"}:${randomUUID()}`,
                name: applicationName,
                description: safeApplicationDescription,
                type: transport === "rest_api" && (["browser-use-cloud", ...NATIVE_PROVIDER_SLUGS].includes(galleryEntry?.slug ?? "") || Boolean(restConnectorFor({ transport, config }))) ? "rest_api" : transport === "mcp_remote" ? "mcp_http" : "mcp_stdio",
                status: "draft",
                metadata: galleryEntry
                  ? {
                      sourceTemplateKey: galleryEntry.slug,
                      galleryKey: galleryEntry.slug,
                    }
                  : { source: "link" },
              })
              .returning();
          } catch (error) {
            if (!isUniqueViolation(error, "tool_applications_company_name_uq"))
              throw error;
            const applicationNames = await db
              .select({ name: toolApplications.name })
              .from(toolApplications)
              .where(eq(toolApplications.companyId, companyId));
            applicationName = nextAvailableConnectionName(
              requestedName,
              applicationNames.map((row) => row.name),
            );
            name = applicationName;
          }
        }
        if (!applicationRow) {
          throw conflict(
            "Paperclip could not allocate a unique connection name",
            {
              code: "tool_access_name_allocation_exhausted",
            },
          );
        }
      }

      await assertSecretRefs(companyId, [
        ...credentialRefs,
        ...credentialSecretRefs,
      ]);
      // Reconnecting an app revives its most recent archived connection instead
      // of inserting a fresh row: keeps the connection id (and its activity
      // history) stable and avoids the unique (company, name) constraint.
      // A personal credential never becomes the connection's shared secret: the
      // row carries the header shape only, and the secret refs go to the user
      // grant below. `ensureDefaultOrganizationGrant` copies this list, so
      // leaving it empty is what keeps the secret off an organization grant.
      const connectionCredentialSecretRefs =
        personalIdentityUserId || dedicatedAgentId ? [] : credentialSecretRefs;
      if (revivedConnectionPrevious) {
        forgetMcpHttpSessions(revivedConnectionPrevious.id);
        [connectionRow] = await db
          .update(toolConnections)
          .set({
            name,
            authKind: genericAuthKind,
            transport,
            status: "draft",
            enabled: false,
            agentInstructions: input.agentInstructions !== undefined
              ? input.agentInstructions
              : retainedConnection ? retainedConnection.agentInstructions
              : defaultConnectionAgentInstructions(galleryEntry?.agentInstructions),
            config,
            transportConfig: config,
            credentialRefs,
            credentialSecretRefs: connectionCredentialSecretRefs,
            credentialSource,
            externalCredential,
            credentialPolicy,
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, revivedConnectionPrevious.id))
          .returning();
      } else {
        const connectionId = randomUUID();
        [connectionRow] = await db
          .insert(toolConnections)
          .values({
            id: connectionId,
            companyId,
            applicationId: applicationRow.id,
            name,
            uid: connectionUid(
              applicationRow.applicationKey ?? applicationRow.name,
              name,
              connectionId,
            ),
            connectionKind: "managed",
            ownership: connectionOwnership,
            authKind: genericAuthKind,
            credentialSource,
            externalCredential,
            transport,
            status: "draft",
            enabled: false,
            agentInstructions: input.agentInstructions !== undefined
              ? input.agentInstructions
              : retainedConnection ? retainedConnection.agentInstructions
              : defaultConnectionAgentInstructions(galleryEntry?.agentInstructions),
            config,
            transportConfig: config,
            credentialRefs,
            credentialSecretRefs: connectionCredentialSecretRefs,
            credentialPolicy,
            createdByAgentId:
              actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
            createdByUserId:
              connectionActorUserId(actor),
          })
          .returning();
      }
      if (revivedConnectionPrevious) {
        emitConnectionUpdated(
          connectionRow,
          revivedConnectionPrevious,
          "gallery",
        );
      } else {
        emitConnectionCreated(connectionRow, "gallery");
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
          let changedGrant: typeof connectionGrants.$inferSelect;
          let previousGrant: typeof connectionGrants.$inferSelect | null = null;
          if (retainedPersonalIdentity?.grant) {
            const [grantSnapshot] = await db
              .select({
                grant: connectionGrants,
                // Preserve PostgreSQL microseconds for the optimistic update;
                // a JavaScript Date truncates them and falsely reports a race.
                updatedAtVersion: sql<string>`${connectionGrants.updatedAt}::text`,
              })
              .from(connectionGrants)
              .where(eq(connectionGrants.id, retainedPersonalIdentity.grant.id))
              .limit(1);
            const currentGrant = grantSnapshot?.grant;
            if (!currentGrant)
              throw conflict(
                "The personal credential changed during setup. Please try again.",
              );
            previousGrant = currentGrant;
            [changedGrant] = await db
              .update(connectionGrants)
              .set({
                credentialSecretRefs,
                status: "active",
                revokedAt: null,
                revokedByAgentId: null,
                revokedByUserId: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(connectionGrants.id, currentGrant.id),
                  sql`${connectionGrants.updatedAt} = ${grantSnapshot!.updatedAtVersion}::timestamptz`,
                ),
              )
              .returning();
            if (!changedGrant)
              throw conflict(
                "The personal credential changed during setup. Please try again.",
              );
          } else {
            [changedGrant] = await db
              .insert(connectionGrants)
              .values({
                companyId,
                connectionId: connectionRow.id,
                kind: "user",
                subjectUserId: personalIdentityUserId,
                credentialSecretRefs,
                status: "active",
                isDefault: false,
                createdByUserId: personalIdentityUserId,
              })
              .returning();
            if (!changedGrant)
              throw new Error("Failed to create personal connection grant");
          }
          if (revivedConnectionPrevious) {
            revivedGrantMutation = {
              previous: previousGrant,
              current: changedGrant,
            };
          }
          await db.insert(toolAccessAuditEvents).values({
            companyId,
            connectionId: connectionRow.id,
            actorType: "user",
            actorId: personalIdentityUserId,
            action: retainedPersonalIdentity?.grant
              ? "connection_grant.updated"
              : "connection_grant.created",
            outcome: "success",
            reasonCode: retainedPersonalIdentity?.grant
              ? "personal_identity_reconnected"
              : "personal_identity_created",
            details: {
              kind: "user",
              credentialSecretRefCount: credentialSecretRefs.length,
            },
          });
        }
      } else if (dedicatedAgentId) {
        // Managed OAuth creates the credential-bearing grant in the callback.
        // Keep the connection free of organization secrets from the outset.
      } else {
        const organizationGrant = await ensureDefaultOrganizationGrant(
          connectionRow,
          db,
          revivedConnectionPrevious
            ? (mutation) => {
                revivedGrantMutation = mutation;
              }
            : undefined,
        );
        if (credentialSource === "vercel_connect") {
          const derived = deriveVercelConnectSubject({
            credential: externalCredential!,
            connectionId: connectionRow.id,
            companyId,
            grantKind: "organization",
          });
          const updatedOrganizationGrant = await db.transaction(async (tx) => {
            const [lockedGrant] = await tx
              .select()
              .from(connectionGrants)
              .where(eq(connectionGrants.id, organizationGrant.id))
              .limit(1)
              .for("update");
            if (
              !lockedGrant ||
              lockedGrant.updatedAt.getTime() !==
                organizationGrant.updatedAt.getTime()
            ) {
              throw conflict(
                "The organization credential changed during setup. Please try again.",
              );
            }
            const [updated] = await tx
              .update(connectionGrants)
              .set({
                externalCredential: {
                  provider: "vercel_connect",
                  subjectType: externalCredential!.principalMode,
                  ...(derived.subjectId
                    ? { subjectId: derived.subjectId }
                    : {}),
                },
                credentialSecretRefs: [],
                updatedAt: now(),
              })
              .where(eq(connectionGrants.id, organizationGrant.id))
              .returning();
            return updated;
          });
          if (!updatedOrganizationGrant) {
            throw conflict(
              "The organization credential changed during setup. Please try again.",
            );
          }
          if (revivedGrantMutation) {
            revivedGrantMutation = {
              previous: revivedGrantMutation.previous,
              current: updatedOrganizationGrant,
            };
          }
        }
      }
      await syncCredentialBindings(
        connectionRow,
        personalIdentityUserId || dedicatedAgentId ? credentialSecretRefs : [],
      );
      await ensureRuntimeSlot(connectionRow);

      if (input.saveDraft && remoteMcpConnector) {
        return { connectionId: connectionRow.id, application: toApplication(applicationRow), connection: toConnection(connectionRow),
          catalog: [], actions: { readOnly: [], canMakeChanges: [] }, suggestedDefaults: { access: "all_agents", askFirstRiskLevels: [] } };
      }
      if (galleryEntry && method?.auth === "oauth") {
        const suggestedDefaults = recommendedDefaultsForApp(
          galleryEntry,
          method.key,
        );
        return {
          connectionId: connectionRow.id,
          application: toApplication(applicationRow),
          connection: toConnection(connectionRow),
          catalog: [],
          actions: { readOnly: [], canMakeChanges: [] },
          suggestedDefaults: dedicatedAgentId
            ? { ...suggestedDefaults, access: { agentIds: [dedicatedAgentId] } }
            : suggestedDefaults,
          auth: { kind: "oauth", startUrl: null },
        };
      }

      // A pasted MCP URL starts with unknown auth. For a personal connection,
      // there is deliberately no empty active grant yet, so probe this one
      // creator-owned draft without credentials. A 401 can then discover OAuth
      // and leave grant creation to the callback; a public endpoint gets an
      // empty personal grant below so later catalog refreshes use the same
      // identity policy.
      const unauthenticatedPersonalProbe = Boolean(
        (!galleryEntry || remoteMcpConnector) &&
          genericAuthKind === "none" &&
          credentialSecretRefs.length === 0 &&
          personalIdentityUserId &&
          !retainedPersonalIdentity?.grant,
      );
      let health: ToolConnectionHealthCheckResult;
      try {
        health = await checkConnectionHealth(connectionRow.id, actor, {
          allowUnauthenticatedProbe: unauthenticatedPersonalProbe,
        });
      } catch (error) {
        if (
          (!galleryEntry || remoteMcpConnector) &&
          input.authMode !== "none" &&
          input.authMode !== "bearer" &&
          input.authMode !== "custom_headers" &&
          error instanceof HttpError &&
          asRecord(error.details).code === "oauth_challenge"
        ) {
          const [oauthConnection] = await db
            .select()
            .from(toolConnections)
            .where(eq(toolConnections.id, connectionRow.id));
          const endpoints = await discoverOAuthEndpoints(oauthConnection).catch(
            (discoveryError: unknown) => {
              // "This server advertised an address Paperclip refuses to open" is a
              // refusal, not a failed discovery: keep it instead of collapsing it
              // into the generic sign-in-required error.
              if (isOAuthEndpointRejection(discoveryError))
                throw discoveryError;
              return null;
            },
          );
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
      if (unauthenticatedPersonalProbe) {
        const personalConnectionId = connectionRow.id;
        const grant = await db.transaction(async (tx) => {
          const [createdGrant] = await tx
            .insert(connectionGrants)
            .values({
              companyId,
              connectionId: personalConnectionId,
              kind: "user",
              subjectUserId: personalIdentityUserId!,
              credentialSecretRefs: [],
              status: "active",
              isDefault: false,
              createdByUserId: personalIdentityUserId!,
            })
            .onConflictDoNothing()
            .returning();
          if (createdGrant) {
            await tx.insert(toolAccessAuditEvents).values({
              companyId,
              connectionId: personalConnectionId,
              actorType: "user",
              actorId: personalIdentityUserId!,
              action: "connection_grant.created",
              outcome: "success",
              reasonCode: "personal_identity_created",
              details: { kind: "user", credentialSecretRefCount: 0 },
            });
          }
          return createdGrant;
        });
        if (!grant) {
          // Another setup attempt may have created this user's grant while
          // both probes were in flight. Reuse only an active personal grant;
          // never overwrite credentials, revive a revoked grant, or claim its
          // audit/rollback ownership in this attempt.
          const existingGrant = await vaultGrantForConnection(connectionRow, actor);
          if (existingGrant?.kind !== "user" || existingGrant.subjectUserId !== personalIdentityUserId) {
            throw conflict("The personal credential changed during setup. Please try again.");
          }
        }
        // A successful public probe establishes this identity, like OAuth
        // consent does. Keep its draft and grant if catalog/default discovery
        // later fails: another retry may already be using the committed grant.
        personalPublicSetupEstablished = true;
      }
      const restoreDraftDefaults = Boolean(revivedConnectionPrevious);
      const refreshOptions = {
        enableAllByDefault: restoreDraftDefaults && !remoteMcpConnector,
        restoreDraftDefaults,
      };
      const catalogConnectionId = connectionRow.id;
      // Keep the established public identity outside this transaction while
      // making catalog, defaults, and their audits one all-or-nothing step.
      const refresh: ToolCatalogRefreshResult = personalPublicSetupEstablished
        ? await db.transaction(async (tx): Promise<ToolCatalogRefreshResult> =>
            toolAccessService(tx as unknown as Db, options).refreshCatalog(
              catalogConnectionId,
              actor,
              refreshOptions,
            ),
          )
        : await refreshCatalog(catalogConnectionId, actor, refreshOptions);
      const [application] = await db
        .select()
        .from(toolApplications)
        .where(eq(toolApplications.id, applicationRow.id));
      return {
        connectionId: refresh.connection.id,
        application: toApplication(application),
        connection: refresh.connection,
        catalog: refresh.catalog,
        actions: groupedActions(refresh.catalog),
        suggestedDefaults: galleryEntry
          ? recommendedDefaultsForApp(galleryEntry, method?.key)
          : {
              access: "all_agents",
              askFirstRiskLevels: [],
            },
      };
    } catch (error) {
      if (personalPublicSetupEstablished) throw error;
      let identityRollbackError: unknown = null;
      let preserveConcurrentRevival = false;
      if (connectionRow && revivedConnectionPrevious) {
        const attemptedConnection = connectionRow;
        try {
          await db.transaction(async (tx) => {
            if (revivedGrantMutation) await tx.select({ id: connectionGrants.id }).from(connectionGrants)
              .where(and(eq(connectionGrants.id, revivedGrantMutation.current.id), eq(connectionGrants.companyId, companyId)))
              .for("update");
            const [latestConnection] = await tx
              .select()
              .from(toolConnections)
              .where(
                and(
                  eq(toolConnections.id, revivedConnectionPrevious.id),
                  eq(toolConnections.companyId, companyId),
                ),
              )
              .limit(1)
              .for("update");
            // Health/catalog failures from this setup may update only health
            // fields and `updatedAt`, so compare the identity/configuration
            // fields this attempt owned. If another request changed any of
            // those fields, its newer connection state is authoritative.
            const connectionMutationIsStillCurrent = Boolean(
              latestConnection &&
              connectionSetupMutationFingerprint(latestConnection) ===
                connectionSetupMutationFingerprint(attemptedConnection),
            );
            if (connectionMutationIsStillCurrent) {
              await tx
                .update(toolConnections)
                .set({
                  agentInstructions: revivedConnectionPrevious.agentInstructions,
                  name: revivedConnectionPrevious.name,
                  transport: revivedConnectionPrevious.transport,
                  status: revivedConnectionPrevious.status,
                  enabled: revivedConnectionPrevious.enabled,
                  config: revivedConnectionPrevious.config,
                  transportConfig: revivedConnectionPrevious.transportConfig,
                  credentialRefs: revivedConnectionPrevious.credentialRefs,
                  credentialSecretRefs:
                    revivedConnectionPrevious.credentialSecretRefs,
                  credentialSource: revivedConnectionPrevious.credentialSource,
                  externalCredential:
                    revivedConnectionPrevious.externalCredential,
                  credentialPolicy: revivedConnectionPrevious.credentialPolicy,
                  updatedAt: new Date(),
                })
                .where(eq(toolConnections.id, revivedConnectionPrevious.id));
            } else {
              preserveConcurrentRevival = true;
            }

            if (connectionMutationIsStillCurrent && revivedGrantMutation) {
              const { previous, current } = revivedGrantMutation;
              const [latestGrant] = await tx
                .select()
                .from(connectionGrants)
                .where(eq(connectionGrants.id, current.id))
                .limit(1)
                .for("update");
              const mutationIsStillCurrent = Boolean(
                latestGrant &&
                latestGrant.updatedAt.getTime() === current.updatedAt.getTime(),
              );
              // A grant manager may have changed this grant while provider
              // setup was in flight. Restore/delete only the exact version this
              // attempt wrote; a newer version is authoritative and remains
              // untouched.
              if (previous && mutationIsStillCurrent) {
                await tx
                  .update(connectionGrants)
                  .set({
                    kind: previous.kind,
                    subjectUserId: previous.subjectUserId,
                    subjectAgentId: previous.subjectAgentId,
                    providerTenant: previous.providerTenant,
                    credentialSecretRefs: previous.credentialSecretRefs,
                    externalCredential: previous.externalCredential,
                    status: previous.status,
                    isDefault: previous.isDefault,
                    createdByAgentId: previous.createdByAgentId,
                    createdByUserId: previous.createdByUserId,
                    revokedAt: previous.revokedAt,
                    revokedByAgentId: previous.revokedByAgentId,
                    revokedByUserId: previous.revokedByUserId,
                    lastUsedAt: previous.lastUsedAt,
                    updatedAt: previous.updatedAt,
                  })
                  .where(eq(connectionGrants.id, current.id));
              } else if (!previous && mutationIsStillCurrent) {
                await tx
                  .delete(connectionGrants)
                  .where(eq(connectionGrants.id, current.id));
              }
            }
          });
        } catch (rollbackError) {
          identityRollbackError = rollbackError;
          // The attempted identity and its grants may no longer agree. Keep the
          // connection unusable until a manager explicitly reconnects it, and
          // surface the restoration failure instead of returning only the
          // original provider error.
          try {
            await db
              .update(toolConnections)
              .set({
                status: "draft",
                enabled: false,
                healthStatus: "error",
                healthMessage:
                  "Connection identity restoration failed. Reconnect this app to continue.",
                lastError: "connection_identity_rollback_failed",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(toolConnections.id, revivedConnectionPrevious.id),
                  eq(toolConnections.companyId, companyId),
                ),
              );
          } catch (quarantineError) {
            identityRollbackError = new AggregateError(
              [rollbackError, quarantineError],
              "Connection identity rollback and quarantine both failed",
            );
          }
        }
      } else if (connectionRow) {
        await db
          .delete(toolConnections)
          .where(eq(toolConnections.id, connectionRow.id))
          .catch(() => undefined);
      }
      if (
        !preserveConcurrentRevival &&
        applicationRow &&
        !existingApplication
      ) {
        await db
          .delete(toolApplications)
          .where(eq(toolApplications.id, applicationRow.id))
          .catch(() => undefined);
      } else if (
        !preserveConcurrentRevival &&
        existingApplication &&
        applicationRow &&
        applicationRow.status !== existingApplication.status
      ) {
        await db
          .update(toolApplications)
          .set({
            status: existingApplication.status,
            archivedAt: existingApplication.archivedAt,
            updatedAt: new Date(),
          })
          .where(eq(toolApplications.id, existingApplication.id))
          .catch(() => undefined);
      }
      if (!preserveConcurrentRevival) {
        for (const secretId of createdSecretIds) {
          await secrets.remove(secretId).catch(() => undefined);
        }
        for (const definitionId of createdDefinitionIds) {
          await db.delete(userSecretDefinitions).where(eq(userSecretDefinitions.id, definitionId)).catch(() => undefined);
        }
      }
      if (identityRollbackError) {
        throw new HttpError(
          500,
          "Connection setup failed and its prior identity could not be restored.",
          {
            code: "connection_identity_rollback_failed",
          },
        );
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
      .where(
        and(
          eq(toolCatalogEntries.companyId, companyId),
          eq(toolCatalogEntries.connectionId, connectionId),
          inArray(toolCatalogEntries.id, uniqueIds),
        ),
      );
    if (rows.length !== uniqueIds.length) {
      throw unprocessable(
        "All selected catalog entries must belong to this app connection",
      );
    }
    return rows;
  }

  async function assertAgentsInCompany(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return;
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          inArray(agents.id, [...new Set(agentIds)]),
        ),
      );
    if (rows.length !== new Set(agentIds).size) {
      throw unprocessable(
        "All app access agent ids must belong to the same company",
      );
    }
  }

  async function finishGalleryAppConnection(
    companyId: string,
    connectionId: string,
    input: FinishToolApp,
    actor?: ActorInfo,
  ): Promise<FinishToolAppResult> {
    await actor?.managementContext?.reauthorize();
    const connection = await getConnectionRow(connectionId, companyId);
    await assertConnectorConnectionSetupEnabled(connection);
    if (connection.status === "archived")
      throw conflict("Archived app connections cannot be finished");
    if (connection.config.mcpPreserveAccess === true && isRemoteMcpConnectorMethod(connection.config.sourceTemplateKey, connection.config.connectionMethodKey)) {
      const [profile] = await db.select().from(toolProfiles).where(and(
        eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${connection.id}`),
      )).limit(1);
      if (!profile) throw conflict("The saved connection permissions could not be found");
      const config = { ...connection.config };
      delete config.mcpPreserveAccess;
      const updated = await db.transaction(async (tx) => {
        await tx.select({ id: toolApplications.id }).from(toolApplications)
          .where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, companyId)))
          .for("update");
        const [row] = await tx.update(toolConnections).set({ config, transportConfig: config, status: "active", enabled: true, ...(input.agentInstructions !== undefined ? { agentInstructions: input.agentInstructions } : {}), updatedAt: new Date() })
          .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, companyId))).returning();
        await tx.update(toolApplications).set({ status: "active", updatedAt: new Date() }).where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, companyId)));
        return row;
      });
      const details = await profileDetails(profile.id, companyId);
      const policies = (await db.select().from(toolPolicies).where(eq(toolPolicies.companyId, companyId))).filter((policy) => asRecord(policy.config).connectionId === connection.id);
      return { connection: toConnection(updated), profile: toProfile(profile), profileEntries: details.entries, profileBindings: details.bindings, policies: policies.map(toPolicy) };
    }
    const enabledIds = [
      ...new Set([
        ...input.enabledCatalogEntryIds,
        ...input.askFirstCatalogEntryIds,
      ]),
    ];
    const requestedReviewedIds = input.reviewedCatalogEntryIds ?? [];
    const reviewedIds = [...new Set(requestedReviewedIds)];
    if (reviewedIds.length !== requestedReviewedIds.length) {
      throw badRequest(
        "Action review decisions must not contain duplicate catalogEntryId values",
      );
    }
    const enabledRows = await assertCatalogEntriesForConnection(
      companyId,
      connection.id,
      enabledIds,
    );
    const askFirstRows = await assertCatalogEntriesForConnection(
      companyId,
      connection.id,
      input.askFirstCatalogEntryIds,
    );
    if (enabledRows.some((entry) => entry.status === "disabled" && !(entry.quarantineReason === "mcp_tool_removed" && isRemoteMcpConnectorMethod(connection.config.sourceTemplateKey, connection.config.connectionMethodKey)))) {
      throw badRequest("Disabled actions cannot be enabled");
    }
    if (reviewedIds.length > 0) {
      await assertCatalogEntriesForConnection(
        companyId,
        connection.id,
        reviewedIds,
      );
      const quarantinedRows = await db
        .select({ id: toolCatalogEntries.id })
        .from(toolCatalogEntries)
        .where(
          and(
            eq(toolCatalogEntries.companyId, companyId),
            eq(toolCatalogEntries.connectionId, connection.id),
            eq(toolCatalogEntries.status, "quarantined"),
          ),
        );
      const reviewedIdSet = new Set(reviewedIds);
      if (
        quarantinedRows.length !== reviewedIdSet.size ||
        quarantinedRows.some((entry) => !reviewedIdSet.has(entry.id))
      ) {
        throw badRequest(
          "Action review decisions must cover every currently quarantined action exactly once",
        );
      }
    }
    if (input.access !== "all_agents")
      await assertAgentsInCompany(companyId, input.access.agentIds);

    const entries: CreateToolProfileEntryForProfile[] = enabledRows.map(
      (entry) => ({
        selectorType: "catalog_entry",
        effect: "include",
        catalogEntryId: entry.id,
        connectionId: connection.id,
        applicationId: connection.applicationId,
      }),
    );
    const profileKey = `app:${connection.id}`;
    const bindingInputs: CreateToolProfileBindingForProfile[] =
      input.access === "all_agents"
        ? [
            {
              targetType: "company",
              targetId: companyId,
              priority: 100,
              metadata: { source: "app_gallery_finish" },
            },
          ]
        : [...new Set(input.access.agentIds)].map((agentId) => ({
            targetType: "agent" as const,
            targetId: agentId,
            priority: 100,
            metadata: { source: "app_gallery_finish" },
          }));
    await actor?.managementContext?.reauthorize();
    const transactionResult = await db.transaction(async (tx) => {
      await tx.select({ id: toolApplications.id }).from(toolApplications)
        .where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, companyId)))
        .for("update");
      const [lockedConnection] = await tx
        .select({ id: toolConnections.id, status: toolConnections.status, enabled: toolConnections.enabled })
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.id, connectionId),
            eq(toolConnections.companyId, companyId),
          ),
        )
        .for("update");
      if (!lockedConnection) throw notFound("Tool connection not found");
      const [existingProfile] = await tx
        .select()
        .from(toolProfiles)
        .where(
          and(
            eq(toolProfiles.companyId, companyId),
            eq(toolProfiles.profileKey, profileKey),
          ),
        )
        .limit(1).for("no key update");
      await lockManagedAppPolicies(tx, companyId, connection.id);
      const existingBindings = existingProfile ? await tx.select().from(toolProfileBindings)
        .where(and(eq(toolProfileBindings.companyId, companyId), eq(toolProfileBindings.profileId, existingProfile.id))) : [];
      const existingInstalls = await tx.select().from(toolConnectionInstalls)
        .where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.connectionId, connection.id)));
      const companyTargets = lockedConnection.status !== "active" || !lockedConnection.enabled || (existingProfile && existingProfile.status !== "active")
        ? [{ targetType: "company", targetId: companyId }] : [];
      await lockToolAssignmentAgents(tx, companyId, [...existingBindings, ...bindingInputs, ...existingInstalls, ...companyTargets]);
      // A renamed connection can leave its old profile name in use. Resolve
      // names against profiles too, including when finalizing an installed draft.
      const otherProfiles = await tx
        .select({ name: toolProfiles.name })
        .from(toolProfiles)
        .where(and(
          eq(toolProfiles.companyId, companyId),
          ne(toolProfiles.profileKey, profileKey),
        ));
      const profileName = nextAvailableConnectionName(
        connection.name,
        otherProfiles.map((profile) => profile.name),
      );
      let profileId: string;
      if (existingProfile) {
        if (input.preserveExistingAccess) {
          for (const prior of existingBindings)
            if (
              !bindingInputs.some(
                (binding) =>
                  binding.targetType === prior.targetType &&
                  binding.targetId === prior.targetId,
              )
            )
              bindingInputs.push({
                targetType: prior.targetType,
                targetId: prior.targetId,
                priority: prior.priority,
                metadata: prior.metadata,
              });
          const priorEntries = await tx
            .select()
            .from(toolProfileEntries)
            .where(eq(toolProfileEntries.profileId, existingProfile.id));
          for (const prior of priorEntries)
            if (
              !entries.some(
                (entry) =>
                  entry.catalogEntryId &&
                  entry.catalogEntryId === prior.catalogEntryId,
              )
            )
              entries.push({
                selectorType: prior.selectorType,
                effect: prior.effect,
                applicationId: prior.applicationId,
                connectionId: prior.connectionId,
                catalogEntryId: prior.catalogEntryId,
                toolName: prior.toolName,
                riskLevel: prior.riskLevel,
                conditions: prior.conditions,
              });
        }
        await tx
          .delete(toolProfileBindings)
          .where(
            and(
              eq(toolProfileBindings.companyId, companyId),
              eq(toolProfileBindings.profileId, existingProfile.id),
            ),
          );
        await tx
          .delete(toolProfileEntries)
          .where(
            and(
              eq(toolProfileEntries.companyId, companyId),
              eq(toolProfileEntries.profileId, existingProfile.id),
            ),
          );
        if (entries.length > 0) {
          await tx.insert(toolProfileEntries).values(
            entries.map((entry) => ({
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
            })),
          );
        }
        const [updated] = await tx
          .update(toolProfiles)
          .set({
            name: profileName,
            description: `Access profile for ${connection.name}.`,
            status: "active",
            defaultAction: "deny",
            metadata: {
              source: "app_gallery_finish",
              connectionId: connection.id,
            },
            updatedAt: new Date(),
          })
          .where(eq(toolProfiles.id, existingProfile.id))
          .returning();
        profileId = updated.id;
      } else {
        const [created] = await tx
          .insert(toolProfiles)
          .values({
            companyId,
            profileKey,
            name: profileName,
            description: `Access profile for ${connection.name}.`,
            status: "active",
            defaultAction: "deny",
            metadata: {
              source: "app_gallery_finish",
              connectionId: connection.id,
            },
          })
          .returning();
        if (entries.length > 0) {
          await tx.insert(toolProfileEntries).values(
            entries.map((entry) => ({
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
            })),
          );
        }
        profileId = created.id;
      }

      const profileBindings: ToolProfileBinding[] = [];
      // These connectors expose one agent-access choice. Commit installation
      // reach and permission bindings together, including an empty selection.
      if (isRemoteMcpConnectorMethod(connection.config.sourceTemplateKey, connection.config.connectionMethodKey)) {
        const desired = new Map(bindingInputs.flatMap((binding) => binding.targetType === "company" || binding.targetType === "agent"
          ? [[`${binding.targetType}:${binding.targetId}`, { targetType: binding.targetType, targetId: binding.targetId }] as const] : []));
        const removed = existingInstalls.filter((install) => !desired.has(`${install.targetType}:${install.targetId}`));
        const added = [...desired.values()].filter((binding) => !existingInstalls.some((install) => install.targetType === binding.targetType && install.targetId === binding.targetId));
        if (removed.length) await tx.delete(toolConnectionInstalls).where(inArray(toolConnectionInstalls.id, removed.map((install) => install.id)));
        if (added.length) await tx.insert(toolConnectionInstalls).values(added.map((binding) => ({
          companyId, connectionId: connection.id, targetType: binding.targetType, targetId: binding.targetId,
          createdByAgentId: actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
          createdByUserId: connectionActorUserId(actor),
        })));
        if (added.length || removed.length) await tx.insert(toolAccessAuditEvents).values({
          companyId, connectionId: connection.id, actorType: actor?.actorType ?? "system", actorId: actor?.actorId ?? null,
          action: "connection_installs.changed", outcome: "success", reasonCode: "installs_changed",
          details: { added: added.map(({ targetType, targetId }) => ({ targetType, targetId })), removed: removed.map(({ targetType, targetId }) => ({ targetType, targetId })) },
        });
      }
      for (const bindingInput of bindingInputs) {
        const [binding] = await tx
          .insert(toolProfileBindings)
          .values({
            companyId,
            profileId,
            targetType: bindingInput.targetType,
            targetId: bindingInput.targetId,
            priority: bindingInput.priority ?? 100,
            metadata: bindingInput.metadata ?? {},
            createdByAgentId:
              actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
            createdByUserId:
              connectionActorUserId(actor),
          })
          .returning();
        profileBindings.push(toProfileBinding(binding));
      }

      const reviewedAt = new Date();
      if (reviewedIds.length > 0) {
        await tx
          .update(toolCatalogEntries)
          .set({
            status: "active",
            reviewedAt,
            reviewedByAgentId:
              actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
            reviewedByUserId:
              connectionActorUserId(actor),
            quarantinedAt: null,
            quarantineReason: null,
            updatedAt: reviewedAt,
          })
          .where(
            and(
              eq(toolCatalogEntries.companyId, companyId),
              eq(toolCatalogEntries.connectionId, connection.id),
              inArray(toolCatalogEntries.id, reviewedIds),
              eq(toolCatalogEntries.status, "quarantined"),
            ),
          );
      }
      if (enabledIds.length > 0) {
        await tx
          .update(toolCatalogEntries)
          .set({
            status: "active",
            reviewedAt,
            reviewedByAgentId:
              actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
            reviewedByUserId:
              connectionActorUserId(actor),
            quarantinedAt: null,
            quarantineReason: null,
            updatedAt: reviewedAt,
          })
          .where(
            and(
              eq(toolCatalogEntries.companyId, companyId),
              inArray(toolCatalogEntries.id, enabledIds),
              ne(toolCatalogEntries.status, "quarantined"),
              ne(toolCatalogEntries.status, "disabled"),
            ),
          );
      }

      const policies = await upsertAskFirstPolicies(
        {
          companyId,
          connection,
          askFirstEntries: askFirstRows,
          disableStale: !input.preserveExistingAccess,
          actor,
        },
        tx,
      );
      const [updatedConnection] = await tx
        .update(toolConnections)
        .set({ status: "active", enabled: true, ...(input.agentInstructions !== undefined ? { agentInstructions: input.agentInstructions } : {}), updatedAt: new Date() })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      await tx
        .update(toolApplications)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(toolApplications.id, connection.applicationId));

      return { profileId, profileBindings, policies, updatedConnection };
    });
    emitConnectionUpdated(
      transactionResult.updatedConnection,
      connection,
      "gallery",
    );

    const details = await profileDetails(
      transactionResult.profileId,
      companyId,
    );
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
    await actor?.managementContext?.reauthorize();
    const connection = await getConnectionRow(connectionId, companyId);
    assertSupportedConnection(connection);
    await assertConnectorConnectionSetupEnabled(connection);
    await assertExperimentalConnectorSetupEnabled(connection.config.sourceTemplateKey, connection.status !== "draft");
    if (connection.status === "archived")
      throw conflict("Archived app connections cannot be reconnected");
    if (connection.credentialSource === "vercel_connect") {
      throw conflict(
        "Manage this connector in Vercel Connect, then run a Paperclip health check to verify it.",
        {
          code: "vercel_connect_managed_externally",
          manageUrl: vercelConnectIntegrationStatus().manageUrl,
        },
      );
    }
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string"
        ? connection.config.sourceTemplateKey
        : null;
    const galleryEntry = sourceTemplateKey
      ? getConnectableAppDefinition(sourceTemplateKey)
      : null;
    const storedCredentialFields = connection.credentialRefs
      .filter((ref) => ref.placement === "header" || ref.placement === "url")
      .map((ref) => ({
        label: ref.placement === "url" ? "MCP server URL" : ref.prefix === "Bearer " ? "App key" : ref.key ?? ref.name,
        configPath: credentialRefConfigPath(ref),
        helpUrl: "",
        required: false,
        placement: ref.placement,
        key: ref.key,
        prefix: ref.prefix,
      }));
    const galleryCredentialFields = galleryEntry
      ? credentialFieldsFor(galleryEntry, connectionMethodForConnection(galleryEntry, connection).key)
      : [];
    const credentialFields = galleryCredentialFields.length > 0
      ? galleryCredentialFields
      : storedCredentialFields.length > 0 ? storedCredentialFields : [
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
      (field) =>
        (input.credentialValues[field.configPath]?.trim().length ?? 0) > 0,
    );
    if (providedFields.length === 0)
      throw badRequest("Enter a replacement credential to reconnect this app");

    const personalIdentity = await fixedPersonalIdentityForReconnect(
      connection,
      undefined,
      actor,
    );
    const credentialSecretRefs = [
      ...(personalIdentity?.grant?.credentialSecretRefs ??
        connection.credentialSecretRefs),
    ];
    const credentialRefs: McpConnectionCredentialRef[] = [
      ...(connection.credentialRefs ?? []),
    ];

    const updated = await db.transaction(async (tx) => {
      await tx.select({ id: connectionGrants.id }).from(connectionGrants)
        .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.connectionId, connection.id)))
        .orderBy(connectionGrants.id).for("update");
      await tx.select({ id: toolApplications.id }).from(toolApplications)
        .where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, companyId)))
        .for("update");
      await tx.select({ id: toolConnections.id }).from(toolConnections)
        .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, companyId)))
        .for("update");
      for (const field of providedFields) {
        const value = input.credentialValues[field.configPath]!.trim();
        if (field.placement === "url" && !remoteUrlCredentialMatchesPublicUrl(String(connection.config.url ?? ""), value)) {
          throw badRequest("The replacement server URL must use the same endpoint as this connection.", {
            code: "mcp_remote_url_credential_mismatch",
          });
        }
        const existing = credentialSecretRefs.find(
          (ref) => ref.configPath === field.configPath,
        );
        const { secret } = await writeConnectionCredential(tx, {
          companyId, connectionName: connection.name, configPath: field.configPath,
          label: field.label, value, ownerUserId: personalIdentity?.subjectUserId,
          existingRef: existing, actor: actorForSecret(actor),
        });
        const nextRef = { secretId: secret.id, versionSelector: "latest" as const,
          configPath: field.configPath, required: field.required ?? true, label: field.label };
        const refIndex = credentialSecretRefs.findIndex((ref) => ref.configPath === field.configPath);
        if (refIndex >= 0) credentialSecretRefs[refIndex] = nextRef;
        else credentialSecretRefs.push(nextRef);
        if ((field.placement === "header" && field.key) || field.placement === "url") {
          const nextCredentialRef = {
            name: field.configPath,
            secretId: secret.id,
            version: "latest",
            placement: field.placement,
            key: field.key ?? "url",
            prefix: field.prefix ?? null,
          } satisfies McpConnectionCredentialRef;
          const existingCredentialRefIndex = credentialRefs.findIndex(
            (ref) => credentialRefConfigPath(ref) === field.configPath,
          );
          if (existingCredentialRefIndex >= 0)
            credentialRefs[existingCredentialRefIndex] = nextCredentialRef;
          else credentialRefs.push(nextCredentialRef);
        }
      }

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
          credentialSecretRefs: personalIdentity
            ? connection.credentialSecretRefs
            : credentialSecretRefs,
          lastError: null,
          updatedAt,
        })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      await syncConnectionCredentialBindings(tx, nextConnection,
        personalIdentity ? credentialSecretRefs : []);
      return nextConnection;
    });
    const health = await checkConnectionHealth(updated.id, actor);
    const refresh = await refreshCatalog(updated.id, actor, {
      enableAllByDefault: true,
    });
    return { ...health, connection: refresh.connection };
  }

  async function preflightGalleryAppMetadata(
    galleryKey: string,
    methodKey?: string | null,
  ): Promise<ToolAppMetadataPreflightResult> {
    const app = getConnectableAppDefinition(galleryKey);
    if (!app || app.availability?.available === false)
      throw notFound("App not found");
    const method = connectionMethodFor(app, methodKey);
    await assertExperimentalConnectorSetupEnabled(app.slug);
    if (method.transport !== "mcp_remote" || !method.defaults?.serverUrl) {
      throw unprocessable(
        "This app method does not use a hosted remote MCP endpoint",
      );
    }

    const serverUrl = await assertRemoteHttpUrlAllowed(
      method.defaults.serverUrl,
    );
    return preflightConnectionMetadata(app, method, method.defaults, serverUrl, () => options.now?.() ?? new Date());
  }

  return {
    /** Identity-only verification: no bot installation/repository access required. */
    verifyPersonalGitHubIdentity: async (companyId: string, connectionId: string, userId: string) => {
      const [connection] = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.id, connectionId), eq(toolConnections.enabled, true)));
      if (!connection || (connection.config.sourceTemplateKey !== "github" && connection.transportConfig?.sourceTemplateKey !== "github")) throw notFound("GitHub connection not found");
      const [ownGrant] = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, userId), eq(connectionGrants.status, "active")));
      if (!ownGrant) throw forbidden("Connect your own GitHub account first. Shared and agent connections cannot prove your identity.");
      const actor = { actorType: "user" as const, actorId: userId };
      const grant = await refreshOAuthGrantCredentials({ companyId, connectionId, grantId: ownGrant.id, actor });
      const accessRef = grant.credentialSecretRefs.find(ref => ref.configPath === "oauth.access_token");
      if (!accessRef) throw unprocessable("Reconnect your personal GitHub connection");
      const { value } = await resolveOAuthGrantSecret(connection, grant, accessRef, actor, undefined);
      const identity = await githubBotRequest<{ id?: number; login?: string; avatar_url?: string }>(fetch, value, "/user");
      if (!Number.isSafeInteger(identity.id) || !identity.id || !identity.login || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(identity.login)) throw unprocessable("GitHub returned an invalid account identity");
      const [current] = await db.select({ id: connectionGrants.id }).from(connectionGrants).where(and(eq(connectionGrants.id, grant.id), eq(connectionGrants.companyId, companyId), eq(connectionGrants.subjectUserId, userId), eq(connectionGrants.status, "active")));
      if (!current) throw forbidden("Your GitHub connection was revoked. Connect it again.");
      return { githubUserId: String(identity.id), login: identity.login, avatarUrl: identity.avatar_url ?? null, connectionId, grantId: grant.id };
    },
    preflightGalleryAppMetadata,
    approvedStdioTemplates: async (
      companyId: string,
    ): Promise<ToolStdioCommandTemplate[]> => {
      const adminTemplates = await db
        .select()
        .from(toolStdioCommandTemplates)
        .where(eq(toolStdioCommandTemplates.companyId, companyId))
        .orderBy(asc(toolStdioCommandTemplates.templateKey));
      return [
        ...Object.keys(APPROVED_STDIO_TEMPLATES)
          .sort()
          .map((templateId) => builtInStdioTemplate(templateId)!),
        ...adminTemplates.map(toStdioCommandTemplate),
      ];
    },

    createStdioCommandTemplate: async (
      companyId: string,
      input: CreateToolStdioCommandTemplate,
      actor?: ActorInfo,
    ): Promise<ToolStdioCommandTemplate> => {
      await actor?.managementContext?.reauthorize();
      if (builtInStdioTemplate(input.templateId)) {
        throw conflict(
          "A built-in stdio template already uses this templateId",
        );
      }
      const existing = await getAdminStdioTemplate(companyId, input.templateId);
      if (existing)
        throw conflict("A stdio command template already uses this templateId");
      const tools = input.tools
        .map((tool) => normalizeToolDescriptor(tool))
        .filter((tool): tool is McpToolDescriptor => Boolean(tool));
      const [row] = await db
        .insert(toolStdioCommandTemplates)
        .values({
          companyId,
          templateKey: input.templateId,
          name: input.name,
          description: input.description ?? null,
          status: "active",
          command: input.command,
          args: input.args,
          envKeys: input.envKeys,
          tools,
          createdByAgentId:
            actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
          createdByUserId:
            connectionActorUserId(actor),
        })
        .returning();
      return toStdioCommandTemplate(row);
    },

    disableStdioCommandTemplate: async (
      companyId: string,
      templateId: string,
    ): Promise<ToolStdioCommandTemplate> => {
      if (builtInStdioTemplate(templateId))
        throw unprocessable("Built-in stdio templates cannot be disabled");
      const existing = await getAdminStdioTemplate(companyId, templateId);
      if (!existing) throw notFound("Stdio command template not found");
      if (existing.status === "disabled")
        return toStdioCommandTemplate(existing);
      const at = now();
      const [row] = await db
        .update(toolStdioCommandTemplates)
        .set({ status: "disabled", disabledAt: at, updatedAt: at })
        .where(
          and(
            eq(toolStdioCommandTemplates.companyId, companyId),
            eq(toolStdioCommandTemplates.templateKey, templateId),
          ),
        )
        .returning();
      return toStdioCommandTemplate(row);
    },
    ...aggregatorAccounts,

    connectGalleryApp,

    finishGalleryAppConnection,

    reconnectGalleryApp,

    storeConnectorOAuthSecret: createOrRotateOAuthSecret,
    resolveConnectorOAuthGrantSecret: resolveOAuthGrantSecret,
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
      managementContext?: ConnectionManagementContext;
    }) => {
      await input.managementContext?.reauthorize();
      const runContext = await loadBrokerRunContext(input);
      const connection = await getConnectionRow(
        input.connectionId,
        input.companyId,
      );
      if (
        !runContext.responsibleUserId ||
        runContext.responsibleUserId !== input.subjectUserId
      ) {
        throw new HttpError(
          403,
          "The agent run cannot start authorization for the requested user",
          {
            code: "subject_not_permitted",
            connection: { uid: connection.uid },
            subject: { type: "user", userId: input.subjectUserId },
          },
        );
      }
      return startOAuth(input.companyId, connection.id, {
        redirectUri: input.redirectUri,
        actor: { actorType: "agent", actorId: input.agentId, ...input.managementContext?.audit, managementContext: input.managementContext },
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
      return Promise.all(
        TOOL_EXAMPLES.map(async (definition) => {
          const rows = await exampleRows(companyId, definition);
          return exampleSummary(definition, rows);
        }),
      );
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
      const application = await upsertExampleApplication(
        companyId,
        definition,
        before.application,
      );
      const connection = await upsertExampleConnection(
        companyId,
        definition,
        application.row.id,
        before.connection,
      );
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
            reviewedByAgentId:
              actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
            reviewedByUserId:
              connectionActorUserId(actor),
            quarantinedAt: null,
            quarantineReason: null,
            updatedAt: reviewedAt,
          })
          .where(
            and(
              eq(toolCatalogEntries.companyId, companyId),
              inArray(toolCatalogEntries.id, safeReadEntryIds),
            ),
          );
        catalog = catalog.map((entry) =>
          safeReadEntryIds.includes(entry.id)
            ? {
                ...entry,
                status: "active",
                reviewedAt,
                quarantinedAt: null,
                quarantineReason: null,
                updatedAt: reviewedAt,
              }
            : entry,
        );
      }
      const profile = await upsertExampleProfile(
        companyId,
        definition,
        before.profile,
      );
      const profileEntries = await syncExampleProfileEntries(
        companyId,
        profile.row.id,
        catalog,
      );
      const profileBinding = await upsertExampleProfileBinding(
        companyId,
        profile.row.id,
        before.profileBinding,
        actor,
      );
      const after = await exampleRows(companyId, definition);
      return {
        example: exampleSummary(definition, after),
        created:
          application.created ||
          connection.created ||
          profile.created ||
          !before.profileBinding,
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
      const catalog =
        rows.catalog.length > 0
          ? rows.catalog.map(toCatalogEntry)
          : (await refreshCatalog(rows.connection.id, actor)).catalog;
      const readEntry = catalog.find(
        (entry) => entry.riskLevel === "read" && entry.status === "active",
      );
      const deniedEntry = catalog.find(
        (entry) =>
          entry.riskLevel === "write" || entry.riskLevel === "destructive",
      );
      if (!readEntry || !deniedEntry) {
        throw unprocessable(
          "Example smoke requires at least one read tool and one denied write/destructive tool",
        );
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
        ok: Boolean(
          allowCheck.auditEventId &&
          allowCheck.toolCallEventId &&
          denyCheck.auditEventId &&
          denyCheck.toolCallEventId,
        ),
        details: {
          auditEventIds: [allowCheck.auditEventId, denyCheck.auditEventId],
          toolCallEventIds: [
            allowCheck.toolCallEventId,
            denyCheck.toolCallEventId,
          ],
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

    createApplication: async (
      companyId: string,
      input: CreateToolApplication,
      managementContext?: ConnectionManagementContext,
    ): Promise<ToolApplication> => {
      await assertOptionalPlugin(input.pluginId);
      await assertOptionalAgent(
        companyId,
        input.ownerAgentId,
        "Tool application owner agent",
      );
      await managementContext?.reauthorize();
      const [row] = await db
        .insert(toolApplications)
        .values({
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
        })
        .returning();
      return toApplication(row);
    },

    getApplication: async (
      applicationId: string,
      companyId?: string,
    ): Promise<ToolApplication> => {
      const where = companyId
        ? and(
            eq(toolApplications.id, applicationId),
            eq(toolApplications.companyId, companyId),
          )
        : eq(toolApplications.id, applicationId);
      const [row] = await db.select().from(toolApplications).where(where);
      if (!row) throw notFound("Tool application not found");
      return toApplication(row);
    },

    updateApplication: async (
      applicationId: string,
      input: UpdateToolApplication,
      managementContext?: ConnectionManagementContext,
    ): Promise<ToolApplication> => {
      const [existing] = await db
        .select()
        .from(toolApplications)
        .where(eq(toolApplications.id, applicationId));
      if (!existing) throw notFound("Tool application not found");
      await assertOptionalPlugin(input.pluginId);
      await assertOptionalAgent(
        existing.companyId,
        input.ownerAgentId,
        "Tool application owner agent",
      );
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
      await managementContext?.reauthorize();
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

    deleteApplication: async (
      applicationId: string,
      managementContext?: ConnectionManagementContext,
    ): Promise<ToolApplication> => {
      const [existing] = await db
        .select()
        .from(toolApplications)
        .where(eq(toolApplications.id, applicationId));
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
      await managementContext?.reauthorize();
      let row: typeof toolApplications.$inferSelect | undefined;
      try {
        [row] = await db
          .delete(toolApplications)
          .where(eq(toolApplications.id, applicationId))
          .returning();
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

    // Repository discovery uses credential audiences, not connection-management
    // visibility. An administrator cannot browse another user's private repos.
    listProjectRepositories: async (companyId: string, userId: string | null, localTrusted = false) =>
      toolAccessService(db).listGitHubRepositories(companyId, userId, localTrusted),

    // Return identifiers, never credentials, so each attempted read can recheck its grant.
    githubReadConnectionIds: async (companyId: string, userId: string | null, localTrusted = false): Promise<string[]> => {
      const connections = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.enabled, true))).orderBy(desc(toolConnections.updatedAt));
      const ids: string[] = [];
      for (const connection of connections) {
        if (connection.status !== "active" || asRecord(connection.config).sourceTemplateKey !== "github") continue;
        try {
          await gitHubReadGrantAccess(db, companyId, connection.id, userId, localTrusted);
          ids.push(connection.id);
        } catch (error) {
          // Only ineligible grants are skipped; database/service failures must surface.
          if (!(error instanceof Error && "status" in error && error.status === 403)) throw error;
        }
      }
      return ids;
    },

    githubReadGrantIds: async (companyId: string, connectionId: string, userId: string | null, localTrusted = false): Promise<Array<string | null>> => {
      const { allowed, legacyShared } = await gitHubReadGrantAccess(db, companyId, connectionId, userId, localTrusted);
      return legacyShared ? [null] : allowed.map(grant => grant.id);
    },

    // Server-side reads share the same grant audience and credential lifecycle as discovery.
    githubReadHeaders: async (companyId: string, connectionId: string, userId: string | null, localTrusted = false, forceRefresh = false, grantId?: string | null): Promise<Record<string, string>> => {
      const { connection, allowed, legacyShared } = await gitHubReadGrantAccess(db, companyId, connectionId, userId, localTrusted);
      const actor: ActorInfo = { actorType: "user", actorId: userId ?? "board" };
      if (legacyShared && !grantId) return resolveCredentialHeaders(connection, actor);
      let grant = grantId ? allowed.find(candidate => candidate.id === grantId) : allowed.length === 1 ? allowed[0] : undefined;
      if (!grant) throw forbidden("Choose an active GitHub authorization you can use.");
      if (asRecord(asRecord(connection.config).oauth).connectorProfile === "github.code") {
        grant = await refreshOAuthGrantCredentials({ companyId, connectionId, grantId: grant.id, actor, forceRefresh });
      }
      const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "oauth.access_token" || /authorization|token|api_key/i.test(ref.configPath));
      if (!ref) throw unprocessable("Reconnect GitHub to read repository files.");
      const secret = await resolveOAuthGrantSecret(connection, grant, ref, actor, undefined);
      return { Authorization: `Bearer ${secret.value}` };
    },

    listGitHubRepositories: async (
      companyId: string,
      userId: string | null,
      localTrusted = false,
    ) => measureRunPhase("connectors.github.catalog", async () => {
      const [connections, grants, members, memberships] = await Promise.all([
        measureRunPhase("connectors.github.connections", () => db
          .select()
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, companyId),
              eq(toolConnections.enabled, true),
            ),
          )),
        measureRunPhase("connectors.github.grants", () => db
          .select()
          .from(connectionGrants)
          .where(eq(connectionGrants.companyId, companyId))),
        measureRunPhase("connectors.github.grant_members", () => db
          .select()
          .from(connectionGrantMembers)
          .where(eq(connectionGrantMembers.companyId, companyId))),
        userId
          ? measureRunPhase("connectors.github.membership", () => db
              .select()
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.companyId, companyId),
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ))
          : Promise.resolve([]),
      ]);
      const repositories = new Map<
        string,
        import("@paperclipai/shared").ProjectRepository
      >();
      const usableConnections: Array<{ id: string; name: string }> = [];
      let connectionCount = 0;
      let failedConnectionCount = 0;
      for (const connection of connections) {
        if (
          connection.status !== "active" ||
          asRecord(connection.config).sourceTemplateKey !== "github"
        )
          continue;
        const connectionGrants = grants.filter(
          (grant) => grant.connectionId === connection.id,
        );
        const availableGrants = connectionGrants.filter(
          (grant) =>
            !(
              grant.kind === "organization" &&
              ["per_user", "per_agent"].includes(connection.credentialPolicy)
            ) &&
            canBrowseProjectRepositoryGrant({
              grant,
              userId,
              activeMember: localTrusted || memberships.length > 0,
              audience: members
                .filter((member) => member.grantId === grant.id)
                .map((member) => member.subjectId),
            }),
        );
        // Legacy shared PAT connections predate grants. Never fall back when a
        // grant exists but is revoked, private, or outside the caller's audience.
        const legacyShared =
          connectionGrants.length === 0 &&
          connection.credentialPolicy === "shared" &&
          (localTrusted || (!!userId && memberships.length > 0));
        if (!availableGrants.length && !legacyShared) continue;
        connectionCount += 1;
        usableConnections.push({ id: connection.id, name: connection.name });
        const actor: ActorInfo = {
          actorType: "user",
          actorId: userId ?? "board",
        };
        let failed = false;
        for (const initialGrant of legacyShared ? [null] : availableGrants) {
          try {
            let rows: Array<{
              id: string;
              fullName: string;
              private?: boolean;
            }>;
            if (
              initialGrant &&
              asRecord(asRecord(connection.config).oauth).connectorProfile ===
                "github.code"
            ) {
              const grant = await refreshManagedGitHubGrantAccess(
                connection,
                initialGrant,
                actor,
              );
              rows = grant.providerTenant?.github?.repositories ?? [];
            } else {
              const headers = await measureRunPhase("connectors.github.credentials", () => initialGrant
                ? (async () => {
                    const ref = initialGrant.credentialSecretRefs.find(
                      (ref) =>
                        ref.configPath === "oauth.access_token" ||
                        /authorization|token|api_key/i.test(ref.configPath),
                    );
                    if (!ref)
                      throw unprocessable(
                        "Reconnect GitHub to load repositories",
                      );
                    const secret = await resolveOAuthGrantSecret(
                      connection,
                      initialGrant,
                      ref,
                      actor,
                      undefined,
                    );
                    return { Authorization: `Bearer ${secret.value}` };
                  })()
                : resolveCredentialHeaders(connection, actor));
              rows = await measureRunPhase("connectors.github.repositories", () => loadGitHubTokenRepositories(headers));
            }
            for (const row of rows) {
              mergeProjectRepository(repositories, row, connection.name, connection.id);
            }
          } catch {
            // Credential/provider errors may contain secrets. Only expose an
            // aggregate failure; successful connections remain usable.
            failed = true;
          }
        }
        if (failed) failedConnectionCount += 1;
      }
      return {
        repositories: [...repositories.values()].sort((a, b) =>
          a.fullName.localeCompare(b.fullName),
        ),
        connections: usableConnections,
        connectionCount,
        failedConnectionCount,
      };
    }),

    listConnections: async (
      companyId: string,
      viewerUserId?: string,
    ): Promise<ToolConnection[]> => {
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
        .orderBy(
          asc(toolConnectionInstalls.targetType),
          asc(toolConnectionInstalls.targetId),
        );
      const installsByConnection = new Map<string, ToolConnectionInstall[]>();
      for (const row of installRows) {
        const installs = installsByConnection.get(row.connectionId) ?? [];
        installs.push(toConnectionInstall(row));
        installsByConnection.set(row.connectionId, installs);
      }
      for (const connection of connections)
        connection.installs = installsByConnection.get(connection.id) ?? [];
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
      await annotateAiGrantHealth(connections);
      await annotateGitHubAuthorization(connections, viewerUserId);
      await annotateSavedOAuthClientSecret(connections, viewerUserId);
      return connections;
    },

    createConnection: async (
      companyId: string,
      input: CreateToolConnection,
      actor?: ActorInfo,
    ): Promise<ToolConnection> => {
      await actor?.managementContext?.reauthorize();
      let applicationId = input.applicationId;
      let applicationNamespace = input.applicationName ?? input.name;
      const transport = input.transport;
      if (!transport) throw badRequest("Tool connection transport is required");
      const config = normalizeGoogleSheetsConnectionConfig(
        input.config ?? input.transportConfig ?? {},
      );
      await assertConnectorConnectionSetupEnabled({ config, applicationId, companyId });
      // Validate company-scoped references before touching a caller-supplied
      // network endpoint. Besides failing fast, this keeps cross-company
      // authorization errors from being masked by DNS or SSRF validation.
      await assertSecretRefs(companyId, [
        ...(input.credentialRefs ?? []),
        ...(input.credentialSecretRefs ?? []),
      ]);
      if (transport === "mcp_remote")
        await assertRemoteConnectionEndpointsAllowed(config);
      if (transport === "local_stdio") await stdioTemplateId(companyId, config);
      assertLocalStdioCanBeEnabled(transport, input.enabled ?? false, config);
      await assertGoogleSheetsSpreadsheetOwnership(companyId, config);
      if (applicationId) {
        const app = await assertApplication(companyId, applicationId);
        applicationNamespace = app.applicationKey ?? app.name;
        await assertConnectorConnectionSetupEnabled({ config }, applicationNamespace);
        if (
          (transport === "mcp_remote" && app.type !== "mcp_http") ||
          (transport === "local_stdio" && app.type !== "mcp_stdio")
        ) {
          throw unprocessable(
            "Connection transport must match application type",
          );
        }
      } else {
        const [app] = await db
          .insert(toolApplications)
          .values({
            companyId,
            applicationKey: normalizeKey(input.applicationName ?? input.name),
            name: input.applicationName ?? input.name,
            type: isBrowserUseConnection({ transport, config }) || nativeProviderCatalogFor({ transport, config }) || restConnectorFor({ transport, config }) ? "rest_api" : transport === "mcp_remote" ? "mcp_http" : "mcp_stdio",
            status: "active",
            metadata: {},
          })
          .returning();
        applicationId = app.id;
      }
      await actor?.managementContext?.reauthorize();
      const connectionId = randomUUID();
      const binding = actorBinding(actor);
      const [row] = await db
        .insert(toolConnections)
        .values({
          id: connectionId,
          companyId,
          applicationId,
          name: input.name,
          uid: connectionUid(applicationNamespace, input.name, connectionId),
          connectionKind: input.connectionKind ?? "managed",
          ownership: input.ownership ?? "customer",
          transport,
          authKind: input.authKind ?? "none",
          credentialPolicy:
            input.credentialPolicy ??
            (input.authKind === "oauth" ? "per_user" : "shared"),
          status: input.status ?? "draft",
          enabled: input.enabled ?? false,
          agentInstructions: input.agentInstructions !== undefined ? input.agentInstructions : defaultConnectionAgentInstructions(
            typeof config.sourceTemplateKey === "string" ? getConnectableAppDefinition(config.sourceTemplateKey)?.agentInstructions : null,
          ),
          config,
          transportConfig: isGoogleSheetsConnectionConfig(config)
            ? config
            : (input.transportConfig ?? config),
          credentialRefs: input.credentialRefs ?? [],
          credentialSecretRefs: input.credentialSecretRefs ?? [],
          createdByAgentId:
            binding.actorType === "agent" ? binding.actorId : null,
          createdByUserId: connectionActorUserId(actor),
        })
        .returning();
      await ensureDefaultOrganizationGrant(row);
      await syncCredentialBindings(row);
      await ensureRuntimeSlot(row);
      emitConnectionCreated(row, "api");
      return toConnection(row);
    },

    getConnection: async (
      connectionId: string,
      companyId?: string,
      viewerUserId?: string,
    ): Promise<ToolConnection> => {
      const connection = toConnection(
        await getConnectionRow(connectionId, companyId),
      );
      connection.installs = await listConnectionInstalls(
        connection.id,
        connection.companyId,
      );
      await annotateAiGrantHealth([connection]);
      await annotateGitHubAuthorization([connection], viewerUserId);
      await annotateSavedOAuthClientSecret([connection], viewerUserId);
      return connection;
    },
    ...connectionGrantsService,
    ...toolActivity,

    listConnectionInstalls,
    putConnectionInstalls: connectionInstalls.putConnectionInstalls,

    updateConnection: async (
      connectionId: string,
      input: UpdateToolConnection,
      managementContext?: ConnectionManagementContext,
    ): Promise<ToolConnection> => {
      const existing = await getConnectionRow(connectionId);
      if (managementContext?.actor.type === "agent" && existing.connectionPurpose === "channel"
        && (input.credentialRefs !== undefined || input.credentialSecretRefs !== undefined)) {
        throw forbidden("Use chat endpoint setup to change channel credentials; verification keys require human entry", {
          code: "chat_endpoint_credentials_require_setup",
        });
      }
      if (existing.connectionPurpose === "ai" && (input.config || input.transportConfig || input.credentialRefs || input.credentialSecretRefs || (input.credentialPolicy && input.credentialPolicy !== existing.credentialPolicy))) throw badRequest("Use AI account reconnect to change credentials. Provider, sign-in method, and ownership cannot be changed.");
      const config = normalizeGoogleSheetsConnectionConfig(
        input.config ?? input.transportConfig ?? existing.config,
      );
      if (input.config?.methodConfig !== undefined && typeof config.sourceTemplateKey === "string") {
        const app = getConnectableAppDefinition(config.sourceTemplateKey);
        if (app) normalizeConnectionMethodConfig(connectionMethodForConnection(app, { ...existing, config }), asRecord(config.methodConfig));
      }
      if (existing.transport === "mcp_remote")
        await assertRemoteConnectionEndpointsAllowed(config);
      if (existing.transport === "local_stdio")
        await stdioTemplateId(existing.companyId, config);
      assertLocalStdioCanBeEnabled(
        existing.transport,
        input.enabled ?? existing.enabled,
        config,
      );
      await assertGoogleSheetsSpreadsheetOwnership(existing.companyId, config, {
        excludeConnectionId: existing.id,
      });
      await assertSecretRefs(existing.companyId, [
        ...(input.credentialRefs ?? existing.credentialRefs),
        ...(input.credentialSecretRefs ?? existing.credentialSecretRefs),
      ]);
      await managementContext?.reauthorize();
      const write = (database: Db) => database
        .update(toolConnections)
        .set({
          name: input.name ?? existing.name,
          status: input.status ?? existing.status,
          enabled: input.enabled ?? existing.enabled,
          ...(input.agentInstructions !== undefined ? { agentInstructions: input.agentInstructions } : {}),
          config,
          transportConfig: isGoogleSheetsConnectionConfig(config)
            ? config
            : (input.transportConfig ?? config),
          credentialRefs: input.credentialRefs ?? existing.credentialRefs,
          credentialSecretRefs:
            input.credentialSecretRefs ?? existing.credentialSecretRefs,
          credentialPolicy: input.credentialPolicy ?? existing.credentialPolicy,
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, connectionId))
        .returning();
      const [row] = existing.transport === "chat_sdk"
        ? await db.transaction(async tx => {
            await notifyChatEndpointWork(tx, existing.id);
            const rows = await write(tx as unknown as Db);
            // Credential resolution must never observe the binding rebuild's
            // delete/insert gap after a configuration wake.
            await syncCredentialBindings(rows[0]!, [], tx);
            return rows;
          })
        : await write(db);
      if (existing.transport !== "chat_sdk") await syncCredentialBindings(row);
      await ensureRuntimeSlot(row);
      emitConnectionUpdated(row, existing, "api");
      return toConnection(row);
    },

    archiveConnection: removeConnection,

    checkHealth: checkConnectionHealth,

    refreshCatalog,

    configureRailwaySsh: async (connectionId: string, companyId: string, input: ConfigureRailwaySsh, actor: ActorInfo): Promise<RailwaySshSetup | null> => {
      await actor.managementContext?.reauthorize();
      const knownHosts = input.action === "enable" ? validateRailwayKnownHosts(input.knownHosts) : "";
      const setup = await db.transaction(async (tx) => {
        const [grant] = await tx.select().from(connectionGrants).where(and(eq(connectionGrants.id, input.grantId), eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.companyId, companyId))).for("update");
        const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId))).for("update");
        if (!connection || !isRailwayConnection(connection) || (connection.status !== "active" && input.action !== "remove")) throw unprocessable("Connect Railway before configuring container access.");
        if (!grant || (grant.status !== "active" && input.action !== "remove")) throw unprocessable("Select an active Railway authorization.");
        if (grant.kind === "user" && connectionActorUserId(actor) !== grant.subjectUserId) throw forbidden("Only this authorization's owner can configure its SSH key.");
        const existing = asRecord(connection.config.railwaySsh);
        if (existing.grantId && existing.grantId !== grant.id) throw conflict("Remove the existing container key before choosing another authorization.");
        const currentRef = grant.credentialSecretRefs.find((ref) => ref.configPath === RAILWAY_SSH_SECRET_PATH);
        let next: RailwaySshSetup | null = null;
        let refs = grant.credentialSecretRefs;
        if (input.action === "remove") {
          if (currentRef) await secretService(tx).remove(currentRef.secretId);
          refs = refs.filter((ref) => ref.configPath !== RAILWAY_SSH_SECRET_PATH);
        } else if (input.action === "prepare") {
          if (currentRef && typeof existing.publicKey === "string") return existing as unknown as RailwaySshSetup;
          const key = await generateRailwaySshKey();
          const ref = await createOrRotateOAuthSecret({ companyId, connection, configPath: RAILWAY_SSH_SECRET_PATH, label: "Railway container SSH key", value: key.privateKey, existingRefs: [], ownerUserId: grant.kind === "user" ? grant.subjectUserId ?? undefined : undefined, actor }, { dbClient: tx, secretClient: secretService(tx) });
          refs = [...refs.filter((ref) => ref.configPath !== RAILWAY_SSH_SECRET_PATH), ref];
          next = { grantId: grant.id, publicKey: key.publicKey, knownHosts: "", enabled: false };
        } else {
          if (!currentRef || typeof existing.publicKey !== "string") throw unprocessable("Generate and register a container key first.");
          next = { grantId: grant.id, publicKey: existing.publicKey, knownHosts, enabled: true };
        }
        await tx.update(connectionGrants).set({ credentialSecretRefs: refs, updatedAt: now() }).where(and(eq(connectionGrants.id, grant.id), eq(connectionGrants.companyId, companyId)));
        const config = { ...connection.config, railwaySsh: next };
        const [updated] = await tx.update(toolConnections).set({ config, transportConfig: config, updatedAt: now() }).where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId))).returning();
        await syncCredentialBindings(updated, [], tx);
        return next;
      });
      await audit({ companyId, connectionId, action: "tool_connection.railway_ssh_updated", outcome: "success", actor, details: { action: input.action, grantId: input.grantId, enabled: setup?.enabled ?? false } });
      return setup;
    },

    listAppsNeedingAttention,

    sweepConnectionHealth,

    sweepGitHubConnectionContinuity,
    ...catalogReader,
    ...toolActionReviewQueue,
    ...profileService,
    ...profileResolver,
    mintConnectionTokenForAgent,
    ...runtimeSlots.api,

    getRuntimeHealth: runtimeHealth,

    previewMcpJsonImport: async (
      input: ImportMcpJson,
    ): Promise<McpJsonImportPreview> => {
      let raw: unknown;
      try {
        raw =
          typeof input.mcpJson === "string"
            ? (JSON.parse(input.mcpJson) as unknown)
            : input.mcpJson;
      } catch {
        throw badRequest("mcp.json must be valid JSON");
      }
      const mcpServers = asRecord(asRecord(raw).mcpServers);
      const drafts = Object.entries(mcpServers).map(([name, rawServer]) => {
        const server = asRecord(rawServer);
        const warnings: string[] = [];
        if (
          typeof server.url === "string" ||
          typeof server.endpoint === "string"
        ) {
          const headers = asRecord(server.headers);
          const credentialFields = Object.keys(headers)
            .sort()
            .map((key) => {
              warnings.push(
                `Header ${key} will be stored as a Paperclip secret before activation.`,
              );
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
          warnings.push(
            "Imported stdio commands stay draft-only unless mapped to an approved Paperclip template.",
          );
          return {
            name,
            transport: "local_stdio" as const,
            status: "draft" as const,
            config: {
              importedCommand: server.command,
              importedArgs: Array.isArray(server.args) ? server.args : [],
            },
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
      if (drafts.length === 0)
        throw badRequest("mcp.json must include an mcpServers object");
      return { drafts };
    },

    assertConnectionCompany: async (
      connectionId: string,
      companyId: string,
    ) => {
      const connection = await getConnectionRow(connectionId, companyId);
      return toConnection(connection);
    },

    ensureNoDuplicateNameError: (error: unknown) => {
      const maybeRecord =
        typeof error === "object" && error !== null
          ? (error as Record<string, unknown>)
          : null;
      const cause = maybeRecord?.cause;
      const maybeCause =
        typeof cause === "object" && cause !== null
          ? (cause as Record<string, unknown>)
          : null;
      const message = [
        error instanceof Error ? error.message : String(error),
        maybeRecord && typeof maybeRecord.detail === "string"
          ? maybeRecord.detail
          : null,
        maybeCause instanceof Error ? maybeCause.message : null,
        maybeCause && typeof maybeCause.detail === "string"
          ? maybeCause.detail
          : null,
      ]
        .filter(Boolean)
        .join("\n");
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
        /duplicate key value|unique constraint|tool_applications_company_id_name_unique/i.test(
          message,
        )
      ) {
        throw conflict("A tool access record with that name already exists", {
          code: "tool_access_name_conflict",
        });
      }
      throw error;
    },
  };
}
