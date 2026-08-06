import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, desc, eq, gte, inArray, lt, max, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  connectionGrants,
  connectionTokenIssuances,
  authUsers,
  companySecretBindings,
  companySecrets,
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
  toolMcpGateways,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeMetricCounters,
  toolRuntimeSlots,
} from "@paperclipai/db";
import type {
  AppDefinition,
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
  ToolConnectionHealthCheckResult,
  ToolConnectionHealthStatus,
  ToolConnectionTransport,
  ToolOAuthStartResult,
  ToolAppsAttentionResponse,
  ToolActionRequest,
  ToolActionRequestListItem,
  ToolActionRequestStatus,
  ToolConnectionActivityResponse,
  ToolConnectionLifecycleEvent,
  ToolConnectionLifecycleEventType,
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
} from "@paperclipai/shared";
import { CLASS3_STATIC_LEASE_ALLOWLIST, credentialConfigPath, getAvailableConnectionMethod, getConnectableAppDefinition, isToolConnectionAttentionHealth, recommendedDefaultsForApp } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { mcpHttpRequestHeaders, parseMcpHttpResponseBody } from "./mcp-http.js";
import { assertPublicRemoteHttpEndpoint, parseRemoteHttpEndpoint } from "./remote-http-endpoint-guard.js";
import { secretService } from "./secrets.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { readSignedToolArgumentsPayload } from "./tool-content-guards.js";
import { narrowestScopeBindings, profileIdsInBindingOrder } from "./tool-profile-binding-precedence.js";
import { recordToolRuntimeAuditWriteFailure, TOOL_RUNTIME_AUDIT_WRITE_FAILURE_METRIC } from "./tool-runtime-metrics.js";
import { createToolRuntimeSupervisor, ToolRuntimeSupervisorError } from "./tool-runtime-supervisor.js";

type ActorInfo = {
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  sessionId?: string | null;
};

const ACTIVE_BROKER_RUN_STATUSES = new Set(["running"]);
const REMOTE_HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REMOTE_HTTP_REDIRECTS = 5;

type OAuthProviderEndpoints = {
  provider: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  grantType?: "authorization_code" | "client_credentials";
  metadataUrl?: string | null;
};

type ToolAccessServiceOptions = {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  trustedLocalStdioRuntimeHost?: string | null;
  now?: () => Date;
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

function connectionMethodFor(app: AppDefinition) {
  const method = getAvailableConnectionMethod(app);
  if (!method) throw unprocessable("This app does not have an available connection method");
  return method;
}

function credentialFieldsFor(app: AppDefinition) {
  const method = connectionMethodFor(app);
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
  const catalogEntry = toCatalogEntry(row);
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

/** Activity-log actions that map to a connection lifecycle event on the Activity tab (PAP-11284). */
const LIFECYCLE_ACTIVITY_LOG_ACTIONS = [
  "tool_app.connected",
  "tool_app.oauth_connected",
  "tool_example.installed",
  "tool_app.reconnected",
  "tool_connection.archived",
  "tool_connection.updated",
] as const;

/**
 * Map a connection-scoped activity-log row to a lifecycle event type, or null
 * when it isn't an operator-visible lifecycle change. A `tool_connection.updated`
 * row only surfaces when the route tagged it with a `lifecycle` discriminator
 * (pause/resume/allowlist); plain settings edits stay out of the feed.
 */
function activityLogActionToLifecycleType(
  action: string,
  details: Record<string, unknown> | null,
): ToolConnectionLifecycleEventType | null {
  switch (action) {
    case "tool_app.connected":
    case "tool_app.oauth_connected":
    case "tool_example.installed":
      return "app_connected";
    case "tool_app.reconnected":
      return "reconnected";
    case "tool_connection.archived":
      return "disconnected";
    case "tool_connection.updated": {
      const lifecycle = typeof details?.lifecycle === "string" ? details.lifecycle : null;
      if (lifecycle === "paused") return "app_paused";
      if (lifecycle === "resumed") return "app_resumed";
      if (lifecycle === "allowlist_changed") return "allowlist_changed";
      return null;
    }
    default:
      return null;
  }
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

export function classifyRisk(tool: McpToolDescriptor): ToolRiskLevel {
  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint === true || annotations.destructive === true) return "destructive";
  if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
  if (verbMatches(tool.name, "delete|remove|destroy|unpublish")) return "destructive";
  if (verbMatches(tool.name, "create|update|write|set|send|publish|post|mutate|mark|archive")) return "write";
  return "read";
}

function descriptorHash(tool: McpToolDescriptor): string {
  return stableHash({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? {},
    annotations: tool.annotations ?? {},
    riskLevel: classifyRisk(tool),
  });
}

function sanitizeHttpFailure(error: unknown): { status: ToolConnectionHealthStatus; message: string; code: string } {
  if (error instanceof HttpError) {
    const code = asRecord(error.details).code;
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

function readStdioTemplateId(config: Record<string, unknown>): string {
  const templateId = config.templateId;
  if (typeof templateId !== "string" || templateId.trim().length === 0) {
    throw badRequest("Local stdio MCP connections must use an approved templateId");
  }
  return templateId.trim();
}

export function toolAccessService(db: Db, options: ToolAccessServiceOptions = {}) {
  const secrets = secretService(db);
  const policySvc = toolAccessPolicyService(db);
  const now = options.now ?? (() => new Date());
  const runtimeSupervisor = createToolRuntimeSupervisor(db, options);

  function allowPrivateRemoteEndpoints() {
    return options.deploymentMode !== "authenticated" || options.deploymentExposure !== "public";
  }

  async function assertRemoteHttpUrlAllowed(value: string): Promise<string> {
    const endpoint = parseRemoteHttpEndpoint(value, (message, code) => badRequest(message, { code }));
    await assertPublicRemoteHttpEndpoint(
      endpoint,
      { allowPrivateNetwork: allowPrivateRemoteEndpoints() },
      (message, code) => badRequest(message, { code }),
    );
    return endpoint.toString();
  }

  async function fetchRemoteHttpUrl(value: string, init: RequestInit = {}): Promise<Response> {
    let currentUrl = value;
    const method = (init.method ?? "GET").toUpperCase();
    for (let redirectCount = 0; redirectCount <= MAX_REMOTE_HTTP_REDIRECTS; redirectCount += 1) {
      const safeUrl = await assertRemoteHttpUrlAllowed(currentUrl);
      const response = await fetch(safeUrl, { ...init, redirect: "manual" });
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
      currentUrl = new URL(location, safeUrl).toString();
    }
    throw new HttpError(502, "Remote OAuth endpoint redirected too many times", { code: "oauth_redirect_limit" });
  }

  async function assertRemoteEndpointAllowed(config: Record<string, unknown>): Promise<string> {
    return assertRemoteHttpUrlAllowed(remoteEndpoint(config));
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

  function tokenBrokerConfig(connection: typeof toolConnections.$inferSelect): Record<string, unknown> {
    const config = asRecord(connection.config);
    const broker = asRecord(config.tokenBroker);
    if (Object.keys(broker).length > 0) return broker;
    return asRecord(config.broker);
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
    return {
      run,
      issueId: runSnapshotString(snapshot, "issueId") ?? runSnapshotString(paperclipIssue, "id"),
      projectId: runSnapshotString(snapshot, "projectId") ?? runSnapshotString(paperclipIssue, "projectId"),
      routineId: runSnapshotString(snapshot, "routineId"),
      responsibleUserId: runSnapshotString(snapshot, "responsibleUserId", "responsible_user_id")
        ?? runSnapshotString(paperclipIssue, "responsibleUserId", "responsible_user_id"),
    };
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
  }) {
    await db.insert(connectionTokenIssuances).values({
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
    const secretCandidates = connection.credentialSecretRefs.filter((ref) => ref.configPath !== "oauth.access_token" && ref.configPath !== "oauth.refresh_token");
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
  }) {
    const ref = findBrokerCredentialRef(input.connection);
    if (!ref) {
      throw unprocessable("Connection token exchange requires a vault-backed parent credential", {
        code: "parent_credential_missing",
      });
    }
    if (ref.kind === "secret_ref") {
      return secrets.resolveSecretValue(input.connection.companyId, ref.ref.secretId, ref.ref.versionSelector ?? "latest", {
        accessContext: accessContextForBroker({ ...input, configPath: ref.configPath }),
        bindingContext: accessContextForBroker({ ...input, configPath: ref.configPath }),
      });
    }
    return secrets.resolveSecretValue(input.connection.companyId, ref.ref.secretId, ref.ref.version ?? "latest", {
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
  }) {
    const isPages = isPagesTokenConnection(input.connection, input.application);
    const parentToken = await resolveBrokerParentCredential(input);
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
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } else {
      const namespace = isPages ? pagesNamespaceFromScope(input.scope) : null;
      const body = isPages && namespace
        ? { namespace, ttlSeconds: input.ttlSeconds, actions: ["publish"], actor }
        : { scope: input.scope, ttlSeconds: input.ttlSeconds, actor, audience: readConfigString(broker, "audience") };
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${parentToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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
    dbClient: Pick<Db, "select" | "insert">,
    connection: typeof toolConnections.$inferSelect,
  ) {
    const profileKey = `app:${connection.id}`;
    let [profile] = await dbClient
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, connection.companyId), eq(toolProfiles.profileKey, profileKey)))
      .limit(1);
    if (!profile) {
      [profile] = await dbClient.insert(toolProfiles).values({
        companyId: connection.companyId,
        profileKey,
        name: connection.name,
        description: `Access profile for ${connection.name}.`,
        status: "active",
        defaultAction: "deny",
        metadata: { source: "tool_connection_install", connectionId: connection.id },
      }).returning();
    }
    const [existingEntry] = await dbClient
      .select({ id: toolProfileEntries.id })
      .from(toolProfileEntries)
      .where(and(
        eq(toolProfileEntries.companyId, connection.companyId),
        eq(toolProfileEntries.profileId, profile.id),
        eq(toolProfileEntries.selectorType, "connection"),
        eq(toolProfileEntries.connectionId, connection.id),
      ))
      .limit(1);
    if (!existingEntry) {
      await dbClient.insert(toolProfileEntries).values({
        companyId: connection.companyId,
        profileId: profile.id,
        selectorType: "connection",
        effect: "include",
        applicationId: connection.applicationId,
        connectionId: connection.id,
      });
    }
    return profile;
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

  async function ensureDefaultWorkspaceGrant(connection: typeof toolConnections.$inferSelect) {
    const [existing] = await db
      .select()
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "workspace"),
        eq(connectionGrants.isDefault, true),
      ))
      .limit(1);
    if (existing) return existing;
    const [created] = await db
      .insert(connectionGrants)
      .values({
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: "workspace",
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

  async function syncCredentialBindings(connection: typeof toolConnections.$inferSelect) {
    await db
      .delete(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, connection.companyId),
          eq(companySecretBindings.targetType, "tool_connection"),
          eq(companySecretBindings.targetId, connection.id),
        ),
      );
    const bindings = [
      ...connection.credentialRefs.map((ref) => ({
        secretId: ref.secretId,
        configPath: `credentials.${ref.name}`,
        projectionClass: "unclassified",
        projectionAllowlistKey: null,
      })),
      ...connection.credentialSecretRefs.map((ref) => ({
        secretId: ref.secretId,
        configPath: ref.configPath,
        projectionClass: ref.projectionClass ?? "unclassified",
        projectionAllowlistKey: ref.projectionAllowlistKey ?? null,
      })),
    ];
    if (bindings.length === 0) return;
    await db.insert(companySecretBindings).values(bindings.map((ref) => ({
      companyId: connection.companyId,
      secretId: ref.secretId,
      targetType: "tool_connection" as const,
      targetId: connection.id,
      configPath: ref.configPath,
      projectionClass: ref.projectionClass,
      projectionAllowlistKey: ref.projectionAllowlistKey,
    })));
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

  async function resolveCredentialHeaders(connection: typeof toolConnections.$inferSelect): Promise<Record<string, string>> {
    try {
      connection = await maybeRefreshOAuthCredentials(connection);
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
      try {
        value = await secrets.resolveSecretValue(connection.companyId, ref.secretId, ref.version ?? "latest", {
          consumerType: "tool_connection",
          consumerId: connection.id,
          configPath: `credentials.${ref.name}`,
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

  async function remoteTools(connection: typeof toolConnections.$inferSelect): Promise<McpToolDescriptor[]> {
    const headers = await resolveCredentialHeaders(connection);
    const endpoint = await assertRemoteEndpointAllowed(connection.config);
    const response = await fetch(endpoint, {
      method: "POST",
      // MCP Streamable HTTP requires advertising that we accept both a JSON body
      // and an SSE stream; spec-compliant servers 406 without it (see mcp-http.ts).
      headers: mcpHttpRequestHeaders(headers),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "paperclip-catalog-refresh",
        method: "tools/list",
        params: {},
      }),
    });
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
              metadataUrl: endpoints.metadataUrl ?? null,
              scopes: endpoints.scopes,
              grantType: endpoints.grantType ?? "authorization_code",
              discoveredAt: new Date().toISOString(),
            },
          };
          await db
            .update(toolConnections)
            .set({ config: nextConfig, transportConfig: nextConfig, updatedAt: new Date() })
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
      throw new HttpError(502, "Remote app returned an error", { status: response.status });
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

  async function discoverTools(connection: typeof toolConnections.$inferSelect): Promise<McpToolDescriptor[]> {
    if (connection.transport === "mcp_remote") return remoteTools(connection);
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
        await remoteTools(connection);
      } else {
        await resolveCredentialHeaders(connection);
        await stdioTemplateId(connection.companyId, connection.config);
      }
      const updated = await updateConnectionHealth(connection, "ok", connection.transport === "local_stdio"
        ? "Approved stdio template is ready."
        : "Remote MCP server responded to tools/list.");
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
      throw new HttpError(failure.status === "missing_secret" ? 422 : 502, failure.message, {
        code: failure.code,
        connection: toConnection(updated),
        runtimeSlot,
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
      });
    }
  }

  async function refreshCatalog(connectionId: string, actor?: ActorInfo): Promise<ToolCatalogRefreshResult> {
    const connection = await getConnectionRow(connectionId);
    const now = new Date();
    let descriptors: McpToolDescriptor[];
    try {
      descriptors = await discoverTools(connection);
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
      throw new HttpError(failure.status === "missing_secret" ? 422 : 502, failure.message, {
        code: failure.code,
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
      });
    }

    const existingRows = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connection.id));
    const existingByName = new Map(existingRows.map((entry) => [entry.toolName, entry]));
    const updatedEntries: ToolCatalogEntry[] = [];
    let quarantinedCount = 0;
    const quarantineOnRefresh = shouldQuarantineNewEntries(connection) && connection.status === "active";
    const safeDefault = asRecord(connection.config).safeDefault === true;
    for (const descriptor of descriptors) {
      const riskLevel = classifyRisk(descriptor);
      const hash = descriptorHash(descriptor);
      const schemaHash = stableHash(descriptor.inputSchema ?? {});
      const existing = existingByName.get(descriptor.name);
      const changed = existing && (existing.versionHash !== hash || existing.schemaHash !== schemaHash);
      const shouldQuarantine =
        quarantineOnRefresh
        && (!existing || changed)
        && existing?.status !== "disabled"
        && (!safeDefault || riskLevel !== "read");
      const status = shouldQuarantine
        ? "quarantined"
        : existing?.status === "disabled"
          ? "disabled"
          : existing?.status === "quarantined"
            ? "quarantined"
            : "active";
      if (shouldQuarantine) quarantinedCount += 1;

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
            lastSeenAt: now,
            quarantinedAt: shouldQuarantine ? now : existing.quarantinedAt,
            quarantineReason: shouldQuarantine ? "pending_review" : existing.quarantineReason,
            updatedAt: now,
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
          firstSeenAt: now,
          lastSeenAt: now,
          quarantinedAt: shouldQuarantine ? now : null,
          quarantineReason: shouldQuarantine ? "pending_review" : null,
        }).returning();
        updatedEntries.push(toCatalogEntry(created));
      }
    }

    const [updatedConnection] = await db
      .update(toolConnections)
      .set({
        healthStatus: "ok",
        healthMessage: "Tool catalog refreshed.",
        healthCheckedAt: now,
        lastHealthAt: now,
        lastCatalogRefreshAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(toolConnections.id, connection.id))
      .returning();

    if (connection.transport === "local_stdio") {
      await ensureRuntimeSlot(updatedConnection);
      await db
        .update(toolRuntimeSlots)
        .set({ healthStatus: "ok", healthMessage: "Approved stdio template is ready.", lastHealthCheckAt: now, updatedAt: now })
        .where(eq(toolRuntimeSlots.connectionId, connection.id));
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
      return url.hostname.replace(/^www\./, "") || "MCP app";
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
      const headerName = configPath.slice("headers.".length).trim();
      if (!headerName) continue;
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

  function oauthClientForConnection(
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
    configPath: "oauth.access_token" | "oauth.refresh_token",
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

  async function authServerMetadataUrls(metadata: Record<string, unknown>): Promise<string[]> {
    const urls: string[] = [];
    if (Array.isArray(metadata.authorization_servers)) {
      for (const server of metadata.authorization_servers) {
        if (typeof server === "string" && server.trim()) {
          try {
            urls.push(new URL("/.well-known/oauth-authorization-server", server).toString());
          } catch {
            // Ignore malformed advertised issuers. The caller will fail if no usable endpoints remain.
          }
        }
      }
    }
    if (typeof metadata.issuer === "string" && metadata.issuer.trim()) {
      try {
        urls.push(new URL("/.well-known/oauth-authorization-server", metadata.issuer).toString());
      } catch {
        // Ignore malformed advertised issuers.
      }
    }
    return [...new Set(urls)];
  }

  async function endpointsFromMetadataUrl(
    connection: typeof toolConnections.$inferSelect,
    metadataUrl: string,
  ): Promise<OAuthProviderEndpoints | null> {
    const metadata = await fetchJsonRecord(metadataUrl);
    if (!metadata) return null;
    let authorizationUrl = typeof metadata.authorization_endpoint === "string" ? metadata.authorization_endpoint : null;
    let tokenUrl = typeof metadata.token_endpoint === "string" ? metadata.token_endpoint : null;
    if (!authorizationUrl || !tokenUrl) {
      for (const authMetadataUrl of await authServerMetadataUrls(metadata)) {
        const authMetadata = await fetchJsonRecord(authMetadataUrl);
        if (!authMetadata) continue;
        authorizationUrl = authorizationUrl ?? (typeof authMetadata.authorization_endpoint === "string" ? authMetadata.authorization_endpoint : null);
        tokenUrl = tokenUrl ?? (typeof authMetadata.token_endpoint === "string" ? authMetadata.token_endpoint : null);
        if (authorizationUrl && tokenUrl) break;
      }
    }
    if (!authorizationUrl || !tokenUrl) return null;
    return {
      provider: oauthProviderForConnection(connection, metadataUrl),
      scopes: normalizeOauthScopes(metadata.scopes_supported),
      authorizationUrl,
      tokenUrl,
      metadataUrl,
    };
  }

  async function discoverOAuthEndpoints(
    connection: typeof toolConnections.$inferSelect,
    challenge?: string | null,
  ): Promise<OAuthProviderEndpoints | null> {
    const oauth = oauthConfig(connection);
    const hints = challenge ? challengeOAuthHints(challenge) : null;
    const configuredAuthorizationUrl =
      typeof oauth.authorizationUrl === "string" ? oauth.authorizationUrl : hints?.authorizationUrl ?? null;
    const configuredTokenUrl = typeof oauth.tokenUrl === "string" ? oauth.tokenUrl : hints?.tokenUrl ?? null;
    const provider = oauthProviderForConnection(connection, typeof oauth.metadataUrl === "string" ? oauth.metadataUrl : hints?.metadataUrl);
    const scopes = normalizeOauthScopes(oauth.scopes).length > 0
      ? normalizeOauthScopes(oauth.scopes)
      : normalizeOauthScopes(oauth.scope).length > 0
        ? normalizeOauthScopes(oauth.scope)
        : normalizeOauthScopes(hints?.scope);
    const grantType = oauth.grantType === "client_credentials" || oauth.clientCredentials === true
      ? "client_credentials" as const
      : "authorization_code" as const;
    if (configuredAuthorizationUrl && configuredTokenUrl) {
      return {
        provider,
        scopes,
        authorizationUrl: configuredAuthorizationUrl,
        tokenUrl: configuredTokenUrl,
        grantType,
        metadataUrl: typeof oauth.metadataUrl === "string" ? oauth.metadataUrl : hints?.metadataUrl ?? null,
      };
    }

    const metadataCandidates = [
      typeof oauth.metadataUrl === "string" ? oauth.metadataUrl : null,
      hints?.metadataUrl ?? null,
    ].filter((value): value is string => Boolean(value));
    if (metadataCandidates.length === 0) {
      const endpoint = new URL(await assertRemoteEndpointAllowed(connection.config));
      metadataCandidates.push(new URL("/.well-known/oauth-protected-resource", endpoint.origin).toString());
      metadataCandidates.push(new URL("/.well-known/oauth-authorization-server", endpoint.origin).toString());
      metadataCandidates.push(new URL("/.well-known/openid-configuration", endpoint.origin).toString());
    }
    for (const metadataUrl of [...new Set(metadataCandidates)]) {
      const endpoints = await endpointsFromMetadataUrl(connection, metadataUrl);
      if (endpoints) return { ...endpoints, scopes: scopes.length > 0 ? scopes : endpoints.scopes, grantType };
    }
    return null;
  }

  async function oauthProviderEndpoints(app: AppDefinition): Promise<OAuthProviderEndpoints> {
    const method = connectionMethodFor(app);
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
    return { provider: app.slug, scopes: method.defaults?.scopesHint ?? [], authorizationUrl, tokenUrl, grantType: "authorization_code", metadataUrl };
  }

  async function oauthEndpointsForConnection(
    connection: typeof toolConnections.$inferSelect,
    challenge?: string | null,
    redirectUri?: string,
  ): Promise<OAuthProviderEndpoints> {
    const smokeLabEndpoints = smokeLabOAuthEndpoints(connection, redirectUri);
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    const endpoints = smokeLabEndpoints
      ?? (galleryEntry && connectionMethodFor(galleryEntry).auth === "oauth"
      ? await oauthProviderEndpoints(galleryEntry)
      : await discoverOAuthEndpoints(connection, challenge));
    if (!endpoints) throw unprocessable("This app connection does not advertise OAuth sign in");
    assertNotSmokeLabOAuthEndpoints(connection, endpoints);
    return endpoints;
  }

  async function oauthGalleryEntryForConnection(connection: typeof toolConnections.$inferSelect) {
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    if (!sourceTemplateKey) throw unprocessable("This app connection was not created from the app gallery");
    const galleryEntry = getConnectableAppDefinition(sourceTemplateKey);
    if (!galleryEntry || connectionMethodFor(galleryEntry).auth !== "oauth") {
      throw unprocessable("This app connection does not use sign in");
    }
    return galleryEntry;
  }

  async function createOrRotateOAuthSecret(input: {
    companyId: string;
    connection: typeof toolConnections.$inferSelect;
    configPath: "oauth.access_token" | "oauth.refresh_token";
    label: string;
    value: string;
    actor?: ActorInfo;
    existingRefs?: typeof connectionGrants.$inferSelect.credentialSecretRefs;
  }) {
    const existing = input.existingRefs === undefined
      ? oauthSecretRef(input.connection, input.configPath)
      : input.existingRefs.find((ref) => ref.configPath === input.configPath);
    if (existing) {
      await secrets.rotate(existing.secretId, { value: input.value }, actorForSecret(input.actor));
      return existing;
    }
    const secret = await secrets.create(input.companyId, {
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

  async function exchangeOAuthToken(input: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string | null;
    grantType?: "authorization_code" | "refresh_token" | "client_credentials";
    scopes?: string[];
    redirectUri?: string | null;
    codeVerifier?: string | null;
    code?: string | null;
    refreshToken?: string | null;
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
    body.set("client_id", input.clientId);
    if (input.clientSecret) body.set("client_secret", input.clientSecret);

    const response = await fetchRemoteHttpUrl(input.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    const record = asRecord(payload);
    if (!response.ok || record.ok === false) {
      const message = typeof record.error_description === "string"
        ? record.error_description
        : typeof record.error === "string"
          ? record.error
          : "OAuth token exchange failed";
      throw new HttpError(502, message, { code: "oauth_token_exchange_failed", status: response.status });
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
    const client = oauthClientForConnection(connection, oauth.provider);
    if (!client.clientId) throw unprocessable(`OAuth client id is not configured for ${oauth.provider}`);
    const refreshToken = refreshRef
      ? await secrets.resolveSecretValue(connection.companyId, refreshRef.secretId, refreshRef.versionSelector ?? "latest", {
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
    const token = await exchangeOAuthToken({
      tokenUrl: oauth.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      grantType,
      scopes: normalizeOauthScopes(oauth.scopes).length > 0 ? normalizeOauthScopes(oauth.scopes) : normalizeOauthScopes(oauth.scope),
      refreshToken,
    });
    const accessRef = await createOrRotateOAuthSecret({
      companyId: connection.companyId,
      connection,
      configPath: "oauth.access_token",
      label: "OAuth access token",
      value: token.accessToken,
      actor,
    });
    const nextCredentialSecretRefs = [
      ...connection.credentialSecretRefs.filter((ref) => ref.configPath !== "oauth.access_token"),
      accessRef,
    ];
    if (token.refreshToken) {
      const nextRefreshRef = await createOrRotateOAuthSecret({
        companyId: connection.companyId,
        connection,
        configPath: "oauth.refresh_token",
        label: "OAuth refresh token",
        value: token.refreshToken,
        actor,
      });
      const filtered = nextCredentialSecretRefs.filter((ref) => ref.configPath !== "oauth.refresh_token");
      nextCredentialSecretRefs.splice(0, nextCredentialSecretRefs.length, ...filtered, nextRefreshRef);
    }
    const expiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
    const nextConfig = {
      ...connection.config,
      oauth: {
        ...oauth,
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
      .where(eq(toolConnections.id, connection.id))
      .returning();
    await syncCredentialBindings(updated);
    return updated;
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
    if (input.applicationId) {
      const [row] = await db.select().from(toolApplications).where(and(
        eq(toolApplications.id, input.applicationId),
        eq(toolApplications.companyId, companyId),
      ));
      if (!row) throw notFound("App not found");
      existingApplication = row;
    }

    const name = input.name ?? existingApplication?.name ?? galleryEntry?.name ?? defaultLinkName(input.link ?? "");
    const method = galleryEntry ? connectionMethodFor(galleryEntry) : null;
    const transport = method?.transport ?? "mcp_remote";
    const baseConfig = transport === "mcp_remote"
      ? { url: method?.defaults?.serverUrl ?? input.link ?? "" }
      : { templateId: method?.defaults?.templateKey };
    let config: Record<string, unknown> = galleryEntry
      ? { ...baseConfig, sourceTemplateKey: galleryEntry.slug, quarantineNewEntries: true }
      : { ...baseConfig, quarantineNewEntries: true };
    if (galleryEntry?.slug === GOOGLE_SHEETS_GALLERY_KEY) {
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
    if (transport === "mcp_remote") await assertRemoteEndpointAllowed(config);
    if (transport === "local_stdio") await stdioTemplateId(companyId, config);
    assertLocalStdioCanBeEnabled(transport, false);

    const credentialValues = input.credentialValues ?? {};
    const credentialSecretRefs: CreateToolConnection["credentialSecretRefs"] = [];
    const credentialRefs: McpConnectionCredentialRef[] = [];
    const createdSecretIds: string[] = [];
    let applicationRow: typeof toolApplications.$inferSelect | null = null;
    let connectionRow: typeof toolConnections.$inferSelect | null = null;
    let revivedConnectionPrevious: typeof toolConnections.$inferSelect | null = null;

    try {
      const credentialFields = galleryEntry ? credentialFieldsFor(galleryEntry) : linkCredentialFields(credentialValues);
      for (const field of credentialFields) {
        const value = credentialValues[field.configPath];
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

      if (existingApplication) {
        if (existingApplication.status !== "active") {
          [applicationRow] = await db.update(toolApplications)
            .set({ status: "draft", archivedAt: null, updatedAt: new Date() })
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
          description: galleryEntry?.description ?? `Connected app at ${input.link}`,
          type: transport === "mcp_remote" ? "mcp_http" : "mcp_stdio",
          status: "draft",
          metadata: galleryEntry ? { sourceTemplateKey: galleryEntry.slug, galleryKey: galleryEntry.slug } : { source: "link" },
        }).returning();
      }

      await assertSecretRefs(companyId, [...credentialRefs, ...credentialSecretRefs]);
      // Reconnecting an app revives its most recent archived connection instead
      // of inserting a fresh row: keeps the connection id (and its activity
      // history) stable and avoids the unique (company, name) constraint.
      if (existingApplication) {
        const [archived] = await db
          .select()
          .from(toolConnections)
          .where(and(
            eq(toolConnections.companyId, companyId),
            eq(toolConnections.applicationId, existingApplication.id),
            eq(toolConnections.status, "archived"),
          ))
          .orderBy(desc(toolConnections.updatedAt))
          .limit(1);
        revivedConnectionPrevious = archived ?? null;
      }
      if (revivedConnectionPrevious) {
        [connectionRow] = await db.update(toolConnections).set({
          name,
          transport,
          status: "draft",
          enabled: false,
          config,
          transportConfig: config,
          credentialRefs,
          credentialSecretRefs,
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
          authKind: galleryEntry ? connectionMethodFor(galleryEntry).auth : "none",
          transport,
          status: "draft",
          enabled: false,
          config,
          transportConfig: config,
          credentialRefs,
          credentialSecretRefs,
          createdByAgentId: actor?.actorType === "agent" ? actor.actorId ?? null : null,
          createdByUserId: actor?.actorType === "user" ? actor.actorId ?? null : null,
        }).returning();
      }
      await syncCredentialBindings(connectionRow);
      await ensureRuntimeSlot(connectionRow);

      if (galleryEntry && connectionMethodFor(galleryEntry).auth === "oauth") {
        return {
          connectionId: connectionRow.id,
          application: toApplication(applicationRow),
          connection: toConnection(connectionRow),
          catalog: [],
          actions: { readOnly: [], canMakeChanges: [] },
          suggestedDefaults: recommendedDefaultsForApp(galleryEntry),
          auth: { kind: "oauth", startUrl: null },
        };
      }

      try {
        await checkConnectionHealth(connectionRow.id, actor);
      } catch (error) {
        if (!galleryEntry && error instanceof HttpError && asRecord(error.details).code === "oauth_challenge") {
          const [oauthConnection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionRow.id));
          const endpoints = await discoverOAuthEndpoints(oauthConnection).catch(() => null);
          if (!endpoints) throw error;
          return {
            connectionId: oauthConnection.id,
            application: toApplication(applicationRow),
            connection: toConnection(oauthConnection),
            catalog: [],
            actions: { readOnly: [], canMakeChanges: [] },
            suggestedDefaults: {
              access: "all_agents",
              askFirstRiskLevels: ["write", "destructive"],
            },
            auth: { kind: "oauth", startUrl: null },
          };
        }
        throw error;
      }
      const refresh = await refreshCatalog(connectionRow.id, actor);
      const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationRow.id));
      return {
        connectionId: refresh.connection.id,
        application: toApplication(application),
        connection: refresh.connection,
        catalog: refresh.catalog,
        actions: groupedActions(refresh.catalog),
        suggestedDefaults: galleryEntry ? recommendedDefaultsForApp(galleryEntry) : {
          access: "all_agents",
          askFirstRiskLevels: ["write", "destructive"],
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
    const enabledRows = await assertCatalogEntriesForConnection(companyId, connection.id, enabledIds);
    const askFirstRows = await assertCatalogEntriesForConnection(companyId, connection.id, input.askFirstCatalogEntryIds);
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
          .where(and(eq(toolCatalogEntries.companyId, companyId), inArray(toolCatalogEntries.id, enabledIds)));
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
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    const credentialFields = galleryEntry ? credentialFieldsFor(galleryEntry) : [
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

    const credentialSecretRefs = [...connection.credentialSecretRefs];
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

    const [updated] = await db
      .update(toolConnections)
      .set({ credentialRefs, credentialSecretRefs, lastError: null, updatedAt: new Date() })
      .where(eq(toolConnections.id, connection.id))
      .returning();
    await syncCredentialBindings(updated);
    return checkConnectionHealth(updated.id, actor);
  }

  async function startOAuth(
    companyId: string,
    connectionId: string,
    input: { redirectUri: string; actor: ActorInfo; subjectUserId?: string; scopes?: string[]; returnTo?: string; issueId?: string },
  ): Promise<ToolOAuthStartResult> {
    const connection = await getConnectionRow(connectionId, companyId);
    if (connection.status === "archived") throw conflict("Archived app connections cannot start sign in");
    const endpoints = await oauthEndpointsForConnection(connection, null, input.redirectUri);
    if (endpoints.grantType === "client_credentials") {
      throw unprocessable("This app uses shared machine credentials and does not need browser sign in");
    }
    const client = oauthClientForConnection(connection, endpoints.provider);
    if (!client.clientId) throw unprocessable(`OAuth client id is not configured for ${endpoints.provider}`);

    await db.delete(toolOauthStates).where(lt(toolOauthStates.expiresAt, new Date()));

    const state = randomOauthToken();
    const codeVerifier = randomOauthToken(48);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const binding = actorBinding(input.actor);
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
      subjectUserId: input.subjectUserId,
      requestedScopes: input.scopes,
      returnTo: input.returnTo,
      issueId: input.issueId,
      expiresAt,
    });

    const authorizationUrl = new URL(endpoints.authorizationUrl);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", client.clientId);
    authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", base64UrlSha256(codeVerifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    const authorizationScopes = input.scopes ?? endpoints.scopes;
    if (authorizationScopes.length > 0) authorizationUrl.searchParams.set("scope", authorizationScopes.join(" "));

    if (input.subjectUserId && input.issueId && binding.actorType === "agent") {
      const idempotencyKey = `connection-authorization:${connection.id}:${input.subjectUserId}`;
      const payload = {
        version: 1 as const,
        prompt: `Connect your account to ${connection.name}`,
        acceptLabel: "Open authorization",
        rejectLabel: "Not now",
        detailsMarkdown: "Authorization is required before this agent can act on your behalf.",
        target: {
          type: "custom" as const,
          key: `connection:${connection.uid}:user:${input.subjectUserId}`,
          revisionId: state,
          label: `Connect ${connection.name}`,
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
            idempotencyKey,
            sourceRunId: binding.actorType === "agent" ? input.actor.sessionId ?? null : null,
            title: "Connect your account",
            summary: `Connect ${connection.name} to continue`,
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
        metadataUrl: endpoints.metadataUrl ?? null,
        scopes: endpoints.scopes,
        grantType: "authorization_code",
        clientIdEnv: client.clientIdEnv,
        clientSecretEnv: client.clientSecret ? client.clientSecretEnv : null,
        credentialScope: credentialScope(connection, input.actor),
      },
    };
    await db
      .update(toolConnections)
      .set({ config: nextConfig, transportConfig: nextConfig, updatedAt: new Date() })
      .where(eq(toolConnections.id, connection.id));

    return {
      connectionId: connection.id,
      provider: endpoints.provider,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function peekOAuthState(state: string) {
    const [row] = await db
      .select({ companyId: toolOauthStates.companyId })
      .from(toolOauthStates)
      .where(eq(toolOauthStates.state, state))
      .limit(1);
    return row ?? null;
  }

  async function completeOAuthCallback(input: {
    state: string;
    code?: string | null;
    error?: string | null;
    errorDescription?: string | null;
    redirectUri: string;
    actor?: ActorInfo;
  }): Promise<ConnectToolAppResult> {
    if (input.error) throw badRequest(input.errorDescription ?? `OAuth provider returned ${input.error}`);
    if (!input.code) throw badRequest("OAuth callback is missing a code");
    const [stateRow] = await db
      .select()
      .from(toolOauthStates)
      .where(eq(toolOauthStates.state, input.state))
      .limit(1);
    if (!stateRow) throw badRequest("OAuth state was not found or has already been used");
    if (stateRow.expiresAt.getTime() <= Date.now()) throw badRequest("OAuth state has expired");
    if (stateRow.subjectUserId) {
      if (input.actor?.actorType !== "user" || input.actor.actorId !== stateRow.subjectUserId) {
        throw forbidden("OAuth callback user does not match the requested subject");
      }
    } else {
      assertSameOAuthActor(stateRow, input.actor);
    }
    await db.delete(toolOauthStates).where(eq(toolOauthStates.state, input.state));

    let connection = await getConnectionRow(stateRow.connectionId, stateRow.companyId);
    const sourceTemplateKey = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey : null;
    const galleryEntry = sourceTemplateKey ? getConnectableAppDefinition(sourceTemplateKey) : null;
    const endpoints = await oauthEndpointsForConnection(connection, null, input.redirectUri);
    const client = oauthClientForConnection(connection, endpoints.provider);
    if (!client.clientId) throw unprocessable(`OAuth client id is not configured for ${endpoints.provider}`);

    const token = await exchangeOAuthToken({
      tokenUrl: endpoints.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: input.redirectUri,
      codeVerifier: stateRow.codeVerifier,
      code: input.code,
    });
    const [existingUserGrant] = stateRow.subjectUserId
      ? await db.select().from(connectionGrants).where(and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, stateRow.subjectUserId),
        )).limit(1)
      : [undefined];
    const subjectCredentialSecretRefs = stateRow.subjectUserId
      ? existingUserGrant?.credentialSecretRefs ?? []
      : connection.credentialSecretRefs;
    const accessRef = await createOrRotateOAuthSecret({
      companyId: connection.companyId,
      connection,
      configPath: "oauth.access_token",
      label: "OAuth access token",
      value: token.accessToken,
      actor: input.actor,
      existingRefs: stateRow.subjectUserId ? subjectCredentialSecretRefs : undefined,
    });
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
        existingRefs: stateRow.subjectUserId ? subjectCredentialSecretRefs : undefined,
      }));
    } else {
      const existingRefreshRef = subjectCredentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token");
      if (existingRefreshRef) nextCredentialSecretRefs.push(existingRefreshRef);
    }
    const expiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
    if (stateRow.subjectUserId) {
      const grantValues = {
        credentialSecretRefs: nextCredentialSecretRefs,
        status: "active" as const,
        revokedAt: null,
        revokedByAgentId: null,
        revokedByUserId: null,
        updatedAt: new Date(),
      };
      if (existingUserGrant) {
        await db.update(connectionGrants).set(grantValues).where(eq(connectionGrants.id, existingUserGrant.id));
      } else {
        await db.insert(connectionGrants).values({
          companyId: connection.companyId,
          connectionId: connection.id,
          kind: "user",
          subjectUserId: stateRow.subjectUserId,
          ...grantValues,
          isDefault: false,
          createdByUserId: stateRow.subjectUserId,
        });
      }
      if (stateRow.interactionId) {
        await db.update(issueThreadInteractions).set({
          status: "accepted",
          result: { version: 1, outcome: "accepted" },
          resolvedByUserId: stateRow.subjectUserId,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        }).where(and(
          eq(issueThreadInteractions.id, stateRow.interactionId),
          eq(issueThreadInteractions.companyId, connection.companyId),
        ));
      }
      const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
      if (!application) throw new Error("OAuth connection application was not found");
      const catalog = (await db.select().from(toolCatalogEntries).where(and(
        eq(toolCatalogEntries.companyId, connection.companyId),
        eq(toolCatalogEntries.connectionId, connection.id),
      ))).map(toCatalogEntry);
      return {
        connectionId: connection.id,
        application: toApplication(application),
        connection: toConnection(connection),
        catalog,
        actions: groupedActions(catalog),
        suggestedDefaults: galleryEntry ? recommendedDefaultsForApp(galleryEntry) : { access: "all_agents", askFirstRiskLevels: ["write", "destructive"] },
        auth: null,
      };
    }
    const nextConfig = {
      ...connection.config,
      oauth: {
        ...oauthConfig(connection),
        provider: endpoints.provider,
        authorizationUrl: endpoints.authorizationUrl,
        tokenUrl: endpoints.tokenUrl,
        metadataUrl: endpoints.metadataUrl ?? null,
        scopes: endpoints.scopes,
        clientIdEnv: client.clientIdEnv,
        clientSecretEnv: client.clientSecret ? client.clientSecretEnv : null,
        credentialScope: credentialScope(connection, input.actor),
        expiresAt,
        scope: token.scope,
        tokenType: token.tokenType,
        connectedAt: new Date().toISOString(),
      },
      providerMetadata: {
        ...asRecord(connection.config.providerMetadata),
        oauth: { expiresAt, scope: token.scope, tokenType: token.tokenType },
      },
    };
    const [updatedConnection] = await db
      .update(toolConnections)
      .set({
        status: "active",
        enabled: isSmokeLabOAuthFixture(connection) ? true : false,
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
    await db
      .update(toolApplications)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(toolApplications.id, connection.applicationId));
    await syncCredentialBindings(connection);

    await checkConnectionHealth(connection.id, input.actor);
    const refresh = await refreshCatalog(connection.id, input.actor);
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
    return {
      connectionId: refresh.connection.id,
      application: toApplication(application),
      connection: refresh.connection,
      catalog: refresh.catalog,
      actions: groupedActions(refresh.catalog),
      suggestedDefaults: galleryEntry ? recommendedDefaultsForApp(galleryEntry) : {
        access: "all_agents",
        askFirstRiskLevels: ["write", "destructive"],
      },
      auth: null,
    };
  }

  /**
   * Build the connection lifecycle timeline for the Activity tab (PAP-11284) by
   * surfacing two existing audit sources scoped to this connection:
   *  - `activity_log` rows (connect / pause / resume / allowlist / reconnect / disconnect)
   *  - `tool_access_audit_events` catalog refreshes that quarantined new actions
   * Actors are resolved to display names (agent name or user name/email).
   */
  async function listConnectionLifecycleEvents(
    connection: typeof toolConnections.$inferSelect,
    limit: number,
  ): Promise<ToolConnectionLifecycleEvent[]> {
    const [logRows, quarantineRows] = await Promise.all([
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, connection.companyId),
            eq(activityLog.entityType, "tool_connection"),
            eq(activityLog.entityId, connection.id),
            inArray(activityLog.action, [...LIFECYCLE_ACTIVITY_LOG_ACTIONS]),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(limit),
      db
        .select()
        .from(toolAccessAuditEvents)
        .where(
          and(
            eq(toolAccessAuditEvents.companyId, connection.companyId),
            eq(toolAccessAuditEvents.connectionId, connection.id),
            eq(toolAccessAuditEvents.action, "tool_connection.catalog_refresh"),
            sql`(${toolAccessAuditEvents.details}->>'quarantinedCount')::int > 0`,
          ),
        )
        .orderBy(desc(toolAccessAuditEvents.createdAt))
        .limit(limit),
    ]);

    type Pending = {
      id: string;
      type: ToolConnectionLifecycleEventType;
      actorType: ToolConnectionLifecycleEvent["actorType"];
      actorId: string | null;
      agentId: string | null;
      details: Record<string, unknown> | null;
      createdAt: Date;
    };
    const pending: Pending[] = [];

    for (const row of logRows) {
      const type = activityLogActionToLifecycleType(row.action, row.details ?? null);
      if (!type) continue;
      pending.push({
        id: row.id,
        type,
        actorType: (row.actorType as Pending["actorType"]) ?? "system",
        actorId: row.actorId ?? null,
        agentId: row.agentId ?? null,
        details: row.details ?? null,
        createdAt: row.createdAt,
      });
    }

    for (const row of quarantineRows) {
      const count = Number((row.details as Record<string, unknown> | null)?.quarantinedCount ?? 0);
      pending.push({
        id: row.id,
        type: "actions_quarantined",
        actorType: (row.actorType as Pending["actorType"]) ?? "system",
        actorId: row.actorId ?? null,
        agentId: null,
        details: { count: Number.isFinite(count) ? count : 0 },
        createdAt: row.createdAt,
      });
    }

    pending.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const limited = pending.slice(0, limit);

    // Resolve actor display names in batch. Agent actors carry their id in
    // `agentId` (activity log) or `actorId` (audit events); user actors carry a
    // user id in `actorId`.
    const agentIds = new Set<string>();
    const userIds = new Set<string>();
    for (const item of limited) {
      if (item.agentId) agentIds.add(item.agentId);
      if (item.actorType === "agent" && item.actorId) agentIds.add(item.actorId);
      if (item.actorType === "user" && item.actorId && item.actorId !== "board") userIds.add(item.actorId);
    }
    const agentRows = agentIds.size
      ? await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, connection.companyId), inArray(agents.id, [...agentIds])))
      : [];
    const userRows = userIds.size
      ? await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(inArray(authUsers.id, [...userIds]))
      : [];
    const agentNames = new Map(agentRows.map((agent) => [agent.id, agent.name]));
    const userNames = new Map(
      userRows.map((user) => [user.id, user.name?.trim() || user.email?.trim() || user.id]),
    );

    return limited.map((item) => {
      let actorDisplayName: string | null = null;
      if (item.agentId) actorDisplayName = agentNames.get(item.agentId) ?? null;
      else if (item.actorType === "agent" && item.actorId) actorDisplayName = agentNames.get(item.actorId) ?? null;
      else if (item.actorType === "user" && item.actorId) {
        actorDisplayName = item.actorId === "board"
          ? "The board"
          : userNames.get(item.actorId) ?? userFallbackName(item.actorId);
      }
      return {
        id: item.id,
        connectionId: connection.id,
        type: item.type,
        actorType: item.actorType,
        actorId: item.actorId,
        agentId: item.agentId,
        actorDisplayName,
        details: item.details,
        createdAt: item.createdAt,
      };
    });
  }

  return {
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

    completeOAuthCallback,

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
        if (duplicate) throw conflict("A tool access record with that name already exists");
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

    createConnection: async (companyId: string, input: CreateToolConnection): Promise<ToolConnection> => {
      let applicationId = input.applicationId;
      let applicationNamespace = input.applicationName ?? input.name;
      const transport = input.transport;
      if (!transport) throw badRequest("Tool connection transport is required");
      const config = normalizeGoogleSheetsConnectionConfig(input.config ?? input.transportConfig ?? {});
      if (transport === "mcp_remote") await assertRemoteEndpointAllowed(config);
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
      await assertSecretRefs(companyId, [...(input.credentialRefs ?? []), ...(input.credentialSecretRefs ?? [])]);
      const connectionId = randomUUID();
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
        status: input.status ?? "draft",
        enabled: input.enabled ?? false,
        config,
        transportConfig: isGoogleSheetsConnectionConfig(config) ? config : input.transportConfig ?? config,
        credentialRefs: input.credentialRefs ?? [],
        credentialSecretRefs: input.credentialSecretRefs ?? [],
      }).returning();
      await ensureDefaultWorkspaceGrant(row);
      await syncCredentialBindings(row);
      await ensureRuntimeSlot(row);
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
      return { connection: { id: connection.id, uid: connection.uid }, grants };
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
          eq(connectionGrants.kind, "workspace"),
        ));
      }
      const binding = actorBinding(actor);
      const [grant] = await db.insert(connectionGrants).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: "workspace",
        providerTenant: input.providerTenant,
        credentialSecretRefs: input.credentialSecretRefs ?? [],
        status: "active",
        isDefault: input.isDefault ?? false,
        createdByAgentId: binding.actorType === "agent" ? binding.actorId : null,
        createdByUserId: binding.actorType === "user" ? binding.actorId : null,
      }).returning();
      if (!grant) throw new Error("Failed to create connection installation");
      return grant;
    },

    revokeConnectionGrant: async (idOrUid: string, grantId: string, actor?: ActorInfo) => {
      const connection = await getConnectionRow(idOrUid);
      const binding = actorBinding(actor);
      const [grant] = await db.update(connectionGrants).set({
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
      if (!grant) throw notFound("Connection grant not found");
      return grant;
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
        const removeIds = existing
          .filter((install) => !requested.has(`${install.targetType}:${install.targetId}`))
          .map((install) => install.id);
        if (removeIds.length > 0) await tx.delete(toolConnectionInstalls).where(inArray(toolConnectionInstalls.id, removeIds));
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
      if (existing.transport === "mcp_remote") await assertRemoteEndpointAllowed(config);
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
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, connectionId))
        .returning();
      await syncCredentialBindings(row);
      await ensureRuntimeSlot(row);
      return toConnection(row);
    },

    archiveConnection: async (connectionId: string): Promise<ToolConnection> => {
      const row = await db.transaction(async (tx) => {
        const [updatedConnection] = await tx
          .update(toolConnections)
          .set({ status: "archived", enabled: false, updatedAt: new Date() })
          .where(eq(toolConnections.id, connectionId))
          .returning();
        if (!updatedConnection) throw notFound("Tool connection not found");

        const remainingConnections = await tx
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.applicationId, updatedConnection.applicationId),
              ne(toolConnections.status, "archived"),
            ),
          )
          .limit(1);

        if (remainingConnections.length === 0) {
          const now = new Date();
          await tx
            .update(toolApplications)
            .set({ status: "archived", archivedAt: now, updatedAt: now })
            .where(eq(toolApplications.id, updatedConnection.applicationId));
        }

        return updatedConnection;
      });
      return toConnection(row);
    },

    checkHealth: checkConnectionHealth,

    refreshCatalog,

    listAppsNeedingAttention,

    sweepConnectionHealth,

    listCatalog: async (connectionId: string, companyId?: string): Promise<ToolCatalogEntry[]> => {
      const connection = await getConnectionRow(connectionId, companyId);
      const rows = await db
        .select()
        .from(toolCatalogEntries)
        .where(eq(toolCatalogEntries.connectionId, connection.id))
        .orderBy(desc(toolCatalogEntries.updatedAt));
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

      const lifecycleEvents = await listConnectionLifecycleEvents(connection, safeLimit);

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
        const invalidRequestIds = requests
          .filter((request) => {
            const invocation = invocationById.get(request.invocationId);
            if (!invocation) return true;
            try {
              return !readSignedToolArgumentsPayload({
                signedArguments: request.signedArguments,
                invocationId: invocation.id,
                toolName: invocation.toolName,
              });
            } catch {
              return true;
            }
          })
          .map((request) => request.id);
        if (invalidRequestIds.length > 0) {
          await db
            .update(toolActionRequests)
            .set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date() })
            .where(and(
              eq(toolActionRequests.companyId, companyId),
              eq(toolActionRequests.status, "pending"),
              inArray(toolActionRequests.id, invalidRequestIds),
            ));
          const invalidIds = new Set(invalidRequestIds);
          visibleRequests = requests.filter((request) => !invalidIds.has(request.id));
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
      const bindings = narrowestScopeBindings(allBindings.filter((binding) =>
        (binding.targetType === "company" && binding.targetId === companyId)
        || (binding.targetType === "agent" && binding.targetId === agentId)
      ));
      if (bindings.length === 0) {
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
      const profileIds = profileIdsInBindingOrder(bindings);
      const profiles = await db
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, companyId), inArray(toolProfiles.id, profileIds)));
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
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

      const subject = input.body.subject ?? { type: "app" as const };
      if (subject.type === "user" && subject.userId !== runContext.responsibleUserId) {
        await fail(403, "The agent run cannot act as the requested user", "denied", "subject_not_permitted", {
          connection: { uid: connection.uid },
          subject,
        });
      }

      let grant: typeof connectionGrants.$inferSelect;
      if (subject.type === "user") {
        const conditions = [
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, subject.userId),
        ];
        if (input.body.grantId) conditions.push(eq(connectionGrants.id, input.body.grantId));
        [grant] = await db.select().from(connectionGrants).where(and(...conditions)).limit(1);
        if (!grant) {
          await fail(409, "User authorization is required", "denied", "user_authorization_required", {
            connection: { uid: connection.uid },
            subject,
            remediation: { action: "start_authorization" },
          });
        }
      } else if (input.body.grantId) {
        [grant] = await db.select().from(connectionGrants).where(and(
          eq(connectionGrants.id, input.body.grantId),
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "workspace"),
        )).limit(1);
        if (!grant) {
          await fail(409, "The requested installation is not available", "denied", "installation_required", {
            connection: { uid: connection.uid },
            subject,
            remediation: { action: "add_installation" },
          });
        }
      } else {
        grant = await ensureDefaultWorkspaceGrant(connection);
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

      try {
        const minted = await mintExchangeConnectionToken({
          connection: credentialConnection,
          application,
          agentId: input.agentId,
          runId: input.runId,
          issueId: runContext.issueId,
          responsibleUserId: runContext.responsibleUserId,
          scope: issuedScope,
          ttlSeconds,
        });
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
        });
        await db.update(connectionGrants).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(connectionGrants.id, grant.id));
        await auditConnectionTokenIssuance({
          companyId: connection.companyId,
          connectionId: connection.id,
          agentId: input.agentId,
          runId: input.runId,
          path,
          outcome: "success",
          details: { ttlSeconds: effectiveTtlSeconds, scopeCount: mintedScope.length, tokenRef: tokenHash },
        });
        return {
          status: "minted",
          connectionId: connection.id,
          connection: { id: connection.id, uid: connection.uid },
          grantId: grant.id,
          providerTenantId: grant.providerTenant?.externalId,
          path: "exchange",
          token: minted.token,
          tokenType: minted.tokenType,
          expiresAt: expiresAt.toISOString(),
          ttlSeconds: effectiveTtlSeconds,
          scope: mintedScope,
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
        throw conflict("A tool access record with that name already exists");
      }
      throw error;
    },
  };
}
