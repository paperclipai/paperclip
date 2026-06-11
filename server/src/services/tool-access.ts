import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySecretBindings,
  companySecrets,
  heartbeatRuns,
  issues,
  plugins,
  projects,
  routines,
  toolAccessAuditEvents,
  toolApplications,
  toolActionRequests,
  toolCatalogEntries,
  toolConnections,
  toolCallEvents,
  toolInvocations,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import type {
  CreateToolApplication,
  CreateToolConnection,
  CreateToolProfileBindingForProfile,
  CreateToolProfileEntryForProfile,
  CreateToolProfileWithEntries,
  DeploymentExposure,
  DeploymentMode,
  ImportMcpJson,
  McpConnectionCredentialRef,
  McpJsonImportPreview,
  ToolApplication,
  ToolCatalogEntry,
  ToolCatalogRefreshResult,
  ToolConnection,
  ToolConnectionHealthCheckResult,
  ToolConnectionHealthStatus,
  ToolConnectionTransport,
  ToolActionRequest,
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
  ToolProfileWithDetails,
  ToolPolicyDecision,
  ToolRiskLevel,
  ToolRuntimeAlertRecommendation,
  ToolRuntimeHealthSummary,
  ToolRunDecision,
  ToolRunDecisionLookup,
  ToolRuntimeSlot,
  UpdateToolApplication,
  UpdateToolConnection,
  UpdateToolProfileEntry,
  UpdateToolProfileWithEntries,
  UnbindToolProfileBinding,
} from "@paperclipai/shared";
import { badRequest, conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { createToolRuntimeSupervisor, ToolRuntimeSupervisorError } from "./tool-runtime-supervisor.js";

type ActorInfo = {
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
};

type ToolAccessServiceOptions = {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  trustedLocalStdioRuntimeHost?: string | null;
  now?: () => Date;
};

type McpToolDescriptor = {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

const APPROVED_STDIO_TEMPLATES: Record<string, { name: string; tools: McpToolDescriptor[] }> = {
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
};

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

function toConnection(row: typeof toolConnections.$inferSelect): ToolConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    applicationId: row.applicationId,
    name: row.name,
    connectionKind: row.connectionKind,
    transport: row.transport,
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

function classifyRisk(tool: McpToolDescriptor): ToolRiskLevel {
  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint === true || annotations.destructive === true) return "destructive";
  if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
  if (/^(create|update|delete|remove|write|set|send|publish|post|mutate|mark_|archive|unpublish)/i.test(tool.name)) {
    return /delete|remove|destroy|unpublish/i.test(tool.name) ? "destructive" : "write";
  }
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
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("Remote MCP connection requires config.url");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("Remote MCP connection URL must use http or https");
  }
  return parsed.toString();
}

function stdioTemplateId(config: Record<string, unknown>): string {
  const templateId = config.templateId;
  if (typeof templateId !== "string" || !APPROVED_STDIO_TEMPLATES[templateId]) {
    throw badRequest("Local stdio MCP connections must use an approved templateId");
  }
  return templateId;
}

export function toolAccessService(db: Db, options: ToolAccessServiceOptions = {}) {
  const secrets = secretService(db);
  const policySvc = toolAccessPolicyService(db);
  const now = options.now ?? (() => new Date());
  const runtimeSupervisor = createToolRuntimeSupervisor(db, options);

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
    auditWriteFailures: number | null;
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
        threshold: "Any degraded/failed/missing-secret connection or any disabled enabled-path connection.",
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
        status: input.auditWriteFailures === null ? "not_instrumented" : input.auditWriteFailures > 0 ? "firing" : "ok",
        threshold: "Any audit write failure.",
        observed: input.auditWriteFailures === null
          ? "Not instrumented as a durable counter yet."
          : `${input.auditWriteFailures} audit write failure(s) in 1 hour.`,
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
    const [slots, connections, auditRows, callEvents] = await Promise.all([
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
    const auditWriteFailures = auditRows.filter((row) =>
      row.action === "runtime_audit_write_failed"
      || row.reasonCode === "audit_write_failed"
    ).length;
    const auditWriteFailuresMetric = auditWriteFailures > 0 ? auditWriteFailures : null;
    const activeConnections = connections.filter((connection) =>
      connection.status !== "archived"
      && connection.status !== "disabled"
      && connection.enabled
    ).length;
    const disabledConnections = connections.filter((connection) =>
      connection.status !== "archived"
      && (!connection.enabled || connection.status === "disabled")
    ).length;
    const degradedConnections = connections.filter((connection) =>
      connection.status !== "archived"
      && ["degraded", "failed", "error", "missing_secret"].includes(connection.healthStatus)
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
      remoteHttpConnections: connections.filter((connection) => connection.status !== "archived" && connection.transport === "remote_http").length,
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
          note: "remote_http MCP connections are supported in hosted cloud and local deployments.",
        },
        localStdio: {
          supported: localStdioSupported,
          note: localStdioSupported
            ? "local_stdio is available for local trusted mode or through the configured trusted MCP runtime host."
            : `local_stdio should stay disabled for ${deploymentMode}/${deploymentExposure}; use remote_http or configure a trusted runtime worker.`,
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

  async function assertSecretRefs(companyId: string, refs: Array<{ secretId: string }>) {
    if (refs.length === 0) return;
    const secretIds = [...new Set(refs.map((ref) => ref.secretId))];
    for (const secretId of secretIds) {
      const [secret] = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId)));
      if (!secret) throw unprocessable("Tool connection credential secrets must belong to the same company");
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
    }
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

  async function getConnectionRow(connectionId: string, companyId?: string) {
    const where = companyId
      ? and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId))
      : eq(toolConnections.id, connectionId);
    const [row] = await db.select().from(toolConnections).where(where);
    if (!row) throw notFound("Tool connection not found");
    return row;
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
    const [entries, bindings] = await Promise.all([
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
    ]);
    return {
      ...toProfile(profile),
      entries: entries.map(toProfileEntry),
      bindings: bindings.map(toProfileBinding),
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
      })),
      ...connection.credentialSecretRefs.map((ref) => ({
        secretId: ref.secretId,
        configPath: ref.configPath,
      })),
    ];
    if (bindings.length === 0) return;
    await db.insert(companySecretBindings).values(bindings.map((ref) => ({
      companyId: connection.companyId,
      secretId: ref.secretId,
      targetType: "tool_connection" as const,
      targetId: connection.id,
      configPath: ref.configPath,
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
    const headers: Record<string, string> = {};
    for (const ref of connection.credentialRefs) {
      const value = await secrets.resolveSecretValue(connection.companyId, ref.secretId, ref.version ?? "latest", {
        consumerType: "tool_connection",
        consumerId: connection.id,
        configPath: `credentials.${ref.name}`,
        actorType: "system",
      });
      if (ref.placement === "header") {
        headers[ref.key] = `${ref.prefix ?? ""}${value}`;
      }
    }
    return headers;
  }

  async function remoteTools(connection: typeof toolConnections.$inferSelect): Promise<McpToolDescriptor[]> {
    const headers = await resolveCredentialHeaders(connection);
    const response = await fetch(remoteEndpoint(connection.config), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "paperclip-catalog-refresh",
        method: "tools/list",
        params: {},
      }),
    });
    if (!response.ok) throw new HttpError(502, "Remote MCP server returned an error", { status: response.status });
    const payload = await response.json() as unknown;
    const result = asRecord(asRecord(payload).result);
    const payloadTools = asRecord(payload).tools;
    const tools: unknown[] = Array.isArray(result.tools) ? result.tools : Array.isArray(payloadTools) ? payloadTools : [];
    return tools.map((tool) => normalizeToolDescriptor(tool)).filter((tool): tool is McpToolDescriptor => Boolean(tool));
  }

  function localTools(connection: typeof toolConnections.$inferSelect): McpToolDescriptor[] {
    const templateId = stdioTemplateId(connection.config);
    return APPROVED_STDIO_TEMPLATES[templateId].tools.map((tool) => ({
      ...tool,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: tool.annotations ?? {},
    }));
  }

  async function discoverTools(connection: typeof toolConnections.$inferSelect): Promise<McpToolDescriptor[]> {
    if (connection.transport === "remote_http") return remoteTools(connection);
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
      throw new HttpError(failure.status === "missing_secret" ? 422 : 502, failure.message, { code: failure.code });
    }

    const existingRows = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connection.id));
      const existingByName = new Map(existingRows.map((entry) => [entry.toolName, entry]));
    const updatedEntries: ToolCatalogEntry[] = [];
    let quarantinedCount = 0;

    for (const descriptor of descriptors) {
      const riskLevel = classifyRisk(descriptor);
      const hash = descriptorHash(descriptor);
      const existing = existingByName.get(descriptor.name);
      const writeCapable = riskLevel === "write" || riskLevel === "destructive";
      const changedWrite = existing && existing.versionHash !== hash && (writeCapable || existing.riskLevel !== "read");
      const shouldQuarantine = writeCapable && (!existing || changedWrite);
      const status = shouldQuarantine ? "quarantined" : existing?.status === "disabled" ? "disabled" : "active";
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
            schemaHash: stableHash(descriptor.inputSchema ?? {}),
            lastSeenAt: now,
            quarantinedAt: shouldQuarantine ? now : existing.quarantinedAt,
            quarantineReason: shouldQuarantine
              ? changedWrite ? "changed_write_tool" : "new_write_tool"
              : existing.quarantineReason,
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
          schemaHash: stableHash(descriptor.inputSchema ?? {}),
          firstSeenAt: now,
          lastSeenAt: now,
          quarantinedAt: shouldQuarantine ? now : null,
          quarantineReason: shouldQuarantine ? "new_write_tool" : null,
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
    const config = { templateId: definition.templateId, exampleId: definition.id, safeDefault: true };
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
    const [created] = await db.insert(toolConnections).values({
      companyId,
      applicationId,
      name: definition.connectionName,
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

  return {
    approvedStdioTemplates: () => APPROVED_STDIO_TEMPLATES,

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
      stdioTemplateId({ templateId: definition.templateId });
      const before = await exampleRows(companyId, definition);
      const application = await upsertExampleApplication(companyId, definition, before.application);
      const connection = await upsertExampleConnection(companyId, definition, application.row.id, before.connection);
      const refresh = await refreshCatalog(connection.row.id, actor);
      const profile = await upsertExampleProfile(companyId, definition, before.profile);
      const profileEntries = await syncExampleProfileEntries(companyId, profile.row.id, refresh.catalog);
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
        catalog: refresh.catalog,
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
      return rows.map(toConnection);
    },

    createConnection: async (companyId: string, input: CreateToolConnection): Promise<ToolConnection> => {
      let applicationId = input.applicationId;
      const transport = input.transport;
      if (!transport) throw badRequest("Tool connection transport is required");
      const config = input.config ?? input.transportConfig ?? {};
      if (transport === "remote_http") remoteEndpoint(config);
      if (transport === "local_stdio") stdioTemplateId(config);
      assertLocalStdioCanBeEnabled(transport, input.enabled ?? false);
      if (applicationId) {
        const app = await assertApplication(companyId, applicationId);
        if ((transport === "remote_http" && app.type !== "mcp_http") || (transport === "local_stdio" && app.type !== "mcp_stdio")) {
          throw unprocessable("Connection transport must match application type");
        }
      } else {
        const [app] = await db.insert(toolApplications).values({
          companyId,
          applicationKey: normalizeKey(input.applicationName ?? input.name),
          name: input.applicationName ?? input.name,
          type: transport === "remote_http" ? "mcp_http" : "mcp_stdio",
          status: "active",
          metadata: {},
        }).returning();
        applicationId = app.id;
      }
      await assertSecretRefs(companyId, [...(input.credentialRefs ?? []), ...(input.credentialSecretRefs ?? [])]);
      const [row] = await db.insert(toolConnections).values({
        companyId,
        applicationId,
        name: input.name,
        connectionKind: input.connectionKind ?? "managed",
        transport,
        status: input.status ?? "draft",
        enabled: input.enabled ?? false,
        config,
        transportConfig: input.transportConfig ?? config,
        credentialRefs: input.credentialRefs ?? [],
        credentialSecretRefs: input.credentialSecretRefs ?? [],
      }).returning();
      await syncCredentialBindings(row);
      await ensureRuntimeSlot(row);
      return toConnection(row);
    },

    getConnection: async (connectionId: string, companyId?: string): Promise<ToolConnection> => {
      return toConnection(await getConnectionRow(connectionId, companyId));
    },

    updateConnection: async (connectionId: string, input: UpdateToolConnection): Promise<ToolConnection> => {
      const existing = await getConnectionRow(connectionId);
      const config = input.config ?? input.transportConfig ?? existing.config;
      if (existing.transport === "remote_http") remoteEndpoint(config);
      if (existing.transport === "local_stdio") stdioTemplateId(config);
      assertLocalStdioCanBeEnabled(existing.transport, input.enabled ?? existing.enabled);
      await assertSecretRefs(existing.companyId, [...(input.credentialRefs ?? existing.credentialRefs), ...(input.credentialSecretRefs ?? existing.credentialSecretRefs)]);
      const [row] = await db
        .update(toolConnections)
        .set({
          name: input.name ?? existing.name,
          status: input.status ?? existing.status,
          enabled: input.enabled ?? existing.enabled,
          config,
          transportConfig: input.transportConfig ?? existing.transportConfig,
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
      const [row] = await db
        .update(toolConnections)
        .set({ status: "archived", enabled: false, updatedAt: new Date() })
        .where(eq(toolConnections.id, connectionId))
        .returning();
      if (!row) throw notFound("Tool connection not found");
      return toConnection(row);
    },

    checkHealth: async (connectionId: string, actor?: ActorInfo): Promise<ToolConnectionHealthCheckResult> => {
      const connection = await getConnectionRow(connectionId);
      try {
        if (connection.transport === "remote_http") {
          await remoteTools(connection);
        } else {
          await resolveCredentialHeaders(connection);
          stdioTemplateId(connection.config);
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
        throw new HttpError(failure.status === "missing_secret" ? 422 : 502, failure.message, { code: failure.code, connection: toConnection(updated), runtimeSlot });
      }
    },

    refreshCatalog,

    listCatalog: async (connectionId: string, companyId?: string): Promise<ToolCatalogEntry[]> => {
      const connection = await getConnectionRow(connectionId, companyId);
      const rows = await db
        .select()
        .from(toolCatalogEntries)
        .where(eq(toolCatalogEntries.connectionId, connection.id))
        .orderBy(desc(toolCatalogEntries.updatedAt));
      return rows.map(toCatalogEntry);
    },

    listProfiles: async (companyId: string): Promise<ToolProfileWithDetails[]> => {
      const profiles = await db
        .select()
        .from(toolProfiles)
        .where(eq(toolProfiles.companyId, companyId))
        .orderBy(desc(toolProfiles.updatedAt));
      if (profiles.length === 0) return [];
      const profileIds = profiles.map((profile) => profile.id);
      const [entries, bindings] = await Promise.all([
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
      ]);
      const entriesByProfile = new Map<string, ToolProfileEntry[]>();
      const bindingsByProfile = new Map<string, ToolProfileBinding[]>();
      for (const entry of entries) {
        const list = entriesByProfile.get(entry.profileId) ?? [];
        list.push(toProfileEntry(entry));
        entriesByProfile.set(entry.profileId, list);
      }
      for (const binding of bindings) {
        const list = bindingsByProfile.get(binding.profileId) ?? [];
        list.push(toProfileBinding(binding));
        bindingsByProfile.set(binding.profileId, list);
      }
      return profiles.map((profile) => ({
        ...toProfile(profile),
        entries: entriesByProfile.get(profile.id) ?? [],
        bindings: bindingsByProfile.get(profile.id) ?? [],
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
      const bindings = allBindings.filter((binding) =>
        (binding.targetType === "company" && binding.targetId === companyId)
        || (binding.targetType === "agent" && binding.targetId === agentId)
      );
      if (bindings.length === 0) {
        return { agentId, profiles: [], entries: [], bindings: [], allowedTools: [], allowedToolNames: [] };
      }
      const profileIds = [...new Set(bindings.map((binding) => binding.profileId))];
      const profiles = await db
        .select()
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, companyId), inArray(toolProfiles.id, profileIds)))
        .orderBy(asc(toolProfiles.createdAt));
      const activeProfiles = profiles.filter((profile) => profile.status === "active");
      if (activeProfiles.length === 0) {
        return {
          agentId,
          profiles: [],
          entries: [],
          bindings: bindings.map(toProfileBinding),
          allowedTools: [],
          allowedToolNames: [],
        };
      }
      const activeProfileIds = activeProfiles.map((profile) => profile.id);
      const [entries, catalog] = await Promise.all([
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
      const details: ToolProfileWithDetails[] = activeProfiles.map((profile) => ({
        ...toProfile(profile),
        entries: (entriesByProfile.get(profile.id) ?? []).map(toProfileEntry),
        bindings: bindings.filter((binding) => binding.profileId === profile.id).map(toProfileBinding),
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
      };
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
      const raw = typeof input.mcpJson === "string" ? JSON.parse(input.mcpJson) as unknown : input.mcpJson;
      const mcpServers = asRecord(asRecord(raw).mcpServers);
      const drafts = Object.entries(mcpServers).map(([name, rawServer]) => {
        const server = asRecord(rawServer);
        const warnings: string[] = [];
        if (typeof server.url === "string" || typeof server.endpoint === "string") {
          const headers = asRecord(server.headers);
          const credentialRefs: McpConnectionCredentialRef[] = Object.keys(headers).flatMap((key) => {
            warnings.push(`Header ${key} needs to be replaced with a Paperclip secret before activation.`);
            return [];
          });
          return {
            name,
            transport: "remote_http" as const,
            status: "draft" as const,
            config: { url: server.url ?? server.endpoint },
            credentialRefs,
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
            warnings,
          };
        }
        warnings.push("Unsupported MCP server entry.");
        return {
          name,
          transport: "remote_http" as const,
          status: "draft" as const,
          config: {},
          credentialRefs: [],
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
