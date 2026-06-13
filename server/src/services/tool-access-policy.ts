import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  projects,
  routines,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolCallEvents,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRateLimitCounters,
} from "@paperclipai/db";
import type {
  ToolAccessDecision,
  ToolAccessDecisionInput,
  ToolAccessReasonCode,
  ToolAccessSelector,
  ToolAuditEventType,
  CreateToolPolicy,
  DuplicateToolPolicy,
  CreateToolTrustRuleFromActionRequest,
  ReorderToolPolicies,
  RevokeToolTrustRule,
  ToolPolicyDecision,
  UpdateToolPolicy,
  ToolRateLimitRule,
  ToolRedactedValueSummary,
  ToolTrustRuleArgumentFilters,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";

type ToolAccessContext = {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  heartbeatRunId: string | null;
  issueId: string | null;
  projectId: string | null;
  routineId: string | null;
  applicationId: string | null;
  connectionId: string | null;
  catalogEntryId: string | null;
  catalogStatus: string | null;
  catalogVersionHash: string | null;
  catalogSchemaHash: string | null;
  toolName: string;
  riskLevel: string | null;
  argumentsHash: string;
  arguments: unknown;
};

type RedactionResult = {
  summary: ToolRedactedValueSummary;
  redactionPlan: { redactedFieldCount: number; redactedFields: string[] };
};

type TrustRuleConfig = {
  trustRule?: {
    sourceActionRequestId?: string | null;
    sourceInvocationId?: string | null;
    sourceApprovalCount?: number;
    approvalThreshold?: number;
    argumentFilters?: ToolTrustRuleArgumentFilters | null;
    expiresAt?: string | null;
    revokedAt?: string | null;
    revokedByAgentId?: string | null;
    revokedByUserId?: string | null;
    revocationReason?: string | null;
    hitCount?: number;
    lastHitAt?: string | null;
    catalogVersionHash?: string | null;
    schemaHash?: string | null;
    batchApproval?: Record<string, unknown> | null;
  };
} & Record<string, unknown>;

const SENSITIVE_KEY_RE =
  /(^|[_-])(api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|jwt|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)($|[_-])/i;
const SECRET_VALUE_RE = /\b(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{12,}|xox[baprs]-[a-z0-9-]{12,}|bearer\s+[a-z0-9._-]{12,})\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function snapshotString(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stableStringify(value: unknown): string {
  if (!isRecord(value) && !Array.isArray(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function isoDateOrNull(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function policyConfig(policy: typeof toolPolicies.$inferSelect): TrustRuleConfig {
  return isRecord(policy.config) ? policy.config as TrustRuleConfig : {};
}

function trustRuleConfig(policy: typeof toolPolicies.$inferSelect) {
  const config = policyConfig(policy).trustRule;
  return isRecord(config) ? config : null;
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    return current[segment];
  }, value);
}

function argumentFiltersMatch(filters: ToolTrustRuleArgumentFilters | null | undefined, ctx: ToolAccessContext): boolean {
  if (!filters || filters.allowAny === true) return true;
  if (filters.exactHash && filters.exactHash !== ctx.argumentsHash) return false;
  if (filters.allowedHashes?.length && !filters.allowedHashes.includes(ctx.argumentsHash)) return false;
  if (filters.fieldEquals) {
    for (const [path, expected] of Object.entries(filters.fieldEquals)) {
      if (stableStringify(readPath(ctx.arguments, path)) !== stableStringify(expected)) return false;
    }
  }
  return Boolean(filters.exactHash || filters.allowedHashes?.length || filters.fieldEquals);
}

function trustRuleNeedsReview(policy: typeof toolPolicies.$inferSelect, ctx: ToolAccessContext): boolean {
  const rule = trustRuleConfig(policy);
  if (!rule || !ctx.catalogEntryId) return false;
  const catalogVersionHash = typeof rule.catalogVersionHash === "string" ? rule.catalogVersionHash : null;
  const schemaHash = typeof rule.schemaHash === "string" ? rule.schemaHash : null;
  return Boolean(
    ctx.catalogStatus === "quarantined"
      || ctx.catalogStatus === "removed"
      || (catalogVersionHash && ctx.catalogVersionHash && catalogVersionHash !== ctx.catalogVersionHash)
      || (schemaHash && ctx.catalogSchemaHash && schemaHash !== ctx.catalogSchemaHash),
  );
}

function trustRuleIsActive(policy: typeof toolPolicies.$inferSelect, now = new Date()): boolean {
  const rule = trustRuleConfig(policy);
  if (!rule) return false;
  if (rule.revokedAt) return false;
  if (rule.expiresAt) {
    const expiresAt = new Date(rule.expiresAt);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) return false;
  }
  return true;
}

function sideEffectIdempotencyKey(ctx: ToolAccessContext, argumentsHash: string): string {
  return `side_effect:${sha256({
    companyId: ctx.companyId,
    runId: ctx.heartbeatRunId,
    issueId: ctx.issueId,
    applicationId: ctx.applicationId,
    connectionId: ctx.connectionId,
    catalogEntryId: ctx.catalogEntryId,
    toolName: ctx.toolName,
    argumentsHash,
  })}`;
}

function auditOutcome(accessDecision: ToolAccessDecision): "pending" | "success" | "denied" | "timeout" {
  if (accessDecision.decision === "allow") return "success";
  if (accessDecision.decision === "require_approval") return "pending";
  if (accessDecision.decision === "defer_runtime") return "timeout";
  return "denied";
}

function summarizeAndRedact(value: unknown): RedactionResult {
  const redactedFields: string[] = [];
  const visit = (current: unknown, path: string): unknown => {
    if (typeof current === "string") {
      if (SECRET_VALUE_RE.test(current)) {
        redactedFields.push(path || "$");
        return "[REDACTED]";
      }
      return current.length > 500 ? `${current.slice(0, 500)}...[truncated]` : current;
    }
    if (Array.isArray(current)) return current.slice(0, 50).map((entry, index) => visit(entry, `${path}[${index}]`));
    if (!isRecord(current)) return current;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current)) {
      const nestedPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_KEY_RE.test(key)) {
        redactedFields.push(nestedPath);
        out[key] = "[REDACTED]";
      } else {
        out[key] = visit(nested, nestedPath);
      }
    }
    return out;
  };
  const redacted = visit(value ?? {}, "");
  const text = stableStringify(redacted);
  return {
    summary: {
      summary: text.length > 4000 ? `${text.slice(0, 4000)}...[truncated]` : text,
      sizeBytes: Buffer.byteLength(text),
      sha256: sha256(redacted),
      redactedFields,
    },
    redactionPlan: {
      redactedFieldCount: redactedFields.length,
      redactedFields,
    },
  };
}

function decision(
  kind: ToolPolicyDecision,
  reasonCode: ToolAccessReasonCode,
  explanation: string,
  effectiveProfileIds: string[],
  matchedPolicyIds: string[],
  extra: Partial<ToolAccessDecision> = {},
): ToolAccessDecision {
  return {
    decision: kind,
    allowed: kind === "allow",
    reasonCode,
    explanation,
    effectiveProfileIds,
    matchedPolicyIds,
    ...extra,
  };
}

function listValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function selectorMatches(selector: ToolAccessSelector | Record<string, unknown> | null | undefined, ctx: ToolAccessContext): boolean {
  if (!selector || Object.keys(selector).length === 0) return true;
  const s = selector as Record<string, unknown>;
  const match = (singleKey: string, pluralKey: string, actual: string | null) => {
    const single = typeof s[singleKey] === "string" ? String(s[singleKey]) : null;
    const many = listValues(s[pluralKey]);
    return (!single || actual === single) && (many.length === 0 || Boolean(actual && many.includes(actual)));
  };
  return (
    match("actorType", "actorTypes", ctx.actorType) &&
    match("agentId", "agentIds", ctx.agentId) &&
    match("projectId", "projectIds", ctx.projectId) &&
    match("routineId", "routineIds", ctx.routineId) &&
    match("issueId", "issueIds", ctx.issueId) &&
    match("applicationId", "applicationIds", ctx.applicationId) &&
    match("connectionId", "connectionIds", ctx.connectionId) &&
    match("catalogEntryId", "catalogEntryIds", ctx.catalogEntryId) &&
    match("toolName", "toolNames", ctx.toolName) &&
    match("riskLevel", "riskLevels", ctx.riskLevel)
  );
}

function profileEntryMatches(entry: typeof toolProfileEntries.$inferSelect, ctx: ToolAccessContext): boolean {
  if (entry.selectorType === "application") return entry.applicationId === ctx.applicationId;
  if (entry.selectorType === "connection") return entry.connectionId === ctx.connectionId;
  if (entry.selectorType === "catalog_entry") return entry.catalogEntryId === ctx.catalogEntryId;
  if (entry.selectorType === "tool_name") return entry.toolName === ctx.toolName;
  if (entry.selectorType === "risk_level") return entry.riskLevel === ctx.riskLevel;
  return false;
}

function targetMatches(binding: typeof toolProfileBindings.$inferSelect, ctx: ToolAccessContext): boolean {
  if (binding.targetType === "company") return binding.targetId === ctx.companyId;
  if (binding.targetType === "agent") return binding.targetId === ctx.agentId;
  if (binding.targetType === "project") return binding.targetId === ctx.projectId;
  if (binding.targetType === "routine") return binding.targetId === ctx.routineId;
  if (binding.targetType === "issue") return binding.targetId === ctx.issueId;
  return false;
}

function rateLimitRule(policy: typeof toolPolicies.$inferSelect): ToolRateLimitRule | null {
  const config = isRecord(policy.config) ? policy.config : {};
  const raw = isRecord(config.rateLimit) ? config.rateLimit : config;
  const limit = typeof raw.limit === "number" ? raw.limit : null;
  const windowSeconds = typeof raw.windowSeconds === "number" ? raw.windowSeconds : null;
  if (!limit || !windowSeconds || limit <= 0 || windowSeconds <= 0) return null;
  return {
    limit: Math.floor(limit),
    windowSeconds: Math.floor(windowSeconds),
    keyBy: Array.isArray(raw.keyBy)
      ? raw.keyBy.filter((item): item is NonNullable<ToolRateLimitRule["keyBy"]>[number] => typeof item === "string")
      : undefined,
  };
}

function assertGenericPolicyType(policyType: string) {
  if (policyType === "trust_rule") {
    throw unprocessable("Trust rules are managed through the trust-rule promotion and revoke endpoints");
  }
}

async function getGenericPolicyRow(db: Db, companyId: string, policyId: string) {
  const [policy] = await db
    .select()
    .from(toolPolicies)
    .where(and(
      eq(toolPolicies.id, policyId),
      eq(toolPolicies.companyId, companyId),
      ne(toolPolicies.policyType, "trust_rule"),
    ))
    .limit(1);
  if (!policy) throw notFound("Tool policy not found");
  return policy;
}

function windowKind(windowSeconds: number): "minute" | "hour" | "day" | "month" {
  if (windowSeconds <= 60) return "minute";
  if (windowSeconds <= 3600) return "hour";
  if (windowSeconds <= 86400) return "day";
  return "month";
}

function windowStart(now: Date, windowSeconds: number): Date {
  return new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
}

function rateBucket(rule: ToolRateLimitRule, ctx: ToolAccessContext): string {
  const parts = rule.keyBy?.length ? rule.keyBy : ["company", "agent", "connection", "tool"] as const;
  return parts.map((part) => {
    if (part === "company") return `company:${ctx.companyId}`;
    if (part === "agent") return `agent:${ctx.agentId ?? "none"}`;
    if (part === "application") return `application:${ctx.applicationId ?? "none"}`;
    if (part === "connection") return `connection:${ctx.connectionId ?? "none"}`;
    return `tool:${ctx.toolName}`;
  }).join("|");
}

function scopeAllowsTool(scope: Record<string, unknown> | null, ctx: ToolAccessContext) {
  if (!scope || Object.keys(scope).length === 0) return true;
  const allowed = listValues(scope.allow);
  if (allowed.includes(`tool:${ctx.toolName}`)) return true;
  if (ctx.connectionId && allowed.includes(`connection:${ctx.connectionId}`)) return true;
  if (ctx.applicationId && allowed.includes(`application:${ctx.applicationId}`)) return true;
  return selectorMatches(scope, ctx);
}

export function toolAccessPolicyService(db: Db) {
  async function listPolicies(companyId: string) {
    return db
      .select()
      .from(toolPolicies)
      .where(and(eq(toolPolicies.companyId, companyId), ne(toolPolicies.policyType, "trust_rule")))
      .orderBy(asc(toolPolicies.priority), desc(toolPolicies.updatedAt));
  }

  async function reorderPolicies(companyId: string, body: ReorderToolPolicies) {
    const uniquePolicyIds = [...new Set(body.policyIds)];
    if (uniquePolicyIds.length !== body.policyIds.length) {
      throw badRequest("policyIds must not contain duplicates");
    }

    return db.transaction(async (tx) => {
      const rows = await tx
        .update(toolPolicies)
        .set({ updatedAt: sql`${toolPolicies.updatedAt}` })
        .where(and(
          eq(toolPolicies.companyId, companyId),
          ne(toolPolicies.policyType, "trust_rule"),
        ))
        .returning();
      const byId = new Map(rows.map((row) => [row.id, row]));
      const missingIds = uniquePolicyIds.filter((id) => !byId.has(id));
      if (missingIds.length > 0) {
        throw unprocessable("All reordered policies must belong to the company", { missingPolicyIds: missingIds });
      }
      if (uniquePolicyIds.length !== rows.length) {
        throw unprocessable("Reorder must include every non-trust policy for the company", {
          expectedPolicyCount: rows.length,
          receivedPolicyCount: uniquePolicyIds.length,
        });
      }

      const now = new Date();
      for (const [index, policyId] of uniquePolicyIds.entries()) {
        await tx
          .update(toolPolicies)
          .set({ priority: (index + 1) * 100, updatedAt: now })
          .where(eq(toolPolicies.id, policyId));
      }
      return tx
        .select()
        .from(toolPolicies)
        .where(and(eq(toolPolicies.companyId, companyId), ne(toolPolicies.policyType, "trust_rule")))
        .orderBy(asc(toolPolicies.priority), desc(toolPolicies.updatedAt));
    });
  }

  async function duplicatePolicy(input: {
    companyId: string;
    policyId: string;
    body: DuplicateToolPolicy;
    actor?: { agentId?: string | null; userId?: string | null };
  }) {
    const existing = await getGenericPolicyRow(db, input.companyId, input.policyId);
    const rows = await db
      .select({ name: toolPolicies.name })
      .from(toolPolicies)
      .where(eq(toolPolicies.companyId, input.companyId));
    const names = new Set(rows.map((row) => row.name));
    let name = input.body.name?.trim() || `${existing.name} copy`;
    if (names.has(name)) {
      const baseName = name;
      let suffix = 2;
      while (names.has(`${baseName} ${suffix}`)) suffix += 1;
      name = `${baseName} ${suffix}`;
    }
    const now = new Date();
    const [policy] = await db
      .insert(toolPolicies)
      .values({
        companyId: existing.companyId,
        name,
        description: existing.description,
        policyType: existing.policyType,
        priority: existing.priority + 1,
        enabled: false,
        selectors: existing.selectors ?? {},
        conditions: existing.conditions ?? null,
        config: existing.config ?? null,
        createdByAgentId: input.actor?.agentId ?? null,
        createdByUserId: input.actor?.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return policy;
  }

  async function createPolicy(
    companyId: string,
    body: CreateToolPolicy,
    actor?: { agentId?: string | null; userId?: string | null },
  ) {
    assertGenericPolicyType(body.policyType);
    const now = new Date();
    const [policy] = await db
      .insert(toolPolicies)
      .values({
        companyId,
        name: body.name,
        description: body.description ?? null,
        policyType: body.policyType,
        priority: body.priority ?? 100,
        enabled: body.enabled ?? true,
        selectors: body.selectors ?? {},
        conditions: body.conditions ?? null,
        config: body.config ?? null,
        createdByAgentId: actor?.agentId ?? null,
        createdByUserId: actor?.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return policy;
  }

  async function updatePolicy(input: {
    companyId: string;
    policyId: string;
    body: UpdateToolPolicy;
  }) {
    if (input.body.policyType) assertGenericPolicyType(input.body.policyType);
    const existing = await getGenericPolicyRow(db, input.companyId, input.policyId);
    const now = new Date();
    const [policy] = await db
      .update(toolPolicies)
      .set({
        ...(input.body.name !== undefined ? { name: input.body.name } : {}),
        ...(input.body.description !== undefined ? { description: input.body.description ?? null } : {}),
        ...(input.body.policyType !== undefined ? { policyType: input.body.policyType } : {}),
        ...(input.body.priority !== undefined ? { priority: input.body.priority } : {}),
        ...(input.body.enabled !== undefined ? { enabled: input.body.enabled } : {}),
        ...(input.body.selectors !== undefined ? { selectors: input.body.selectors ?? {} } : {}),
        ...(input.body.conditions !== undefined ? { conditions: input.body.conditions ?? null } : {}),
        ...(input.body.config !== undefined ? { config: input.body.config ?? null } : {}),
        updatedAt: now,
      })
      .where(eq(toolPolicies.id, existing.id))
      .returning();
    return policy;
  }

  async function deletePolicy(input: { companyId: string; policyId: string }) {
    const existing = await getGenericPolicyRow(db, input.companyId, input.policyId);
    const [deleted] = await db
      .delete(toolPolicies)
      .where(eq(toolPolicies.id, existing.id))
      .returning();
    return deleted;
  }

  async function loadContext(input: ToolAccessDecisionInput): Promise<
    | { ok: true; ctx: ToolAccessContext; redaction: RedactionResult }
    | { ok: false; decision: ToolAccessDecision; redaction: RedactionResult }
  > {
    const redaction = summarizeAndRedact(input.request.arguments ?? {});
    let agentId = input.actor.agentId ?? (input.actor.actorType === "agent" ? input.actor.actorId : null);
    let heartbeatRunId = input.runContext?.heartbeatRunId ?? null;
    let issueId = input.runContext?.issueId ?? null;
    let projectId = input.runContext?.projectId ?? null;
    let routineId = input.runContext?.routineId ?? null;

    if (input.actor.actorType === "agent") {
      const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId ?? ""), eq(agents.companyId, input.companyId)));
      if (!agent) {
        return { ok: false, redaction, decision: decision("deny", "deny_missing_agent", "Authenticated agent was not found in the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      agentId = agent.id;
    }

    if (heartbeatRunId) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatRunId));
      if (!run || run.companyId !== input.companyId || (input.actor.actorType === "agent" && run.agentId !== agentId)) {
        return { ok: false, redaction, decision: decision("deny", "deny_run_context_mismatch", "Supplied run context does not match the authenticated actor.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      agentId = run.agentId;
      const snapshot = isRecord(run.contextSnapshot) ? run.contextSnapshot : {};
      const runIssueId = snapshotString(snapshot, "issueId");
      const runProjectId = snapshotString(snapshot, "projectId");
      const runRoutineId = snapshotString(snapshot, "routineId");
      if ((issueId && runIssueId && issueId !== runIssueId)
        || (projectId && runProjectId && projectId !== runProjectId)
        || (routineId && runRoutineId && routineId !== runRoutineId)) {
        return { ok: false, redaction, decision: decision("deny", "deny_run_context_mismatch", "Supplied run context does not match the stored heartbeat context.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      issueId = runIssueId ?? issueId;
      projectId = runProjectId ?? projectId;
      routineId = runRoutineId ?? routineId;
    }

    if (issueId) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      if (!issue || issue.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Issue context is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      if (projectId && projectId !== issue.projectId) {
        return { ok: false, redaction, decision: decision("deny", "deny_run_context_mismatch", "Project context does not match the issue context.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      projectId = projectId ?? issue.projectId;
    }
    if (projectId) {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
      if (!project || project.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Project context is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
    }
    if (routineId) {
      const [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
      if (!routine || routine.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Routine context is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
    }

    let applicationId = input.request.applicationId ?? null;
    let connectionId = input.request.connectionId ?? null;
    let catalogEntryId = input.request.catalogEntryId ?? null;
    let catalogStatus: string | null = null;
    let catalogVersionHash: string | null = null;
    let catalogSchemaHash: string | null = null;
    let riskLevel: string | null = null;

    if (catalogEntryId) {
      const [entry] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.id, catalogEntryId));
      if (!entry || entry.companyId !== input.companyId || (entry.name !== input.request.toolName && entry.toolName !== input.request.toolName)) {
        return { ok: false, redaction, decision: decision("deny", "deny_missing_tool", "Requested tool is not in the company catalog.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      connectionId = entry.connectionId;
      applicationId = entry.applicationId ?? applicationId;
      riskLevel = entry.riskLevel;
      catalogStatus = entry.status;
      catalogVersionHash = entry.versionHash;
      catalogSchemaHash = entry.schemaHash;
    } else if (connectionId) {
      const [entry] = await db
        .select()
        .from(toolCatalogEntries)
        .where(and(eq(toolCatalogEntries.companyId, input.companyId), eq(toolCatalogEntries.connectionId, connectionId), eq(toolCatalogEntries.name, input.request.toolName)));
      if (entry) {
        catalogEntryId = entry.id;
        applicationId = entry.applicationId ?? applicationId;
        riskLevel = entry.riskLevel;
        catalogStatus = entry.status;
        catalogVersionHash = entry.versionHash;
        catalogSchemaHash = entry.schemaHash;
      }
    }

    if (connectionId) {
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
      if (!connection || connection.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Connection is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      if (!connection.enabled || connection.status === "disabled" || connection.status === "archived") {
        return { ok: false, redaction, decision: decision("deny", "deny_disabled_connection", "Connection is disabled.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      applicationId = connection.applicationId;
    }
    if (applicationId) {
      const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationId));
      if (!application || application.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Application is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      if (application.status === "disabled") {
        return { ok: false, redaction, decision: decision("deny", "deny_disabled_application", "Application is disabled.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      if (application.status === "archived") {
        return { ok: false, redaction, decision: decision("deny", "deny_archived_application", "Application is archived.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
    }

    return {
      ok: true,
      redaction,
      ctx: {
        companyId: input.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId,
        heartbeatRunId,
        issueId,
        projectId,
        routineId,
        applicationId,
        connectionId,
        catalogEntryId,
        catalogStatus,
        catalogVersionHash,
        catalogSchemaHash,
        toolName: input.request.toolName,
        riskLevel,
        argumentsHash: redaction.summary.sha256 ?? sha256(input.request.arguments ?? {}),
        arguments: input.request.arguments ?? {},
      },
    };
  }

  async function effectiveProfiles(ctx: ToolAccessContext) {
    const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, ctx.companyId));
    const activeBindings = bindings.filter((binding) => targetMatches(binding, ctx));
    if (activeBindings.length === 0) return { profiles: [], entries: [] as Array<typeof toolProfileEntries.$inferSelect> };
    const profileIds = [...new Set(activeBindings.map((binding) => binding.profileId))];
    const profiles = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, ctx.companyId), inArray(toolProfiles.id, profileIds)));
    const activeProfileIds = profiles.filter((profile) => profile.status === "active").map((profile) => profile.id);
    const entries = activeProfileIds.length > 0
      ? await db.select().from(toolProfileEntries).where(and(eq(toolProfileEntries.companyId, ctx.companyId), inArray(toolProfileEntries.profileId, activeProfileIds)))
      : [];
    return { profiles: profiles.filter((profile) => profile.status === "active"), entries };
  }

  async function explicitGrant(ctx: ToolAccessContext): Promise<boolean> {
    const principalType = ctx.actorType === "agent" ? "agent" : ctx.actorType === "user" ? "user" : null;
    const principalId = ctx.actorType === "agent" ? ctx.agentId : ctx.actorId;
    if (!principalType || !principalId) return false;
    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, ctx.companyId),
        eq(principalPermissionGrants.principalType, principalType),
        eq(principalPermissionGrants.principalId, principalId),
        eq(principalPermissionGrants.permissionKey, "tools:use"),
      ));
    return grants.some((grant) => scopeAllowsTool(grant.scope, ctx));
  }

  async function enforceRateLimit(policy: typeof toolPolicies.$inferSelect, ctx: ToolAccessContext, consume: boolean) {
    const rule = rateLimitRule(policy);
    if (!rule) return null;
    const now = new Date();
    const start = windowStart(now, rule.windowSeconds);
    const kind = windowKind(rule.windowSeconds);
    const resetAt = new Date(start.getTime() + rule.windowSeconds * 1000);
    const bucketKey = `${policy.id}:${rateBucket(rule, ctx)}`;
    const [existing] = await db.select().from(toolRateLimitCounters).where(and(
      eq(toolRateLimitCounters.companyId, ctx.companyId),
      eq(toolRateLimitCounters.policyId, policy.id),
      eq(toolRateLimitCounters.counterKey, bucketKey),
      eq(toolRateLimitCounters.windowKind, kind),
      eq(toolRateLimitCounters.windowStartAt, start),
    ));
    const count = existing ? Math.max(0, existing.limit - existing.remaining) : 0;
    if (count >= rule.limit) {
      return { limited: true, count, limit: rule.limit, windowSeconds: rule.windowSeconds, bucketKey };
    }
    if (consume) {
      if (existing) {
        await db.update(toolRateLimitCounters).set({
          remaining: Math.max(0, existing.remaining - 1),
          updatedAt: now,
        }).where(eq(toolRateLimitCounters.id, existing.id));
      } else {
        await db.insert(toolRateLimitCounters).values({
          companyId: ctx.companyId,
          policyId: policy.id,
          counterKey: bucketKey,
          scopeType: "policy",
          scopeId: policy.id,
          windowKind: kind,
          windowStartAt: start,
          limit: rule.limit,
          remaining: Math.max(0, rule.limit - 1),
          resetAt,
        });
      }
    }
    return { limited: false, count: consume ? count + 1 : count, limit: rule.limit, windowSeconds: rule.windowSeconds, bucketKey };
  }

  async function recordTrustRuleHit(policy: typeof toolPolicies.$inferSelect, ctx: ToolAccessContext, redaction: RedactionResult) {
    const now = new Date();
    const config = policyConfig(policy);
    const rule = trustRuleConfig(policy) ?? {};
    const nextRule = {
      ...rule,
      hitCount: Math.max(0, Number(rule.hitCount ?? 0)) + 1,
      lastHitAt: now.toISOString(),
    };
    await db
      .update(toolPolicies)
      .set({ config: { ...config, trustRule: nextRule }, updatedAt: now })
      .where(eq(toolPolicies.id, policy.id));
    await db.insert(toolAccessAuditEvents).values({
      companyId: ctx.companyId,
      connectionId: ctx.connectionId,
      catalogEntryId: ctx.catalogEntryId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: "tool_access.trust_rule_used",
      outcome: "success",
      reasonCode: "allow_trust_rule",
      details: {
        policyId: policy.id,
        agentId: ctx.agentId,
        issueId: ctx.issueId,
        runId: ctx.heartbeatRunId,
        toolName: ctx.toolName,
        hitCount: nextRule.hitCount,
        argumentsSummary: redaction.summary,
      },
    });
    await db.insert(toolCallEvents).values({
      companyId: ctx.companyId,
      eventType: "trust_rule_used",
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      agentId: ctx.agentId,
      runId: ctx.heartbeatRunId,
      issueId: ctx.issueId,
      applicationId: ctx.applicationId,
      connectionId: ctx.connectionId,
      catalogEntryId: ctx.catalogEntryId,
      toolName: ctx.toolName,
      decision: "allow",
      matchedPolicyIds: [policy.id],
      reasonCode: "allow_trust_rule",
      outcome: "success",
      argumentsSummary: redaction.summary,
      requestHash: redaction.summary.sha256 ?? null,
      requestSummary: redaction.summary,
      redactionPlan: redaction.redactionPlan,
      metadata: { hitCount: nextRule.hitCount },
    });
  }

  async function decide(input: ToolAccessDecisionInput): Promise<ToolAccessDecision> {
    const loaded = await loadContext(input);
    if (!loaded.ok) return loaded.decision;
    const { ctx, redaction } = loaded;
    const profileState = await effectiveProfiles(ctx);
    const effectiveProfileIds = profileState.profiles.map((profile) => profile.id);
    const policies = await db.select().from(toolPolicies).where(and(eq(toolPolicies.companyId, ctx.companyId), eq(toolPolicies.enabled, true))).orderBy(asc(toolPolicies.priority), asc(toolPolicies.createdAt));
    const matchingPolicies = policies.filter((policy) => selectorMatches(policy.selectors, ctx));
    for (const policy of matchingPolicies) {
      if (policy.policyType === "block") {
        return decision("deny", "deny_policy_block", policy.description ?? "Tool access is blocked by policy.", effectiveProfileIds, [policy.id], { redactionPlan: redaction.redactionPlan });
      }
      if (policy.policyType === "rate_limit") {
        const state = await enforceRateLimit(policy, ctx, input.consumeRateLimit === true);
        if (state?.limited) {
          return decision("rate_limited", "rate_limited", "Tool access rate limit exceeded.", effectiveProfileIds, [policy.id], { rateLimitState: state, redactionPlan: redaction.redactionPlan });
        }
        continue;
      }
      if (policy.policyType === "trust_rule") {
        const rule = trustRuleConfig(policy);
        if (!rule || !trustRuleIsActive(policy)) continue;
        if (!argumentFiltersMatch(rule.argumentFilters, ctx)) continue;
        if (trustRuleNeedsReview(policy, ctx)) {
          return decision(
            "require_approval",
            "requires_review_changed_tool",
            "Tool definition changed or was quarantined after this trust rule was created; review is required.",
            effectiveProfileIds,
            [policy.id],
            { redactionPlan: redaction.redactionPlan },
          );
        }
        if (input.consumeRateLimit === true) {
          await recordTrustRuleHit(policy, ctx, redaction);
        }
        return decision("allow", "allow_trust_rule", policy.description ?? "Tool access allowed by trust rule.", effectiveProfileIds, [policy.id], { redactionPlan: redaction.redactionPlan });
      }
      if (policy.policyType === "require_approval") {
        return decision("require_approval", "requires_approval_policy", policy.description ?? "Tool access requires approval.", effectiveProfileIds, [policy.id], { redactionPlan: redaction.redactionPlan });
      }
      if (policy.policyType === "allow") {
        return decision("allow", "allow_policy", "Tool access allowed by policy.", effectiveProfileIds, [policy.id], { redactionPlan: redaction.redactionPlan });
      }
    }
    if (await explicitGrant(ctx)) {
      return decision("allow", "allow_explicit_grant", "Tool access allowed by explicit grant.", effectiveProfileIds, [], { redactionPlan: redaction.redactionPlan });
    }

    const entriesByProfile = new Map<string, Array<typeof toolProfileEntries.$inferSelect>>();
    for (const entry of profileState.entries) {
      const list = entriesByProfile.get(entry.profileId) ?? [];
      list.push(entry);
      entriesByProfile.set(entry.profileId, list);
    }
    for (const profile of profileState.profiles) {
      const entries = entriesByProfile.get(profile.id) ?? [];
      const matchingEntries = entries.filter((entry) => profileEntryMatches(entry, ctx));
      if (matchingEntries.some((entry) => entry.effect === "exclude")) continue;
      if (profile.defaultAction === "allow" || matchingEntries.some((entry) => entry.effect === "include")) {
        return decision("allow", "allow_profile", "Tool access allowed by effective profile.", effectiveProfileIds, [], { redactionPlan: redaction.redactionPlan });
      }
    }

    return decision("deny", "deny_default", "No effective tool profile, grant, or allow policy permits this call.", effectiveProfileIds, [], { redactionPlan: redaction.redactionPlan });
  }

  async function writeAudit(
    input: ToolAccessDecisionInput,
    accessDecision: ToolAccessDecision,
    eventType: ToolAuditEventType = "policy_decision",
  ) {
    const loaded = await loadContext(input);
    const redaction = loaded.redaction;
    const ctx = loaded.ok ? loaded.ctx : {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? null,
      issueId: input.runContext?.issueId ?? null,
      runId: input.runContext?.heartbeatRunId ?? null,
      connectionId: input.request.connectionId ?? null,
      catalogEntryId: input.request.catalogEntryId ?? null,
      applicationId: input.request.applicationId ?? null,
      toolName: input.request.toolName,
    };
    const runId = "runId" in ctx ? ctx.runId : ctx.heartbeatRunId;
    const [legacyAuditEvent] = await db.insert(toolAccessAuditEvents).values({
      companyId: input.companyId,
      connectionId: ctx.connectionId,
      catalogEntryId: ctx.catalogEntryId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      action: `tool_access.${eventType}`,
      outcome: accessDecision.allowed ? "success" : "denied",
      reasonCode: accessDecision.reasonCode,
      details: {
        decision: accessDecision.decision,
        matchedPolicyIds: accessDecision.matchedPolicyIds,
        effectiveProfileIds: accessDecision.effectiveProfileIds,
        applicationId: ctx.applicationId,
        agentId: ctx.agentId,
        issueId: ctx.issueId,
        runId,
        toolName: ctx.toolName,
        argumentsSummary: redaction.summary,
        redactionPlan: redaction.redactionPlan,
        rateLimitState: accessDecision.rateLimitState ?? null,
      },
    }).returning();
    const [toolCallEvent] = await db.insert(toolCallEvents).values({
      companyId: input.companyId,
      eventType: eventType as typeof toolCallEvents.$inferInsert["eventType"],
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      agentId: ctx.agentId,
      runId,
      issueId: ctx.issueId,
      applicationId: ctx.applicationId,
      connectionId: ctx.connectionId,
      catalogEntryId: ctx.catalogEntryId,
      toolName: ctx.toolName,
      decision: accessDecision.decision,
      matchedPolicyIds: accessDecision.matchedPolicyIds,
      reasonCode: accessDecision.reasonCode,
      outcome: auditOutcome(accessDecision),
      argumentsSummary: redaction.summary,
      requestHash: redaction.summary.sha256 ?? null,
      requestSummary: redaction.summary,
      redactionPlan: redaction.redactionPlan,
      rateLimitState: accessDecision.rateLimitState ?? null,
      metadata: {
        legacyAuditEventId: legacyAuditEvent.id,
        effectiveProfileIds: accessDecision.effectiveProfileIds,
        explanation: accessDecision.explanation,
      },
    }).returning();
    return { legacyAuditEvent, toolCallEvent };
  }

  async function recordInvocation(input: ToolAccessDecisionInput, accessDecision: ToolAccessDecision) {
    const loaded = await loadContext(input);
    if (!loaded.ok) throw new Error("Cannot record invocation for invalid tool access context");
    const { ctx, redaction } = loaded;
    const argumentsHash = redaction.summary.sha256 ?? sha256(input.request.arguments ?? {});
    const idempotencyKey = input.request.idempotencyKey
      ?? (input.request.sideEffecting ? sideEffectIdempotencyKey(ctx, argumentsHash) : null);
    if (idempotencyKey) {
      const [existing] = await db.select().from(toolInvocations).where(and(
        eq(toolInvocations.companyId, input.companyId),
        eq(toolInvocations.idempotencyKey, idempotencyKey),
      ));
      if (existing) return { invocation: existing, replayed: true, actionRequest: null };
    }
    const status = accessDecision.decision === "allow"
      ? "authorized"
      : accessDecision.decision === "require_approval"
        ? "awaiting_approval"
        : accessDecision.decision === "rate_limited"
          ? "rate_limited"
          : "denied";
    const [invocation] = await db.insert(toolInvocations).values({
      companyId: ctx.companyId,
      idempotencyKey,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      agentId: ctx.agentId,
      issueId: ctx.issueId,
      runId: ctx.heartbeatRunId,
      applicationId: ctx.applicationId,
      connectionId: ctx.connectionId,
      catalogEntryId: ctx.catalogEntryId,
      catalogVersionHash: ctx.catalogVersionHash,
      catalogSchemaHash: ctx.catalogSchemaHash,
      toolName: ctx.toolName,
      argumentsHash,
      argumentsSummary: redaction.summary,
      policyDecision: accessDecision.decision,
      matchedPolicyIds: accessDecision.matchedPolicyIds,
      approvalState: accessDecision.decision === "require_approval" ? "pending" : "not_required",
      status,
    }).returning();
    let actionRequest = null;
    if (accessDecision.decision === "require_approval") {
      [actionRequest] = await db.insert(toolActionRequests).values({
        companyId: ctx.companyId,
        invocationId: invocation.id,
        issueId: ctx.issueId,
        status: "pending",
        canonicalArgumentsHash: invocation.argumentsHash ?? argumentsHash,
        canonicalArgumentsSummary: redaction.summary,
        requestedByAgentId: ctx.actorType === "agent" ? ctx.agentId : null,
        requestedByUserId: ctx.actorType === "user" ? ctx.actorId : null,
      }).returning();
    }
    return { invocation, replayed: false, actionRequest };
  }

  async function matchingApprovedActionRequestCount(input: {
    companyId: string;
    invocation: typeof toolInvocations.$inferSelect;
    filters: ToolTrustRuleArgumentFilters;
    selectors: Record<string, unknown>;
  }) {
    const rows = await db
      .select()
      .from(toolActionRequests)
      .where(and(eq(toolActionRequests.companyId, input.companyId), inArray(toolActionRequests.status, ["approved", "executed"])));
    if (rows.length === 0) return 0;
    const invocationIds = rows.map((row) => row.invocationId);
    const invocations = await db
      .select()
      .from(toolInvocations)
      .where(and(eq(toolInvocations.companyId, input.companyId), inArray(toolInvocations.id, invocationIds)));
    const byId = new Map(invocations.map((row) => [row.id, row]));
    const issueIds = [...new Set(invocations.map((row) => row.issueId).filter((id): id is string => Boolean(id)))];
    const issueRows = issueIds.length > 0
      ? await db
        .select({ id: issues.id, projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, issueIds)))
      : [];
    const issueProjectById = new Map(issueRows.map((row) => [row.id, row.projectId]));
    const allowedHashes = new Set([
      ...(input.filters.allowedHashes ?? []),
      ...(input.filters.exactHash ? [input.filters.exactHash] : []),
      ...(input.invocation.argumentsHash ? [input.invocation.argumentsHash] : []),
    ]);
    return rows.filter((row) => {
      const invocation = byId.get(row.invocationId);
      if (!invocation) return false;
      if (invocation.toolName !== input.invocation.toolName) return false;
      if (invocation.applicationId !== input.invocation.applicationId) return false;
      if (invocation.connectionId !== input.invocation.connectionId) return false;
      if (invocation.catalogEntryId !== input.invocation.catalogEntryId) return false;
      if (invocation.catalogVersionHash !== input.invocation.catalogVersionHash) return false;
      if (invocation.catalogSchemaHash !== input.invocation.catalogSchemaHash) return false;
      if (!selectorMatches(input.selectors, {
        companyId: input.companyId,
        actorType: invocation.actorType as ToolAccessContext["actorType"],
        actorId: invocation.actorId ?? invocation.agentId ?? "system",
        agentId: invocation.agentId,
        heartbeatRunId: invocation.runId,
        issueId: invocation.issueId,
        projectId: invocation.issueId ? issueProjectById.get(invocation.issueId) ?? null : null,
        routineId: null,
        applicationId: invocation.applicationId,
        connectionId: invocation.connectionId,
        catalogEntryId: invocation.catalogEntryId,
        catalogStatus: null,
        catalogVersionHash: invocation.catalogVersionHash,
        catalogSchemaHash: invocation.catalogSchemaHash,
        toolName: invocation.toolName,
        riskLevel: null,
        argumentsHash: invocation.argumentsHash ?? "",
        arguments: {},
      })) return false;
      if (input.filters.allowAny === true) return true;
      return Boolean(invocation.argumentsHash && allowedHashes.has(invocation.argumentsHash));
    }).length;
  }

  function trustRuleSelectors(input: {
    invocation: typeof toolInvocations.$inferSelect;
    issueProjectId: string | null;
    selectors?: ToolAccessSelector;
    scope?: CreateToolTrustRuleFromActionRequest["scope"];
  }): Record<string, unknown> {
    const selectors: Record<string, unknown> = { ...(input.selectors ?? {}) };
    const scope = input.scope ?? {};
    const apply = (key: string, value: string | null | undefined, enabled: boolean) => {
      if (!enabled || !value || selectors[key] || selectors[`${key}s`]) return;
      selectors[key] = value;
    };
    apply("agentId", input.invocation.agentId, scope.includeAgent ?? true);
    apply("projectId", input.issueProjectId, scope.includeProject ?? true);
    apply("issueId", input.invocation.issueId, scope.includeIssue === true);
    apply("applicationId", input.invocation.applicationId, scope.includeApplication ?? true);
    apply("connectionId", input.invocation.connectionId, scope.includeConnection ?? true);
    apply("catalogEntryId", input.invocation.catalogEntryId, scope.includeCatalogEntry === true);
    apply("toolName", input.invocation.toolName, scope.includeTool ?? true);
    return selectors;
  }

  async function createTrustRuleFromActionRequest(input: {
    companyId: string;
    actionRequestId: string;
    body: CreateToolTrustRuleFromActionRequest;
    actor?: { agentId?: string | null; userId?: string | null };
  }) {
    const [actionRequest] = await db
      .select()
      .from(toolActionRequests)
      .where(and(eq(toolActionRequests.id, input.actionRequestId), eq(toolActionRequests.companyId, input.companyId)))
      .limit(1);
    if (!actionRequest) throw notFound("Tool action request not found");
    if (actionRequest.status !== "approved" && actionRequest.status !== "executed") {
      throw unprocessable("Trust rules can only be created from approved or executed action requests");
    }
    const [invocation] = await db
      .select()
      .from(toolInvocations)
      .where(and(eq(toolInvocations.id, actionRequest.invocationId), eq(toolInvocations.companyId, input.companyId)))
      .limit(1);
    if (!invocation) throw notFound("Tool invocation not found");
    if (invocation.policyDecision !== "require_approval") {
      throw unprocessable("Trust rules must be promoted from approval-required tool actions");
    }
    if (invocation.catalogEntryId && !invocation.catalogVersionHash) {
      throw unprocessable("Trust rule promotion requires a reviewed tool catalog version on the source action request");
    }

    const filters = input.body.argumentFilters ?? {
      exactHash: invocation.argumentsHash,
    };
    if (!filters.allowAny && !filters.exactHash && !filters.allowedHashes?.length && !filters.fieldEquals) {
      throw badRequest("Trust rule requires an argument filter or allowAny=true");
    }
    const [issue] = invocation.issueId
      ? await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, invocation.issueId), eq(issues.companyId, input.companyId)))
        .limit(1)
      : [null];
    const selectors = trustRuleSelectors({
      invocation,
      issueProjectId: issue?.projectId ?? null,
      selectors: input.body.selectors,
      scope: input.body.scope,
    });
    const approvalThreshold = input.body.approvalThreshold ?? 2;
    const approvedCount = await matchingApprovedActionRequestCount({
      companyId: input.companyId,
      invocation,
      filters,
      selectors,
    });
    if (approvedCount < approvalThreshold) {
      throw unprocessable(`Trust rule requires ${approvalThreshold} matching approved actions in the final rule scope; found ${approvedCount}`);
    }
    const now = new Date();
    const expiresAt = isoDateOrNull(input.body.expiresAt);
    const name = input.body.name ?? `Trust ${invocation.toolName} ${actionRequest.id.slice(0, 8)}`;
    const description = input.body.description
      ?? `Progressive-autonomy trust rule promoted from action request ${actionRequest.id}.`;
    const [policy] = await db.insert(toolPolicies).values({
      companyId: input.companyId,
      name,
      description,
      policyType: "trust_rule",
      priority: input.body.priority ?? 40,
      enabled: true,
      selectors,
      config: {
        trustRule: {
          sourceActionRequestId: actionRequest.id,
          sourceInvocationId: invocation.id,
          sourceApprovalCount: approvedCount,
          approvalThreshold,
          argumentFilters: filters,
          expiresAt,
          revokedAt: null,
          hitCount: 0,
          lastHitAt: null,
          catalogVersionHash: invocation.catalogVersionHash ?? null,
          schemaHash: invocation.catalogSchemaHash ?? null,
          batchApproval: input.body.batchApproval ?? null,
        },
      },
      createdByAgentId: input.actor?.agentId ?? null,
      createdByUserId: input.actor?.userId ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    await db.insert(toolAccessAuditEvents).values({
      companyId: input.companyId,
      connectionId: invocation.connectionId,
      catalogEntryId: invocation.catalogEntryId,
      actorType: input.actor?.agentId ? "agent" : input.actor?.userId ? "user" : "system",
      actorId: input.actor?.agentId ?? input.actor?.userId ?? null,
      action: "tool_access.trust_rule_created",
      outcome: "success",
      reasonCode: "trust_rule_promoted_from_approval",
      details: {
        policyId: policy.id,
        actionRequestId: actionRequest.id,
        invocationId: invocation.id,
        approvalThreshold,
        approvedCount,
        selectors,
        argumentFilters: filters,
        expiresAt,
      },
    });
    await db.insert(toolCallEvents).values({
      companyId: input.companyId,
      eventType: "trust_rule_created",
      actorType: input.actor?.agentId ? "agent" : input.actor?.userId ? "user" : "system",
      actorId: input.actor?.agentId ?? input.actor?.userId ?? null,
      agentId: invocation.agentId,
      runId: invocation.runId,
      issueId: invocation.issueId,
      applicationId: invocation.applicationId,
      connectionId: invocation.connectionId,
      catalogEntryId: invocation.catalogEntryId,
      invocationId: invocation.id,
      actionRequestId: actionRequest.id,
      toolName: invocation.toolName,
      decision: "allow",
      matchedPolicyIds: [policy.id],
      reasonCode: "trust_rule_promoted_from_approval",
      outcome: "success",
      argumentsSummary: invocation.argumentsSummary,
      requestHash: invocation.argumentsHash,
      requestSummary: invocation.argumentsSummary,
      metadata: { approvalThreshold, approvedCount, selectors, expiresAt },
    });
    return policy;
  }

  async function listTrustRules(companyId: string) {
    return db
      .select()
      .from(toolPolicies)
      .where(and(eq(toolPolicies.companyId, companyId), eq(toolPolicies.policyType, "trust_rule")))
      .orderBy(desc(toolPolicies.updatedAt));
  }

  async function revokeTrustRule(input: {
    companyId: string;
    policyId: string;
    body: RevokeToolTrustRule;
    actor?: { agentId?: string | null; userId?: string | null };
  }) {
    const [existing] = await db
      .select()
      .from(toolPolicies)
      .where(and(eq(toolPolicies.id, input.policyId), eq(toolPolicies.companyId, input.companyId)))
      .limit(1);
    if (!existing || existing.policyType !== "trust_rule") throw notFound("Tool trust rule not found");
    const now = new Date();
    const config = policyConfig(existing);
    const rule = trustRuleConfig(existing) ?? {};
    const [updated] = await db
      .update(toolPolicies)
      .set({
        enabled: false,
        config: {
          ...config,
          trustRule: {
            ...rule,
            revokedAt: rule.revokedAt ?? now.toISOString(),
            revokedByAgentId: input.actor?.agentId ?? null,
            revokedByUserId: input.actor?.userId ?? null,
            revocationReason: input.body.reason ?? null,
          },
        },
        updatedAt: now,
      })
      .where(eq(toolPolicies.id, existing.id))
      .returning();
    await db.insert(toolAccessAuditEvents).values({
      companyId: input.companyId,
      actorType: input.actor?.agentId ? "agent" : input.actor?.userId ? "user" : "system",
      actorId: input.actor?.agentId ?? input.actor?.userId ?? null,
      action: "tool_access.trust_rule_revoked",
      outcome: "success",
      reasonCode: "trust_rule_revoked",
      details: { policyId: existing.id, reason: input.body.reason ?? null },
    });
    await db.insert(toolCallEvents).values({
      companyId: input.companyId,
      eventType: "trust_rule_revoked",
      actorType: input.actor?.agentId ? "agent" : input.actor?.userId ? "user" : "system",
      actorId: input.actor?.agentId ?? input.actor?.userId ?? null,
      decision: "deny",
      matchedPolicyIds: [existing.id],
      reasonCode: "trust_rule_revoked",
      outcome: "success",
      metadata: { reason: input.body.reason ?? null },
    });
    return updated;
  }

  return {
    decide,
    writeAudit,
    recordInvocation,
    summarizeAndRedact,
    listPolicies,
    reorderPolicies,
    createPolicy,
    duplicatePolicy,
    updatePolicy,
    deletePolicy,
    createTrustRuleFromActionRequest,
    listTrustRules,
    revokeTrustRule,
    ensureNoDuplicatePolicyNameError: (error: unknown) => {
      if (error instanceof Error && /duplicate key value/.test(error.message)) {
        throw conflict("A tool policy with that name already exists");
      }
      throw error;
    },
  };
}
