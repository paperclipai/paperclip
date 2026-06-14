import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
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
  toolGatewaySessions,
  toolInvocations,
} from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type {
  DeploymentExposure,
  DeploymentMode,
  McpConnectionCredentialRef,
  SecretVersionSelector,
  ToolAccessDecision,
  ToolAccessDecisionInput,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";
import type { AgentToolDescriptor, PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { mcpHttpRequestHeaders, parseMcpHttpResponseBody } from "./mcp-http.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  createToolRuntimeSupervisor,
  ToolRuntimeSupervisorError,
  type ToolRuntimeSupervisorOptions,
  type ToolRuntimeSlotView,
} from "./tool-runtime-supervisor.js";
import {
  canonicalToolArguments,
  readSignedToolArgumentsPayload,
  signToolArguments,
  summarizeToolValue,
  ToolContentValidationError,
  validateToolContent,
  verifyToolArgumentsSignature,
} from "./tool-content-guards.js";

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const MAX_REMOTE_MCP_RESPONSE_BYTES = 1_000_000;
const ACTIVE_GATEWAY_RUN_STATUSES = new Set(["running"]);

export type ToolGatewayProviderType =
  | "mcp_http_fixture"
  | "mcp_stdio_fixture"
  | "mcp_remote_http"
  | "paperclip_self"
  | "paperclip_plugin";

export interface ConnectedMcpGatewayMetadata {
  applicationId: string;
  applicationKey: string | null;
  connectionId: string;
  catalogEntryId: string;
  transport: "remote_http";
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
}

export interface ToolGatewayDescriptor extends AgentToolDescriptor {
  providerType: ToolGatewayProviderType;
  risk: "read" | "write" | "destructive";
  applicationId?: string | null;
  applicationKey?: string | null;
  connectionId?: string | null;
  catalogEntryId?: string | null;
  upstreamToolName?: string | null;
  providerMetadata?: ConnectedMcpGatewayMetadata | Record<string, unknown>;
}

export interface ToolGatewaySession {
  id: string;
  token: string;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  projectId: string | null;
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
  tool: string;
  parameters?: unknown;
  timeoutMs?: number;
  approvedActionRequestId?: string | null;
  idempotencyKey?: string | null;
}

interface ExecutePluginToolInput {
  actor: { type: "agent" | "board"; agentId?: string | null; companyId?: string | null; userId?: string | null; runId?: string | null };
  tool: string;
  parameters: unknown;
  runContext: ToolRunContext;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function generateGatewayToken(sessionId: string) {
  return `pcgt_${sessionId}.${randomBytes(32).toString("base64url")}`;
}

function hashGatewayToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sessionIdFromGatewayToken(token: string) {
  const match = token.match(/^pcgt_([0-9a-fA-F-]{36})\.[A-Za-z0-9_-]+$/);
  return match?.[1] ?? null;
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
 * Advanced surfaces (M8a/M8b) and the board-only formal-approval interaction. See PAP-10896.
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

export function createToolGatewayService(
  db: Db,
  options: {
    pluginToolDispatcher?: PluginToolDispatcher;
    deploymentMode?: DeploymentMode;
    deploymentExposure?: DeploymentExposure;
    trustedLocalStdioRuntimeHost?: string | null;
    runtimeSupervisor?: ToolRuntimeSupervisorOptions;
    toolActionSigningSecret?: string;
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
        eq(toolConnections.transport, "remote_http"),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
        inArray(toolConnections.healthStatus, ["ok", "healthy"]),
        eq(toolApplications.companyId, companyId),
        eq(toolApplications.type, "mcp_http"),
        eq(toolApplications.status, "active"),
      ))
      .orderBy(toolConnections.name, toolCatalogEntries.name);

    const baseNames = rows.map(({ catalogEntry, connection, application }) => {
      const applicationKey = application.applicationKey ?? null;
      const connectionNamespace = `${slugSegment(applicationKey ?? connection.name ?? application.name, "mcp")}-${shortStableId(connection.id)}`;
      const toolSlug = slugSegment(catalogEntry.toolName, "tool");
      return `mcp.${connectionNamespace}:${toolSlug}`;
    });
    const baseNameCounts = baseNames.reduce<Map<string, number>>((counts, name) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return counts;
    }, new Map());

    return rows.map(({ catalogEntry, connection, application }, index) => {
      const baseName = baseNames[index]!;
      const gatewayToolName = baseNameCounts.get(baseName)! > 1
        ? `${baseName}-${shortStableId(catalogEntry.id)}`
        : baseName;
      const applicationKey = application.applicationKey ?? null;
      const inputSchema = catalogEntry.inputSchema ?? {};
      const outputSchema = catalogEntry.outputSchema ?? null;
      const annotations = catalogEntry.annotations ?? {};
      const risk = riskFromCatalogEntry(catalogEntry);
      const providerMetadata: ConnectedMcpGatewayMetadata = {
        applicationId: application.id,
        applicationKey,
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        transport: "remote_http",
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
      };
      return {
        name: gatewayToolName,
        displayName: catalogEntry.title ?? catalogEntry.toolName,
        description: catalogEntry.description ?? `Connected MCP tool ${catalogEntry.toolName} from ${connection.name}.`,
        parametersSchema: inputSchema,
        pluginId: `mcp:${applicationKey ?? application.id}`,
        providerType: "mcp_remote_http",
        risk,
        applicationId: application.id,
        applicationKey,
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        upstreamToolName: catalogEntry.toolName,
        providerMetadata,
      };
    });
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
    agentId: string;
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
      input.action === "tool_gateway.call_denied" || input.action === "tool_gateway.session_rejected"
        ? "denied"
        : input.action === "tool_gateway.call_deferred"
          ? "timeout"
          : input.action === "tool_gateway.call_failed"
            ? "failure"
            : "success";
    await db.insert(toolAccessAuditEvents).values({
      companyId: input.companyId,
      connectionId: typeof input.details.connectionId === "string" ? input.details.connectionId : null,
      catalogEntryId: typeof input.details.catalogEntryId === "string" ? input.details.catalogEntryId : null,
      actorType: input.actorType ?? "agent",
      actorId: input.actorId ?? input.agentId,
      action: dedicatedAuditAction,
      outcome: dedicatedOutcome,
      reasonCode: typeof input.details.reasonCode === "string" ? input.details.reasonCode : null,
      details: {
        source: input.action,
        agentId: input.agentId,
        issueId: input.issueId,
        runId: input.runId,
        gatewaySessionId: input.session?.id ?? null,
        ...input.details,
      },
    });

    const entityType = input.issueId ? "issue" : "agent";
    const entityId = input.issueId ?? input.agentId;
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "agent",
      actorId: input.actorId ?? input.agentId,
      action: input.action,
      entityType,
      entityId,
      agentId: input.agentId,
      runId: input.runId,
      details: {
        gatewaySessionId: input.session?.id ?? null,
        issueId: input.issueId,
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

  async function getActiveSession(sessionToken: string): Promise<ToolGatewaySession> {
    const token = sessionToken.trim();
    if (!token) {
      throw new ToolGatewayHttpError(401, "Tool gateway session is expired or invalid", "session_invalid");
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
      actorType: "agent",
      actorId: input.session.agentId,
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
      metadata: Object.keys(metadata).length > 0 || input.metadata
        ? { ...metadata, ...(input.metadata ?? {}) }
        : null,
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
        { invocationId: input.invocation.id, tool: input.tool.name },
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

    const signedArguments = signToolArguments({
      invocationId: input.invocation.id,
      toolName: input.tool.name,
      canonicalArguments,
      approvalSnapshot: approvalSnapshot ?? undefined,
      signingSecret: options.toolActionSigningSecret,
    });
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
        continuationPolicy: "wake_assignee_on_accept",
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
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
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

    throw new ToolGatewayHttpError(409, "Tool action requires approval", "approval_required", {
      invocationId: input.invocation.id,
      actionRequestId: actionRequest.id,
      interactionId: interaction.id,
      approvalId: formalApprovalId,
      tool: input.tool.name,
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
      tool: input.tool,
      parameters: input.parameters,
      idempotencyKey: input.idempotencyKey,
      consumeRateLimit: input.consumeRateLimit,
      heartbeatRunId: input.session.runId,
      issueId: input.session.issueId,
      projectId: input.session.projectId,
    });
  }

  function policyInputForAgentTool(input: {
    companyId: string;
    agentId: string;
    tool: ToolGatewayDescriptor;
    parameters?: unknown;
    idempotencyKey?: string | null;
    consumeRateLimit?: boolean;
    heartbeatRunId?: string | null;
    issueId?: string | null;
    projectId?: string | null;
  }): ToolAccessDecisionInput {
    return {
      companyId: input.companyId,
      actor: {
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
      },
      runContext: {
        heartbeatRunId: input.heartbeatRunId ?? null,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
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
    const tool = [...allTools(), ...await connectedMcpToolsForCompany(session.companyId)]
      .find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new ToolGatewayHttpError(404, `Tool "${toolName}" not found`, "tool_not_found", { tool: toolName });
    }
    return tool;
  }

  async function listToolsForContext(session: ToolGatewaySession): Promise<ToolGatewayDescriptor[]> {
    await assertAgentInCompany(session.companyId, session.agentId);
    const tools = [...allTools(), ...await connectedMcpToolsForCompany(session.companyId)];
    const decisions = await Promise.all(tools.map(async (tool) => {
      const decision = await policyService.decide(policyInputForTool({ session, tool }));
      return { tool, decision };
    }));
    return decisions
      .filter(({ decision }) => decision.allowed || decision.decision === "require_approval")
      .map(({ tool }) => tool);
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
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ToolGatewayHttpError(422, "Remote MCP connection requires config.url", "remote_http_url_missing");
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ToolGatewayHttpError(422, "Remote MCP connection URL is invalid", "remote_http_url_invalid");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ToolGatewayHttpError(422, "Remote MCP connection URL must use http or https", "remote_http_url_invalid");
    }
    return parsed.toString();
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

  function normalizeMcpToolResult(result: unknown) {
    const record = asRecord(result);
    if (!record) throw malformedRemoteMcpResponse();
    return {
      content: normalizeMcpContent(record.content),
      data: {
        content: record.content,
        structuredContent: record.structuredContent ?? null,
        isError: record.isError === true,
        transport: "mcp_http",
        spawnedLocalProcess: false,
      },
      ...(record.isError === true ? { error: "Remote MCP tool returned an error result" } : {}),
    };
  }

  async function executeRemoteHttpTool(
    session: ToolGatewaySession,
    tool: ToolGatewayDescriptor,
    parameters: unknown,
    ms: number,
  ) {
    const { entry, connection } = await resolveConnectedRemoteTool(session, tool);
    const endpoint = remoteEndpoint(connection.config ?? {});
    const headers = await resolveCredentialHeaders(connection);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        // MCP Streamable HTTP requires the Accept header advertising both a JSON
        // body and an SSE stream; spec-compliant servers 406 without it.
        headers: mcpHttpRequestHeaders(headers),
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `paperclip-tool-${randomUUID()}`,
          method: "tools/call",
          params: {
            name: entry.toolName,
            arguments: parameters ?? {},
          },
        }),
      });
      const body = await readBoundedRemoteResponse(response);
      if (!response.ok) {
        await markRemoteConnectionHealth(connection, "error", "Remote MCP server returned an HTTP error.");
        throw new ToolGatewayHttpError(502, "Remote MCP server returned an HTTP error", "remote_http_status", {
          status: response.status,
          connectionId: connection.id,
          catalogEntryId: entry.id,
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
        });
      }
      const payloadRecord = asRecord(payload);
      if (!payloadRecord) throw malformedRemoteMcpResponse();
      if (payloadRecord.error !== undefined) {
        const errorRecord = asRecord(payloadRecord.error);
        await markRemoteConnectionHealth(connection, "error", "Remote MCP server returned a JSON-RPC error.");
        throw new ToolGatewayHttpError(502, "Remote MCP server returned an error", "remote_mcp_error", {
          code: typeof errorRecord?.code === "number" ? errorRecord.code : null,
          connectionId: connection.id,
          catalogEntryId: entry.id,
        });
      }
      if (!Object.prototype.hasOwnProperty.call(payloadRecord, "result")) {
        throw malformedRemoteMcpResponse();
      }
      const result = normalizeMcpToolResult(payloadRecord.result);
      await markRemoteConnectionHealth(connection, "ok", "Remote MCP server responded to tools/call.");
      return result;
    } catch (error) {
      if (error instanceof ToolGatewayHttpError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        await markRemoteConnectionHealth(connection, "error", "Remote MCP tool call timed out.");
        throw new ToolGatewayHttpError(504, "Remote MCP tool call timed out", "tool_timeout", {
          connectionId: connection.id,
          catalogEntryId: entry.id,
        });
      }
      await markRemoteConnectionHealth(connection, "error", "Remote MCP tool call failed.");
      throw new ToolGatewayHttpError(502, "Remote MCP tool call failed", "remote_http_fetch_failed", {
        connectionId: connection.id,
        catalogEntryId: entry.id,
      });
    } finally {
      clearTimeout(timer);
    }
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

  return {
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
        agentId: session.agentId,
        runId: session.runId,
        issueId: session.issueId,
        projectId: session.projectId,
        tokenHash: hashGatewayToken(token),
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
      });

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

    async approveActionRequest(input: {
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
      if (actionRequest.status !== "pending" && actionRequest.status !== "approved") {
        throw new ToolGatewayHttpError(409, "Tool action request is no longer pending", "action_not_pending");
      }
      if (
        !readSignedToolArgumentsPayload({
          signedArguments: actionRequest.signedArguments,
          invocationId: invocation.id,
          toolName: invocation.toolName,
          signingSecret: options.toolActionSigningSecret,
        })
      ) {
        throw new ToolGatewayHttpError(409, "Tool action request signature is invalid", "signed_arguments_invalid");
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
        return actionRequest;
      }
      const now = new Date();
      const [updated] = await db
        .update(toolActionRequests)
        .set({
          status: "approved",
          resolvedByAgentId: input.actor.agentId ?? null,
          resolvedByUserId: input.actor.userId ?? null,
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
      return updated;
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
      const session = await getActiveSession(input.sessionToken);
      let invocationId = String(randomUUID());
      const startedAt = Date.now();

      const tool = await findToolForSession(session, input.tool);

      const requestedParameters = input.parameters ?? {};
      const argumentValidation = validateToolContent({
        value: requestedParameters,
        direction: "arguments",
        sensitiveMode: "redact",
        promptInjectionMode: "ignore",
      });
      let effectiveParameters: unknown = requestedParameters;
      let effectiveArgumentsSummary = argumentValidation.summary;

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
        ) {
          throw new ToolGatewayHttpError(403, "Approved action request is not scoped to this gateway session", "action_scope_mismatch");
        }
        if (!actionRequest.issueId) {
          throw new ToolGatewayHttpError(403, "Approved action request is missing issue scope", "action_scope_mismatch");
        }
        const actionIssueId: string = actionRequest.issueId;
        if (storedInvocation.toolName !== tool.name) {
          throw new ToolGatewayHttpError(409, "Approved action request is for a different tool", "action_tool_mismatch");
        }
        if (actionRequest.expiresAt && actionRequest.expiresAt.getTime() <= Date.now()) {
          await db
            .update(toolActionRequests)
            .set({ status: "expired", updatedAt: new Date() })
            .where(and(eq(toolActionRequests.id, actionRequest.id), eq(toolActionRequests.status, "pending")));
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
          ...toolAuditMetadata(tool),
          argumentsSummary: effectiveArgumentsSummary,
        },
      });

      try {
        const executionTimeoutMs = timeoutMs(input.timeoutMs);
        const result =
          tool.providerType === "mcp_remote_http"
            ? await executeRemoteHttpTool(session, tool, effectiveParameters, executionTimeoutMs)
            : tool.providerType === "paperclip_plugin"
            ? await runWithTimeout(
                pluginToolDispatcher!.executeTool(
                  tool.name,
                  effectiveParameters,
                  {
                    agentId: session.agentId,
                    runId: session.runId,
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
            ...toolAuditMetadata(tool),
            durationMs: Date.now() - startedAt,
            result: summarizeResult(resultValidation.value),
            resultSummary: resultValidation.summary,
          },
        });
        return {
          invocationId,
          status: "completed" as const,
          tool: tool.name,
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
          metadata: normalizedError instanceof ToolContentValidationError ? { findings: normalizedError.findings } : null,
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
            ...toolAuditMetadata(tool),
            argumentsSummary: effectiveArgumentsSummary,
            durationMs: Date.now() - startedAt,
            error: message,
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

    async revokeSession(input: { companyId: string; sessionId: string; revokedAt?: Date }) {
      const now = input.revokedAt ?? new Date();
      const [session] = await db
        .update(toolGatewaySessions)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(toolGatewaySessions.companyId, input.companyId), eq(toolGatewaySessions.id, input.sessionId)))
        .returning();
      if (!session) {
        throw new ToolGatewayHttpError(404, "Tool gateway session not found", "session_not_found");
      }
      return gatewaySessionFromRow(session);
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
