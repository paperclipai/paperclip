import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  documents,
  heartbeatRuns,
  issueApprovals,
  issueDocuments,
  issueThreadInteractions,
  issues,
  projects,
  toolActionRequests,
  toolAccessAuditEvents,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolGatewayRateLimitCounters,
  toolGatewaySessions,
  toolInvocations,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolStdioCommandTemplates,
} from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type {
  CreateToolMcpGateway,
  CreateToolMcpGatewayToken,
  DeploymentExposure,
  DeploymentMode,
  McpConnectionCredentialRef,
  SecretVersionSelector,
  ToolAccessDecision,
  ToolAccessDecisionInput,
  ToolConnectionTestCallStatus,
  ToolConnectionTestCallStatusPhase,
  ToolCredentialSecretRef,
  ToolMcpGateway,
  ToolMcpGatewayClientSnippet,
  ToolMcpGatewayToken,
  ToolMcpGatewayTokenAction,
  ToolMcpGatewayTokenCreated,
  ToolMcpGatewayWithTokens,
  UpdateToolMcpGateway,
} from "@paperclipai/shared";
import type { AgentToolDescriptor, PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { mcpHttpRequestHeaders, parseMcpHttpResponseBody } from "./mcp-http.js";
import { assertPublicRemoteHttpEndpoint, parseRemoteHttpEndpoint } from "./remote-http-endpoint-guard.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  createToolRuntimeSupervisor,
  ToolRuntimeSupervisorError,
  type ToolRuntimeSupervisorOptions,
  type ToolRuntimeSlotView,
} from "./tool-runtime-supervisor.js";
import { recordToolRuntimeAuditWriteFailure } from "./tool-runtime-metrics.js";
import {
  canonicalToolArguments,
  readSignedToolArgumentsPayload,
  signToolArguments,
  summarizeToolValue,
  ToolActionSigningSecretMissingError,
  ToolContentValidationError,
  validateToolContent,
  verifyToolArgumentsSignature,
} from "./tool-content-guards.js";

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
// When a human approves a parked write, the server carries it out on their
// behalf with no interactive caller left to raise `timeoutMs`. Remote write
// providers (e.g. Zapier Google Sheets `add_row`) routinely take longer than
// the 10s interactive default, so an approved action would otherwise abort with
// `tool_timeout` even though the approval succeeded. Give approved executions
// the full permitted headroom instead.
const APPROVED_EXECUTION_TIMEOUT_MS = 60_000;
const MAX_REMOTE_MCP_RESPONSE_BYTES = 1_000_000;
const ACTIVE_GATEWAY_RUN_STATUSES = new Set(["running"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type McpGatewayProtocolMethod = "initialize" | "tools/list" | "tools/call";
type McpGatewayRateLimitConfig = { windowMs: number; max: number };
type McpGatewayRateLimitState = { limited: boolean; count: number; retryAfterMs: number };
type McpGatewayProtocolLimitOptions = {
  authFailures: McpGatewayRateLimitConfig;
  gatewayRequests: McpGatewayRateLimitConfig;
  tokenRequests: McpGatewayRateLimitConfig;
  sessionSetup: McpGatewayRateLimitConfig;
};

const DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS: McpGatewayProtocolLimitOptions = {
  authFailures: { windowMs: 5 * 60 * 1000, max: 20 },
  gatewayRequests: { windowMs: 60 * 1000, max: 300 },
  tokenRequests: { windowMs: 60 * 1000, max: 120 },
  sessionSetup: { windowMs: 60 * 1000, max: 30 },
};
const TOOL_APPROVAL_DESCRIPTION_SUFFIX =
  "Requires human approval: calling it posts an approval card on your task and you will be woken with the result once decided.";

export type ToolGatewayProviderType =
  | "mcp_http_fixture"
  | "mcp_stdio_fixture"
  | "mcp_remote_http"
  | "mcp_local_stdio"
  | "paperclip_self"
  | "paperclip_plugin"
  | "paperclip_virtual";

export interface ConnectedMcpGatewayMetadata {
  applicationId: string;
  applicationKey: string | null;
  applicationDisplayName: string;
  connectionId: string;
  catalogEntryId: string;
  transport: "remote_http" | "local_stdio";
  gatewayToolName: string;
  upstreamToolName: string;
  catalogName: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown>;
  risk: {
    level: string;
    isReadOnly: boolean;
    isWrite: boolean;
    isDestructive: boolean;
  };
  onDemandTools?: boolean;
}

export interface ToolGatewayDescriptor extends AgentToolDescriptor {
  providerType: ToolGatewayProviderType;
  risk: "read" | "write" | "destructive";
  applicationId?: string | null;
  applicationKey?: string | null;
  applicationDisplayName?: string | null;
  connectionId?: string | null;
  catalogEntryId?: string | null;
  upstreamToolName?: string | null;
  providerMetadata?: ConnectedMcpGatewayMetadata | Record<string, unknown>;
}

export interface ToolGatewaySession {
  id: string;
  token: string;
  companyId: string;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  projectId: string | null;
  gatewayId?: string | null;
  gatewayPublicId?: string | null;
  gatewayName?: string | null;
  gatewayTokenId?: string | null;
  gatewayTokenAllowedActions?: ToolMcpGatewayTokenAction[];
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export type ToolGatewayRuntimeSlot = ToolRuntimeSlotView;

export class ToolGatewayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reasonCode: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface ExecuteGatewayToolInput {
  sessionToken: string;
  gatewayId?: string | null;
  gatewayPublicId?: string | null;
  tool: string;
  parameters?: unknown;
  timeoutMs?: number;
  approvedActionRequestId?: string | null;
  idempotencyKey?: string | null;
  callerHeaders?: Record<string, string | string[] | undefined>;
}

interface ExecuteTestCallInput {
  companyId: string;
  connectionId: string;
  agentId: string;
  userId: string;
  toolName: string;
  parameters?: unknown;
  timeoutMs?: number;
}

interface ExecutePluginToolInput {
  actor: { type: "agent" | "board"; agentId?: string | null; companyId?: string | null; userId?: string | null; runId?: string | null };
  tool: string;
  parameters: unknown;
  runContext: ToolRunContext;
}

type HeaderPolicyConfig = {
  staticHeaders: Array<{ name: string; value: string }>;
  passthroughAllowlist: string[];
  metadataHeaders: Array<"company_id" | "agent_id" | "issue_id" | "project_id" | "run_id" | "gateway_session_id" | "correlation_id">;
};

type HeaderPolicySummary = {
  staticHeaderNames: string[];
  credentialHeaderNames: string[];
  passthroughHeaderNames: string[];
  droppedPassthroughHeaderNames: string[];
  metadataHeaderNames: string[];
  collisionRules: Array<{ header: string; source: string; action: string }>;
};

type RemoteHttpExecutionResult = {
  result: unknown;
  headerSummary?: HeaderPolicySummary;
  execution?: RemoteHttpExecutionAudit;
};

type RemoteHttpExecutionAudit = {
  transport: "remote_http";
  request: {
    protocol: "MCP JSON-RPC 2.0";
    httpMethod: "POST";
    endpoint: string;
    mcpMethod: "tools/call";
    requestId: string;
    upstreamToolName: string;
    dispatched: true;
  };
  response?: {
    httpStatus: number;
    contentType: string | null;
    bodySizeBytes: number;
    upstreamRequestId: string | null;
  };
};

type LocalStdioRuntimeTemplate = {
  templateId: string;
  command: string | null;
  args: string[];
  envKeys: string[];
};

const BUILTIN_LOCAL_STDIO_RUNTIME_TEMPLATES: Record<string, Omit<LocalStdioRuntimeTemplate, "templateId">> = {
  "paperclip.google-sheets": {
    command: "paperclip-google-sheets-mcp-server",
    args: [],
    envKeys: [
      "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON",
      "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH",
      "GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS",
    ],
  },
  "paperclip.echo-calculator-time": {
    command: null,
    args: [],
    envKeys: [],
  },
  "paperclip.synthetic-todo-kv": {
    command: null,
    args: [],
    envKeys: [],
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const sensitivePassthroughHeaderPattern = /(^|[-_])(auth|authorization|cookie|secret|session|token)([-_]|$)|(^|[-_])api[-_]?key([-_]|$)/i;
const sensitivePassthroughHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-paperclip-tool-gateway-token",
]);

function isSensitivePassthroughHeader(name: string) {
  return name.startsWith("x-paperclip-")
    || sensitivePassthroughHeaderNames.has(name)
    || sensitivePassthroughHeaderPattern.test(name);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function auditSafeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "configured remote MCP endpoint";
  }
}

function executionAuditFromError(error: unknown): RemoteHttpExecutionAudit | undefined {
  if (!(error instanceof ToolGatewayHttpError)) return undefined;
  const execution = error.details.execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) return undefined;
  return execution as RemoteHttpExecutionAudit;
}

function generateGatewayToken(sessionId: string) {
  return `pcgt_${sessionId}.${randomBytes(32).toString("base64url")}`;
}

function generateNamedGatewayToken(tokenId: string) {
  return `pcgw_${tokenId}.${randomBytes(32).toString("base64url")}`;
}

function hashGatewayToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sessionIdFromGatewayToken(token: string) {
  const match = token.match(/^pcgt_([0-9a-fA-F-]{36})\.[A-Za-z0-9_-]+$/);
  return match?.[1] ?? null;
}

function namedGatewayTokenId(token: string) {
  const match = token.match(/^pcgw_([0-9a-fA-F-]{36})\.[A-Za-z0-9_-]+$/);
  return match?.[1] ?? null;
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mergeLimitConfig(
  defaults: McpGatewayRateLimitConfig,
  overrides: Partial<McpGatewayRateLimitConfig> | undefined,
): McpGatewayRateLimitConfig {
  return {
    windowMs: overrides?.windowMs && overrides.windowMs > 0 ? overrides.windowMs : defaults.windowMs,
    max: overrides?.max && overrides.max > 0 ? overrides.max : defaults.max,
  };
}

function mcpGatewayProtocolLimits(
  overrides: Partial<{
    authFailures: Partial<McpGatewayRateLimitConfig>;
    gatewayRequests: Partial<McpGatewayRateLimitConfig>;
    tokenRequests: Partial<McpGatewayRateLimitConfig>;
    sessionSetup: Partial<McpGatewayRateLimitConfig>;
  }> | undefined,
): McpGatewayProtocolLimitOptions {
  const envDefaults: McpGatewayProtocolLimitOptions = {
    authFailures: {
      windowMs: positiveInt(process.env.PAPERCLIP_MCP_GATEWAY_AUTH_FAILURE_WINDOW_MS, DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS.authFailures.windowMs),
      max: positiveInt(process.env.PAPERCLIP_MCP_GATEWAY_AUTH_FAILURE_LIMIT, DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS.authFailures.max),
    },
    gatewayRequests: {
      windowMs: positiveInt(process.env.PAPERCLIP_MCP_GATEWAY_REQUEST_WINDOW_MS, DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS.gatewayRequests.windowMs),
      max: positiveInt(process.env.PAPERCLIP_MCP_GATEWAY_REQUEST_LIMIT, DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS.gatewayRequests.max),
    },
    tokenRequests: {
      windowMs: positiveInt(process.env.PAPERCLIP_MCP_GATEWAY_TOKEN_REQUEST_WINDOW_MS, DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS.tokenRequests.windowMs),
      max: positiveInt(process.env.PAPERCLIP_MCP_GATEWAY_TOKEN_REQUEST_LIMIT, DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS.tokenRequests.max),
    },
    sessionSetup: {
      windowMs: positiveInt(process.env.PAPERCLIP_MCP_GATEWAY_SESSION_SETUP_WINDOW_MS, DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS.sessionSetup.windowMs),
      max: positiveInt(process.env.PAPERCLIP_MCP_GATEWAY_SESSION_SETUP_LIMIT, DEFAULT_MCP_GATEWAY_PROTOCOL_LIMITS.sessionSetup.max),
    },
  };
  return {
    authFailures: mergeLimitConfig(envDefaults.authFailures, overrides?.authFailures),
    gatewayRequests: mergeLimitConfig(envDefaults.gatewayRequests, overrides?.gatewayRequests),
    tokenRequests: mergeLimitConfig(envDefaults.tokenRequests, overrides?.tokenRequests),
    sessionSetup: mergeLimitConfig(envDefaults.sessionSetup, overrides?.sessionSetup),
  };
}

function tokenPrefixFromNamedBearer(token: string) {
  const tokenId = namedGatewayTokenId(token);
  if (tokenId) return `pcgw_${tokenId.slice(0, 8)}`;
  return token.startsWith("pcgw_") ? "pcgw_malformed" : "unknown";
}

function safeHeaderValue(headers: Record<string, string | string[] | undefined> | undefined, name: string, maxLength = 160) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const sanitized = raw.replace(/[\r\n\t]/g, " ").trim();
  return sanitized ? sanitized.slice(0, maxLength) : null;
}

function safeClientMetadata(headers: Record<string, string | string[] | undefined> | undefined) {
  const clientName = safeHeaderValue(headers, "x-paperclip-client-name", 120)
    ?? safeHeaderValue(headers, "mcp-client-name", 120)
    ?? null;
  const correlationId = safeHeaderValue(headers, "x-request-id", 120)
    ?? safeHeaderValue(headers, "x-correlation-id", 120)
    ?? null;
  return {
    clientName,
    correlationId,
    userAgent: safeHeaderValue(headers, "user-agent", 200),
  };
}

function rateLimitWindowStart(current: number, windowMs: number) {
  return new Date(Math.floor(current / windowMs) * windowMs);
}

function gatewaySessionFromRow(row: typeof toolGatewaySessions.$inferSelect): ToolGatewaySession {
  return {
    id: row.id,
    token: "",
    companyId: row.companyId,
    agentId: row.agentId,
    runId: row.runId,
    issueId: row.issueId,
    projectId: row.projectId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function timeoutMs(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.max(1, Math.min(60_000, Math.floor(value ?? DEFAULT_TOOL_TIMEOUT_MS)));
}

function sessionTtlMs(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_SESSION_TTL_MS;
  return Math.max(1_000, Math.min(MAX_SESSION_TTL_MS, Math.floor(value ?? DEFAULT_SESSION_TTL_MS)));
}

function summarizeResult(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (!record) return { type: typeof result };
  const content = typeof record.content === "string" ? record.content : null;
  return {
    hasContent: content !== null,
    contentLength: content?.length ?? 0,
    hasData: record.data !== undefined,
    hasError: Boolean(record.error),
  };
}

function inferToolRisk(toolName: string): ToolGatewayDescriptor["risk"] {
  const lower = toolName.toLowerCase();
  if (/\b(delete|destroy|remove|drop|truncate|wipe|purge)\b|(^|[:._-])(delete|destroy|remove|drop|truncate|wipe|purge)([:._-]|$)/.test(lower)) {
    return "destructive";
  }
  if (/\b(create|update|write|edit|patch|post|send|publish|merge|commit|apply)\b|(^|[:._-])(create|update|write|edit|patch|post|send|publish|merge|commit|apply)([:._-]|$)/.test(lower)) {
    return "write";
  }
  return "read";
}

function riskFromCatalogEntry(entry: Pick<typeof toolCatalogEntries.$inferSelect, "riskLevel" | "isReadOnly" | "isWrite" | "isDestructive">): ToolGatewayDescriptor["risk"] {
  if (entry.riskLevel === "destructive" || entry.isDestructive || entry.riskLevel === "critical" || entry.riskLevel === "high") {
    return "destructive";
  }
  if (entry.riskLevel === "write" || entry.isWrite || entry.riskLevel === "medium") {
    return "write";
  }
  return "read";
}

function slugSegment(value: string | null | undefined, fallback: string): string {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

function shortStableId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

function toolRequiresFormalApproval(tool: ToolGatewayDescriptor): boolean {
  return tool.risk === "destructive";
}

function toolAuditMetadata(tool: ToolGatewayDescriptor): Record<string, unknown> {
  return {
    applicationId: tool.applicationId ?? null,
    applicationKey: tool.applicationKey ?? null,
    connectionId: tool.connectionId ?? null,
    catalogEntryId: tool.catalogEntryId ?? null,
    upstreamToolName: tool.upstreamToolName ?? tool.name,
    providerType: tool.providerType,
    risk: tool.risk,
    riskLevel: tool.risk,
  };
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function normalizeSignedApprovalSnapshot(value: unknown): Record<string, unknown> | null {
  return asRecord(value);
}

function approvalSnapshotsMatch(reviewed: unknown, live: Record<string, unknown> | null): boolean {
  const reviewedRecord = normalizeSignedApprovalSnapshot(reviewed);
  if (!reviewedRecord && !live) return true;
  if (!reviewedRecord || !live) return false;
  return stableSerialize(reviewedRecord) === stableSerialize(live);
}

type ConnectedCredentialVersionSnapshot = {
  refHash: string;
  versionSelector: string;
  resolvedVersion: number;
};

const REDACTED_ARGUMENT_SENTINEL = "***REDACTED***";

/** Turn a machine field key (`note_body`, `noteBody`, `note-body`) into a Title-Cased label. */
function humanizeArgumentKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** Identifier-ish fields leak raw IDs into the prosumer card; the vocab gate forbids them. */
function isIdentifierArgumentKey(key: string): boolean {
  return /(^|[_-])(id|ids|uuid|guid|key|token|hash|sha\d*)$/i.test(key);
}

/** Render a single argument value as short, plain text — or null if it shouldn't be shown. */
function humanizeArgumentValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed === REDACTED_ARGUMENT_SENTINEL) return "hidden for privacy";
    return trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Build the prosumer-facing "Ask first" preview (M5/M7/M9). Deliberately free of the
 * words tool/risk/transport/arguments and of raw JSON — those only belong on the
 * Advanced surfaces (M8a/M8b) and the board-only formal-approval interaction.
 */
function buildHumanizedActionPreview(input: {
  tool: ToolGatewayDescriptor;
  argumentsSummary: ReturnType<typeof summarizeToolValue>;
}): string {
  const trustLine =
    input.tool.risk === "destructive"
      ? "It can permanently change or remove something, so we’re checking with you first."
      : "It can change something, so we’re checking with you first.";

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.argumentsSummary.summary);
  } catch {
    return trustLine;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return trustLine;

  const fieldLines: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (fieldLines.length >= 6) break;
    if (isIdentifierArgumentKey(key)) continue;
    const rendered = humanizeArgumentValue(value);
    if (rendered === null) continue;
    fieldLines.push(`**${humanizeArgumentKey(key)}:** ${rendered}`);
  }

  if (fieldLines.length === 0) return trustLine;
  return [trustLine, "", ...fieldLines].join("\n");
}

const BUILTIN_TOOLS: ToolGatewayDescriptor[] = [
  {
    name: "mcp-remote-fixture:echo",
    displayName: "Remote fixture echo",
    description: "Remote HTTP MCP fixture that echoes a message without spawning a local process.",
    parametersSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    pluginId: "mcp-remote-fixture",
    providerType: "mcp_http_fixture",
    risk: "read",
  },
  {
    name: "mcp-remote-fixture:add",
    displayName: "Remote fixture add",
    description: "Remote HTTP MCP fixture that adds two numbers without spawning a local process.",
    parametersSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
    pluginId: "mcp-remote-fixture",
    providerType: "mcp_http_fixture",
    risk: "read",
  },
  {
    name: "mcp-remote-fixture:update_note",
    displayName: "Remote fixture update note",
    description: "Remote HTTP MCP fixture that simulates a side-effecting write.",
    parametersSchema: {
      type: "object",
      properties: { noteId: { type: "string" }, body: { type: "string" } },
      required: ["noteId", "body"],
      additionalProperties: false,
    },
    pluginId: "mcp-remote-fixture",
    providerType: "mcp_http_fixture",
    risk: "write",
  },
  {
    name: "paperclip-self:list_my_issues",
    displayName: "List my Paperclip issues",
    description: "Paperclip self-MCP read fixture that lists the authenticated agent's current issues.",
    parametersSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
    pluginId: "paperclip-self",
    providerType: "paperclip_self",
    risk: "read",
  },
  {
    name: "paperclip-self:get_issue_context",
    displayName: "Get issue context",
    description: "Paperclip self-MCP read fixture that returns scoped issue context and plan document metadata.",
    parametersSchema: {
      type: "object",
      properties: { issueId: { type: "string" } },
      additionalProperties: false,
    },
    pluginId: "paperclip-self",
    providerType: "paperclip_self",
    risk: "read",
  },
  {
    name: "mcp-stdio-fixture:increment_counter",
    displayName: "Stdio runtime counter",
    description: "Local stdio MCP fixture that lazy-starts a supervised runtime slot and increments slot-local state.",
    parametersSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    pluginId: "mcp-stdio-fixture",
    providerType: "mcp_stdio_fixture",
    risk: "read",
  },
  {
    name: "mcp-stdio-fixture:runtime_status",
    displayName: "Stdio runtime status",
    description: "Local stdio MCP fixture that reports the reused runtime slot state.",
    parametersSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    pluginId: "mcp-stdio-fixture",
    providerType: "mcp_stdio_fixture",
    risk: "read",
  },
];

const VIRTUAL_SEARCH_TOOLS: ToolGatewayDescriptor = {
  name: "search_tools",
  displayName: "Search available tools",
  description: "Search the tools available through this Paperclip gateway without loading every target tool into the tool list.",
  parametersSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    additionalProperties: false,
  },
  pluginId: "paperclip-gateway",
  providerType: "paperclip_virtual",
  risk: "read",
};

const VIRTUAL_RUN_TOOL: ToolGatewayDescriptor = {
  name: "run_tool",
  displayName: "Run a selected tool",
  description: "Run a target tool by name after Paperclip applies the target tool's profile, policy, approval, and rate-limit checks.",
  parametersSchema: {
    type: "object",
    properties: {
      tool: { type: "string" },
      arguments: { type: "object" },
    },
    required: ["tool"],
    additionalProperties: false,
  },
  pluginId: "paperclip-gateway",
  providerType: "paperclip_virtual",
  risk: "write",
};

const VIRTUAL_TOOLS = [VIRTUAL_SEARCH_TOOLS, VIRTUAL_RUN_TOOL];

export function createToolGatewayService(
  db: Db,
  options: {
    pluginToolDispatcher?: PluginToolDispatcher;
    deploymentMode?: DeploymentMode;
    deploymentExposure?: DeploymentExposure;
    trustedLocalStdioRuntimeHost?: string | null;
    runtimeSupervisor?: ToolRuntimeSupervisorOptions;
    toolActionSigningSecret?: string;
    mcpGatewayProtocolLimits?: Partial<{
      authFailures: Partial<McpGatewayRateLimitConfig>;
      gatewayRequests: Partial<McpGatewayRateLimitConfig>;
      tokenRequests: Partial<McpGatewayRateLimitConfig>;
      sessionSetup: Partial<McpGatewayRateLimitConfig>;
    }>;
    now?: () => number;
  } = {},
) {
  const runtimeSupervisor = createToolRuntimeSupervisor(db, {
    deploymentMode: options.deploymentMode,
    deploymentExposure: options.deploymentExposure,
    trustedLocalStdioRuntimeHost: options.trustedLocalStdioRuntimeHost,
    ...options.runtimeSupervisor,
  });
  const pluginToolDispatcher = options.pluginToolDispatcher;
  const interactions = issueThreadInteractionService(db);
  const policyService = toolAccessPolicyService(db);
  const secrets = secretService(db);
  const protocolLimits = mcpGatewayProtocolLimits(options.mcpGatewayProtocolLimits);
  let nextProtocolRateLimitPruneAt = 0;

  async function pruneExpiredProtocolRateLimitCounters(current: number) {
    if (current < nextProtocolRateLimitPruneAt) return;
    nextProtocolRateLimitPruneAt = current + 60_000;
    await db
      .delete(toolGatewayRateLimitCounters)
      .where(lte(toolGatewayRateLimitCounters.resetAt, new Date(current)));
  }

  async function consumeProtocolRateLimit(input: {
    companyId: string;
    counterKey: string;
    config: McpGatewayRateLimitConfig;
  }): Promise<McpGatewayRateLimitState> {
    const current = options.now?.() ?? Date.now();
    const windowStartAt = rateLimitWindowStart(current, input.config.windowMs);
    const resetAt = new Date(windowStartAt.getTime() + input.config.windowMs);
    const nowDate = new Date(current);
    const windowStartIso = windowStartAt.toISOString();
    const resetIso = resetAt.toISOString();
    const nowIso = nowDate.toISOString();
    await pruneExpiredProtocolRateLimitCounters(current);
    const rows = Array.from(await db.execute(sql<{ count: number | string }>`
      INSERT INTO "tool_gateway_rate_limit_counters" (
        "company_id",
        "counter_key",
        "window_start_at",
        "window_ms",
        "limit",
        "count",
        "reset_at",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${input.companyId},
        ${input.counterKey},
        ${windowStartIso}::timestamptz,
        ${input.config.windowMs},
        ${input.config.max},
        1,
        ${resetIso}::timestamptz,
        ${nowIso}::timestamptz,
        ${nowIso}::timestamptz
      )
      ON CONFLICT ("company_id", "counter_key", "window_start_at")
      DO UPDATE SET
        "count" = "tool_gateway_rate_limit_counters"."count" + 1,
        "window_ms" = ${input.config.windowMs},
        "limit" = ${input.config.max},
        "reset_at" = ${resetIso}::timestamptz,
        "updated_at" = ${nowIso}::timestamptz
      RETURNING "count"
    `));
    const count = Number(rows[0]?.count ?? 1);
    return {
      limited: count > input.config.max,
      count,
      retryAfterMs: Math.max(0, resetAt.getTime() - current),
    };
  }

  function pluginTools(): ToolGatewayDescriptor[] {
    return (pluginToolDispatcher?.listToolsForAgent() ?? []).map((tool) => ({
      ...tool,
      providerType: "paperclip_plugin" as const,
      risk: inferToolRisk(tool.name),
    }));
  }

  function allTools(): ToolGatewayDescriptor[] {
    return [...BUILTIN_TOOLS, ...pluginTools()];
  }

  async function connectedMcpToolsForCompany(companyId: string): Promise<ToolGatewayDescriptor[]> {
    const rows = await db
      .select({
        catalogEntry: toolCatalogEntries,
        connection: toolConnections,
        application: toolApplications,
      })
      .from(toolCatalogEntries)
      .innerJoin(toolConnections, eq(toolCatalogEntries.connectionId, toolConnections.id))
      .innerJoin(toolApplications, eq(toolConnections.applicationId, toolApplications.id))
      .where(and(
        eq(toolCatalogEntries.companyId, companyId),
        eq(toolCatalogEntries.entryKind, "tool"),
        eq(toolCatalogEntries.status, "active"),
        isNull(toolCatalogEntries.quarantinedAt),
        eq(toolConnections.companyId, companyId),
        inArray(toolConnections.transport, ["remote_http", "local_stdio"]),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
        inArray(toolConnections.healthStatus, ["ok", "healthy"]),
        eq(toolApplications.companyId, companyId),
        inArray(toolApplications.type, ["mcp_http", "mcp_stdio"]),
        eq(toolApplications.status, "active"),
      ))
      .orderBy(toolConnections.name, toolCatalogEntries.name);

    const eligibleRows = rows.filter(({ connection, application }) =>
      (connection.transport === "remote_http" && application.type === "mcp_http")
      || (connection.transport === "local_stdio" && application.type === "mcp_stdio")
    );
    const baseNames = eligibleRows.map(({ catalogEntry, connection, application }) => {
      const applicationKey = application.applicationKey ?? null;
      const connectionNamespace = `${slugSegment(applicationKey ?? connection.name ?? application.name, "mcp")}-${shortStableId(connection.id)}`;
      const toolSlug = slugSegment(catalogEntry.toolName, "tool");
      return `mcp.${connectionNamespace}:${toolSlug}`;
    });
    const baseNameCounts = baseNames.reduce<Map<string, number>>((counts, name) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return counts;
    }, new Map());

    return eligibleRows.map(({ catalogEntry, connection, application }, index) => {
      const baseName = baseNames[index]!;
      const gatewayToolName = baseNameCounts.get(baseName)! > 1
        ? `${baseName}-${shortStableId(catalogEntry.id)}`
        : baseName;
      const applicationKey = application.applicationKey ?? null;
      const inputSchema = catalogEntry.inputSchema ?? {};
      const outputSchema = catalogEntry.outputSchema ?? null;
      const annotations = catalogEntry.annotations ?? {};
      const risk = riskFromCatalogEntry(catalogEntry);
      const onDemandTools = readOnDemandToolsEnabled(connection);
      const providerMetadata: ConnectedMcpGatewayMetadata = {
        applicationId: application.id,
        applicationKey,
        applicationDisplayName: application.name,
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        transport: connection.transport,
        gatewayToolName,
        upstreamToolName: catalogEntry.toolName,
        catalogName: catalogEntry.name,
        inputSchema,
        outputSchema,
        annotations,
        risk: {
          level: catalogEntry.riskLevel,
          isReadOnly: catalogEntry.isReadOnly,
          isWrite: catalogEntry.isWrite,
          isDestructive: catalogEntry.isDestructive,
        },
        onDemandTools,
      };
      return {
        name: gatewayToolName,
        displayName: catalogEntry.title ?? catalogEntry.toolName,
        description: catalogEntry.description ?? `Connected MCP tool ${catalogEntry.toolName} from ${connection.name}.`,
        parametersSchema: inputSchema,
        pluginId: `mcp:${applicationKey ?? application.id}`,
        providerType: connection.transport === "local_stdio" ? "mcp_local_stdio" : "mcp_remote_http",
        risk,
        applicationId: application.id,
        applicationKey,
        applicationDisplayName: application.name,
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        upstreamToolName: catalogEntry.toolName,
        providerMetadata,
      };
    });
  }

  async function connectedMcpToolsForConnection(companyId: string, connectionId: string): Promise<ToolGatewayDescriptor[]> {
    return (await connectedMcpToolsForCompany(companyId))
      .filter((tool) => tool.connectionId === connectionId);
  }

  async function assertAgentInCompany(companyId: string, agentId: string): Promise<void> {
    const [agent] = await db
      .select({
        companyId: agents.companyId,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent || agent.companyId !== companyId) {
      throw new ToolGatewayHttpError(404, "Agent not found for company", "agent_not_found");
    }
  }

  /**
   * "Last changed by {Actor} · {relativeTime}" audit hint for the Test tab Off
   * side panel. Looks across the configuration that governs this agent's access
   * to the connection — the policies that matched, the profiles in effect, the
   * entries that scope them to this connection, and the bindings that assigned
   * those profiles to the agent — and reports the most recent edit. Only
   * policies and bindings carry an actor, so the attributed agent name is best
   * effort: when the latest edit was a profile/entry toggle (no actor column),
   * the timestamp is still returned but the actor is null.
   */
  async function summarizeAccessLastChange(input: {
    companyId: string;
    connectionId: string;
    agentId: string;
    policyIds: string[];
    profileIds: string[];
  }): Promise<{ lastChangedAt: string | null; lastChangedByAgentId: string | null; lastChangedByName: string | null }> {
    const empty = { lastChangedAt: null, lastChangedByAgentId: null, lastChangedByName: null };
    const candidates: Array<{ updatedAt: Date; agentId: string | null }> = [];

    if (input.policyIds.length > 0) {
      const policies = await db
        .select({ updatedAt: toolPolicies.updatedAt, agentId: toolPolicies.createdByAgentId })
        .from(toolPolicies)
        .where(and(eq(toolPolicies.companyId, input.companyId), inArray(toolPolicies.id, input.policyIds)));
      candidates.push(...policies.map((row) => ({ updatedAt: row.updatedAt, agentId: row.agentId })));
    }

    if (input.profileIds.length > 0) {
      const [profiles, entries, bindings] = await Promise.all([
        db
          .select({ updatedAt: toolProfiles.updatedAt })
          .from(toolProfiles)
          .where(and(eq(toolProfiles.companyId, input.companyId), inArray(toolProfiles.id, input.profileIds))),
        db
          .select({ updatedAt: toolProfileEntries.updatedAt })
          .from(toolProfileEntries)
          .where(and(
            eq(toolProfileEntries.companyId, input.companyId),
            inArray(toolProfileEntries.profileId, input.profileIds),
            eq(toolProfileEntries.connectionId, input.connectionId),
          )),
        db
          .select({ updatedAt: toolProfileBindings.updatedAt, agentId: toolProfileBindings.createdByAgentId })
          .from(toolProfileBindings)
          .where(and(
            eq(toolProfileBindings.companyId, input.companyId),
            inArray(toolProfileBindings.profileId, input.profileIds),
            eq(toolProfileBindings.targetType, "agent"),
            eq(toolProfileBindings.targetId, input.agentId),
          )),
      ]);
      candidates.push(...profiles.map((row) => ({ updatedAt: row.updatedAt, agentId: null })));
      candidates.push(...entries.map((row) => ({ updatedAt: row.updatedAt, agentId: null })));
      candidates.push(...bindings.map((row) => ({ updatedAt: row.updatedAt, agentId: row.agentId })));
    }

    if (candidates.length === 0) return empty;
    const latest = candidates.reduce((a, b) => (b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a));

    let lastChangedByName: string | null = null;
    if (latest.agentId) {
      const [actor] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, latest.agentId))
        .limit(1);
      lastChangedByName = actor?.name ?? null;
    }
    return {
      lastChangedAt: latest.updatedAt.toISOString(),
      lastChangedByAgentId: latest.agentId,
      lastChangedByName,
    };
  }

  async function resolveRunContext(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string | null;
    projectId?: string | null;
  }): Promise<{ issueId: string | null; projectId: string | null }> {
    const [run] = await db
      .select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);

    if (!run || run.companyId !== input.companyId) {
      throw new ToolGatewayHttpError(403, "Run does not belong to company", "run_company_mismatch");
    }
    if (run.agentId !== input.agentId) {
      throw new ToolGatewayHttpError(403, "Run does not belong to agent", "run_agent_mismatch");
    }
    if (!ACTIVE_GATEWAY_RUN_STATUSES.has(run.status)) {
      throw new ToolGatewayHttpError(403, "Run is not active", "run_inactive");
    }

    const snapshot = asRecord(run.contextSnapshot);
    const snapshotIssueId = stringValue(snapshot?.issueId);
    const snapshotProjectId = stringValue(snapshot?.projectId);
    if ((input.issueId && snapshotIssueId && input.issueId !== snapshotIssueId)
      || (input.projectId && snapshotProjectId && input.projectId !== snapshotProjectId)) {
      throw new ToolGatewayHttpError(403, "Supplied run context does not match stored heartbeat context", "run_context_mismatch");
    }
    const issueId = snapshotIssueId ?? input.issueId ?? null;
    let projectId = snapshotProjectId ?? input.projectId ?? null;
    if (issueId) {
      const [issue] = await db
        .select({ companyId: issues.companyId, projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1);
      if (!issue || issue.companyId !== input.companyId) {
        throw new ToolGatewayHttpError(403, "Issue context is outside the run company", "run_context_mismatch");
      }
      if (projectId && issue.projectId && projectId !== issue.projectId) {
        throw new ToolGatewayHttpError(403, "Project context does not match issue context", "run_context_mismatch");
      }
      projectId = projectId ?? issue.projectId;
    }
    if (projectId) {
      const [project] = await db
        .select({ companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!project || project.companyId !== input.companyId) {
        throw new ToolGatewayHttpError(403, "Project context is outside the run company", "run_context_mismatch");
      }
    }
    return {
      issueId,
      projectId,
    };
  }

  async function writeAudit(input: {
    session?: ToolGatewaySession | null;
    companyId: string;
    agentId: string | null;
    runId: string | null;
    issueId: string | null;
    actorType?: LogActivityInput["actorType"];
    actorId?: string;
    action: string;
    details: Record<string, unknown>;
  }) {
    const dedicatedAuditAction =
      input.action === "tool_gateway.discovery"
        ? "discovery"
        : input.action === "tool_gateway.session_revoked"
          ? "session_revoked"
          : input.action === "tool_gateway.call_allowed" || input.action === "tool_gateway.session_created"
          ? "policy_decision"
          : input.action === "tool_gateway.call_completed"
            ? "call_completed"
            : input.action === "tool_gateway.call_denied" || input.action === "tool_gateway.session_rejected"
              ? "call_denied"
              : input.action === "tool_gateway.call_deferred"
                ? "call_failed"
                : "call_failed";
    const dedicatedOutcome =
      input.action === "tool_gateway.session_revoked"
        ? "success"
        : input.action === "tool_gateway.call_denied" || input.action === "tool_gateway.session_rejected"
        ? "denied"
        : input.action === "tool_gateway.call_deferred"
          ? "timeout"
          : input.action === "tool_gateway.call_failed"
            ? "failure"
            : "success";
    try {
      await db.insert(toolAccessAuditEvents).values({
        companyId: input.companyId,
        gatewayId: input.session?.gatewayId ?? (typeof input.details.gatewayId === "string" && uuidPattern.test(input.details.gatewayId) ? input.details.gatewayId : null),
        gatewayTokenId: input.session?.gatewayTokenId && uuidPattern.test(input.session.gatewayTokenId)
          ? input.session.gatewayTokenId
          : typeof input.details.gatewayTokenId === "string" && uuidPattern.test(input.details.gatewayTokenId)
            ? input.details.gatewayTokenId
            : null,
        gatewayPublicId: typeof input.details.gatewayPublicId === "string" ? input.details.gatewayPublicId : null,
        clientName: typeof input.details.clientName === "string" ? input.details.clientName : null,
        correlationId: typeof input.details.correlationId === "string" ? input.details.correlationId : null,
        connectionId: typeof input.details.connectionId === "string" ? input.details.connectionId : null,
        catalogEntryId: typeof input.details.catalogEntryId === "string" ? input.details.catalogEntryId : null,
        actorType: input.actorType ?? input.session?.actorType ?? (input.agentId ? "agent" : "system"),
        actorId: input.actorId ?? input.session?.actorId ?? input.agentId ?? input.session?.gatewayTokenId ?? input.companyId,
        action: dedicatedAuditAction,
        outcome: dedicatedOutcome,
        reasonCode: typeof input.details.reasonCode === "string" ? input.details.reasonCode : null,
        details: {
          source: input.action,
          agentId: input.agentId,
          issueId: input.issueId,
          projectId: input.session?.projectId ?? null,
          runId: input.runId,
          gatewaySessionId: input.session?.id ?? null,
          gatewayId: input.session?.gatewayId ?? null,
          gatewayPublicId: input.session?.gatewayPublicId ?? null,
          gatewayName: input.session?.gatewayName ?? null,
          gatewayTokenId: input.session?.gatewayTokenId ?? null,
          ...input.details,
        },
      });
    } catch (error) {
      await recordToolRuntimeAuditWriteFailure(db, input.companyId);
      throw error;
    }

    const entityType = input.issueId ? "issue" : input.session?.gatewayId ? "tool_mcp_gateway" : "agent";
    const entityId = input.issueId ?? input.session?.gatewayId ?? input.agentId ?? input.companyId;
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actorType ?? input.session?.actorType ?? (input.agentId ? "agent" : "system"),
      actorId: input.actorId ?? input.session?.actorId ?? input.agentId ?? input.session?.gatewayTokenId ?? input.companyId,
      action: input.action,
      entityType,
      entityId,
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId,
      details: {
        gatewaySessionId: input.session?.id ?? null,
        gatewayId: input.session?.gatewayId ?? null,
        gatewayPublicId: input.session?.gatewayPublicId ?? null,
        issueId: input.issueId,
        projectId: input.session?.projectId ?? null,
        runId: input.runId,
        ...input.details,
      },
    });
  }

  async function writeSessionAuthFailure(
    row: typeof toolGatewaySessions.$inferSelect,
    reasonCode: string,
    details: Record<string, unknown> = {},
  ) {
    const session = gatewaySessionFromRow(row);
    await writeAudit({
      session,
      companyId: session.companyId,
      agentId: session.agentId,
      runId: session.runId,
      issueId: session.issueId,
      action: "tool_gateway.session_rejected",
      details: {
        decision: "deny",
        reasonCode,
        expiresAt: session.expiresAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
        ...details,
      },
    });
  }

  async function assertSessionRunIsActive(row: typeof toolGatewaySessions.$inferSelect) {
    const [run] = await db
      .select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, row.runId))
      .limit(1);

    if (!run
      || run.companyId !== row.companyId
      || run.agentId !== row.agentId
      || !ACTIVE_GATEWAY_RUN_STATUSES.has(run.status)) {
      await writeSessionAuthFailure(row, "session_run_inactive", {
        runStatus: run?.status ?? null,
      });
      throw new ToolGatewayHttpError(401, "Tool gateway session is expired or invalid", "session_run_inactive");
    }
  }

  async function getActiveSession(
    sessionToken: string,
    namedGatewayProtocol?: {
      gatewayId?: string | null;
      gatewayPublicId?: string | null;
      protocolMethod: McpGatewayProtocolMethod;
      callerHeaders?: Record<string, string | string[] | undefined>;
    },
  ): Promise<ToolGatewaySession> {
    const token = sessionToken.trim();
    if (!token) {
      throw new ToolGatewayHttpError(401, "Tool gateway session is expired or invalid", "session_invalid");
    }
    if (namedGatewayTokenId(token)) {
      return namedGatewaySessionFromBearer({
        gatewayId: namedGatewayProtocol?.gatewayId ?? null,
        gatewayPublicId: namedGatewayProtocol?.gatewayPublicId ?? null,
        bearerToken: token,
        protocolMethod: namedGatewayProtocol?.protocolMethod ?? "tools/call",
        callerHeaders: namedGatewayProtocol?.callerHeaders,
      });
    }

    const tokenHash = hashGatewayToken(token);
    const [row] = await db
      .select()
      .from(toolGatewaySessions)
      .where(eq(toolGatewaySessions.tokenHash, tokenHash))
      .limit(1);

    if (!row) {
      const sessionId = sessionIdFromGatewayToken(token);
      if (sessionId) {
        const [candidate] = await db
          .select()
          .from(toolGatewaySessions)
          .where(eq(toolGatewaySessions.id, sessionId))
          .limit(1);
        if (candidate) {
          await writeSessionAuthFailure(candidate, "session_invalid");
        }
      }
      throw new ToolGatewayHttpError(401, "Tool gateway session is expired or invalid", "session_invalid");
    }

    if (row.revokedAt) {
      await writeSessionAuthFailure(row, "session_revoked");
      throw new ToolGatewayHttpError(401, "Tool gateway session is expired or invalid", "session_revoked");
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      await writeSessionAuthFailure(row, "session_expired");
      throw new ToolGatewayHttpError(401, "Tool gateway session is expired or invalid", "session_expired");
    }

    await assertSessionRunIsActive(row);

    const now = new Date();
    await db
      .update(toolGatewaySessions)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(toolGatewaySessions.id, row.id));

    return gatewaySessionFromRow({ ...row, lastUsedAt: now, updatedAt: now });
  }

  function normalizeGatewayTokenActions(value: unknown): ToolMcpGatewayTokenAction[] {
    const actions = Array.isArray(value)
      ? value.filter((action): action is ToolMcpGatewayTokenAction => action === "tools/list" || action === "tools/call")
      : [];
    return actions.length > 0 ? actions : ["tools/list", "tools/call"];
  }

  async function assertGatewayTokenAction(session: ToolGatewaySession, action: ToolMcpGatewayTokenAction) {
    const allowedActions = session.gatewayTokenAllowedActions;
    if (!allowedActions || allowedActions.includes(action)) return;
    await writeAudit({
      session,
      companyId: session.companyId,
      agentId: session.agentId,
      runId: session.runId,
      issueId: session.issueId,
      action: action === "tools/list" ? "tool_gateway.discovery" : "tool_gateway.call_denied",
      details: {
        decision: "deny",
        reasonCode: "gateway_token_action_denied",
        requestedAction: action,
        allowedActions,
      },
    });
    throw new ToolGatewayHttpError(403, "Gateway bearer token is not allowed to perform this MCP action", "gateway_token_action_denied", {
      requestedAction: action,
    });
  }

  async function writeToolCallEvent(input: {
    invocationId?: string | null;
    actionRequestId?: string | null;
    session: ToolGatewaySession;
    eventType: "policy_decision" | "invocation_created" | "approval_requested" | "approval_resolved" | "call_started" | "call_completed" | "call_failed" | "call_denied";
    outcome: "pending" | "success" | "failure" | "denied" | "timeout" | "cancelled";
    toolName: string;
    policyDecision?: "allow" | "deny" | "require_approval" | "defer_runtime" | null;
    reasonCode?: string | null;
    argumentsSummary?: ReturnType<typeof summarizeToolValue> | null;
    resultSummary?: ReturnType<typeof summarizeToolValue> | null;
    metadata?: Record<string, unknown> | null;
    tool?: ToolGatewayDescriptor | null;
  }) {
    const metadata = input.tool ? toolAuditMetadata(input.tool) : {};
    await db.insert(toolCallEvents).values({
      companyId: input.session.companyId,
      invocationId: input.invocationId ?? null,
      actionRequestId: input.actionRequestId ?? null,
      eventType: input.eventType,
      outcome: input.outcome,
      actorType: input.session.actorType ?? (input.session.agentId ? "agent" : "system"),
      actorId: input.session.actorId ?? input.session.agentId ?? input.session.gatewayTokenId ?? input.session.companyId,
      agentId: input.session.agentId,
      issueId: input.session.issueId,
      runId: input.session.runId,
      applicationId: input.tool?.applicationId ?? null,
      connectionId: input.tool?.connectionId ?? null,
      catalogEntryId: input.tool?.catalogEntryId ?? null,
      toolName: input.toolName,
      decision: input.policyDecision ?? null,
      reasonCode: input.reasonCode ?? null,
      matchedPolicyIds: [],
      requestHash: input.argumentsSummary?.sha256 ?? null,
      requestSummary: input.argumentsSummary ?? null,
      resultHash: input.resultSummary?.sha256 ?? null,
      resultSummary: input.resultSummary ?? null,
      resultSizeBytes: input.resultSummary?.sizeBytes ?? null,
      metadata: Object.keys(metadata).length > 0 || input.metadata || input.session.projectId
        ? {
            ...metadata,
            gatewayId: input.session.gatewayId ?? null,
            gatewayName: input.session.gatewayName ?? null,
            projectId: input.session.projectId ?? null,
            ...(input.metadata ?? {}),
          }
        : null,
    });
  }

  async function reflectToolActionInteractionLifecycle(input: {
    actionRequestId: string;
    status: "approved" | "executing" | "executed" | "failed" | "expired";
    errorCode?: string | null;
    errorMessage?: string | null;
    resultSummary?: string | null;
  }): Promise<void> {
    const [linked] = await db
      .select({
        companyId: toolActionRequests.companyId,
        interactionId: toolActionRequests.interactionId,
      })
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, input.actionRequestId))
      .limit(1);
    if (!linked?.interactionId) return;

    const [interaction] = await db
      .select({
        status: issueThreadInteractions.status,
        result: issueThreadInteractions.result,
      })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.id, linked.interactionId),
        eq(issueThreadInteractions.companyId, linked.companyId),
      ))
      .limit(1);
    if (!interaction) return;

    const currentResult = interaction.result && typeof interaction.result === "object"
      ? interaction.result as unknown as Record<string, unknown>
      : null;
    const outcome = typeof currentResult?.outcome === "string"
      ? currentResult.outcome
      : interaction.status === "accepted"
        ? "accepted"
        : interaction.status === "rejected"
          ? "rejected"
          : interaction.status === "expired" || input.status === "expired"
            ? "stale_target"
            : null;
    if (!outcome) return;

    const now = new Date();
    await db
      .update(issueThreadInteractions)
      .set({
        ...(input.status === "expired" && interaction.status === "pending"
          ? { status: "expired", resolvedAt: now }
          : {}),
        result: {
          ...(currentResult ?? { version: 1, outcome }),
          toolAction: {
            version: 1,
            status: input.status,
            errorCode: input.errorCode ?? null,
            errorMessage: input.errorMessage ?? null,
            resultSummary: input.resultSummary ?? null,
            updatedAt: now.toISOString(),
          },
        } as unknown as NonNullable<typeof issueThreadInteractions.$inferInsert.result>,
        updatedAt: now,
      })
      .where(eq(issueThreadInteractions.id, linked.interactionId));
  }

  async function approvalRequiredInstructions(issueId: string): Promise<string> {
    const [issue] = await db
      .select({ identifier: issues.identifier })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    const task = issue?.identifier ?? issueId;
    return `A human approval card was posted on task ${task}. Do not retry this call now. Wrap up other work and end your run noting you are waiting on tool approval (status in_review). You will be woken when it is decided; if approved, the action runs automatically and your wake includes the result.`;
  }

  async function throwApprovalRequired(input: {
    invocationId: string;
    actionRequestId: string;
    interactionId?: string | null;
    issueId: string;
    toolName: string;
    argumentsHash: string;
  }): Promise<never> {
    throw new ToolGatewayHttpError(409, "Tool action requires approval", "approval_required", {
      invocationId: input.invocationId,
      actionRequestId: input.actionRequestId,
      interactionId: input.interactionId ?? null,
      issueId: input.issueId,
      tool: input.toolName,
      argumentsHash: input.argumentsHash,
      instructions: await approvalRequiredInstructions(input.issueId),
    });
  }

  async function requestApprovalForRecordedToolCall(input: {
    invocation: typeof toolInvocations.$inferSelect;
    actionRequest: typeof toolActionRequests.$inferSelect | null;
    session: ToolGatewaySession;
    tool: ToolGatewayDescriptor;
    parameters: unknown;
    argumentsSummary: ReturnType<typeof summarizeToolValue>;
    policyDecision: ToolAccessDecision;
  }): Promise<never> {
    const canonicalArguments = canonicalToolArguments(input.parameters);
    const canonicalArgumentsHash = input.argumentsSummary.sha256 ?? "";
    const approvalSnapshot = await connectedRemoteApprovalSnapshot(input.session, input.tool, {
      requireResolvedCredentials: true,
    });

    if (!input.session.issueId) {
      await db
        .update(toolInvocations)
        .set({
          status: "denied",
          approvalState: "required",
          errorCode: "approval_path_missing",
          errorMessage: "Approval-required tool calls need an issue-scoped gateway session",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolInvocations.id, input.invocation.id));
      await writeToolCallEvent({
        invocationId: input.invocation.id,
        actionRequestId: input.actionRequest?.id ?? null,
        session: input.session,
        eventType: "call_denied",
        outcome: "denied",
        toolName: input.tool.name,
        policyDecision: "deny",
        reasonCode: "approval_path_missing",
        argumentsSummary: input.argumentsSummary,
        tool: input.tool,
      });
      throw new ToolGatewayHttpError(
        409,
        "Tool action requires approval, but this gateway session is not attached to an issue",
        "approval_path_missing",
        {
          invocationId: input.invocation.id,
          tool: input.tool.name,
          instructions: "This session is not attached to a task, so an approval card cannot be posted. Re-run this action from a run that has the task checked out.",
        },
      );
    }

    if (!input.actionRequest) {
      await db
        .update(toolInvocations)
        .set({
          status: "denied",
          errorCode: "approval_request_missing",
          errorMessage: "Approval-required policy decision did not create an action request",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolInvocations.id, input.invocation.id));
      throw new ToolGatewayHttpError(500, "Approval request was not created", "approval_request_missing", {
        invocationId: input.invocation.id,
        tool: input.tool.name,
      });
    }
    const actionRequest = input.actionRequest;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    let signedArguments: ReturnType<typeof signToolArguments>;
    try {
      signedArguments = signToolArguments({
        invocationId: input.invocation.id,
        toolName: input.tool.name,
        canonicalArguments,
        approvalSnapshot: approvalSnapshot ?? undefined,
        executionOnApprove: true,
        signingSecret: options.toolActionSigningSecret,
      });
    } catch (error) {
      await db
        .update(toolActionRequests)
        .set({
          status: "cancelled",
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(toolActionRequests.id, actionRequest.id), eq(toolActionRequests.status, "pending")));
      if (error instanceof ToolActionSigningSecretMissingError) {
        await db
          .update(toolInvocations)
          .set({
            status: "failed",
            errorCode: "signing_secret_unconfigured",
            errorMessage: error.message,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolInvocations.id, input.invocation.id));
        throw new ToolGatewayHttpError(500, error.message, "signing_secret_unconfigured", {
          invocationId: input.invocation.id,
          tool: input.tool.name,
        });
      }
      throw error;
    }
    // Board-only technical detail for the formal-approval interaction (target=custom).
    const detailsMarkdown = [
      `Tool: \`${input.tool.name}\``,
      `Risk: \`${input.tool.risk}\``,
      "",
      "Arguments reviewed for execution:",
      "",
      "```json",
      input.argumentsSummary.summary,
      "```",
    ].join("\n");

    // Prosumer-facing card preview (M5/M7/M9). Respect an already-set custom preview
    // (e.g. OpenClaw-supplied), otherwise emit plain language with no technical vocab.
    const previewMarkdown =
      actionRequest.previewMarkdown?.trim() ||
      buildHumanizedActionPreview({ tool: input.tool, argumentsSummary: input.argumentsSummary });

    let formalApprovalId: string | null = null;
    if (toolRequiresFormalApproval(input.tool)) {
      const [approval] = await db
        .insert(approvals)
        .values({
          companyId: input.session.companyId,
          type: "request_board_approval",
          requestedByAgentId: input.session.agentId,
          payload: {
            title: `Approve high-risk tool action: ${input.tool.name}`,
            summary: `${input.tool.name} is classified as ${input.tool.risk} and requires formal board approval before execution.`,
            recommendedAction: "Approve only if the reviewed arguments match the intended operation.",
            risks: [
              "The tool may perform irreversible or externally visible side effects.",
              "Execution will use the stored reviewed arguments exactly once.",
            ],
            source: "tool_gateway",
            invocationId: input.invocation.id,
            actionRequestId: actionRequest.id,
            tool: input.tool.name,
            risk: input.tool.risk,
            argumentsHash: canonicalArgumentsHash,
          },
        })
        .returning();
      formalApprovalId = approval.id;
      await db
        .insert(issueApprovals)
        .values({
          companyId: input.session.companyId,
          issueId: input.session.issueId,
          approvalId: approval.id,
          linkedByAgentId: input.session.agentId,
        })
        .onConflictDoNothing();
    }

    const interaction = await interactions.create(
      { id: input.session.issueId, companyId: input.session.companyId },
      {
        kind: "request_confirmation",
        idempotencyKey: `tool-action:${actionRequest.id}`,
        title: "Approve tool action",
        summary: `${input.tool.name} requires approval before Paperclip will execute it.`,
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: `Approve ${input.tool.name}?`,
          acceptLabel: "Approve action",
          rejectLabel: "Reject action",
          rejectRequiresReason: false,
          allowDeclineReason: true,
          detailsMarkdown,
          target: {
            type: "custom",
            key: `tool-action:${actionRequest.id}`,
            revisionId: canonicalArgumentsHash,
            label: input.tool.name,
          },
          toolAction: {
            version: 1,
            actionRequestId: actionRequest.id,
            invocationId: input.invocation.id,
            toolName: input.tool.name,
            toolDisplayName: input.tool.displayName?.trim() || input.tool.name,
            connectionId: input.tool.connectionId ?? null,
            applicationId: input.tool.applicationId ?? null,
            appDisplayName: input.tool.applicationDisplayName?.trim() || null,
            risk: input.tool.risk === "destructive" ? "destructive" : "write",
            previewMarkdown,
            argumentsSummaryJson: input.argumentsSummary.summary,
            argumentsHash: canonicalArgumentsHash,
            expiresAt: expiresAt.toISOString(),
          },
        },
      },
      { agentId: input.session.agentId },
    );

    await db
      .update(toolActionRequests)
      .set({
        interactionId: interaction.id,
        canonicalArgumentsHash,
        canonicalArgumentsSummary: input.argumentsSummary,
        signedArguments,
        previewMarkdown,
        approvalId: formalApprovalId,
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(toolActionRequests.id, actionRequest.id));

    await writeToolCallEvent({
      invocationId: input.invocation.id,
      actionRequestId: actionRequest.id,
      session: input.session,
      eventType: "approval_requested",
      outcome: "pending",
      toolName: input.tool.name,
      policyDecision: "require_approval",
      reasonCode: "requires_approval_policy",
      argumentsSummary: input.argumentsSummary,
      metadata: { actionRequestId: actionRequest.id, interactionId: interaction.id, approvalId: formalApprovalId },
      tool: input.tool,
    });

    await writeAudit({
      session: input.session,
      companyId: input.session.companyId,
      agentId: input.session.agentId,
      runId: input.session.runId,
      issueId: input.session.issueId,
      action: "tool_gateway.approval_requested",
      details: {
        invocationId: input.invocation.id,
        actionRequestId: actionRequest.id,
        interactionId: interaction.id,
        approvalId: formalApprovalId,
        decision: "require_approval",
        reasonCode: "requires_approval_policy",
        matchedPolicyIds: input.policyDecision.matchedPolicyIds,
        tool: input.tool.name,
        ...toolAuditMetadata(input.tool),
        argumentsSummary: input.argumentsSummary,
      },
    });

    return throwApprovalRequired({
      invocationId: input.invocation.id,
      actionRequestId: actionRequest.id,
      interactionId: interaction.id,
      issueId: input.session.issueId,
      toolName: input.tool.name,
      argumentsHash: canonicalArgumentsHash,
    });
  }

  function policyInputForTool(input: {
    session: ToolGatewaySession;
    tool: ToolGatewayDescriptor;
    parameters?: unknown;
    idempotencyKey?: string | null;
    consumeRateLimit?: boolean;
  }): ToolAccessDecisionInput {
    return policyInputForAgentTool({
      companyId: input.session.companyId,
      agentId: input.session.agentId,
      actorType: input.session.actorType,
      actorId: input.session.actorId ?? input.session.gatewayTokenId ?? null,
      tool: input.tool,
      parameters: input.parameters,
      idempotencyKey: input.idempotencyKey,
      consumeRateLimit: input.consumeRateLimit,
      heartbeatRunId: input.session.runId,
      issueId: input.session.issueId,
      projectId: input.session.projectId,
      gatewayId: input.session.gatewayId ?? null,
    });
  }

  function policyInputForAgentTool(input: {
    companyId: string;
    agentId: string | null;
    actorType?: "agent" | "user" | "system" | "plugin";
    actorId?: string | null;
    tool: ToolGatewayDescriptor;
    parameters?: unknown;
    idempotencyKey?: string | null;
    consumeRateLimit?: boolean;
    heartbeatRunId?: string | null;
    issueId?: string | null;
    projectId?: string | null;
    gatewayId?: string | null;
  }): ToolAccessDecisionInput {
    const actorType = input.actorType ?? (input.agentId ? "agent" : "system");
    const actorId = input.actorId ?? input.agentId ?? input.gatewayId ?? input.companyId;
    return {
      companyId: input.companyId,
      actor: {
        actorType,
        actorId,
        agentId: input.agentId,
      },
      runContext: {
        heartbeatRunId: input.heartbeatRunId ?? null,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
        gatewayId: input.gatewayId ?? null,
      },
      request: {
        toolName: input.tool.name,
        applicationId: input.tool.applicationId ?? null,
        applicationKey: input.tool.applicationKey ?? null,
        connectionId: input.tool.connectionId ?? null,
        catalogEntryId: input.tool.catalogEntryId ?? null,
        providerType: input.tool.providerType,
        upstreamToolName: input.tool.upstreamToolName ?? input.tool.name,
        riskLevel: input.tool.risk,
        arguments: input.parameters ?? {},
        idempotencyKey: input.idempotencyKey ?? null,
        sideEffecting: input.tool.risk !== "read",
      },
      consumeRateLimit: input.consumeRateLimit === true,
    };
  }

  function policyErrorStatus(decision: ToolAccessDecision) {
    if (decision.decision === "rate_limited") return 429;
    return 403;
  }

  function findStaticTool(toolName: string): ToolGatewayDescriptor {
    const tool = allTools().find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new ToolGatewayHttpError(404, `Tool "${toolName}" not found`, "tool_not_found", { tool: toolName });
    }
    return tool;
  }

  async function findToolForSession(session: ToolGatewaySession, toolName: string): Promise<ToolGatewayDescriptor> {
    const connectedTools = await connectedMcpToolsForCompany(session.companyId);
    const hasOnDemandTargets = connectedTools.some(isOnDemandRemoteTool);
    const virtualTools = hasOnDemandTargets ? VIRTUAL_TOOLS : [];
    const tool = [...allTools(), ...connectedTools, ...virtualTools]
      .filter((candidate) => session.agentId || (candidate.providerType !== "paperclip_self" && candidate.providerType !== "paperclip_plugin"))
      .find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new ToolGatewayHttpError(404, `Tool "${toolName}" not found`, "tool_not_found", { tool: toolName });
    }
    return tool;
  }

  function virtualRunToolInput(parameters: unknown): { targetToolName: string; targetParameters: unknown } {
    const params = asRecord(parameters) ?? {};
    const targetToolName = typeof params.tool === "string" ? params.tool.trim() : "";
    if (!targetToolName) {
      throw new ToolGatewayHttpError(400, "run_tool requires a target tool name", "invalid_parameters");
    }
    return {
      targetToolName,
      targetParameters: params.arguments ?? {},
    };
  }

  async function searchableOnDemandTools(session: ToolGatewaySession): Promise<ToolGatewayDescriptor[]> {
    const tools = (await connectedMcpToolsForCompany(session.companyId)).filter(isOnDemandRemoteTool);
    const decisions = await Promise.all(tools.map(async (tool) => ({
      tool,
      decision: await policyService.decide(policyInputForTool({ session, tool })),
    })));
    return decisions
      .filter(({ decision }) => decision.allowed || decision.decision === "require_approval")
      .map(({ tool }) => tool);
  }

  async function executeVirtualSearchTools(session: ToolGatewaySession, parameters: unknown) {
    const params = asRecord(parameters) ?? {};
    const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
    const limit = Math.max(1, Math.min(50, Number(params.limit ?? 10) || 10));
    const tools = (await searchableOnDemandTools(session))
      .filter((tool) => {
        if (!query) return true;
        return [
          tool.name,
          tool.displayName,
          tool.description,
          tool.applicationKey,
          tool.upstreamToolName,
        ].filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(query));
      })
      .slice(0, limit)
      .map((tool) => ({
        name: tool.name,
        displayName: tool.displayName ?? tool.name,
        description: tool.description ?? null,
        parametersSchema: tool.parametersSchema,
        applicationId: tool.applicationId ?? null,
        connectionId: tool.connectionId ?? null,
        catalogEntryId: tool.catalogEntryId ?? null,
        upstreamToolName: tool.upstreamToolName ?? tool.name,
        risk: tool.risk,
      }));

    return {
      content: JSON.stringify({ tools }),
      data: { tools },
    };
  }

  async function listToolsForContext(session: ToolGatewaySession): Promise<ToolGatewayDescriptor[]> {
    if (session.agentId) {
      await assertAgentInCompany(session.companyId, session.agentId);
    }
    const allConnectedTools = await connectedMcpToolsForCompany(session.companyId);
    const onDemandTargets = allConnectedTools.filter(isOnDemandRemoteTool);
    const tools = [...allTools(), ...allConnectedTools.filter((tool) => !isOnDemandRemoteTool(tool))].filter(
      (tool) => session.agentId || (tool.providerType !== "paperclip_self" && tool.providerType !== "paperclip_plugin"),
    );
    const decisions = await Promise.all(tools.map(async (tool) => {
      const decision = await policyService.decide(policyInputForTool({ session, tool }));
      return { tool, decision };
    }));
    const visibleTools = decisions
      .filter(({ decision }) => decision.allowed || decision.decision === "require_approval")
      .map(({ tool, decision }) => decision.decision === "require_approval"
        ? {
            ...tool,
            description: [tool.description?.trim(), TOOL_APPROVAL_DESCRIPTION_SUFFIX].filter(Boolean).join(" "),
          }
        : tool);
    if (onDemandTargets.length > 0) {
      const targetDecisions = await Promise.all(onDemandTargets.map(async (tool) => {
        const decision = await policyService.decide(policyInputForTool({ session, tool }));
        return { tool, decision };
      }));
      if (targetDecisions.some(({ decision }) => decision.allowed || decision.decision === "require_approval")) {
        visibleTools.push(...VIRTUAL_TOOLS);
      }
    }
    return visibleTools;
  }

  async function executeBuiltinTool(session: ToolGatewaySession, tool: ToolGatewayDescriptor, parameters: unknown) {
    const params = asRecord(parameters) ?? {};

    if (tool.name === "mcp-remote-fixture:echo") {
      return {
        content: String(params.message ?? ""),
        data: {
          transport: "mcp_http",
          spawnedLocalProcess: false,
        },
      };
    }

    if (tool.name === "mcp-remote-fixture:add") {
      const a = Number(params.a);
      const b = Number(params.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new ToolGatewayHttpError(400, "Parameters a and b must be finite numbers", "invalid_parameters");
      }
      return {
        content: String(a + b),
        data: {
          result: a + b,
          transport: "mcp_http",
          spawnedLocalProcess: false,
        },
      };
    }

    if (tool.name === "mcp-remote-fixture:update_note") {
      const noteId = typeof params.noteId === "string" ? params.noteId.trim() : "";
      const body = typeof params.body === "string" ? params.body : "";
      if (!noteId || !body) {
        throw new ToolGatewayHttpError(400, "Parameters noteId and body are required", "invalid_parameters");
      }
      return {
        content: JSON.stringify({ noteId, updated: true }),
        data: {
          noteId,
          bodyLength: body.length,
          transport: "mcp_http",
          spawnedLocalProcess: false,
        },
      };
    }

    if (tool.name === "paperclip-self:list_my_issues") {
      if (!session.agentId) {
        throw new ToolGatewayHttpError(403, "Paperclip self tools require an agent-scoped gateway session", "agent_context_required");
      }
      const limit = Math.max(1, Math.min(50, Number(params.limit ?? 10) || 10));
      const rows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(and(eq(issues.companyId, session.companyId), eq(issues.assigneeAgentId, session.agentId)))
        .orderBy(desc(issues.updatedAt))
        .limit(limit);

      return {
        content: JSON.stringify(rows),
        data: { issues: rows },
      };
    }

    if (tool.name === "paperclip-self:get_issue_context") {
      if (!session.agentId) {
        throw new ToolGatewayHttpError(403, "Paperclip self tools require an agent-scoped gateway session", "agent_context_required");
      }
      const issueId = typeof params.issueId === "string" ? params.issueId : session.issueId;
      if (!issueId) {
        throw new ToolGatewayHttpError(400, "issueId is required when the session is not issue-scoped", "missing_issue_id");
      }
      const [issue] = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(and(eq(issues.companyId, session.companyId), eq(issues.id, issueId)))
        .limit(1);
      if (!issue) {
        throw new ToolGatewayHttpError(404, "Issue not found", "issue_not_found");
      }

      const [planDocument] = await db
        .select({
          documentId: documents.id,
          title: documents.title,
          latestRevisionId: documents.latestRevisionId,
          latestRevisionNumber: documents.latestRevisionNumber,
        })
        .from(issueDocuments)
        .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
        .where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.key, "plan")))
        .limit(1);

      return {
        content: JSON.stringify({ issue, planDocument: planDocument ?? null }),
        data: { issue, planDocument: planDocument ?? null },
      };
    }

    if (tool.providerType === "mcp_stdio_fixture") {
      return runtimeSupervisor.useFixtureSlot(
        {
          companyId: session.companyId,
          connectionKey: `${session.companyId}:mcp-stdio-fixture:default`,
          runId: session.runId,
          issueId: session.issueId,
          agentId: session.agentId,
        },
        async (handle) => {
          const priorUseCount = Number(handle.metadata.useCount ?? 0) || 0;
          let counter = Number(handle.metadata.counter ?? 0) || 0;
          if (tool.name === "mcp-stdio-fixture:increment_counter") {
            counter += 1;
            handle.metadata.counter = counter;
            handle.appendLog("stdout", `increment_counter counter=${counter}`);
          } else {
            handle.appendLog("stdout", `runtime_status counter=${counter}`);
          }
          const nextUseCount = priorUseCount + 1;
          return {
            content: JSON.stringify({
              slotId: handle.slot.id,
              status: handle.slot.status,
              counter,
              useCount: nextUseCount,
            }),
            data: {
              slotId: handle.slot.id,
              status: handle.slot.status,
              counter,
              useCount: nextUseCount,
              lazyStarted: priorUseCount === 0,
              reusedRuntimeSlot: priorUseCount > 0,
            },
          };
        },
      );
    }

    throw new ToolGatewayHttpError(404, `Tool "${tool.name}" not found`, "tool_not_found");
  }

  function remoteEndpoint(config: Record<string, unknown>): string {
    const value = config.url ?? config.endpoint ?? config.remoteUrl;
    const parsed = parseRemoteHttpEndpoint(
      value,
      (message, code) => new ToolGatewayHttpError(422, message, code),
    );
    return parsed.toString();
  }

  function allowPrivateRemoteEndpoints() {
    return options.deploymentMode !== "authenticated" || options.deploymentExposure !== "public";
  }

  async function assertRemoteEndpointAllowed(config: Record<string, unknown>): Promise<string> {
    const endpoint = new URL(remoteEndpoint(config));
    await assertPublicRemoteHttpEndpoint(
      endpoint,
      { allowPrivateNetwork: allowPrivateRemoteEndpoints() },
      (message, code) => new ToolGatewayHttpError(422, message, code),
    );
    return endpoint.toString();
  }

  function headerName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(trimmed)) return null;
    return trimmed.toLowerCase();
  }

  function headerValue(value: unknown): string | null {
    if (typeof value !== "string") return null;
    if (/[\r\n]/.test(value)) return null;
    return value;
  }

  function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  function readHeaderPolicy(connection: typeof toolConnections.$inferSelect): HeaderPolicyConfig {
    const config = asRecord(connection.config) ?? {};
    const transportConfig = asRecord(connection.transportConfig) ?? {};
    const rawPolicy =
      asRecord(config.headerPolicy)
      ?? asRecord(transportConfig.headerPolicy)
      ?? {};
    const passthrough = asRecord(rawPolicy.passthrough) ?? {};
    const staticHeaders = rawPolicy.staticHeaders;
    const parsedStaticHeaders: Array<{ name: string; value: string }> = [];

    if (Array.isArray(staticHeaders)) {
      for (const entry of staticHeaders) {
        const record = asRecord(entry);
        const name = headerName(record?.name);
        const value = headerValue(record?.value);
        if (name && value !== null) parsedStaticHeaders.push({ name, value });
      }
    } else {
      const record = asRecord(staticHeaders);
      if (record) {
        for (const [rawName, rawValue] of Object.entries(record)) {
          const name = headerName(rawName);
          const value = headerValue(rawValue);
          if (name && value !== null) parsedStaticHeaders.push({ name, value });
        }
      }
    }

    const passthroughAllowlist = [
      ...stringArray(passthrough.allow),
      ...stringArray(passthrough.allowedHeaders),
      ...stringArray(rawPolicy.allowedPassthroughHeaders),
    ]
      .map(headerName)
      .filter((name): name is string => Boolean(name))
      .filter((name) => !isSensitivePassthroughHeader(name));

    const metadata = asRecord(rawPolicy.metadata) ?? {};
    const metadataHeaders = [
      ...stringArray(metadata.forward),
      ...stringArray(metadata.headers),
      ...stringArray(rawPolicy.forwardContextHeaders),
    ].filter((value): value is HeaderPolicyConfig["metadataHeaders"][number] =>
      value === "company_id"
      || value === "agent_id"
      || value === "issue_id"
      || value === "project_id"
      || value === "run_id"
      || value === "gateway_session_id"
      || value === "correlation_id",
    );

    return {
      staticHeaders: parsedStaticHeaders,
      passthroughAllowlist: [...new Set(passthroughAllowlist)],
      metadataHeaders: [...new Set(metadataHeaders)],
    };
  }

  function readOnDemandToolsEnabled(connectionOrConfig: typeof toolConnections.$inferSelect | Record<string, unknown>): boolean {
    const config = "config" in connectionOrConfig ? asRecord(connectionOrConfig.config) ?? {} : connectionOrConfig;
    const raw = asRecord(config.onDemandTools) ?? asRecord(config.loadToolsOnDemand);
    return config.onDemandTools === true || config.loadToolsOnDemand === true || raw?.enabled === true;
  }

  function isOnDemandRemoteTool(tool: ToolGatewayDescriptor): boolean {
    const metadata = asRecord(tool.providerMetadata);
    return tool.providerType === "mcp_remote_http" && metadata?.onDemandTools === true;
  }

  function normalizeCallerHeaders(input: ExecuteGatewayToolInput["callerHeaders"]): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(input ?? {})) {
      const name = headerName(rawName);
      if (!name) continue;
      const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
      const normalizedValue = headerValue(value);
      if (normalizedValue !== null) headers[name] = normalizedValue;
    }
    return headers;
  }

  function metadataHeadersForSession(session: ToolGatewaySession, policy: HeaderPolicyConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    const values: Record<HeaderPolicyConfig["metadataHeaders"][number], string | null> = {
      company_id: session.companyId,
      agent_id: session.agentId,
      issue_id: session.issueId,
      project_id: session.projectId,
      run_id: session.runId,
      gateway_session_id: session.id,
      correlation_id: randomUUID(),
    };
    for (const key of policy.metadataHeaders) {
      const value = values[key];
      if (value) headers[`x-paperclip-${key.replace(/_/g, "-")}`] = value;
    }
    return headers;
  }

  function buildRemoteHeaders(input: {
    session: ToolGatewaySession;
    connection: typeof toolConnections.$inferSelect;
    credentialHeaders: Record<string, string>;
    callerHeaders?: ExecuteGatewayToolInput["callerHeaders"];
  }): { headers: Record<string, string>; summary: HeaderPolicySummary } {
    const policy = readHeaderPolicy(input.connection);
    const caller = normalizeCallerHeaders(input.callerHeaders);
    const credentialHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.credentialHeaders)) {
      const normalized = headerName(name);
      if (normalized) credentialHeaders[normalized] = value;
    }
    const reservedHeaders = new Set(["accept", "content-type", "content-length", "host", "connection"]);
    const managedCredentialHeaders = new Set(Object.keys(credentialHeaders));
    const headers: Record<string, string> = {};
    const summary: HeaderPolicySummary = {
      staticHeaderNames: [],
      credentialHeaderNames: Object.keys(credentialHeaders).sort(),
      passthroughHeaderNames: [],
      droppedPassthroughHeaderNames: [],
      metadataHeaderNames: [],
      collisionRules: [],
    };

    for (const [name, value] of Object.entries(caller)) {
      if (reservedHeaders.has(name)) {
        summary.droppedPassthroughHeaderNames.push(name);
        summary.collisionRules.push({ header: name, source: "caller", action: "dropped_reserved_header" });
        continue;
      }
      if (managedCredentialHeaders.has(name)) {
        summary.droppedPassthroughHeaderNames.push(name);
        summary.collisionRules.push({ header: name, source: "caller", action: "kept_managed_credential" });
        continue;
      }
      if (isSensitivePassthroughHeader(name)) {
        summary.droppedPassthroughHeaderNames.push(name);
        summary.collisionRules.push({ header: name, source: "caller", action: "dropped_sensitive_header" });
        continue;
      }
      if (!policy.passthroughAllowlist.includes(name)) {
        summary.droppedPassthroughHeaderNames.push(name);
        continue;
      }
      headers[name] = value;
      summary.passthroughHeaderNames.push(name);
    }

    for (const { name, value } of policy.staticHeaders) {
      if (reservedHeaders.has(name)) {
        summary.collisionRules.push({ header: name, source: "static", action: "dropped_reserved_header" });
        continue;
      }
      if (managedCredentialHeaders.has(name)) {
        summary.collisionRules.push({ header: name, source: "static", action: "kept_managed_credential" });
        continue;
      }
      if (headers[name] !== undefined) {
        summary.collisionRules.push({ header: name, source: "static", action: "overrode_passthrough" });
      }
      headers[name] = value;
      summary.staticHeaderNames.push(name);
    }

    const metadataHeaders = metadataHeadersForSession(input.session, policy);
    for (const [name, value] of Object.entries(metadataHeaders)) {
      if (reservedHeaders.has(name)) continue;
      if (managedCredentialHeaders.has(name)) {
        summary.collisionRules.push({ header: name, source: "metadata", action: "kept_managed_credential" });
        continue;
      }
      if (headers[name] !== undefined) {
        summary.collisionRules.push({ header: name, source: "metadata", action: "overrode_previous_header" });
      }
      headers[name] = value;
      summary.metadataHeaderNames.push(name);
    }

    for (const [name, value] of Object.entries(credentialHeaders)) {
      if (headers[name] !== undefined) {
        summary.collisionRules.push({ header: name, source: "credential", action: "overrode_previous_header" });
      }
      headers[name] = value;
    }

    summary.staticHeaderNames.sort();
    summary.passthroughHeaderNames.sort();
    summary.droppedPassthroughHeaderNames = [...new Set(summary.droppedPassthroughHeaderNames)].sort();
    summary.metadataHeaderNames.sort();
    return { headers, summary };
  }

  async function markRemoteConnectionHealth(
    connection: typeof toolConnections.$inferSelect,
    status: "ok" | "error" | "missing_secret",
    message: string | null,
  ) {
    const now = new Date();
    await db
      .update(toolConnections)
      .set({
        healthStatus: status,
        healthMessage: message,
        healthCheckedAt: now,
        lastHealthAt: now,
        lastError: status === "ok" ? null : message,
        updatedAt: now,
      })
      .where(eq(toolConnections.id, connection.id));
  }

  async function resolveCredentialHeaders(connection: typeof toolConnections.$inferSelect): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    for (const ref of connection.credentialRefs ?? []) {
      if (ref.placement !== "header") continue;
      try {
        const value = await secrets.resolveSecretValue(connection.companyId, ref.secretId, ref.version ?? "latest", {
          consumerType: "tool_connection",
          consumerId: connection.id,
          configPath: `credentials.${ref.name}`,
          actorType: "system",
        });
        headers[ref.key] = `${ref.prefix ?? ""}${value}`;
      } catch {
        await markRemoteConnectionHealth(connection, "missing_secret", "A configured credential secret could not be resolved.");
        throw new ToolGatewayHttpError(
          422,
          "A configured credential secret could not be resolved.",
          "remote_http_missing_secret",
          { connectionId: connection.id, credential: ref.name },
        );
      }
    }
    return headers;
  }

  function credentialVersionRefHash(value: Record<string, unknown>): string {
    return stableHash(value);
  }

  async function resolveConnectedCredentialVersion(
    connection: typeof toolConnections.$inferSelect,
    input: {
      secretId: string;
      versionSelector: SecretVersionSelector | undefined;
      configPath: string;
      refHash: string;
      requireResolved: boolean;
    },
  ): Promise<ConnectedCredentialVersionSnapshot> {
    const versionSelector = input.versionSelector ?? "latest";
    try {
      const resolvedVersion = await secrets.resolveSecretVersion(connection.companyId, input.secretId, versionSelector, {
        consumerType: "tool_connection",
        consumerId: connection.id,
        configPath: input.configPath,
        actorType: "system",
      });
      return {
        refHash: input.refHash,
        versionSelector: String(versionSelector),
        resolvedVersion,
      };
    } catch {
      await markRemoteConnectionHealth(connection, "missing_secret", "A configured credential secret could not be resolved.");
      if (input.requireResolved) {
        throw new ToolGatewayHttpError(
          422,
          "A configured credential secret could not be resolved.",
          "remote_http_missing_secret",
          { connectionId: connection.id, credential: input.configPath },
        );
      }
      return {
        refHash: input.refHash,
        versionSelector: String(versionSelector),
        resolvedVersion: -1,
      };
    }
  }

  async function connectedCredentialVersionSnapshots(
    connection: typeof toolConnections.$inferSelect,
    options: { requireResolved: boolean },
  ): Promise<{
    headerCredentialVersions: ConnectedCredentialVersionSnapshot[];
    credentialSecretVersions: ConnectedCredentialVersionSnapshot[];
  }> {
    const headerCredentialVersions: ConnectedCredentialVersionSnapshot[] = [];
    const credentialSecretVersions: ConnectedCredentialVersionSnapshot[] = [];

    for (const ref of connection.credentialRefs ?? []) {
      if (ref.placement !== "header") continue;
      const typedRef = ref as McpConnectionCredentialRef;
      const configPath = `credentials.${typedRef.name}`;
      headerCredentialVersions.push(await resolveConnectedCredentialVersion(connection, {
        secretId: typedRef.secretId,
        versionSelector: typedRef.version,
        configPath,
        refHash: credentialVersionRefHash({
          kind: "header",
          name: typedRef.name,
          secretId: typedRef.secretId,
          placement: typedRef.placement,
          key: typedRef.key,
          prefix: typedRef.prefix ?? null,
          configPath,
        }),
        requireResolved: options.requireResolved,
      }));
    }

    for (const ref of connection.credentialSecretRefs ?? []) {
      const typedRef = ref as ToolCredentialSecretRef;
      credentialSecretVersions.push(await resolveConnectedCredentialVersion(connection, {
        secretId: typedRef.secretId,
        versionSelector: typedRef.versionSelector,
        configPath: typedRef.configPath,
        refHash: credentialVersionRefHash({
          kind: "secret_ref",
          secretId: typedRef.secretId,
          configPath: typedRef.configPath,
          required: typedRef.required ?? true,
          label: typedRef.label ?? null,
        }),
        requireResolved: options.requireResolved,
      }));
    }

    return { headerCredentialVersions, credentialSecretVersions };
  }

  async function resolveConnectedRemoteTool(session: ToolGatewaySession, tool: ToolGatewayDescriptor) {
    if (tool.providerType !== "mcp_remote_http" || !tool.connectionId || !tool.catalogEntryId) {
      throw new ToolGatewayHttpError(404, `Tool "${tool.name}" not found`, "tool_not_found");
    }
    const [entry] = await db
      .select()
      .from(toolCatalogEntries)
      .where(and(
        eq(toolCatalogEntries.id, tool.catalogEntryId),
        eq(toolCatalogEntries.companyId, session.companyId),
      ))
      .limit(1);
    if (!entry || entry.status !== "active" || entry.entryKind !== "tool") {
      throw new ToolGatewayHttpError(404, `Tool "${tool.name}" not found`, "tool_not_found");
    }
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(and(
        eq(toolConnections.id, entry.connectionId),
        eq(toolConnections.companyId, session.companyId),
      ))
      .limit(1);
    if (!connection || connection.transport !== "remote_http") {
      throw new ToolGatewayHttpError(404, `Tool "${tool.name}" not found`, "tool_not_found");
    }
    if (!connection.enabled || connection.status !== "active") {
      throw new ToolGatewayHttpError(403, "Connection is disabled.", "remote_http_connection_disabled", {
        connectionId: connection.id,
      });
    }
    return { entry, connection };
  }

  async function resolveConnectedLocalStdioTool(session: ToolGatewaySession, tool: ToolGatewayDescriptor) {
    if (tool.providerType !== "mcp_local_stdio" || !tool.connectionId || !tool.catalogEntryId) {
      throw new ToolGatewayHttpError(404, `Tool "${tool.name}" not found`, "tool_not_found");
    }
    const [entry] = await db
      .select()
      .from(toolCatalogEntries)
      .where(and(
        eq(toolCatalogEntries.id, tool.catalogEntryId),
        eq(toolCatalogEntries.companyId, session.companyId),
      ))
      .limit(1);
    if (!entry || entry.status !== "active" || entry.entryKind !== "tool") {
      throw new ToolGatewayHttpError(404, `Tool "${tool.name}" not found`, "tool_not_found");
    }
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(and(
        eq(toolConnections.id, entry.connectionId),
        eq(toolConnections.companyId, session.companyId),
      ))
      .limit(1);
    if (!connection || connection.transport !== "local_stdio") {
      throw new ToolGatewayHttpError(404, `Tool "${tool.name}" not found`, "tool_not_found");
    }
    if (!connection.enabled || connection.status !== "active") {
      throw new ToolGatewayHttpError(403, "Connection is disabled.", "local_stdio_connection_disabled", {
        connectionId: connection.id,
      });
    }
    return { entry, connection };
  }

  function localStdioTemplateId(connection: typeof toolConnections.$inferSelect): string {
    const config = asRecord(connection.config) ?? {};
    const templateId = config.templateId;
    if (typeof templateId !== "string" || templateId.trim().length === 0) {
      throw new ToolGatewayHttpError(422, "Local stdio MCP connection requires an approved templateId", "local_stdio_template_missing", {
        connectionId: connection.id,
      });
    }
    return templateId.trim();
  }

  async function resolveLocalStdioRuntimeTemplate(connection: typeof toolConnections.$inferSelect): Promise<LocalStdioRuntimeTemplate> {
    const templateId = localStdioTemplateId(connection);
    const builtIn = BUILTIN_LOCAL_STDIO_RUNTIME_TEMPLATES[templateId];
    if (builtIn) return { templateId, ...builtIn };
    const [template] = await db
      .select()
      .from(toolStdioCommandTemplates)
      .where(and(
        eq(toolStdioCommandTemplates.companyId, connection.companyId),
        eq(toolStdioCommandTemplates.templateKey, templateId),
      ))
      .limit(1);
    if (!template || template.status !== "active") {
      throw new ToolGatewayHttpError(422, "Local stdio MCP connection requires an active approved template", "local_stdio_template_invalid", {
        connectionId: connection.id,
        templateId,
      });
    }
    return {
      templateId,
      command: template.command,
      args: template.args ?? [],
      envKeys: template.envKeys ?? [],
    };
  }

  function localStdioEnvironment(connection: typeof toolConnections.$inferSelect, template: LocalStdioRuntimeTemplate): NodeJS.ProcessEnv {
    const config = asRecord(connection.config) ?? {};
    const configEnv = asRecord(config.env) ?? {};
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
      const value = process.env[key];
      if (typeof value === "string" && value.length > 0) {
        env[key] = value;
      }
    }
    for (const key of template.envKeys) {
      const configured = configEnv[key];
      if (typeof configured === "string") {
        env[key] = configured;
      }
    }
    return env;
  }

  function stdioProtocolError(message: string, details: Record<string, unknown> = {}) {
    return new ToolGatewayHttpError(502, message, "local_stdio_protocol_error", details);
  }

  async function callLocalStdioMcp(input: {
    connection: typeof toolConnections.$inferSelect;
    entry: typeof toolCatalogEntries.$inferSelect;
    template: LocalStdioRuntimeTemplate;
    parameters: unknown;
    timeoutMs: number;
  }): Promise<unknown> {
    if (!input.template.command) {
      throw new ToolGatewayHttpError(
        501,
        "Local stdio template does not define an executable command",
        "local_stdio_command_unavailable",
        { connectionId: input.connection.id, templateId: input.template.templateId },
      );
    }
    const child = spawn(input.template.command, input.template.args, {
      env: localStdioEnvironment(input.connection, input.template),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let nextId = 1;
    const pending = new Map<number, {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }>();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      for (const { reject } of pending.values()) {
        reject(new ToolGatewayHttpError(504, "Local stdio MCP tool call timed out", "tool_timeout", {
          connectionId: input.connection.id,
          catalogEntryId: input.entry.id,
        }));
      }
      pending.clear();
    }, input.timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            const id = typeof message.id === "number" ? message.id : null;
            if (id !== null && pending.has(id)) {
              const waiter = pending.get(id)!;
              pending.delete(id);
              if (message.error !== undefined) {
                waiter.reject(stdioProtocolError("Local stdio MCP server returned a JSON-RPC error", {
                  connectionId: input.connection.id,
                  catalogEntryId: input.entry.id,
                  error: message.error,
                }));
              } else {
                waiter.resolve(message.result);
              }
            }
          } catch {
            for (const { reject } of pending.values()) {
              reject(stdioProtocolError("Local stdio MCP server returned invalid JSON", {
                connectionId: input.connection.id,
                catalogEntryId: input.entry.id,
              }));
            }
            pending.clear();
          }
        }
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    const exitPromise = new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        const gatewayError = new ToolGatewayHttpError(502, "Local stdio MCP command failed to start", "local_stdio_spawn_failed", {
          connectionId: input.connection.id,
          templateId: input.template.templateId,
          message: error.message,
        });
        for (const { reject: rejectPending } of pending.values()) {
          rejectPending(gatewayError);
        }
        pending.clear();
        reject(gatewayError);
      });
      child.on("exit", (code, signal) => {
        if (pending.size === 0) {
          resolve();
          return;
        }
        for (const { reject: rejectPending } of pending.values()) {
          rejectPending(new ToolGatewayHttpError(502, "Local stdio MCP command exited before responding", "local_stdio_process_exited", {
            connectionId: input.connection.id,
            catalogEntryId: input.entry.id,
            code,
            signal,
            stderr,
          }));
        }
        pending.clear();
        resolve();
      });
    });
    const request = (method: string, params: Record<string, unknown>) => {
      const id = nextId;
      nextId += 1;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return promise;
    };
    try {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "paperclip-tool-gateway", version: "0.3.1" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      return await request("tools/call", {
        name: input.entry.toolName,
        arguments: input.parameters ?? {},
      });
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      await exitPromise.catch(() => undefined);
    }
  }

  async function connectedRemoteApprovalSnapshot(
    session: ToolGatewaySession,
    tool: ToolGatewayDescriptor,
    options: { requireResolvedCredentials?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    if (tool.providerType !== "mcp_remote_http" || !tool.connectionId || !tool.catalogEntryId) {
      return null;
    }
    const [row] = await db
      .select({
        entry: toolCatalogEntries,
        connection: toolConnections,
        application: toolApplications,
      })
      .from(toolCatalogEntries)
      .innerJoin(toolConnections, eq(toolCatalogEntries.connectionId, toolConnections.id))
      .innerJoin(toolApplications, eq(toolConnections.applicationId, toolApplications.id))
      .where(and(
        eq(toolCatalogEntries.id, tool.catalogEntryId),
        eq(toolCatalogEntries.companyId, session.companyId),
        eq(toolConnections.id, tool.connectionId),
        eq(toolConnections.companyId, session.companyId),
        eq(toolApplications.companyId, session.companyId),
      ))
      .limit(1);
    if (!row) return null;
    const credentialVersions = await connectedCredentialVersionSnapshots(row.connection, {
      requireResolved: options.requireResolvedCredentials === true,
    });
    return {
      applicationId: row.application.id,
      applicationKey: row.application.applicationKey ?? null,
      applicationStatus: row.application.status,
      applicationType: row.application.type,
      connectionId: row.connection.id,
      connectionStatus: row.connection.status,
      connectionEnabled: row.connection.enabled,
      connectionTransport: row.connection.transport,
      connectionConfigHash: stableHash(row.connection.config ?? {}),
      connectionTransportConfigHash: stableHash(row.connection.transportConfig ?? {}),
      credentialRefsHash: stableHash(row.connection.credentialRefs ?? []),
      credentialSecretRefsHash: stableHash(row.connection.credentialSecretRefs ?? []),
      headerCredentialVersions: credentialVersions.headerCredentialVersions,
      credentialSecretVersions: credentialVersions.credentialSecretVersions,
      catalogEntryId: row.entry.id,
      catalogStatus: row.entry.status,
      catalogEntryKind: row.entry.entryKind,
      catalogVersionHash: row.entry.versionHash,
      catalogSchemaHash: row.entry.schemaHash ?? null,
      upstreamToolName: row.entry.toolName,
      providerType: tool.providerType,
      gatewayToolName: tool.name,
      riskLevel: tool.risk,
    };
  }

  function responseTooLargeError() {
    return new ToolGatewayHttpError(
      502,
      "Remote MCP response exceeded the gateway size limit",
      "remote_http_response_too_large",
      { maxBytes: MAX_REMOTE_MCP_RESPONSE_BYTES },
    );
  }

  async function readBoundedRemoteResponse(response: Response): Promise<string> {
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REMOTE_MCP_RESPONSE_BYTES) {
      throw responseTooLargeError();
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_REMOTE_MCP_RESPONSE_BYTES) {
      throw responseTooLargeError();
    }
    return body;
  }

  function malformedRemoteMcpResponse(): ToolGatewayHttpError {
    return new ToolGatewayHttpError(
      502,
      "Remote MCP server returned a malformed tools/call response",
      "remote_mcp_malformed_response",
    );
  }

  type McpElicitationRequest = {
    message: string;
    requestedSchema: Record<string, unknown> | null;
    raw: Record<string, unknown>;
  };

  function extractMcpElicitationRequest(value: unknown): McpElicitationRequest | null {
    const record = asRecord(value);
    if (!record) return null;
    const meta = asRecord(record._meta);
    const candidate =
      (record.method === "elicitation/create" ? asRecord(record.params) : null)
      ?? asRecord(record.elicitation)
      ?? asRecord(record.elicitationRequest)
      ?? asRecord(meta?.elicitation)
      ?? asRecord(meta?.elicitationRequest);
    if (!candidate) return null;
    const message =
      stringValue(candidate.message)
      ?? stringValue(candidate.prompt)
      ?? stringValue(candidate.title)
      ?? "The MCP tool needs more information before it can continue.";
    const requestedSchema = asRecord(candidate.requestedSchema ?? candidate.schema ?? candidate.inputSchema);
    return { message, requestedSchema, raw: candidate };
  }

  function enumOptions(values: unknown[]): Array<{ id: string; label: string }> {
    return values.slice(0, 10).map((value, index) => {
      const label = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : `Option ${index + 1}`;
      return {
        id: slugSegment(label, `option-${index + 1}`).slice(0, 120),
        label: label.slice(0, 120),
      };
    });
  }

  function elicitationQuestions(request: McpElicitationRequest) {
    const schema = request.requestedSchema;
    const properties = asRecord(schema?.properties);
    const required = Array.isArray(schema?.required)
      ? new Set(schema.required.filter((item): item is string => typeof item === "string"))
      : new Set<string>();
    const questions: Array<{
      id: string;
      prompt: string;
      helpText?: string | null;
      selectionMode: "single" | "multi";
      required?: boolean;
      options: Array<{ id: string; label: string; description?: string | null }>;
    }> = [];
    if (properties) {
      for (const [key, rawProperty] of Object.entries(properties)) {
        if (questions.length >= 10) break;
        const property = asRecord(rawProperty) ?? {};
        const enumValues = Array.isArray(property.enum) ? property.enum : [];
        const options = enumValues.length > 0
          ? enumOptions(enumValues)
          : [{ id: "answer", label: "Provide answer" }];
        questions.push({
          id: key.slice(0, 120),
          prompt: (stringValue(property.title) ?? stringValue(property.description) ?? key).slice(0, 500),
          helpText: enumValues.length > 0 ? null : "Use Other to enter the requested value.",
          selectionMode: "single",
          required: required.has(key),
          options,
        });
      }
    }
    if (questions.length > 0) return questions;
    return [{
      id: "response",
      prompt: request.message.slice(0, 500),
      helpText: "Use Other to enter the requested response.",
      selectionMode: "single" as const,
      required: true,
      options: [{ id: "answer", label: "Provide response" }],
    }];
  }

  async function requestElicitationForRecordedToolCall(input: {
    session: ToolGatewaySession;
    tool: ToolGatewayDescriptor;
    invocationId: string;
    request: McpElicitationRequest;
  }): Promise<never> {
    if (!input.session.issueId) {
      throw new ToolGatewayHttpError(
        409,
        "MCP elicitation is not supported for non-interactive gateway clients",
        "elicitation_not_supported",
        { invocationId: input.invocationId, tool: input.tool.name },
      );
    }
    const interaction = await interactions.create(
      { id: input.session.issueId, companyId: input.session.companyId },
      {
        kind: "ask_user_questions",
        idempotencyKey: `mcp-elicitation:${input.invocationId}`,
        title: "Tool needs input",
        summary: `${input.tool.name} asked for more information before it can continue.`,
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          title: input.request.message.slice(0, 240),
          submitLabel: "Send response",
          questions: elicitationQuestions(input.request),
        },
      },
      { agentId: input.session.agentId },
    );
    const now = new Date();
    await db
      .update(toolInvocations)
      .set({
        status: "awaiting_approval",
        errorCode: "elicitation_required",
        errorMessage: "Remote MCP tool requested elicitation; Paperclip created an issue interaction for the response.",
        updatedAt: now,
      })
      .where(eq(toolInvocations.id, input.invocationId));
    await writeToolCallEvent({
      invocationId: input.invocationId,
      session: input.session,
      eventType: "call_failed",
      outcome: "pending",
      toolName: input.tool.name,
      policyDecision: "defer_runtime",
      reasonCode: "elicitation_required",
      metadata: { interactionId: interaction.id, elicitation: { message: input.request.message, requestedSchema: input.request.requestedSchema } },
      tool: input.tool,
    });
    await writeAudit({
      session: input.session,
      companyId: input.session.companyId,
      agentId: input.session.agentId,
      runId: input.session.runId,
      issueId: input.session.issueId,
      action: "tool_gateway.elicitation_requested",
      details: {
        invocationId: input.invocationId,
        interactionId: interaction.id,
        decision: "defer_runtime",
        reasonCode: "elicitation_required",
        tool: input.tool.name,
        ...toolAuditMetadata(input.tool),
      },
    });
    throw new ToolGatewayHttpError(409, "MCP tool requested additional input", "elicitation_required", {
      invocationId: input.invocationId,
      interactionId: interaction.id,
      tool: input.tool.name,
    });
  }

  function normalizeMcpContent(content: unknown): string {
    if (!Array.isArray(content)) throw malformedRemoteMcpResponse();
    return content.map((item) => {
      const record = asRecord(item);
      if (!record || typeof record.type !== "string") throw malformedRemoteMcpResponse();
      if (record.type === "text") {
        if (typeof record.text !== "string") throw malformedRemoteMcpResponse();
        return record.text;
      }
      return JSON.stringify(record);
    }).join("\n");
  }

  function normalizeMcpToolResult(
    result: unknown,
    transport: "mcp_http" | "local_stdio" = "mcp_http",
    spawnedLocalProcess = false,
  ) {
    const record = asRecord(result);
    if (!record) throw malformedRemoteMcpResponse();
    return {
      content: normalizeMcpContent(record.content),
      data: {
        content: record.content,
        structuredContent: record.structuredContent ?? null,
        isError: record.isError === true,
        transport,
        spawnedLocalProcess,
      },
      ...(record.isError === true ? { error: "MCP tool returned an error result" } : {}),
    };
  }

  async function executeRemoteHttpTool(
    session: ToolGatewaySession,
    tool: ToolGatewayDescriptor,
    parameters: unknown,
    ms: number,
    invocationId: string,
    callerHeaders?: ExecuteGatewayToolInput["callerHeaders"],
  ): Promise<RemoteHttpExecutionResult> {
    const { entry, connection } = await resolveConnectedRemoteTool(session, tool);
    const endpoint = await assertRemoteEndpointAllowed(connection.config ?? {});
    const credentialHeaders = await resolveCredentialHeaders(connection);
    const { headers, summary: headerSummary } = buildRemoteHeaders({
      session,
      connection,
      credentialHeaders,
      callerHeaders,
    });
    const requestId = `paperclip-tool-${randomUUID()}`;
    const execution: RemoteHttpExecutionAudit = {
      transport: "remote_http",
      request: {
        protocol: "MCP JSON-RPC 2.0",
        httpMethod: "POST",
        endpoint: auditSafeEndpoint(endpoint),
        mcpMethod: "tools/call",
        requestId,
        upstreamToolName: entry.toolName,
        dispatched: true,
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "manual",
        // MCP Streamable HTTP requires the Accept header advertising both a JSON
        // body and an SSE stream; spec-compliant servers 406 without it.
        headers: mcpHttpRequestHeaders(headers),
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: {
            name: entry.toolName,
            arguments: parameters ?? {},
          },
        }),
      });
      const body = await readBoundedRemoteResponse(response);
      execution.response = {
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        bodySizeBytes: Buffer.byteLength(body, "utf8"),
        upstreamRequestId:
          response.headers.get("x-request-id")
          ?? response.headers.get("x-zapier-request-id")
          ?? response.headers.get("traceparent"),
      };
      if (!response.ok) {
        await markRemoteConnectionHealth(connection, "error", "Remote MCP server returned an HTTP error.");
        throw new ToolGatewayHttpError(502, "Remote MCP server returned an HTTP error", "remote_http_status", {
          status: response.status,
          connectionId: connection.id,
          catalogEntryId: entry.id,
          execution,
        });
      }
      let payload: unknown;
      try {
        payload = parseMcpHttpResponseBody(body, response.headers.get("content-type"));
      } catch {
        await markRemoteConnectionHealth(connection, "error", "Remote MCP server returned invalid JSON.");
        throw new ToolGatewayHttpError(502, "Remote MCP server returned invalid JSON", "remote_http_invalid_json", {
          connectionId: connection.id,
          catalogEntryId: entry.id,
          execution,
        });
      }
      const payloadRecord = asRecord(payload);
      if (!payloadRecord) throw malformedRemoteMcpResponse();
      const topLevelElicitation = extractMcpElicitationRequest(payloadRecord);
      if (topLevelElicitation) {
        await requestElicitationForRecordedToolCall({ session, tool, invocationId, request: topLevelElicitation });
      }
      if (payloadRecord.error !== undefined) {
        const errorRecord = asRecord(payloadRecord.error);
        await markRemoteConnectionHealth(connection, "error", "Remote MCP server returned a JSON-RPC error.");
        throw new ToolGatewayHttpError(502, "Remote MCP server returned an error", "remote_mcp_error", {
          code: typeof errorRecord?.code === "number" ? errorRecord.code : null,
          connectionId: connection.id,
          catalogEntryId: entry.id,
          execution,
        });
      }
      if (!Object.prototype.hasOwnProperty.call(payloadRecord, "result")) {
        throw malformedRemoteMcpResponse();
      }
      const resultElicitation = extractMcpElicitationRequest(payloadRecord.result);
      if (resultElicitation) {
        await requestElicitationForRecordedToolCall({ session, tool, invocationId, request: resultElicitation });
      }
      const result = normalizeMcpToolResult(payloadRecord.result);
      await markRemoteConnectionHealth(connection, "ok", "Remote MCP server responded to tools/call.");
      return { result, headerSummary, execution };
    } catch (error) {
      if (error instanceof ToolGatewayHttpError) {
        throw new ToolGatewayHttpError(error.status, error.message, error.reasonCode, {
          ...error.details,
          execution: error.details.execution ?? execution,
        });
      }
      if (error instanceof Error && error.name === "AbortError") {
        await markRemoteConnectionHealth(connection, "error", "Remote MCP tool call timed out.");
        throw new ToolGatewayHttpError(504, "Remote MCP tool call timed out", "tool_timeout", {
          connectionId: connection.id,
          catalogEntryId: entry.id,
          execution,
        });
      }
      await markRemoteConnectionHealth(connection, "error", "Remote MCP tool call failed.");
      throw new ToolGatewayHttpError(502, "Remote MCP tool call failed", "remote_http_fetch_failed", {
        connectionId: connection.id,
        catalogEntryId: entry.id,
        execution,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function executeLocalStdioTool(
    session: ToolGatewaySession,
    tool: ToolGatewayDescriptor,
    parameters: unknown,
    ms: number,
  ): Promise<RemoteHttpExecutionResult> {
    const { entry, connection } = await resolveConnectedLocalStdioTool(session, tool);
    const template = await resolveLocalStdioRuntimeTemplate(connection);
    const result = await runtimeSupervisor.useConnectionSlot(
      {
        companyId: session.companyId,
        applicationId: tool.applicationId ?? null,
        connectionId: connection.id,
        connectionKey: `mcp:${session.companyId}:${connection.id}`,
        runId: session.runId,
        issueId: session.issueId,
        agentId: session.agentId,
        commandTemplateKey: template.templateId,
        metadata: {
          fixture: "connected-local-stdio",
          applicationId: tool.applicationId ?? null,
          connectionId: connection.id,
          catalogEntryId: entry.id,
        },
      },
      async (handle) => {
        handle.appendLog("stdout", `calling ${entry.toolName}`);
        return callLocalStdioMcp({
          connection,
          entry,
          template,
          parameters,
          timeoutMs: ms,
        });
      },
    );
    return {
      result: normalizeMcpToolResult(result, "local_stdio", true),
    };
  }

  async function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new ToolGatewayHttpError(504, "Tool execution timed out", "tool_timeout"));
          }, ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function gatewayEndpointPath(gatewayPublicId: string) {
    return `/mcp/gateways/${gatewayPublicId}`;
  }

  function gatewayClientSnippets(gateway: Pick<typeof toolMcpGateways.$inferSelect, "gatewayPublicId" | "name">): ToolMcpGatewayClientSnippet[] {
    const endpoint = gatewayEndpointPath(gateway.gatewayPublicId);
    const bearerPlaceholder = "pcgw_...";
    return [
      {
        client: "cursor",
        label: "Cursor",
        config: { mcpServers: { [gateway.name]: { url: endpoint, headers: { Authorization: `Bearer ${bearerPlaceholder}` } } } },
        notes: ["Use the full Paperclip origin before the endpoint path."],
      },
      {
        client: "claude_desktop",
        label: "Claude Desktop",
        config: { mcpServers: { [gateway.name]: { url: endpoint, headers: { Authorization: `Bearer ${bearerPlaceholder}` } } } },
        notes: ["Recent Claude Desktop builds support remote HTTP MCP servers."],
      },
      {
        client: "vscode",
        label: "VS Code",
        config: { servers: { [gateway.name]: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${bearerPlaceholder}` } } } },
        notes: ["Place this under your MCP extension or editor MCP settings."],
      },
      {
        client: "claude_code",
        label: "Claude Code",
        config: { command: "claude", args: ["mcp", "add", gateway.name, endpoint, "--header", `Authorization: Bearer ${bearerPlaceholder}`] },
        notes: ["Use the equivalent remote HTTP MCP add command for your installed version."],
      },
      {
        client: "opencode",
        label: "OpenCode",
        config: { mcp: { [gateway.name]: { url: endpoint, headers: { Authorization: `Bearer ${bearerPlaceholder}` } } } },
        notes: ["Use the full Paperclip origin before the endpoint path."],
      },
    ];
  }

  function toGateway(row: typeof toolMcpGateways.$inferSelect): ToolMcpGateway {
    return {
      id: row.id,
      companyId: row.companyId,
      gatewayPublicId: row.gatewayPublicId,
      name: row.name,
      displaySlug: row.displaySlug || row.slug,
      slug: row.slug,
      description: row.description,
      status: row.status,
      profileId: row.profileId,
      defaultProfileMode: row.defaultProfileMode,
      contextScopeType: row.contextScopeType,
      contextScopeId: row.contextScopeId,
      agentId: row.agentId,
      projectId: row.projectId,
      issueId: row.issueId,
      approvalIssueId: row.approvalIssueId,
      endpointPath: gatewayEndpointPath(row.gatewayPublicId),
      authConfig: row.authConfig,
      headerPolicy: row.headerPolicy,
      metadataPolicy: row.metadataPolicy,
      onDemandToolsConfig: row.onDemandToolsConfig,
      metadata: row.metadata ?? {},
      createdByAgentId: row.createdByAgentId,
      createdByUserId: row.createdByUserId,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toGatewayToken(row: typeof toolMcpGatewayTokens.$inferSelect): ToolMcpGatewayToken {
    return {
      id: row.id,
      companyId: row.companyId,
      gatewayId: row.gatewayId,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      clientLabel: row.clientLabel,
      ownerNote: row.ownerNote,
      allowedActions: row.allowedActions,
      expiresAt: row.expiresAt,
      expiryOverrideReason: row.expiryOverrideReason,
      expiryOverrideByUserId: row.expiryOverrideByUserId,
      expiryOverrideByAgentId: row.expiryOverrideByAgentId,
      expiryOverrideAt: row.expiryOverrideAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      createdByAgentId: row.createdByAgentId,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function getGatewayWithTokens(companyId: string, gatewayId: string): Promise<ToolMcpGatewayWithTokens> {
    const [gateway] = await db
      .select()
      .from(toolMcpGateways)
      .where(and(eq(toolMcpGateways.companyId, companyId), eq(toolMcpGateways.id, gatewayId)))
      .limit(1);
    if (!gateway) {
      throw new ToolGatewayHttpError(404, "MCP gateway not found", "gateway_not_found");
    }
    const tokens = await db
      .select()
      .from(toolMcpGatewayTokens)
      .where(and(eq(toolMcpGatewayTokens.companyId, companyId), eq(toolMcpGatewayTokens.gatewayId, gatewayId)))
      .orderBy(desc(toolMcpGatewayTokens.createdAt));
    return {
      ...toGateway(gateway),
      tokens: tokens.map(toGatewayToken),
      clientSnippets: gatewayClientSnippets(gateway),
    };
  }

  async function assertGatewayContext(input: {
    companyId: string;
    profileId?: string | null;
    agentId?: string | null;
    projectId?: string | null;
    issueId?: string | null;
  }) {
    if (input.profileId) {
      const [profile] = await db
        .select({ id: toolProfiles.id })
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, input.companyId), eq(toolProfiles.id, input.profileId)))
        .limit(1);
      if (!profile) throw new ToolGatewayHttpError(422, "Gateway profile must belong to the company", "gateway_profile_invalid");
    }
    if (input.agentId) await assertAgentInCompany(input.companyId, input.agentId);
    if (input.projectId) {
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)))
        .limit(1);
      if (!project) throw new ToolGatewayHttpError(422, "Gateway project must belong to the company", "gateway_project_invalid");
    }
    if (input.issueId) {
      const [issue] = await db
        .select({ id: issues.id, projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
        .limit(1);
      if (!issue) throw new ToolGatewayHttpError(422, "Gateway issue must belong to the company", "gateway_issue_invalid");
      if (input.projectId && issue.projectId && issue.projectId !== input.projectId) {
        throw new ToolGatewayHttpError(422, "Gateway issue must belong to the selected project", "gateway_issue_project_mismatch");
      }
    }
  }

  async function findGatewayForProtocolLocator(input: { gatewayId?: string | null; gatewayPublicId?: string | null }) {
    if (input.gatewayId) {
      const [gateway] = await db
        .select()
        .from(toolMcpGateways)
        .where(eq(toolMcpGateways.id, input.gatewayId))
        .limit(1);
      return gateway ?? null;
    }
    if (input.gatewayPublicId) {
      const [gateway] = await db
        .select()
        .from(toolMcpGateways)
        .where(eq(toolMcpGateways.gatewayPublicId, input.gatewayPublicId))
        .limit(1);
      return gateway ?? null;
    }
    return null;
  }

  function protocolLimiterKeyClass(method: McpGatewayProtocolMethod) {
    return method === "initialize" ? "session_setup" : method;
  }

  async function writeProtocolRateLimitAudit(input: {
    session: ToolGatewaySession;
    method: McpGatewayProtocolMethod;
    limiterKeyClass: "token" | "gateway";
    count: number;
    limit: McpGatewayRateLimitConfig;
    retryAfterMs: number;
    clientMetadata: ReturnType<typeof safeClientMetadata>;
  }) {
    await writeAudit({
      session: input.session,
      companyId: input.session.companyId,
      agentId: input.session.agentId,
      runId: input.session.runId,
      issueId: input.session.issueId,
      action: "tool_gateway.call_denied",
      details: {
        decision: "rate_limited",
        reasonCode: "gateway_rate_limited",
        reasonText: "The MCP gateway request was rate limited before the protocol action ran.",
        limiterKeyClass: input.limiterKeyClass,
        protocolMethod: input.method,
        protocolAction: protocolLimiterKeyClass(input.method),
        requestCount: input.count,
        limit: input.limit.max,
        windowMs: input.limit.windowMs,
        retryAfterMs: input.retryAfterMs,
        gatewayId: input.session.gatewayId ?? null,
        gatewayPublicId: input.session.gatewayPublicId ?? null,
        gatewayTokenId: input.session.gatewayTokenId ?? null,
        tokenPrefix: typeof input.session.gatewayTokenId === "string" ? `pcgw_${input.session.gatewayTokenId.slice(0, 8)}` : null,
        ...input.clientMetadata,
      },
    });
  }

  async function assertNamedGatewayProtocolLimit(
    session: ToolGatewaySession,
    method: McpGatewayProtocolMethod,
    clientMetadata: ReturnType<typeof safeClientMetadata>,
  ) {
    const action = protocolLimiterKeyClass(method);
    const tokenLimit = method === "initialize" ? protocolLimits.sessionSetup : protocolLimits.tokenRequests;
    const tokenKey = `mcp_gateway_protocol:token:${session.gatewayTokenId ?? session.actorId ?? "unknown"}:${action}`;
    const tokenState = await consumeProtocolRateLimit({ companyId: session.companyId, counterKey: tokenKey, config: tokenLimit });
    if (tokenState.limited) {
      await writeProtocolRateLimitAudit({
        session,
        method,
        limiterKeyClass: "token",
        count: tokenState.count,
        limit: tokenLimit,
        retryAfterMs: tokenState.retryAfterMs,
        clientMetadata,
      });
      throw new ToolGatewayHttpError(429, "MCP gateway request was rate limited", "gateway_rate_limited", {
        reasonText: "The MCP gateway request was rate limited before the protocol action ran.",
        limiterKeyClass: "token",
        protocolMethod: method,
        retryAfterMs: tokenState.retryAfterMs,
      });
    }

    const gatewayLimit = method === "initialize" ? protocolLimits.sessionSetup : protocolLimits.gatewayRequests;
    const gatewayKey = `mcp_gateway_protocol:gateway:${session.gatewayId ?? session.gatewayPublicId ?? "unknown"}:${action}`;
    const gatewayState = await consumeProtocolRateLimit({ companyId: session.companyId, counterKey: gatewayKey, config: gatewayLimit });
    if (gatewayState.limited) {
      await writeProtocolRateLimitAudit({
        session,
        method,
        limiterKeyClass: "gateway",
        count: gatewayState.count,
        limit: gatewayLimit,
        retryAfterMs: gatewayState.retryAfterMs,
        clientMetadata,
      });
      throw new ToolGatewayHttpError(429, "MCP gateway request was rate limited", "gateway_rate_limited", {
        reasonText: "The MCP gateway request was rate limited before the protocol action ran.",
        limiterKeyClass: "gateway",
        protocolMethod: method,
        retryAfterMs: gatewayState.retryAfterMs,
      });
    }
  }

  async function recordNamedGatewayAuthFailure(input: {
    gatewayId?: string | null;
    gatewayPublicId?: string | null;
    bearerToken: string;
    reasonCode: string;
    clientMetadata: ReturnType<typeof safeClientMetadata>;
  }): Promise<never> {
    const token = input.bearerToken.trim();
    const tokenId = namedGatewayTokenId(token);
    const gatewayKey = input.gatewayId ? `id:${input.gatewayId}` : `public:${input.gatewayPublicId ?? "unknown"}`;
    const tokenKey = tokenId ? `id:${tokenId}` : `hash:${hashGatewayToken(token).slice(0, 24)}`;
    const gateway = await findGatewayForProtocolLocator(input);
    if (!gateway) {
      throw new ToolGatewayHttpError(401, "Gateway bearer token is expired or invalid", input.reasonCode);
    }
    const gatewayState = await consumeProtocolRateLimit({
      companyId: gateway.companyId,
      counterKey: `mcp_gateway_auth_failure:gateway:${gatewayKey}`,
      config: protocolLimits.authFailures,
    });
    const tokenState = await consumeProtocolRateLimit({
      companyId: gateway.companyId,
      counterKey: `mcp_gateway_auth_failure:token:${gatewayKey}:${tokenKey}`,
      config: protocolLimits.authFailures,
    });
    const limited = gatewayState.limited || tokenState.limited;
    if (limited) {
      const limiterKeyClass = gatewayState.limited ? "gateway_auth" : "token_auth";
      const count = gatewayState.limited ? gatewayState.count : tokenState.count;
      const retryAfterMs = gatewayState.limited ? gatewayState.retryAfterMs : tokenState.retryAfterMs;
      await writeAudit({
        session: {
          id: `gateway:${gateway.id}`,
          token: "",
          companyId: gateway.companyId,
          agentId: gateway.agentId,
          runId: null,
          issueId: gateway.issueId,
          projectId: gateway.projectId,
          gatewayId: gateway.id,
          gatewayPublicId: gateway.gatewayPublicId,
          gatewayName: gateway.name,
          gatewayTokenId: null,
          actorType: "system",
          actorId: gateway.id,
          createdAt: new Date(),
          expiresAt: new Date(),
        },
        companyId: gateway.companyId,
        agentId: gateway.agentId,
        runId: null,
        issueId: gateway.issueId,
        action: "tool_gateway.session_rejected",
        details: {
          decision: "deny",
          reasonCode: "gateway_auth_throttled",
          reasonText: "The MCP gateway authentication attempt was throttled after repeated failures.",
          limiterKeyClass,
          failedReasonCode: input.reasonCode,
          requestCount: count,
          limit: protocolLimits.authFailures.max,
          windowMs: protocolLimits.authFailures.windowMs,
          retryAfterMs,
          gatewayId: gateway.id,
          gatewayPublicId: gateway.gatewayPublicId,
          tokenPrefix: tokenPrefixFromNamedBearer(token),
          ...input.clientMetadata,
        },
      });
    }
    if (limited) {
      throw new ToolGatewayHttpError(429, "MCP gateway authentication was throttled", "gateway_auth_throttled", {
        reasonText: "The MCP gateway authentication attempt was throttled after repeated failures.",
        retryAfterMs: Math.max(gatewayState.retryAfterMs, tokenState.retryAfterMs),
      });
    }
    throw new ToolGatewayHttpError(401, "Gateway bearer token is expired or invalid", input.reasonCode);
  }

  async function namedGatewaySessionFromBearer(input: {
    gatewayId?: string | null;
    gatewayPublicId?: string | null;
    bearerToken: string;
    protocolMethod: McpGatewayProtocolMethod;
    callerHeaders?: Record<string, string | string[] | undefined>;
  }): Promise<ToolGatewaySession> {
    const clientMetadata = safeClientMetadata(input.callerHeaders);
    const bearerToken = input.bearerToken.trim();
    const tokenId = namedGatewayTokenId(bearerToken.trim());
    const tokenHash = hashGatewayToken(bearerToken.trim());
    const conditions = [eq(toolMcpGatewayTokens.tokenHash, tokenHash)];
    if (input.gatewayId) conditions.push(eq(toolMcpGatewayTokens.gatewayId, input.gatewayId));
    if (input.gatewayPublicId) conditions.push(eq(toolMcpGateways.gatewayPublicId, input.gatewayPublicId));
    const [row] = await db
      .select({ gateway: toolMcpGateways, token: toolMcpGatewayTokens })
      .from(toolMcpGatewayTokens)
      .innerJoin(toolMcpGateways, eq(toolMcpGatewayTokens.gatewayId, toolMcpGateways.id))
      .where(and(...conditions))
      .limit(1);
    if (!row) {
      await recordNamedGatewayAuthFailure({
        gatewayId: input.gatewayId,
        gatewayPublicId: input.gatewayPublicId,
        bearerToken,
        reasonCode: "gateway_token_invalid",
        clientMetadata,
      });
    }
    if (row.gateway.status !== "active") {
      await recordNamedGatewayAuthFailure({
        gatewayId: input.gatewayId,
        gatewayPublicId: input.gatewayPublicId,
        bearerToken,
        reasonCode: "gateway_disabled",
        clientMetadata,
      });
    }
    if (row.token.revokedAt) {
      await recordNamedGatewayAuthFailure({
        gatewayId: input.gatewayId,
        gatewayPublicId: input.gatewayPublicId,
        bearerToken,
        reasonCode: "gateway_token_revoked",
        clientMetadata,
      });
    }
    if (row.token.expiresAt && row.token.expiresAt.getTime() <= Date.now()) {
      await recordNamedGatewayAuthFailure({
        gatewayId: input.gatewayId,
        gatewayPublicId: input.gatewayPublicId,
        bearerToken,
        reasonCode: "gateway_token_expired",
        clientMetadata,
      });
    }
    let agentId = row.gateway.agentId;
    let runId: string | null = null;
    let issueId = row.gateway.issueId;
    let projectId = row.gateway.projectId;
    if (row.token.subjectType === "heartbeat_run") {
      const tokenRunId = row.token.subjectId;
      if (!tokenRunId || !uuidPattern.test(tokenRunId)) {
        return recordNamedGatewayAuthFailure({
          gatewayId: input.gatewayId,
          gatewayPublicId: input.gatewayPublicId,
          bearerToken,
          reasonCode: "gateway_token_run_invalid",
          clientMetadata,
        });
      }
      const [run] = await db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, tokenRunId))
        .limit(1);
      if (!run || run.companyId !== row.gateway.companyId) {
        return recordNamedGatewayAuthFailure({
          gatewayId: input.gatewayId,
          gatewayPublicId: input.gatewayPublicId,
          bearerToken,
          reasonCode: "gateway_token_run_invalid",
          clientMetadata,
        });
      }
      if (!ACTIVE_GATEWAY_RUN_STATUSES.has(run.status)) {
        return recordNamedGatewayAuthFailure({
          gatewayId: input.gatewayId,
          gatewayPublicId: input.gatewayPublicId,
          bearerToken,
          reasonCode: "gateway_token_run_inactive",
          clientMetadata,
        });
      }
      if (row.gateway.agentId && row.gateway.agentId !== run.agentId) {
        return recordNamedGatewayAuthFailure({
          gatewayId: input.gatewayId,
          gatewayPublicId: input.gatewayPublicId,
          bearerToken,
          reasonCode: "gateway_token_run_context_invalid",
          clientMetadata,
        });
      }
      try {
        const runContext = await resolveRunContext({
          companyId: row.gateway.companyId,
          agentId: run.agentId,
          runId: tokenRunId,
          issueId: row.gateway.issueId,
          projectId: row.gateway.projectId,
        });
        agentId = run.agentId;
        runId = tokenRunId;
        issueId = runContext.issueId;
        projectId = runContext.projectId;
      } catch {
        return recordNamedGatewayAuthFailure({
          gatewayId: input.gatewayId,
          gatewayPublicId: input.gatewayPublicId,
          bearerToken,
          reasonCode: "gateway_token_run_context_invalid",
          clientMetadata,
        });
      }
    }
    const now = new Date();
    await db
      .update(toolMcpGatewayTokens)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(toolMcpGatewayTokens.id, row.token.id));
    const session: ToolGatewaySession = {
      id: `gateway:${row.gateway.id}`,
      token: "",
      companyId: row.gateway.companyId,
      agentId,
      runId,
      issueId,
      projectId,
      gatewayId: row.gateway.id,
      gatewayPublicId: row.gateway.gatewayPublicId,
      gatewayName: row.gateway.name,
      gatewayTokenId: row.token.id || tokenId,
      gatewayTokenAllowedActions: normalizeGatewayTokenActions(row.token.allowedActions),
      actorType: runId ? "agent" : "system",
      actorId: runId ? agentId : row.token.id,
      createdAt: row.token.createdAt,
      expiresAt: row.token.expiresAt ?? new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
    };
    await assertNamedGatewayProtocolLimit(session, input.protocolMethod, clientMetadata);
    return session;
  }

  /**
   * A "test-origin" invocation is one created by the Apps → Test tab's
   * impersonated test call: an out-of-band `actorType: "user"` invocation with
   * no heartbeat run, issue, or gateway behind it. We key off the durable
   * invocation columns rather than audit metadata so the signal survives a
   * reload — and so the live test panel can drive an approved test call to
   * completion without a real agent run re-invoking it.
   */
  function isTestOriginInvocation(invocation: typeof toolInvocations.$inferSelect): boolean {
    return (
      invocation.actorType === "user"
      && invocation.runId === null
      && invocation.issueId === null
      && invocation.gatewayId === null
      && invocation.connectionId !== null
    );
  }

  /**
   * Execute an already-authorized test-tab tool call against the connected MCP
   * server and record the result/error onto the invocation. Shared by
   * {@link executeTestCall} (the allow path) and the approval-driven execution
   * of a parked ask-first request, so both produce identical persistence,
   * events, and audit entries.
   */
  async function runTestToolInvocation(args: {
    session: ToolGatewaySession;
    tool: ToolGatewayDescriptor;
    parameters: unknown;
    invocationId: string;
    companyId: string;
    agentId: string;
    userId: string;
    argumentsSummary: ReturnType<typeof summarizeToolValue>;
    reasonCode: string;
    matchedPolicyIds: string[];
    timeoutMs?: number;
  }): Promise<
    | { decision: "allowed"; invocationId: string; result: unknown }
    | { decision: "allowed"; invocationId: string; error: { message: string; reasonCode: string } }
  > {
    await db
      .update(toolInvocations)
      .set({ status: "executing", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(toolInvocations.id, args.invocationId));
    await writeAudit({
      session: args.session,
      companyId: args.companyId,
      agentId: args.agentId,
      runId: null,
      issueId: null,
      actorType: "user",
      actorId: args.userId,
      action: "tool_gateway.call_allowed",
      details: {
        source: "test",
        invocationId: args.invocationId,
        decision: "allow",
        reasonCode: args.reasonCode,
        matchedPolicyIds: args.matchedPolicyIds,
        tool: args.tool.name,
        ...toolAuditMetadata(args.tool),
        argumentsSummary: args.argumentsSummary,
      },
    });

    const startedAt = Date.now();
    try {
      const executionTimeoutMs = timeoutMs(args.timeoutMs);
      const connectedMcpExecution =
        args.tool.providerType === "mcp_remote_http"
          ? await executeRemoteHttpTool(args.session, args.tool, args.parameters, executionTimeoutMs, args.invocationId)
          : args.tool.providerType === "mcp_local_stdio"
            ? await executeLocalStdioTool(args.session, args.tool, args.parameters, executionTimeoutMs)
            : null;
      if (!connectedMcpExecution) {
        throw new ToolGatewayHttpError(404, `Tool "${args.tool.name}" not found`, "tool_not_found", {
          tool: args.tool.name,
        });
      }
      const result = connectedMcpExecution.result;
      const resultValidation = validateToolContent({
        value: result,
        direction: "result",
        sensitiveMode: "redact",
        promptInjectionMode: "block",
      });
      await db
        .update(toolInvocations)
        .set({
          status: "succeeded",
          resultHash: resultValidation.summary.sha256 ?? null,
          resultSummary: resultValidation.summary,
          resultSizeBytes: resultValidation.summary.sizeBytes ?? null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolInvocations.id, args.invocationId));
      await writeToolCallEvent({
        invocationId: args.invocationId,
        session: args.session,
        eventType: "call_completed",
        outcome: "success",
        toolName: args.tool.name,
        policyDecision: "allow",
        reasonCode: "tool_completed",
        argumentsSummary: args.argumentsSummary,
        resultSummary: resultValidation.summary,
        metadata: {
          source: "test",
          headerSummary: connectedMcpExecution.headerSummary ?? undefined,
          execution: connectedMcpExecution.execution,
        },
        tool: args.tool,
      });
      await writeAudit({
        session: args.session,
        companyId: args.companyId,
        agentId: args.agentId,
        runId: null,
        issueId: null,
        actorType: "user",
        actorId: args.userId,
        action: "tool_gateway.call_completed",
        details: {
          source: "test",
          invocationId: args.invocationId,
          decision: "allow",
          reasonCode: "tool_completed",
          tool: args.tool.name,
          ...toolAuditMetadata(args.tool),
          durationMs: Date.now() - startedAt,
          argumentsSummary: args.argumentsSummary,
          result: summarizeResult(resultValidation.value),
          resultSummary: resultValidation.summary,
          headerSummary: connectedMcpExecution.headerSummary ?? undefined,
          execution: connectedMcpExecution.execution,
        },
      });
      return {
        decision: "allowed" as const,
        invocationId: args.invocationId,
        result: resultValidation.value,
      };
    } catch (err) {
      const status = err instanceof ToolGatewayHttpError ? err.status : 502;
      const reasonCode =
        err instanceof ToolContentValidationError
          ? err.reasonCode
          : err instanceof ToolGatewayHttpError
            ? err.reasonCode
            : "tool_execution_failed";
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(toolInvocations)
        .set({
          status: status === 504 ? "timed_out" : status === 429 ? "rate_limited" : "failed",
          errorCode: reasonCode,
          errorMessage: message,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolInvocations.id, args.invocationId));
      await writeToolCallEvent({
        invocationId: args.invocationId,
        session: args.session,
        eventType: "call_failed",
        outcome: status === 504 ? "timeout" : "failure",
        toolName: args.tool.name,
        policyDecision: status === 504 ? "defer_runtime" : "deny",
        reasonCode,
        argumentsSummary: args.argumentsSummary,
        metadata: {
          source: "test",
          ...(err instanceof ToolContentValidationError ? { findings: err.findings } : {}),
          ...(executionAuditFromError(err) ? { execution: executionAuditFromError(err) } : {}),
        },
        tool: args.tool,
      });
      await writeAudit({
        session: args.session,
        companyId: args.companyId,
        agentId: args.agentId,
        runId: null,
        issueId: null,
        actorType: "user",
        actorId: args.userId,
        action: status === 504 ? "tool_gateway.call_deferred" : "tool_gateway.call_failed",
        details: {
          source: "test",
          invocationId: args.invocationId,
          decision: status === 504 ? "defer_runtime" : "deny",
          reasonCode,
          tool: args.tool.name,
          ...toolAuditMetadata(args.tool),
          argumentsSummary: args.argumentsSummary,
          durationMs: Date.now() - startedAt,
          error: message,
          ...(executionAuditFromError(err) ? { execution: executionAuditFromError(err) } : {}),
        },
      });
      return {
        decision: "allowed" as const,
        invocationId: args.invocationId,
        error: { message, reasonCode },
      };
    }
  }

  /**
   * Drive a freshly-approved test-origin ask-first request to completion. The
   * Test tab has no agent run to re-invoke the parked call, so approving it in
   * the Review tab is what executes it — the live status panel then surfaces the
   * real result. Reconstructs the impersonated test session and the signed
   * arguments, and never throws: any failure is recorded on the invocation so it
   * shows up as an error in the panel rather than rolling back the approval.
   */
  async function runApprovedTestInvocation(
    invocation: typeof toolInvocations.$inferSelect,
    parameters: unknown,
    actionRequestId: string,
  ): Promise<void> {
    const agentId = invocation.agentId;
    if (!invocation.connectionId || !agentId) return;
    const userId = invocation.actorId ?? "board";
    const session: ToolGatewaySession = {
      id: "test-call",
      token: "test-call",
      companyId: invocation.companyId,
      agentId,
      runId: null,
      issueId: null,
      projectId: null,
      actorType: "user",
      actorId: userId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + DEFAULT_SESSION_TTL_MS),
    };
    let tool: ToolGatewayDescriptor | undefined;
    try {
      tool = (await connectedMcpToolsForConnection(invocation.companyId, invocation.connectionId)).find(
        (candidate) =>
          candidate.name === invocation.toolName || candidate.upstreamToolName === invocation.toolName,
      );
    } catch {
      tool = undefined;
    }
    if (!tool) {
      await db
        .update(toolInvocations)
        .set({
          status: "failed",
          errorCode: "tool_not_found",
          errorMessage: `Tool "${invocation.toolName}" is no longer connected`,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolInvocations.id, invocation.id));
      await reflectToolActionInteractionLifecycle({
        actionRequestId,
        status: "failed",
        errorCode: "tool_not_found",
        errorMessage: `Tool "${invocation.toolName}" is no longer connected`,
      });
      return;
    }
    const argumentsSummary = validateToolContent({
      value: parameters,
      direction: "arguments",
      sensitiveMode: "redact",
      promptInjectionMode: "ignore",
    }).summary;
    try {
      await runTestToolInvocation({
        session,
        tool,
        parameters,
        invocationId: invocation.id,
        companyId: invocation.companyId,
        agentId,
        userId,
        argumentsSummary,
        reasonCode: "approval_granted",
        matchedPolicyIds: invocation.matchedPolicyIds ?? [],
      });
      await reflectToolActionInteractionLifecycle({ actionRequestId, status: "executed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(toolInvocations)
        .set({
          status: "failed",
          errorCode: "tool_execution_failed",
          errorMessage: message,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(toolInvocations.id, invocation.id));
      await reflectToolActionInteractionLifecycle({
        actionRequestId,
        status: "failed",
        errorCode: "tool_execution_failed",
        errorMessage: message,
      });
    }
  }

  async function waitForActionRequestExecution(actionRequestId: string) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [row] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, actionRequestId))
        .limit(1);
      if (!row || row.status !== "executing") return row ?? null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new ToolGatewayHttpError(409, "Approved tool action is still executing", "action_execution_in_progress", {
      actionRequestId,
    });
  }

  function storedInvocationResult(invocation: typeof toolInvocations.$inferSelect): unknown {
    const summary = invocation.resultSummary?.summary;
    if (typeof summary !== "string") return null;
    try {
      return JSON.parse(summary);
    } catch {
      return summary;
    }
  }

  async function actionRequestResolution(actionRequest: typeof toolActionRequests.$inferSelect) {
    if (actionRequest.status !== "executed" && actionRequest.status !== "failed") return actionRequest;
    const [invocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.id, actionRequest.invocationId))
      .limit(1);
    return {
      ...actionRequest,
      resultSummary: invocation?.resultSummary?.summary ?? null,
      error: invocation?.errorMessage ?? null,
    };
  }

  async function markApprovedActionFailed(input: {
    actionRequestId: string;
    invocationId: string;
    error: unknown;
  }) {
    const reasonCode = input.error instanceof ToolGatewayHttpError
      ? input.error.reasonCode
      : "tool_execution_failed";
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const now = new Date();
    await db.update(toolInvocations).set({
      status: "failed",
      errorCode: reasonCode,
      errorMessage: message,
      completedAt: now,
      updatedAt: now,
    }).where(eq(toolInvocations.id, input.invocationId));
    await db.update(toolActionRequests).set({
      status: "failed",
      resolvedAt: now,
      updatedAt: now,
    }).where(eq(toolActionRequests.id, input.actionRequestId));
    await reflectToolActionInteractionLifecycle({
      actionRequestId: input.actionRequestId,
      status: "failed",
      errorCode: reasonCode,
      errorMessage: message,
    });
    return { reasonCode, message };
  }

  async function executeApprovedAgentInvocation(input: {
    actionRequest: typeof toolActionRequests.$inferSelect;
    invocation: typeof toolInvocations.$inferSelect;
  }) {
    const { actionRequest, invocation } = input;
    if (!invocation.agentId || !invocation.issueId || isTestOriginInvocation(invocation)) {
      throw new ToolGatewayHttpError(409, "Tool action request is not an agent-origin action", "action_origin_invalid");
    }

    const [claimed] = await db
      .update(toolActionRequests)
      .set({ status: "executing", updatedAt: new Date() })
      .where(and(eq(toolActionRequests.id, actionRequest.id), eq(toolActionRequests.status, "approved")))
      .returning();
    if (!claimed) {
      const settled = await waitForActionRequestExecution(actionRequest.id);
      const [settledInvocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.id, invocation.id))
        .limit(1);
      if (settled?.status === "executed" && settledInvocation) {
        return storedInvocationResult(settledInvocation);
      }
      if (settled?.status === "failed") {
        throw new ToolGatewayHttpError(
          502,
          settledInvocation?.errorMessage ?? "Approved tool action failed",
          settledInvocation?.errorCode ?? "tool_execution_failed",
          { actionRequestId: actionRequest.id, invocationId: invocation.id },
        );
      }
      throw new ToolGatewayHttpError(409, "Tool action request was already consumed", "action_already_consumed");
    }

    const signedPayload = readSignedToolArgumentsPayload({
      signedArguments: claimed.signedArguments,
      invocationId: invocation.id,
      toolName: invocation.toolName,
      signingSecret: options.toolActionSigningSecret,
    });
    if (!signedPayload) {
      const error = new ToolGatewayHttpError(409, "Approved tool action arguments signature is invalid", "signed_arguments_invalid");
      await markApprovedActionFailed({ actionRequestId: claimed.id, invocationId: invocation.id, error });
      throw error;
    }
    if (signedPayload.executionOnApprove !== true) {
      throw new ToolGatewayHttpError(
        409,
        "This approval predates execute-on-approve and must remain inert",
        "legacy_approved_action_inert",
      );
    }

    const [issue] = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.id, invocation.issueId), eq(issues.companyId, invocation.companyId)))
      .limit(1);
    const session: ToolGatewaySession = {
      id: `approved-action:${claimed.id}`,
      token: "",
      companyId: invocation.companyId,
      agentId: invocation.agentId,
      runId: invocation.runId,
      issueId: invocation.issueId,
      projectId: issue?.projectId ?? null,
      gatewayId: invocation.gatewayId,
      gatewayPublicId: invocation.gatewayPublicId,
      gatewayTokenId: invocation.gatewayTokenId,
      actorType: "agent",
      actorId: invocation.agentId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + DEFAULT_SESSION_TTL_MS),
    };
    let tool: ToolGatewayDescriptor;
    let liveApprovalSnapshot: Awaited<ReturnType<typeof connectedRemoteApprovalSnapshot>>;
    try {
      tool = await findToolForSession(session, invocation.toolName);
      liveApprovalSnapshot = await connectedRemoteApprovalSnapshot(session, tool);
    } catch (error) {
      await markApprovedActionFailed({ actionRequestId: claimed.id, invocationId: invocation.id, error });
      throw error;
    }
    if (!approvalSnapshotsMatch(signedPayload.approvalSnapshot, liveApprovalSnapshot)) {
      const error = new ToolGatewayHttpError(409, "Approved tool action target changed after review", "approved_tool_target_changed");
      await markApprovedActionFailed({ actionRequestId: claimed.id, invocationId: invocation.id, error });
      throw error;
    }
    const parameters = signedPayload.arguments;
    const canonicalArguments = canonicalToolArguments(parameters);
    if (
      claimed.canonicalArgumentsHash !== summarizeToolValue(parameters).sha256
      || !verifyToolArgumentsSignature({
        signedArguments: claimed.signedArguments,
        invocationId: invocation.id,
        toolName: invocation.toolName,
        canonicalArguments,
        approvalSnapshot: signedPayload.approvalSnapshot,
        executionOnApprove: true,
        signingSecret: options.toolActionSigningSecret,
      })
    ) {
      const error = new ToolGatewayHttpError(409, "Approved tool action arguments do not match reviewed hash", "signed_arguments_mismatch");
      await markApprovedActionFailed({ actionRequestId: claimed.id, invocationId: invocation.id, error });
      throw error;
    }

    const argumentsSummary = validateToolContent({
      value: parameters,
      direction: "arguments",
      sensitiveMode: "redact",
      promptInjectionMode: "ignore",
    }).summary;
    const startedAt = Date.now();
    await db
      .update(toolInvocations)
      .set({ status: "executing", approvalState: "approved", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(toolInvocations.id, invocation.id));
    await reflectToolActionInteractionLifecycle({ actionRequestId: claimed.id, status: "executing" });

    try {
      const executionTimeoutMs = timeoutMs(APPROVED_EXECUTION_TIMEOUT_MS);
      const result = tool.providerType === "mcp_remote_http"
        ? (await executeRemoteHttpTool(session, tool, parameters, executionTimeoutMs, invocation.id)).result
        : tool.providerType === "mcp_local_stdio"
          ? (await executeLocalStdioTool(session, tool, parameters, executionTimeoutMs)).result
          : tool.providerType !== "paperclip_plugin"
            ? await runWithTimeout(executeBuiltinTool(session, tool, parameters), executionTimeoutMs)
            : (() => { throw new ToolGatewayHttpError(409, "Plugin actions cannot execute outside their originating run", "approved_execution_unsupported"); })();
      const resultValidation = validateToolContent({
        value: result,
        direction: "result",
        sensitiveMode: "redact",
        promptInjectionMode: "block",
      });
      const now = new Date();
      await db.update(toolInvocations).set({
        status: "succeeded",
        resultHash: resultValidation.summary.sha256 ?? null,
        resultSummary: resultValidation.summary,
        resultSizeBytes: resultValidation.summary.sizeBytes ?? null,
        completedAt: now,
        updatedAt: now,
      }).where(eq(toolInvocations.id, invocation.id));
      await db.update(toolActionRequests).set({ status: "executed", resolvedAt: now, updatedAt: now }).where(eq(toolActionRequests.id, claimed.id));
      await reflectToolActionInteractionLifecycle({
        actionRequestId: claimed.id,
        status: "executed",
        resultSummary: resultValidation.summary.summary,
      });
      await writeToolCallEvent({
        invocationId: invocation.id,
        actionRequestId: claimed.id,
        session,
        eventType: "call_completed",
        outcome: "success",
        toolName: tool.name,
        policyDecision: "allow",
        reasonCode: "approved_action_executed",
        argumentsSummary,
        resultSummary: resultValidation.summary,
        metadata: { durationMs: Date.now() - startedAt, timeoutMs: executionTimeoutMs },
        tool,
      });
      return resultValidation.value;
    } catch (error) {
      const { reasonCode } = await markApprovedActionFailed({
        actionRequestId: claimed.id,
        invocationId: invocation.id,
        error,
      });
      await writeToolCallEvent({
        invocationId: invocation.id,
        actionRequestId: claimed.id,
        session,
        eventType: "call_failed",
        outcome: "failure",
        toolName: tool.name,
        policyDecision: "deny",
        reasonCode,
        argumentsSummary,
        metadata: { durationMs: Date.now() - startedAt },
        tool,
      });
      throw error;
    }
  }

  async function matchingAgentActionRequest(input: {
    session: ToolGatewaySession;
    toolName: string;
    argumentsHash: string;
  }) {
    if (!input.session.issueId || !input.session.agentId) return null;
    const [match] = await db
      .select({ actionRequest: toolActionRequests, invocation: toolInvocations })
      .from(toolActionRequests)
      .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
      .where(and(
        eq(toolActionRequests.companyId, input.session.companyId),
        eq(toolActionRequests.issueId, input.session.issueId),
        eq(toolActionRequests.canonicalArgumentsHash, input.argumentsHash),
        eq(toolInvocations.agentId, input.session.agentId),
        eq(toolInvocations.toolName, input.toolName),
        inArray(toolActionRequests.status, ["pending", "approved", "executing", "rejected", "executed"]),
      ))
      .orderBy(desc(toolActionRequests.createdAt))
      .limit(1);
    if (!match) return null;
    if (
      match.actionRequest.status === "pending"
      && match.actionRequest.expiresAt
      && match.actionRequest.expiresAt.getTime() <= Date.now()
    ) {
      const now = new Date();
      await db.update(toolActionRequests).set({ status: "expired", resolvedAt: now, updatedAt: now }).where(and(
        eq(toolActionRequests.id, match.actionRequest.id),
        eq(toolActionRequests.status, "pending"),
      ));
      await db.update(toolInvocations).set({
        approvalState: "expired",
        idempotencyKey: null,
        updatedAt: now,
      }).where(eq(toolInvocations.id, match.invocation.id));
      await reflectToolActionInteractionLifecycle({ actionRequestId: match.actionRequest.id, status: "expired" });
      return null;
    }
    return match;
  }

  async function replayMatchingAgentAction(input: {
    session: ToolGatewaySession;
    toolName: string;
    argumentsHash: string;
  }) {
    const match = await matchingAgentActionRequest(input);
    if (!match) return null;
    const { actionRequest, invocation } = match;
    if (actionRequest.status === "pending") {
      await throwApprovalRequired({
        invocationId: invocation.id,
        actionRequestId: actionRequest.id,
        interactionId: actionRequest.interactionId,
        issueId: input.session.issueId!,
        toolName: input.toolName,
        argumentsHash: input.argumentsHash,
      });
    }
    if (actionRequest.status === "rejected") {
      throw new ToolGatewayHttpError(409, "This tool action was declined; do not retry the same call", "action_declined", {
        invocationId: invocation.id,
        actionRequestId: actionRequest.id,
        instructions: "The action was declined. Do not retry the same call; adjust your approach or report the decline on the task.",
      });
    }
    if (actionRequest.status === "executed") {
      return { matched: true as const, result: storedInvocationResult(invocation), invocationId: invocation.id };
    }
    if (actionRequest.status === "executing") {
      const settled = await waitForActionRequestExecution(actionRequest.id);
      const [settledInvocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, invocation.id)).limit(1);
      if (settled?.status === "executed" && settledInvocation) {
        return { matched: true as const, result: storedInvocationResult(settledInvocation), invocationId: invocation.id };
      }
      throw new ToolGatewayHttpError(
        502,
        settledInvocation?.errorMessage ?? "Approved tool action failed",
        settledInvocation?.errorCode ?? "tool_execution_failed",
      );
    }
    if (actionRequest.status === "approved" && actionRequest.decidedAt) {
      const signedPayload = readSignedToolArgumentsPayload({
        signedArguments: actionRequest.signedArguments,
        invocationId: invocation.id,
        toolName: invocation.toolName,
        signingSecret: options.toolActionSigningSecret,
      });
      if (signedPayload?.executionOnApprove !== true) return null;
      const result = await executeApprovedAgentInvocation({ actionRequest, invocation });
      return { matched: true as const, result, invocationId: invocation.id };
    }
    return null;
  }

  /**
   * Project an ask-first test request + its invocation onto the lifecycle the
   * Test tab panel renders. Recovers the redacted parameter snapshot (the
   * "Where" row) and, once the call has run, the structured result or error.
   */
  function buildTestCallStatus(
    actionRequest: typeof toolActionRequests.$inferSelect,
    invocation: typeof toolInvocations.$inferSelect,
  ): ToolConnectionTestCallStatus {
    const invocationDone =
      invocation.status === "succeeded"
      || invocation.status === "failed"
      || invocation.status === "timed_out"
      || invocation.status === "rate_limited"
      || invocation.status === "denied";

    let phase: ToolConnectionTestCallStatusPhase;
    if (actionRequest.status === "rejected") {
      phase = "denied";
    } else if (actionRequest.status === "cancelled") {
      phase = "cancelled";
    } else if (actionRequest.status === "expired") {
      phase = "expired";
    } else if (actionRequest.status === "approved" || actionRequest.status === "executed") {
      phase = invocationDone ? "done" : "running";
    } else {
      phase = "waiting";
    }

    // Recover a redacted, structured snapshot of the parameters for the
    // "Where" row — the test-call response never echoes them back.
    let parameters: Record<string, unknown> | null = null;
    const signed = readSignedToolArgumentsPayload({
      signedArguments: actionRequest.signedArguments,
      invocationId: invocation.id,
      toolName: invocation.toolName,
      signingSecret: options.toolActionSigningSecret,
    });
    if (signed && signed.arguments && typeof signed.arguments === "object" && !Array.isArray(signed.arguments)) {
      const redacted = validateToolContent({
        value: signed.arguments,
        direction: "arguments",
        sensitiveMode: "redact",
        promptInjectionMode: "ignore",
      }).value;
      if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
        parameters = redacted as Record<string, unknown>;
      }
    }

    let result: unknown;
    let error: ToolConnectionTestCallStatus["error"];
    if (phase === "done") {
      if (invocation.status === "succeeded") {
        const summary = invocation.resultSummary?.summary;
        if (typeof summary === "string") {
          try {
            result = JSON.parse(summary);
          } catch {
            result = summary;
          }
        } else {
          result = null;
        }
      } else {
        error = {
          message: invocation.errorMessage ?? "The call didn't complete.",
          reasonCode: invocation.errorCode ?? null,
        };
      }
    }

    const durationMs =
      invocation.startedAt && invocation.completedAt
        ? Math.max(0, invocation.completedAt.getTime() - invocation.startedAt.getTime())
        : null;

    return {
      actionRequestId: actionRequest.id,
      invocationId: invocation.id,
      phase,
      parameters,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
      durationMs,
      requestedAt: actionRequest.createdAt.toISOString(),
      resolvedAt: actionRequest.resolvedAt ? actionRequest.resolvedAt.toISOString() : null,
    };
  }

  return {
    async recordRuntimeMcpDeliveryDiagnostic(input: {
      companyId: string;
      agentId: string;
      runId: string;
      permittedNotInstalledConnections: Array<{ id: string; name: string }>;
    }) {
      if (input.permittedNotInstalledConnections.length === 0) return;
      const [run] = await db
        .select({ issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'` })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
        ))
        .limit(1);
      await writeAudit({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        issueId: run?.issueId ?? null,
        action: "tool_gateway.runtime_mcp_delivery",
        details: {
          decision: "diagnostic",
          reasonCode: "permitted_connections_not_installed",
          deliveredServerCount: 0,
          permittedNotInstalledCount: input.permittedNotInstalledConnections.length,
          permittedNotInstalledConnections: input.permittedNotInstalledConnections,
        },
      });
    },

    async listNamedGateways(companyId: string): Promise<ToolMcpGatewayWithTokens[]> {
      // Archived gateways are retired — they must not appear in the list UI.
      const gateways = await db
        .select()
        .from(toolMcpGateways)
        .where(
          and(
            eq(toolMcpGateways.companyId, companyId),
            ne(toolMcpGateways.status, "archived"),
          ),
        )
        .orderBy(desc(toolMcpGateways.createdAt));
      const rows = await Promise.all(gateways.map((gateway) => getGatewayWithTokens(companyId, gateway.id)));
      return rows;
    },

    async createNamedGateway(input: {
      companyId: string;
      body: CreateToolMcpGateway;
      actor?: { agentId?: string | null; userId?: string | null };
    }): Promise<ToolMcpGatewayWithTokens> {
      await assertGatewayContext({
        companyId: input.companyId,
        profileId: input.body.profileId,
        agentId: input.body.agentId ?? null,
        projectId: input.body.projectId ?? null,
        issueId: input.body.issueId ?? null,
      });
      const now = new Date();
      const slug = input.body.displaySlug ?? input.body.slug ?? slugSegment(input.body.name, "gateway");
      const [gateway] = await db
        .insert(toolMcpGateways)
        .values({
          companyId: input.companyId,
          name: input.body.name,
          slug,
          displaySlug: slug,
          description: input.body.description ?? null,
          defaultProfileMode: input.body.defaultProfileMode ?? "gateway_only",
          contextScopeType: input.body.contextScopeType ?? "none",
          contextScopeId: input.body.contextScopeId ?? null,
          profileId: input.body.profileId,
          agentId: input.body.agentId ?? null,
          projectId: input.body.projectId ?? null,
          issueId: input.body.issueId ?? null,
          approvalIssueId: input.body.approvalIssueId ?? null,
          ...(input.body.authConfig !== undefined ? { authConfig: input.body.authConfig } : {}),
          ...(input.body.headerPolicy !== undefined ? { headerPolicy: input.body.headerPolicy } : {}),
          ...(input.body.metadataPolicy !== undefined ? { metadataPolicy: input.body.metadataPolicy } : {}),
          ...(input.body.onDemandToolsConfig !== undefined ? { onDemandToolsConfig: input.body.onDemandToolsConfig } : {}),
          metadata: input.body.metadata ?? {},
          createdByAgentId: input.actor?.agentId ?? null,
          createdByUserId: input.actor?.userId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await db
        .insert(toolProfileBindings)
        .values({
          companyId: input.companyId,
          profileId: input.body.profileId,
          targetType: "gateway",
          targetId: gateway.id,
          priority: 10,
          metadata: { source: "named_mcp_gateway" },
          createdByAgentId: input.actor?.agentId ?? null,
          createdByUserId: input.actor?.userId ?? null,
        })
        .onConflictDoNothing();
      await writeAudit({
        session: {
          id: `gateway:${gateway.id}`,
          token: "",
          companyId: gateway.companyId,
          agentId: gateway.agentId,
          runId: null,
          issueId: gateway.issueId,
          projectId: gateway.projectId,
          gatewayId: gateway.id,
          gatewayName: gateway.name,
          actorType: input.actor?.agentId ? "agent" : input.actor?.userId ? "user" : "system",
          actorId: input.actor?.agentId ?? input.actor?.userId ?? gateway.id,
          createdAt: now,
          expiresAt: now,
        },
        companyId: input.companyId,
        agentId: input.actor?.agentId ?? gateway.agentId,
        runId: null,
        issueId: gateway.issueId,
        actorType: input.actor?.agentId ? "agent" : input.actor?.userId ? "user" : "system",
        actorId: input.actor?.agentId ?? input.actor?.userId ?? gateway.id,
        action: "tool_gateway.session_created",
        details: {
          decision: "allow",
          reasonCode: "named_gateway_created",
          gatewayId: gateway.id,
          gatewayName: gateway.name,
          profileId: gateway.profileId,
        },
      });
      return getGatewayWithTokens(input.companyId, gateway.id);
    },

    async updateNamedGateway(input: {
      companyId: string;
      gatewayId: string;
      body: UpdateToolMcpGateway;
    }): Promise<ToolMcpGatewayWithTokens> {
      const [existing] = await db
        .select()
        .from(toolMcpGateways)
        .where(and(eq(toolMcpGateways.companyId, input.companyId), eq(toolMcpGateways.id, input.gatewayId)))
        .limit(1);
      if (!existing) throw new ToolGatewayHttpError(404, "MCP gateway not found", "gateway_not_found");
      await assertGatewayContext({
        companyId: input.companyId,
        profileId: input.body.profileId ?? existing.profileId,
        agentId: input.body.agentId === undefined ? existing.agentId : input.body.agentId,
        projectId: input.body.projectId === undefined ? existing.projectId : input.body.projectId,
        issueId: input.body.issueId === undefined ? existing.issueId : input.body.issueId,
      });
      const [updated] = await db
        .update(toolMcpGateways)
        .set({
          ...(input.body.name !== undefined ? { name: input.body.name } : {}),
          ...(input.body.slug !== undefined || input.body.displaySlug !== undefined ? { slug: input.body.displaySlug ?? input.body.slug } : {}),
          ...(input.body.slug !== undefined || input.body.displaySlug !== undefined ? { displaySlug: input.body.displaySlug ?? input.body.slug } : {}),
          ...(input.body.description !== undefined ? { description: input.body.description ?? null } : {}),
          ...(input.body.status !== undefined ? { status: input.body.status } : {}),
          ...(input.body.profileId !== undefined ? { profileId: input.body.profileId } : {}),
          ...(input.body.defaultProfileMode !== undefined ? { defaultProfileMode: input.body.defaultProfileMode } : {}),
          ...(input.body.contextScopeType !== undefined ? { contextScopeType: input.body.contextScopeType } : {}),
          ...(input.body.contextScopeId !== undefined ? { contextScopeId: input.body.contextScopeId ?? null } : {}),
          ...(input.body.agentId !== undefined ? { agentId: input.body.agentId ?? null } : {}),
          ...(input.body.projectId !== undefined ? { projectId: input.body.projectId ?? null } : {}),
          ...(input.body.issueId !== undefined ? { issueId: input.body.issueId ?? null } : {}),
          ...(input.body.approvalIssueId !== undefined ? { approvalIssueId: input.body.approvalIssueId ?? null } : {}),
          ...(input.body.authConfig !== undefined ? { authConfig: input.body.authConfig } : {}),
          ...(input.body.headerPolicy !== undefined ? { headerPolicy: input.body.headerPolicy } : {}),
          ...(input.body.metadataPolicy !== undefined ? { metadataPolicy: input.body.metadataPolicy } : {}),
          ...(input.body.onDemandToolsConfig !== undefined ? { onDemandToolsConfig: input.body.onDemandToolsConfig } : {}),
          ...(input.body.metadata !== undefined ? { metadata: input.body.metadata ?? {} } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(toolMcpGateways.companyId, input.companyId), eq(toolMcpGateways.id, input.gatewayId)))
        .returning();
      if (input.body.profileId && input.body.profileId !== existing.profileId) {
        await db
          .insert(toolProfileBindings)
          .values({
            companyId: input.companyId,
            profileId: input.body.profileId,
            targetType: "gateway",
            targetId: input.gatewayId,
            priority: 10,
            metadata: { source: "named_mcp_gateway" },
          })
          .onConflictDoNothing();
      }
      return getGatewayWithTokens(input.companyId, updated.id);
    },

    async createNamedGatewayToken(input: {
      companyId: string;
      gatewayId: string;
      body: CreateToolMcpGatewayToken;
      actor?: { agentId?: string | null; userId?: string | null };
    }): Promise<ToolMcpGatewayTokenCreated> {
      const [gateway] = await db
        .select()
        .from(toolMcpGateways)
        .where(and(eq(toolMcpGateways.companyId, input.companyId), eq(toolMcpGateways.id, input.gatewayId)))
        .limit(1);
      if (!gateway) throw new ToolGatewayHttpError(404, "MCP gateway not found", "gateway_not_found");
      const tokenId = randomUUID();
      const token = generateNamedGatewayToken(tokenId);
      const tokenPrefix = `pcgw_${tokenId.slice(0, 8)}`;
      const now = new Date();
      const [row] = await db
        .insert(toolMcpGatewayTokens)
        .values({
          id: tokenId,
          companyId: input.companyId,
          gatewayId: input.gatewayId,
          name: input.body.name,
          tokenHash: hashGatewayToken(token),
          tokenPrefix,
          subjectType: input.body.subjectType ?? "gateway_client",
          subjectId: input.body.subjectId ?? null,
          clientLabel: input.body.clientLabel,
          ownerNote: input.body.ownerNote,
          allowedActions: input.body.allowedActions ?? ["tools/list", "tools/call"],
          expiresAt: input.body.expiresAt ?? null,
          expiryOverrideReason: input.body.expiryOverrideReason ?? null,
          expiryOverrideByAgentId: input.actor?.agentId && input.body.expiryOverrideReason ? input.actor.agentId : null,
          expiryOverrideByUserId: input.actor?.userId && input.body.expiryOverrideReason ? input.actor.userId : null,
          expiryOverrideAt: input.body.expiryOverrideReason ? now : null,
          createdByAgentId: input.actor?.agentId ?? null,
          createdByUserId: input.actor?.userId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { ...toGatewayToken(row), token };
    },

    async revokeNamedGatewayToken(input: { companyId: string; tokenId: string; revokedAt?: Date }): Promise<ToolMcpGatewayToken> {
      const now = input.revokedAt ?? new Date();
      const [row] = await db
        .update(toolMcpGatewayTokens)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(toolMcpGatewayTokens.companyId, input.companyId), eq(toolMcpGatewayTokens.id, input.tokenId)))
        .returning();
      if (!row) throw new ToolGatewayHttpError(404, "MCP gateway token not found", "gateway_token_not_found");
      return toGatewayToken(row);
    },

    async initializeNamedGatewayProtocol(input: {
      gatewayId?: string | null;
      gatewayPublicId?: string | null;
      bearerToken: string;
      callerHeaders?: Record<string, string | string[] | undefined>;
    }): Promise<ToolGatewaySession> {
      return namedGatewaySessionFromBearer({
        gatewayId: input.gatewayId ?? null,
        gatewayPublicId: input.gatewayPublicId ?? null,
        bearerToken: input.bearerToken,
        protocolMethod: "initialize",
        callerHeaders: input.callerHeaders,
      });
    },

    async listToolsForNamedGateway(input: {
      gatewayId?: string | null;
      gatewayPublicId?: string | null;
      bearerToken: string;
      callerHeaders?: Record<string, string | string[] | undefined>;
    }): Promise<ToolGatewayDescriptor[]> {
      const session = await namedGatewaySessionFromBearer({
        gatewayId: input.gatewayId ?? null,
        gatewayPublicId: input.gatewayPublicId ?? null,
        bearerToken: input.bearerToken,
        protocolMethod: "tools/list",
        callerHeaders: input.callerHeaders,
      });
      await assertGatewayTokenAction(session, "tools/list");
      const tools = await listToolsForContext(session);
      await writeAudit({
        session,
        companyId: session.companyId,
        agentId: session.agentId,
        runId: session.runId,
        issueId: session.issueId,
        action: "tool_gateway.discovery",
        details: {
          decision: "allow",
          reasonCode: "named_gateway_discovery_filtered",
          visibleToolCount: tools.length,
          visibleTools: tools.map((tool) => tool.name),
        },
      });
      return tools;
    },

    async createSession(input: {
      companyId: string;
      agentId: string;
      runId: string;
      issueId?: string | null;
      projectId?: string | null;
      ttlMs?: number;
      actorType?: LogActivityInput["actorType"];
      actorId?: string;
    }): Promise<ToolGatewaySession> {
      await assertAgentInCompany(input.companyId, input.agentId);
      const { issueId, projectId } = await resolveRunContext(input);
      const now = new Date();
      const sessionId = randomUUID();
      const token = generateGatewayToken(sessionId);
      const session: ToolGatewaySession = {
        id: sessionId,
        token,
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        issueId,
        projectId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + sessionTtlMs(input.ttlMs)),
      };

      await db.insert(toolGatewaySessions).values({
        id: session.id,
        companyId: session.companyId,
        agentId: input.agentId,
        runId: input.runId,
        issueId: session.issueId,
        projectId: session.projectId,
        tokenHash: hashGatewayToken(token),
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
      } as any);

      await writeAudit({
        session,
        companyId: session.companyId,
        agentId: session.agentId,
        runId: session.runId,
        issueId: session.issueId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: "tool_gateway.session_created",
        details: {
          decision: "allow",
          reasonCode: "session_created",
          expiresAt: session.expiresAt.toISOString(),
        },
      });

      return session;
    },

    async listToolsForSession(sessionToken: string): Promise<ToolGatewayDescriptor[]> {
      const session = await getActiveSession(sessionToken);
      const tools = await listToolsForContext(session);
      await writeAudit({
        session,
        companyId: session.companyId,
        agentId: session.agentId,
        runId: session.runId,
        issueId: session.issueId,
        action: "tool_gateway.discovery",
        details: {
          decision: "allow",
          reasonCode: "discovery_filtered",
          visibleToolCount: tools.length,
          visibleTools: tools.map((tool) => tool.name),
        },
      });
      return tools;
    },

    async listPluginToolsForAgent(input: { companyId: string; agentId: string }): Promise<AgentToolDescriptor[]> {
      await assertAgentInCompany(input.companyId, input.agentId);
      const decisions = await Promise.all(pluginTools().map(async (tool) => {
        const decision = await policyService.decide(policyInputForAgentTool({
          companyId: input.companyId,
          agentId: input.agentId,
          tool,
        }));
        return { tool, decision };
      }));
      return decisions
        .filter(({ decision }) => decision.allowed || decision.decision === "require_approval")
        .map(({ tool }) => {
          const { providerType: _providerType, risk: _risk, ...descriptor } = tool;
          return descriptor;
        });
    },

    async summarizeConnectionAccessForAgent(input: { companyId: string; connectionId: string; agentId: string }) {
      await assertAgentInCompany(input.companyId, input.agentId);
      const tools = await connectedMcpToolsForConnection(input.companyId, input.connectionId);
      const decisions = await Promise.all(tools.map(async (tool) => {
        const decision = await policyService.decide(policyInputForAgentTool({
          companyId: input.companyId,
          agentId: input.agentId,
          tool,
        }));
        const testDecision =
          decision.decision === "require_approval"
            ? "ask_first"
            : decision.allowed
              ? "allowed"
              : "off";
        return {
          toolName: tool.upstreamToolName ?? tool.name,
          gatewayToolName: tool.name,
          displayName: tool.displayName,
          risk: tool.risk,
          decision: testDecision,
          reasonCode: decision.reasonCode,
          matchedPolicyIds: decision.matchedPolicyIds,
          effectiveProfileIds: decision.effectiveProfileIds,
        };
      }));
      const lastChange = await summarizeAccessLastChange({
        companyId: input.companyId,
        connectionId: input.connectionId,
        agentId: input.agentId,
        policyIds: [...new Set(decisions.flatMap((decision) => decision.matchedPolicyIds))],
        profileIds: [...new Set(decisions.flatMap((decision) => decision.effectiveProfileIds))],
      });
      return {
        connectionId: input.connectionId,
        toolCount: decisions.length,
        allowedCount: decisions.filter((decision) => decision.decision === "allowed").length,
        askFirstCount: decisions.filter((decision) => decision.decision === "ask_first").length,
        offCount: decisions.filter((decision) => decision.decision === "off").length,
        lastChangedAt: lastChange.lastChangedAt,
        lastChangedByAgentId: lastChange.lastChangedByAgentId,
        lastChangedByName: lastChange.lastChangedByName,
        tools: decisions.map(({ effectiveProfileIds: _effectiveProfileIds, ...tool }) => tool),
      };
    },

    async executeTestCall(input: ExecuteTestCallInput) {
      await assertAgentInCompany(input.companyId, input.agentId);
      const session: ToolGatewaySession = {
        id: "test-call",
        token: "test-call",
        companyId: input.companyId,
        agentId: input.agentId,
        runId: null,
        issueId: null,
        projectId: null,
        actorType: "user",
        actorId: input.userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + DEFAULT_SESSION_TTL_MS),
      };
      const tool = (await connectedMcpToolsForConnection(input.companyId, input.connectionId))
        .find((candidate) =>
          candidate.name === input.toolName
          || candidate.upstreamToolName === input.toolName
        );
      if (!tool) {
        throw new ToolGatewayHttpError(404, `Tool "${input.toolName}" not found`, "tool_not_found", {
          connectionId: input.connectionId,
          tool: input.toolName,
        });
      }

      const requestedParameters = input.parameters ?? {};
      const argumentValidation = validateToolContent({
        value: requestedParameters,
        direction: "arguments",
        sensitiveMode: "redact",
        promptInjectionMode: "ignore",
      });
      const decisionInput = policyInputForAgentTool({
        companyId: input.companyId,
        agentId: input.agentId,
        actorType: "user",
        actorId: input.userId,
        tool,
        parameters: requestedParameters,
        idempotencyKey: `test-call:${randomUUID()}`,
        consumeRateLimit: true,
      });
      const accessDecision = await policyService.decide(decisionInput);
      const recorded = await policyService.recordInvocation(decisionInput, accessDecision);
      await policyService.writeAudit(decisionInput, accessDecision);
      const invocationId = recorded.invocation.id;

      if (accessDecision.decision === "require_approval") {
        if (!recorded.actionRequest) {
          throw new ToolGatewayHttpError(500, "Approval request was not created", "approval_request_missing", {
            invocationId,
            tool: tool.name,
          });
        }
        const canonicalArguments = canonicalToolArguments(requestedParameters);
        const canonicalArgumentsHash = argumentValidation.summary.sha256 ?? "";
        const approvalSnapshot = await connectedRemoteApprovalSnapshot(session, tool, {
          requireResolvedCredentials: true,
        });
        const signedArguments = signToolArguments({
          invocationId,
          toolName: tool.name,
          canonicalArguments,
          approvalSnapshot: approvalSnapshot ?? undefined,
          executionOnApprove: true,
          signingSecret: options.toolActionSigningSecret,
        });
        const previewMarkdown = buildHumanizedActionPreview({ tool, argumentsSummary: argumentValidation.summary });
        await db
          .update(toolActionRequests)
          .set({
            canonicalArgumentsHash,
            canonicalArgumentsSummary: argumentValidation.summary,
            signedArguments,
            previewMarkdown,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            updatedAt: new Date(),
          })
          .where(eq(toolActionRequests.id, recorded.actionRequest.id));
        await writeToolCallEvent({
          invocationId,
          actionRequestId: recorded.actionRequest.id,
          session,
          eventType: "approval_requested",
          outcome: "pending",
          toolName: tool.name,
          policyDecision: "require_approval",
          reasonCode: accessDecision.reasonCode,
          argumentsSummary: argumentValidation.summary,
          metadata: { source: "test", actionRequestId: recorded.actionRequest.id },
          tool,
        });
        await writeAudit({
          session,
          companyId: input.companyId,
          agentId: input.agentId,
          runId: null,
          issueId: null,
          actorType: "user",
          actorId: input.userId,
          action: "tool_gateway.approval_requested",
          details: {
            source: "test",
            invocationId,
            actionRequestId: recorded.actionRequest.id,
            decision: "require_approval",
            reasonCode: accessDecision.reasonCode,
            matchedPolicyIds: accessDecision.matchedPolicyIds,
            tool: tool.name,
            ...toolAuditMetadata(tool),
            argumentsSummary: argumentValidation.summary,
          },
        });
        return {
          decision: "ask_first" as const,
          invocationId,
          actionRequestId: recorded.actionRequest.id,
        };
      }

      if (!accessDecision.allowed) {
        await writeAudit({
          session,
          companyId: input.companyId,
          agentId: input.agentId,
          runId: null,
          issueId: null,
          actorType: "user",
          actorId: input.userId,
          action: "tool_gateway.call_denied",
          details: {
            source: "test",
            invocationId,
            decision: accessDecision.decision,
            reasonCode: accessDecision.reasonCode,
            matchedPolicyIds: accessDecision.matchedPolicyIds,
            tool: tool.name,
            ...toolAuditMetadata(tool),
            argumentsSummary: argumentValidation.summary,
            rateLimitState: accessDecision.rateLimitState ?? null,
          },
        });
        return {
          decision: "off" as const,
          invocationId,
          error: {
            message: accessDecision.explanation,
            reasonCode: accessDecision.reasonCode,
          },
        };
      }

      return runTestToolInvocation({
        session,
        tool,
        parameters: requestedParameters,
        invocationId,
        companyId: input.companyId,
        agentId: input.agentId,
        userId: input.userId,
        argumentsSummary: argumentValidation.summary,
        reasonCode: accessDecision.reasonCode,
        matchedPolicyIds: accessDecision.matchedPolicyIds,
        timeoutMs: input.timeoutMs,
      });
    },

    /**
     * Live status of an ask-first test call, polled by the Test tab panel.
     * Scoped to the connection the panel is bound to and to test-origin
     * requests only, so it can't be used to read arbitrary action requests.
     */
    async getTestCallStatus(input: {
      companyId: string;
      connectionId: string;
      actionRequestId: string;
    }): Promise<ToolConnectionTestCallStatus> {
      const [actionRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, input.actionRequestId))
        .limit(1);
      if (!actionRequest || actionRequest.companyId !== input.companyId) {
        throw new ToolGatewayHttpError(404, "Tool action request not found", "action_request_not_found");
      }
      const [invocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.id, actionRequest.invocationId))
        .limit(1);
      if (!invocation || invocation.companyId !== input.companyId) {
        throw new ToolGatewayHttpError(404, "Tool invocation not found", "invocation_not_found");
      }
      if (invocation.connectionId !== input.connectionId || !isTestOriginInvocation(invocation)) {
        throw new ToolGatewayHttpError(404, "Tool action request not found", "action_request_not_found");
      }
      return buildTestCallStatus(actionRequest, invocation);
    },

    async approveActionRequest(input: {
      companyId: string;
      issueId?: string;
      interactionId?: string;
      actionRequestId: string;
      actor: { agentId?: string | null; userId?: string | null };
    }) {
      const [actionRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, input.actionRequestId))
        .limit(1);
      if (!actionRequest || actionRequest.companyId !== input.companyId) {
        throw new ToolGatewayHttpError(404, "Tool action request not found", "action_request_not_found");
      }
      const [invocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.id, actionRequest.invocationId))
        .limit(1);
      if (!invocation || invocation.companyId !== input.companyId) {
        throw new ToolGatewayHttpError(404, "Tool invocation not found", "invocation_not_found");
      }
      if (input.issueId !== undefined || input.interactionId !== undefined) {
        if (
          !input.issueId
          || !input.interactionId
          || actionRequest.issueId !== input.issueId
          || actionRequest.interactionId !== input.interactionId
          || invocation.issueId !== input.issueId
        ) {
          throw new ToolGatewayHttpError(
            409,
            "Tool action request does not belong to this interaction",
            "action_context_mismatch",
          );
        }
        const [originatingInteraction] = await db
          .select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.id, input.interactionId),
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, input.issueId),
          ))
          .limit(1);
        if (!originatingInteraction) {
          throw new ToolGatewayHttpError(
            409,
            "Tool action request does not belong to this interaction",
            "action_context_mismatch",
          );
        }
      }
      if (actionRequest.status !== "pending" && actionRequest.status !== "approved") {
        throw new ToolGatewayHttpError(409, "Tool action request is no longer pending", "action_not_pending");
      }
      let signedPayload: ReturnType<typeof readSignedToolArgumentsPayload> = null;
      try {
        signedPayload = readSignedToolArgumentsPayload({
          signedArguments: actionRequest.signedArguments,
          invocationId: invocation.id,
          toolName: invocation.toolName,
          signingSecret: options.toolActionSigningSecret,
        });
      } catch {
        signedPayload = null;
      }
      if (!signedPayload) {
        if (actionRequest.status === "pending") {
          await db
            .update(toolActionRequests)
            .set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(toolActionRequests.id, actionRequest.id), eq(toolActionRequests.status, "pending")));
        }
        throw new ToolGatewayHttpError(
          409,
          "Tool action request is no longer approvable; refresh the review queue",
          "action_request_invalidated",
        );
      }
      if (actionRequest.approvalId) {
        const [formalApproval] = await db
          .select({ status: approvals.status })
          .from(approvals)
          .where(and(
            eq(approvals.id, actionRequest.approvalId),
            eq(approvals.companyId, input.companyId),
          ))
          .limit(1);
        if (!formalApproval || formalApproval.status !== "approved") {
          throw new ToolGatewayHttpError(
            409,
            "Tool action request requires formal board approval before execution",
            "formal_approval_required",
            { approvalId: actionRequest.approvalId },
          );
        }
      }
      if (actionRequest.status === "approved") {
        await reflectToolActionInteractionLifecycle({ actionRequestId: actionRequest.id, status: "approved" });
        if (!isTestOriginInvocation(invocation) && signedPayload.executionOnApprove === true) {
          try {
            await executeApprovedAgentInvocation({ actionRequest, invocation });
          } catch {
            // The execution outcome is persisted on the invocation/request and
            // reflected onto the accepted interaction for the continuation wake.
          }
          const [settled] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, actionRequest.id)).limit(1);
          return actionRequestResolution(settled ?? actionRequest);
        }
        return actionRequest;
      }
      const now = new Date();
      const [updated] = await db
        .update(toolActionRequests)
        .set({
          status: "approved",
          resolvedByAgentId: input.actor.agentId ?? null,
          resolvedByUserId: input.actor.userId ?? null,
          decidedByAgentId: input.actor.agentId ?? null,
          decidedByUserId: input.actor.userId ?? null,
          decidedAt: now,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(eq(toolActionRequests.id, actionRequest.id), eq(toolActionRequests.status, "pending")))
        .returning();
      if (!updated) {
        throw new ToolGatewayHttpError(409, "Tool action request has already been resolved", "action_already_resolved");
      }
      await db
        .update(toolInvocations)
        .set({ approvalState: "approved", updatedAt: now })
        .where(eq(toolInvocations.id, invocation.id));
      await reflectToolActionInteractionLifecycle({ actionRequestId: updated.id, status: "approved" });
      // A test-tab ask-first request has no agent run to carry out the parked
      // call, so approving it is what runs it. Execute against the signed
      // arguments and record the result on the invocation for the live panel.
      if (isTestOriginInvocation(invocation)) {
        await runApprovedTestInvocation(
          { ...invocation, approvalState: "approved" },
          signedPayload.arguments,
          updated.id,
        );
      } else if (signedPayload.executionOnApprove === true) {
        try {
          await executeApprovedAgentInvocation({ actionRequest: updated, invocation });
        } catch {
          // Persisted failure is the approval result; accepting the card itself
          // remains successful and the agent wake receives the failure context.
        }
      }
      const [settled] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, updated.id)).limit(1);
      return actionRequestResolution(settled ?? updated);
    },

    async declineActionRequest(input: {
      companyId: string;
      actionRequestId: string;
      actor: { agentId?: string | null; userId?: string | null };
    }) {
      const [actionRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, input.actionRequestId))
        .limit(1);
      if (!actionRequest || actionRequest.companyId !== input.companyId) {
        throw new ToolGatewayHttpError(404, "Tool action request not found", "action_request_not_found");
      }
      const [invocation] = await db
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.id, actionRequest.invocationId))
        .limit(1);
      if (!invocation || invocation.companyId !== input.companyId) {
        throw new ToolGatewayHttpError(404, "Tool invocation not found", "invocation_not_found");
      }
      if (actionRequest.status === "rejected") {
        return actionRequest;
      }
      if (actionRequest.status !== "pending") {
        throw new ToolGatewayHttpError(409, "Tool action request is no longer pending", "action_not_pending");
      }
      const now = new Date();
      const [updated] = await db
        .update(toolActionRequests)
        .set({
          status: "rejected",
          resolvedByAgentId: input.actor.agentId ?? null,
          resolvedByUserId: input.actor.userId ?? null,
          decidedByAgentId: input.actor.agentId ?? null,
          decidedByUserId: input.actor.userId ?? null,
          decidedAt: now,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(eq(toolActionRequests.id, actionRequest.id), eq(toolActionRequests.status, "pending")))
        .returning();
      if (!updated) {
        throw new ToolGatewayHttpError(409, "Tool action request has already been resolved", "action_already_resolved");
      }
      await db
        .update(toolInvocations)
        .set({ approvalState: "rejected", updatedAt: now })
        .where(eq(toolInvocations.id, invocation.id));
      return updated;
    },

    async executeTool(input: ExecuteGatewayToolInput) {
      const session = await getActiveSession(input.sessionToken, {
        gatewayId: input.gatewayId ?? null,
        gatewayPublicId: input.gatewayPublicId ?? null,
        protocolMethod: "tools/call",
        callerHeaders: input.callerHeaders,
      });
      await assertGatewayTokenAction(session, "tools/call");
      let invocationId = String(randomUUID());
      const startedAt = Date.now();

      let tool = await findToolForSession(session, input.tool);
      let virtualToolName: string | null = null;
      let requestedParameters: unknown = input.parameters ?? {};

      if (tool.name === "search_tools" && tool.providerType === "paperclip_virtual") {
        const argumentValidation = validateToolContent({
          value: requestedParameters,
          direction: "arguments",
          sensitiveMode: "redact",
          promptInjectionMode: "ignore",
        });
        const result = await executeVirtualSearchTools(session, requestedParameters);
        const resultValidation = validateToolContent({
          value: result,
          direction: "result",
          sensitiveMode: "redact",
          promptInjectionMode: "block",
        });
        const [invocation] = await db.insert(toolInvocations).values({
          companyId: session.companyId,
          actorType: session.actorType ?? (session.agentId ? "agent" : "system"),
          actorId: session.actorId ?? session.agentId ?? session.gatewayTokenId ?? session.companyId,
          agentId: session.agentId,
          issueId: session.issueId,
          runId: session.runId,
          providerType: "paperclip_virtual",
          upstreamToolName: "search_tools",
          riskLevel: "read",
          toolName: "search_tools",
          argumentsHash: argumentValidation.summary.sha256 ?? null,
          argumentsSummary: argumentValidation.summary,
          policyDecision: "allow",
          matchedPolicyIds: [],
          approvalState: "not_required",
          status: "succeeded",
          resultHash: resultValidation.summary.sha256 ?? null,
          resultSummary: resultValidation.summary,
          resultSizeBytes: resultValidation.summary.sizeBytes ?? null,
          startedAt: new Date(),
          completedAt: new Date(),
        }).returning();
        await writeToolCallEvent({
          invocationId: invocation.id,
          session,
          eventType: "call_completed",
          outcome: "success",
          toolName: "search_tools",
          policyDecision: "allow",
          reasonCode: "virtual_tool_completed",
          argumentsSummary: argumentValidation.summary,
          resultSummary: resultValidation.summary,
          metadata: { virtualToolName: "search_tools" },
          tool,
        });
        await writeAudit({
          session,
          companyId: session.companyId,
          agentId: session.agentId,
          runId: session.runId,
          issueId: session.issueId,
          action: "tool_gateway.call_completed",
          details: {
            invocationId: invocation.id,
            decision: "allow",
            reasonCode: "virtual_tool_completed",
            tool: "search_tools",
            virtualToolName: "search_tools",
            durationMs: Date.now() - startedAt,
            argumentsSummary: argumentValidation.summary,
            result: summarizeResult(resultValidation.value),
            resultSummary: resultValidation.summary,
          },
        });
        return {
          invocationId: invocation.id,
          status: "completed" as const,
          tool: "search_tools",
          result: resultValidation.value,
        };
      }

      if (tool.name === "run_tool" && tool.providerType === "paperclip_virtual") {
        const { targetToolName, targetParameters } = virtualRunToolInput(requestedParameters);
        const targetTool = await findToolForSession(session, targetToolName);
        if (!isOnDemandRemoteTool(targetTool)) {
          throw new ToolGatewayHttpError(404, `Tool "${targetToolName}" not found`, "tool_not_found", { tool: targetToolName });
        }
        virtualToolName = "run_tool";
        tool = targetTool;
        requestedParameters = targetParameters;
      }

      const argumentValidation = validateToolContent({
        value: requestedParameters,
        direction: "arguments",
        sensitiveMode: "redact",
        promptInjectionMode: "ignore",
      });
      let effectiveParameters: unknown = requestedParameters;
      let effectiveArgumentsSummary = argumentValidation.summary;

      if (!input.approvedActionRequestId) {
        const replay = await replayMatchingAgentAction({
          session,
          toolName: tool.name,
          argumentsHash: argumentValidation.summary.sha256 ?? "",
        });
        if (replay?.matched) {
          return {
            invocationId: replay.invocationId,
            status: "replayed" as const,
            tool: virtualToolName ?? tool.name,
            targetTool: virtualToolName ? tool.name : undefined,
            result: replay.result,
          };
        }
      }

      if (input.approvedActionRequestId) {
        let [actionRequest] = await db
          .select()
          .from(toolActionRequests)
          .where(eq(toolActionRequests.id, input.approvedActionRequestId))
          .limit(1);
        if (!actionRequest || actionRequest.companyId !== session.companyId) {
          throw new ToolGatewayHttpError(404, "Tool action request not found", "action_request_not_found");
        }
        const [storedInvocation] = await db
          .select()
          .from(toolInvocations)
          .where(eq(toolInvocations.id, actionRequest.invocationId))
          .limit(1);
        if (!storedInvocation || storedInvocation.companyId !== session.companyId) {
          throw new ToolGatewayHttpError(404, "Tool invocation not found", "invocation_not_found");
        }
        if (
          actionRequest.issueId !== session.issueId
          || storedInvocation.issueId !== session.issueId
          || storedInvocation.agentId !== session.agentId
          || storedInvocation.runId !== session.runId
          || actionRequest.requestedByAgentId !== session.agentId
        ) {
          throw new ToolGatewayHttpError(403, "Approved action request is not scoped to this gateway session", "action_scope_mismatch");
        }
        if (!actionRequest.issueId || !actionRequest.interactionId) {
          throw new ToolGatewayHttpError(403, "Approved action request is missing issue scope", "action_scope_mismatch");
        }
        const actionIssueId: string = actionRequest.issueId;
        const [linkedInteraction] = await db
          .select({
            id: issueThreadInteractions.id,
            issueId: issueThreadInteractions.issueId,
            companyId: issueThreadInteractions.companyId,
          })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.id, actionRequest.interactionId),
            eq(issueThreadInteractions.companyId, session.companyId),
            eq(issueThreadInteractions.issueId, actionIssueId),
          ))
          .limit(1);
        if (!linkedInteraction) {
          throw new ToolGatewayHttpError(403, "Approved action request is not linked to its originating interaction", "action_scope_mismatch");
        }
        if (storedInvocation.toolName !== tool.name) {
          throw new ToolGatewayHttpError(409, "Approved action request is for a different tool", "action_tool_mismatch");
        }
        if (actionRequest.expiresAt && actionRequest.expiresAt.getTime() <= Date.now()) {
          const expiredAt = new Date();
          const [expired] = await db
            .update(toolActionRequests)
            .set({ status: "expired", resolvedAt: expiredAt, updatedAt: expiredAt })
            .where(and(
              eq(toolActionRequests.id, actionRequest.id),
              inArray(toolActionRequests.status, ["pending", "approved"]),
            ))
            .returning({ id: toolActionRequests.id });
          if (expired) {
            await reflectToolActionInteractionLifecycle({ actionRequestId: expired.id, status: "expired" });
          }
          throw new ToolGatewayHttpError(409, "Tool action request approval has expired", "action_expired");
        }
        if (actionRequest.status === "pending" && actionRequest.interactionId) {
          const [interaction] = await db
            .select({
              status: issueThreadInteractions.status,
              kind: issueThreadInteractions.kind,
              resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
              resolvedByUserId: issueThreadInteractions.resolvedByUserId,
              resolvedAt: issueThreadInteractions.resolvedAt,
            })
            .from(issueThreadInteractions)
            .where(and(
              eq(issueThreadInteractions.id, actionRequest.interactionId),
              eq(issueThreadInteractions.companyId, session.companyId),
              eq(issueThreadInteractions.issueId, actionIssueId),
            ))
            .limit(1);
          if (interaction?.kind === "request_confirmation" && interaction.status === "accepted") {
            const [approved] = await db
              .update(toolActionRequests)
              .set({
                status: "approved",
                resolvedByAgentId: interaction.resolvedByAgentId ?? null,
                resolvedByUserId: interaction.resolvedByUserId ?? null,
                decidedByAgentId: interaction.resolvedByAgentId ?? null,
                decidedByUserId: interaction.resolvedByUserId ?? null,
                decidedAt: interaction.resolvedAt ?? new Date(),
                resolvedAt: interaction.resolvedAt ?? new Date(),
                updatedAt: new Date(),
              })
              .where(and(eq(toolActionRequests.id, actionRequest.id), eq(toolActionRequests.status, "pending")))
              .returning();
            if (!approved) {
              throw new ToolGatewayHttpError(409, "Tool action request has already been resolved", "action_already_resolved");
            }
            actionRequest = approved;
            await reflectToolActionInteractionLifecycle({ actionRequestId: approved.id, status: "approved" });
            await writeToolCallEvent({
              invocationId: storedInvocation.id,
              actionRequestId: actionRequest.id,
              session,
              eventType: "approval_resolved",
              outcome: "success",
              toolName: tool.name,
              policyDecision: "require_approval",
              reasonCode: "interaction_accepted",
              metadata: { actionRequestId: actionRequest.id, interactionId: actionRequest.interactionId },
              tool,
            });
          }
        }
        if (actionRequest.status !== "approved") {
          throw new ToolGatewayHttpError(409, "Tool action request is not approved or was already consumed", "action_not_approved");
        }
        if (actionRequest.approvalId) {
          const [formalApproval] = await db
            .select({ status: approvals.status })
            .from(approvals)
            .where(and(
              eq(approvals.id, actionRequest.approvalId),
              eq(approvals.companyId, session.companyId),
            ))
            .limit(1);
          if (!formalApproval || formalApproval.status !== "approved") {
            throw new ToolGatewayHttpError(
              409,
              "Tool action request requires formal board approval before execution",
              "formal_approval_required",
              { approvalId: actionRequest.approvalId },
            );
          }
        }
        const signedPayload = readSignedToolArgumentsPayload({
          signedArguments: actionRequest.signedArguments,
          invocationId: storedInvocation.id,
          toolName: storedInvocation.toolName,
          signingSecret: options.toolActionSigningSecret,
        });
        if (!signedPayload) {
          throw new ToolGatewayHttpError(409, "Approved tool action arguments signature is invalid", "signed_arguments_invalid");
        }
        const liveApprovalSnapshot = await connectedRemoteApprovalSnapshot(session, tool);
        if (!approvalSnapshotsMatch(signedPayload.approvalSnapshot, liveApprovalSnapshot)) {
          throw new ToolGatewayHttpError(
            409,
            "Approved tool action target changed after review",
            "approved_tool_target_changed",
            {
              invocationId: storedInvocation.id,
              actionRequestId: actionRequest.id,
              tool: tool.name,
            },
          );
        }
        const storedParameters = signedPayload.arguments;
        const storedArgumentValidation = validateToolContent({
          value: storedParameters,
          direction: "arguments",
          sensitiveMode: "redact",
          promptInjectionMode: "ignore",
        });
        const storedCanonical = canonicalToolArguments(storedParameters);
        if (
          actionRequest.canonicalArgumentsHash !== summarizeToolValue(storedParameters).sha256
          || !verifyToolArgumentsSignature({
            signedArguments: actionRequest.signedArguments,
            invocationId: storedInvocation.id,
            toolName: storedInvocation.toolName,
            canonicalArguments: storedCanonical,
            approvalSnapshot: signedPayload.approvalSnapshot,
            executionOnApprove: signedPayload.executionOnApprove,
            signingSecret: options.toolActionSigningSecret,
          })
        ) {
          throw new ToolGatewayHttpError(409, "Approved tool action arguments do not match reviewed hash", "signed_arguments_mismatch");
        }
        const [consumed] = await db
          .update(toolActionRequests)
          .set({
            status: "executed",
            resolvedByAgentId: session.agentId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(toolActionRequests.id, actionRequest.id), eq(toolActionRequests.status, "approved")))
          .returning();
        if (!consumed) {
          throw new ToolGatewayHttpError(409, "Tool action request was already consumed", "action_already_consumed");
        }
        await reflectToolActionInteractionLifecycle({ actionRequestId: consumed.id, status: "executing" });
        invocationId = storedInvocation.id as typeof invocationId;
        effectiveParameters = storedParameters;
        effectiveArgumentsSummary = storedArgumentValidation.summary;
        await db
          .update(toolInvocations)
          .set({ status: "executing", approvalState: "approved", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(toolInvocations.id, invocationId));
      } else {
        const decisionInput = policyInputForTool({
          session,
          tool,
          parameters: effectiveParameters,
          idempotencyKey: input.idempotencyKey,
          consumeRateLimit: true,
        });
        const accessDecision = await policyService.decide(decisionInput);
        const recorded = await policyService.recordInvocation(decisionInput, accessDecision);
        await policyService.writeAudit(decisionInput, accessDecision);
        invocationId = recorded.invocation.id;
        if (recorded.replayed) {
          await writeAudit({
            session,
            companyId: session.companyId,
            agentId: session.agentId,
            runId: session.runId,
            issueId: session.issueId,
            action: "tool_gateway.call_completed",
            details: {
              invocationId,
              decision: "allow",
              reasonCode: "idempotent_replay",
              tool: tool.name,
              ...toolAuditMetadata(tool),
              replayed: true,
            },
          });
          return {
            invocationId,
            status: "replayed" as const,
            tool: tool.name,
            result: recorded.invocation.resultSummary ?? null,
          };
        }
        if (accessDecision.decision === "require_approval") {
          await requestApprovalForRecordedToolCall({
            invocation: recorded.invocation,
            actionRequest: recorded.actionRequest,
            session,
            tool,
            parameters: effectiveParameters,
            argumentsSummary: argumentValidation.summary,
            policyDecision: accessDecision,
          });
        }
        if (!accessDecision.allowed) {
          await writeAudit({
            session,
            companyId: session.companyId,
            agentId: session.agentId,
            runId: session.runId,
            issueId: session.issueId,
            action: "tool_gateway.call_denied",
            details: {
              invocationId,
              decision: accessDecision.decision,
              reasonCode: accessDecision.reasonCode,
              matchedPolicyIds: accessDecision.matchedPolicyIds,
              tool: tool.name,
              virtualToolName,
              targetToolName: virtualToolName ? tool.name : undefined,
              ...toolAuditMetadata(tool),
              argumentsSummary: effectiveArgumentsSummary,
              rateLimitState: accessDecision.rateLimitState ?? null,
            },
          });
          throw new ToolGatewayHttpError(
            policyErrorStatus(accessDecision),
            accessDecision.explanation,
            accessDecision.reasonCode,
            {
              invocationId,
              tool: tool.name,
              decision: accessDecision.decision,
              matchedPolicyIds: accessDecision.matchedPolicyIds,
              rateLimitState: accessDecision.rateLimitState ?? null,
            },
          );
        }
        await db
          .update(toolInvocations)
          .set({ status: "executing", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(toolInvocations.id, invocationId));
      }

      await writeAudit({
        session,
        companyId: session.companyId,
        agentId: session.agentId,
        runId: session.runId,
        issueId: session.issueId,
        action: "tool_gateway.call_allowed",
        details: {
          invocationId,
          decision: input.approvedActionRequestId ? "approved" : "allow",
          reasonCode: input.approvedActionRequestId ? "approved_action_request" : "profile_allows_tool",
          tool: tool.name,
          virtualToolName,
          targetToolName: virtualToolName ? tool.name : undefined,
          ...toolAuditMetadata(tool),
          argumentsSummary: effectiveArgumentsSummary,
        },
      });

      try {
        const executionTimeoutMs = timeoutMs(input.timeoutMs);
        if (tool.providerType === "paperclip_plugin" && (!session.agentId || !session.runId)) {
          throw new ToolGatewayHttpError(403, "Plugin tools require an agent run context", "agent_context_required");
        }
        const connectedMcpExecution =
          tool.providerType === "mcp_remote_http"
            ? await executeRemoteHttpTool(session, tool, effectiveParameters, executionTimeoutMs, invocationId, input.callerHeaders)
            : tool.providerType === "mcp_local_stdio"
            ? await executeLocalStdioTool(session, tool, effectiveParameters, executionTimeoutMs)
            : null;
        const result =
          connectedMcpExecution
            ? connectedMcpExecution.result
            : tool.providerType === "paperclip_plugin"
            ? await runWithTimeout(
                pluginToolDispatcher!.executeTool(
                  tool.name,
                  effectiveParameters,
                  {
                    agentId: session.agentId!,
                    runId: session.runId!,
                    companyId: session.companyId,
                    projectId: session.projectId ?? "",
                  },
                ),
                executionTimeoutMs,
              )
            : await runWithTimeout(executeBuiltinTool(session, tool, effectiveParameters), executionTimeoutMs);

        const resultValidation = validateToolContent({
          value: result,
          direction: "result",
          sensitiveMode: "redact",
          promptInjectionMode: "block",
        });
        await db
          .update(toolInvocations)
          .set({
            status: "succeeded",
            resultHash: resultValidation.summary.sha256 ?? null,
            resultSummary: resultValidation.summary,
            resultSizeBytes: resultValidation.summary.sizeBytes ?? null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolInvocations.id, invocationId));
        if (input.approvedActionRequestId) {
          await reflectToolActionInteractionLifecycle({
            actionRequestId: input.approvedActionRequestId,
            status: "executed",
          });
        }
        await writeToolCallEvent({
          invocationId,
          actionRequestId: input.approvedActionRequestId ?? null,
          session,
          eventType: "call_completed",
          outcome: "success",
          toolName: tool.name,
          policyDecision: input.approvedActionRequestId ? "allow" : "allow",
          reasonCode: "tool_completed",
          argumentsSummary: effectiveArgumentsSummary,
          resultSummary: resultValidation.summary,
          metadata: {
            ...(virtualToolName ? { virtualToolName, targetToolName: tool.name } : {}),
            ...(connectedMcpExecution?.headerSummary ? { headerSummary: connectedMcpExecution.headerSummary } : {}),
            ...(connectedMcpExecution ? { execution: connectedMcpExecution.execution } : {}),
          },
          tool,
        });

        await writeAudit({
          session,
          companyId: session.companyId,
          agentId: session.agentId,
          runId: session.runId,
          issueId: session.issueId,
          action: "tool_gateway.call_completed",
          details: {
            invocationId,
            decision: "allow",
            reasonCode: "tool_completed",
            tool: tool.name,
            virtualToolName,
            targetToolName: virtualToolName ? tool.name : undefined,
            ...toolAuditMetadata(tool),
            durationMs: Date.now() - startedAt,
            argumentsSummary: effectiveArgumentsSummary,
            result: summarizeResult(resultValidation.value),
            resultSummary: resultValidation.summary,
            headerSummary: connectedMcpExecution?.headerSummary ?? undefined,
            execution: connectedMcpExecution?.execution ?? undefined,
          },
        });
        return {
          invocationId,
          status: "completed" as const,
          tool: virtualToolName ?? tool.name,
          targetTool: virtualToolName ? tool.name : undefined,
          result: resultValidation.value,
        };
      } catch (err) {
        const normalizedError = err instanceof ToolRuntimeSupervisorError
          ? new ToolGatewayHttpError(err.status, err.message, err.reasonCode, err.details)
          : err;
        const status = normalizedError instanceof ToolGatewayHttpError ? normalizedError.status : 502;
        const reasonCode =
          normalizedError instanceof ToolContentValidationError
            ? normalizedError.reasonCode
            : normalizedError instanceof ToolGatewayHttpError
              ? normalizedError.reasonCode
              : "tool_execution_failed";
        const isRuntimeDeferred =
          status === 429
          && (
            reasonCode === "runtime_capacity_unavailable"
            || reasonCode === "runtime_restart_backoff"
            || reasonCode === "runtime_restart_suppressed"
          );
        const isDeferred = status === 504 || isRuntimeDeferred;
        const message = normalizedError instanceof Error ? normalizedError.message : String(normalizedError);
        if (reasonCode === "elicitation_required") {
          throw normalizedError;
        }
        await db
          .update(toolInvocations)
          .set({
            status: status === 504 ? "timed_out" : status === 429 ? "rate_limited" : "failed",
            errorCode: reasonCode,
            errorMessage: message,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolInvocations.id, invocationId));
        if (input.approvedActionRequestId) {
          await reflectToolActionInteractionLifecycle({
            actionRequestId: input.approvedActionRequestId,
            status: "failed",
            errorCode: reasonCode,
            errorMessage: message,
          });
        }
        await writeToolCallEvent({
          invocationId,
          actionRequestId: input.approvedActionRequestId ?? null,
          session,
          eventType: status === 504 ? "call_failed" : "call_failed",
          outcome: status === 504 ? "timeout" : "failure",
          toolName: tool.name,
          policyDecision: isDeferred ? "defer_runtime" : "deny",
          reasonCode,
          argumentsSummary: effectiveArgumentsSummary,
          metadata: {
            ...(virtualToolName ? { virtualToolName, targetToolName: tool.name } : {}),
            ...(normalizedError instanceof ToolContentValidationError ? { findings: normalizedError.findings } : {}),
            ...(executionAuditFromError(normalizedError) ? { execution: executionAuditFromError(normalizedError) } : {}),
          },
          tool,
        });
        await writeAudit({
          session,
          companyId: session.companyId,
          agentId: session.agentId,
          runId: session.runId,
          issueId: session.issueId,
          action: isDeferred ? "tool_gateway.call_deferred" : "tool_gateway.call_failed",
          details: {
            invocationId,
            decision: isDeferred ? "defer_runtime" : "deny",
            reasonCode,
            tool: tool.name,
            virtualToolName,
            targetToolName: virtualToolName ? tool.name : undefined,
            ...toolAuditMetadata(tool),
            argumentsSummary: effectiveArgumentsSummary,
            durationMs: Date.now() - startedAt,
            error: message,
            ...(executionAuditFromError(normalizedError) ? { execution: executionAuditFromError(normalizedError) } : {}),
          },
        });
        if (normalizedError instanceof ToolContentValidationError) {
          throw new ToolGatewayHttpError(422, message, reasonCode, { findings: normalizedError.findings });
        }
        throw normalizedError;
      }
    },

    async executePluginTool(input: ExecutePluginToolInput) {
      if (!pluginToolDispatcher) {
        throw new ToolGatewayHttpError(501, "Plugin tool dispatch is not enabled", "plugin_tools_disabled");
      }
      if (input.actor.type === "agent") {
        if (input.actor.companyId !== input.runContext.companyId) {
          throw new ToolGatewayHttpError(403, "Agent key cannot access another company", "actor_company_mismatch");
        }
        if (input.actor.agentId !== input.runContext.agentId) {
          throw new ToolGatewayHttpError(403, "Agent cannot execute tools as another agent", "actor_agent_mismatch");
        }
        if (input.actor.runId && input.actor.runId !== input.runContext.runId) {
          throw new ToolGatewayHttpError(403, "Agent cannot execute tools for another run", "actor_run_mismatch");
        }
      }

      const context = await resolveRunContext({
        companyId: input.runContext.companyId,
        agentId: input.runContext.agentId,
        runId: input.runContext.runId,
        projectId: input.runContext.projectId,
      });
      let invocationId = String(randomUUID());
      const sessionLike: ToolGatewaySession = {
        id: "plugin-route",
        token: "plugin-route",
        companyId: input.runContext.companyId,
        agentId: input.runContext.agentId,
        runId: input.runContext.runId,
        issueId: context.issueId,
        projectId: input.runContext.projectId ?? context.projectId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + DEFAULT_SESSION_TTL_MS),
      };

      const tool = findStaticTool(input.tool);

      if (tool.providerType !== "paperclip_plugin") {
        throw new ToolGatewayHttpError(404, `Tool "${input.tool}" is not a plugin tool`, "tool_not_found");
      }

      const requestedParameters = input.parameters ?? {};
      const argumentValidation = validateToolContent({
        value: requestedParameters,
        direction: "arguments",
        sensitiveMode: "redact",
        promptInjectionMode: "ignore",
      });

      const decisionInput = policyInputForTool({
        session: sessionLike,
        tool,
        parameters: requestedParameters,
        consumeRateLimit: true,
      });
      const accessDecision = await policyService.decide(decisionInput);
      const recorded = await policyService.recordInvocation(decisionInput, accessDecision);
      await policyService.writeAudit(decisionInput, accessDecision);
      invocationId = recorded.invocation.id;

      if (recorded.replayed) {
        return recorded.invocation.resultSummary;
      }

      if (accessDecision.decision === "require_approval") {
        await requestApprovalForRecordedToolCall({
          invocation: recorded.invocation,
          actionRequest: recorded.actionRequest,
          session: sessionLike,
          tool,
          parameters: requestedParameters,
          argumentsSummary: argumentValidation.summary,
          policyDecision: accessDecision,
        });
      }

      if (!accessDecision.allowed) {
        await writeAudit({
          session: sessionLike,
          companyId: input.runContext.companyId,
          agentId: input.runContext.agentId,
          runId: input.runContext.runId,
          issueId: context.issueId,
          action: "tool_gateway.call_denied",
          details: {
            invocationId,
            decision: accessDecision.decision,
            reasonCode: accessDecision.reasonCode,
            matchedPolicyIds: accessDecision.matchedPolicyIds,
            tool: input.tool,
            ...toolAuditMetadata(tool),
            argumentsSummary: argumentValidation.summary,
            rateLimitState: accessDecision.rateLimitState ?? null,
          },
        });
        throw new ToolGatewayHttpError(
          policyErrorStatus(accessDecision),
          accessDecision.explanation,
          accessDecision.reasonCode,
          {
            invocationId,
            tool: input.tool,
            decision: accessDecision.decision,
            matchedPolicyIds: accessDecision.matchedPolicyIds,
            rateLimitState: accessDecision.rateLimitState ?? null,
          },
        );
      }

      await db
        .update(toolInvocations)
        .set({ status: "executing", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(toolInvocations.id, invocationId));

      await writeAudit({
        session: sessionLike,
        companyId: input.runContext.companyId,
        agentId: input.runContext.agentId,
        runId: input.runContext.runId,
        issueId: context.issueId,
        action: "tool_gateway.call_allowed",
        details: {
          invocationId,
          decision: "allow",
          reasonCode: "profile_allows_tool",
          tool: input.tool,
          ...toolAuditMetadata(tool),
          argumentsSummary: argumentValidation.summary,
        },
      });

      const startedAt = Date.now();
      try {
        const result = await pluginToolDispatcher.executeTool(input.tool, requestedParameters, input.runContext);
        const resultValidation = validateToolContent({
          value: result,
          direction: "result",
          sensitiveMode: "redact",
          promptInjectionMode: "block",
        });
        await db
          .update(toolInvocations)
          .set({
            status: "succeeded",
            resultHash: resultValidation.summary.sha256 ?? null,
            resultSummary: resultValidation.summary,
            resultSizeBytes: resultValidation.summary.sizeBytes ?? null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolInvocations.id, invocationId));
        await writeToolCallEvent({
          invocationId,
          session: sessionLike,
          eventType: "call_completed",
          outcome: "success",
          toolName: tool.name,
          policyDecision: "allow",
          reasonCode: "tool_completed",
          argumentsSummary: argumentValidation.summary,
          resultSummary: resultValidation.summary,
          tool,
        });
        await writeAudit({
          session: sessionLike,
          companyId: input.runContext.companyId,
          agentId: input.runContext.agentId,
          runId: input.runContext.runId,
          issueId: context.issueId,
          action: "tool_gateway.call_completed",
          details: {
            invocationId,
            decision: "allow",
            reasonCode: "tool_completed",
            tool: input.tool,
            ...toolAuditMetadata(tool),
            durationMs: Date.now() - startedAt,
            result: summarizeResult((resultValidation.value as typeof result).result),
            resultSummary: resultValidation.summary,
          },
        });
        return resultValidation.value as typeof result;
      } catch (err) {
        const status = err instanceof ToolGatewayHttpError ? err.status : 502;
        const reasonCode =
          err instanceof ToolContentValidationError
            ? err.reasonCode
            : err instanceof ToolGatewayHttpError
              ? err.reasonCode
              : "tool_execution_failed";
        const message = err instanceof Error ? err.message : String(err);
        await db
          .update(toolInvocations)
          .set({
            status: status === 504 ? "timed_out" : "failed",
            errorCode: reasonCode,
            errorMessage: message,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolInvocations.id, invocationId));
        await writeToolCallEvent({
          invocationId,
          session: sessionLike,
          eventType: "call_failed",
          outcome: status === 504 ? "timeout" : "failure",
          toolName: tool.name,
          policyDecision: status === 504 ? "defer_runtime" : "deny",
          reasonCode,
          argumentsSummary: argumentValidation.summary,
          metadata: err instanceof ToolContentValidationError ? { findings: err.findings } : null,
          tool,
        });
        await writeAudit({
          session: sessionLike,
          companyId: input.runContext.companyId,
          agentId: input.runContext.agentId,
          runId: input.runContext.runId,
          issueId: context.issueId,
          action: "tool_gateway.call_failed",
          details: {
            invocationId,
            decision: "deny",
            reasonCode,
            tool: input.tool,
            ...toolAuditMetadata(tool),
            argumentsSummary: argumentValidation.summary,
            durationMs: Date.now() - startedAt,
            error: message,
          },
        });
        if (err instanceof ToolContentValidationError) {
          throw new ToolGatewayHttpError(422, message, reasonCode, { findings: err.findings });
        }
        throw err;
      }
    },

    async revokeSession(input: {
      companyId: string;
      sessionId: string;
      revokedAt?: Date;
      actor?: {
        actorType?: LogActivityInput["actorType"];
        actorId?: string;
        agentId?: string | null;
        runId?: string | null;
      };
      agentScope?: { agentId: string; runId?: string | null } | null;
    }) {
      const now = input.revokedAt ?? new Date();
      const [existing] = await db
        .select()
        .from(toolGatewaySessions)
        .where(and(eq(toolGatewaySessions.companyId, input.companyId), eq(toolGatewaySessions.id, input.sessionId)))
        .limit(1);
      if (!existing) {
        throw new ToolGatewayHttpError(404, "Tool gateway session not found", "session_not_found");
      }
      if (input.agentScope) {
        const runMatches = input.agentScope.runId ? existing.runId === input.agentScope.runId : true;
        if (existing.agentId !== input.agentScope.agentId || !runMatches) {
          throw new ToolGatewayHttpError(
            403,
            "Tool gateway session is outside the authenticated agent scope",
            "session_scope_mismatch",
          );
        }
      }
      const [session] = await db
        .update(toolGatewaySessions)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(toolGatewaySessions.companyId, input.companyId), eq(toolGatewaySessions.id, input.sessionId)))
        .returning();
      const sessionView = gatewaySessionFromRow(session!);
      await writeAudit({
        session: sessionView,
        companyId: sessionView.companyId,
        agentId: sessionView.agentId,
        runId: sessionView.runId,
        issueId: sessionView.issueId,
        actorType: input.actor?.actorType,
        actorId: input.actor?.actorId,
        action: "tool_gateway.session_revoked",
        details: {
          decision: "revoke",
          reasonCode: "session_revoked",
          revokedAt: now.toISOString(),
          previousRevokedAt: existing.revokedAt?.toISOString() ?? null,
        },
      });
      return { ...sessionView, revokedAt: session!.revokedAt ?? now };
    },

    async cleanupExpiredSessions(input: { now?: Date } = {}) {
      const now = input.now ?? new Date();
      const rows = await db
        .delete(toolGatewaySessions)
        .where(lte(toolGatewaySessions.expiresAt, now))
        .returning({ id: toolGatewaySessions.id });
      return { deletedCount: rows.length };
    },

    async listRuntimeSlots(companyId?: string) {
      return runtimeSupervisor.listSlots(companyId);
    },

    async stopRuntimeSlot(input: {
      companyId: string;
      slotId: string;
      actor?: { agentId?: string | null; runId?: string | null };
    }) {
      try {
        return await runtimeSupervisor.stopSlot({
          companyId: input.companyId,
          slotId: input.slotId,
          agentId: input.actor?.agentId ?? null,
          runId: input.actor?.runId ?? null,
        });
      } catch (err) {
        if (err instanceof ToolRuntimeSupervisorError) {
          throw new ToolGatewayHttpError(err.status, err.message, err.reasonCode, err.details);
        }
        throw err;
      }
    },

    async restartRuntimeSlot(input: {
      companyId: string;
      slotId: string;
      actor?: { agentId?: string | null; runId?: string | null };
    }) {
      try {
        return await runtimeSupervisor.restartSlot({
          companyId: input.companyId,
          slotId: input.slotId,
          agentId: input.actor?.agentId ?? null,
          runId: input.actor?.runId ?? null,
        });
      } catch (err) {
        if (err instanceof ToolRuntimeSupervisorError) {
          throw new ToolGatewayHttpError(err.status, err.message, err.reasonCode, err.details);
        }
        throw err;
      }
    },
  };
}

export type ToolGatewayService = ReturnType<typeof createToolGatewayService>;
