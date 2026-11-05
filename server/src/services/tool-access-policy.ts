import type { ConnectionManagementContext } from "./connection-management.js";
import { createHash } from "node:crypto";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import type { ToolApprovalClaim } from "./tool-approval-execution.js";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
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
  toolMcpGateways,
  toolMcpGatewayTokens,
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
  ToolPolicyConditions,
  UpdateToolPolicy,
  ToolRateLimitRule,
  ToolRedactedValueSummary,
  ToolTrustRuleArgumentFilters,
  ToolRiskLevel,
} from "@paperclipai/shared";
import { toolPolicyConditionsSchema } from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import {
  effectiveToolProfileBindings,
  profileIdsInBindingOrder,
} from "./tool-profile-binding-precedence.js";
import { recordToolRuntimeAuditWriteFailure } from "./tool-runtime-metrics.js";
import { canonicalToolArguments, readSignedToolArgumentsPayload, toolRequestIdentityHash } from "./tool-content-guards.js";

class RejectedInvocationAdmission extends Error {
  constructor(readonly decision: ToolAccessDecision) {
    super(decision.explanation);
  }
}

type ToolAccessContext = {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  heartbeatRunId: string | null;
  issueId: string | null;
  projectId: string | null;
  routineId: string | null;
  gatewayId: string | null;
  applicationId: string | null;
  connectionId: string | null;
  catalogEntryId: string | null;
  catalogStatus: string | null;
  catalogVersionHash: string | null;
  catalogSchemaHash: string | null;
  providerType: string | null;
  applicationKey: string | null;
  upstreamToolName: string | null;
  toolName: string;
  riskLevel: ToolRiskLevel | null;
  argumentsHash: string;
  arguments: unknown;
};

type RedactionResult = {
  summary: ToolRedactedValueSummary;
  redactionPlan: { redactedFieldCount: number; redactedFields: string[] };
};

type PolicyConditionEvaluation = {
  matched: boolean;
  matchedGroups: string[];
  failedGroup?: string;
  reason?: string;
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

function nonBlankString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Reads one string field of a run's context snapshot in SQL. The snapshot can
 * hold hundreds of KB of task text, so a policy check never loads the whole
 * document. A non-string value reads as null. Runs store the snapshot as a
 * JSON object, which the run indexes on `context_snapshot ->> 'issueId'` also
 * expect.
 */
export function runContextSnapshotString(key: "issueId" | "projectId" | "routineId" | "wakeCommentId") {
  const field = sql.raw(`'${key}'`);
  return sql<string | null>`case when jsonb_typeof(${heartbeatRuns.contextSnapshot} -> ${field}) = 'string'
    then ${heartbeatRuns.contextSnapshot} ->> ${field} end`;
}

/**
 * Memo for one batch of `decide` calls that share a company, actor and run
 * context, such as one tools/list response. A listing decides every tool
 * against the same agent, run, profiles and policies, so the batch reads each
 * of those rows once instead of once per tool. The cache is a point-in-time
 * view: create one per batch and drop it with the request. Rate-limit counters
 * are never cached.
 */
export type ToolAccessDecisionCache = Map<string, Promise<unknown>>;

export function createToolAccessDecisionCache(): ToolAccessDecisionCache {
  return new Map();
}

function cachedRead<T>(
  cache: ToolAccessDecisionCache | undefined,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  if (!cache) return read();
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;
  const pending = read();
  cache.set(key, pending);
  // Do not keep a failed read, so a later call in the batch tries again.
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

// The database returns ids in this canonical form.
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const catalogEntryContextColumns = {
  id: toolCatalogEntries.id,
  companyId: toolCatalogEntries.companyId,
  connectionId: toolCatalogEntries.connectionId,
  applicationId: toolCatalogEntries.applicationId,
  riskLevel: toolCatalogEntries.riskLevel,
  toolName: toolCatalogEntries.toolName,
  status: toolCatalogEntries.status,
  versionHash: toolCatalogEntries.versionHash,
  schemaHash: toolCatalogEntries.schemaHash,
};

function stableStringify(value: unknown): string {
  if (!isRecord(value) && !Array.isArray(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

type ConsumedRateAdmission = { policyId: string; versionHash: string; bucketKey?: string };
function ratePolicyVersionHash(policy: typeof toolPolicies.$inferSelect): string {
  return sha256({ ...policy, createdAt: policy.createdAt.toISOString(), updatedAt: policy.updatedAt.toISOString() });
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
  if (filters.fieldNotEquals) {
    for (const [path, expected] of Object.entries(filters.fieldNotEquals)) {
      if (stableStringify(readPath(ctx.arguments, path)) === stableStringify(expected)) return false;
    }
  }
  if (filters.fieldIn) {
    for (const [path, allowedValues] of Object.entries(filters.fieldIn)) {
      const actual = stableStringify(readPath(ctx.arguments, path));
      if (!allowedValues.some((expected) => stableStringify(expected) === actual)) return false;
    }
  }
  if (filters.fieldMatches) {
    for (const [path, pattern] of Object.entries(filters.fieldMatches)) {
      const actual = readPath(ctx.arguments, path);
      if (typeof actual !== "string") return false;
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        return false;
      }
      if (!re.test(actual)) return false;
    }
  }
  if (filters.fieldExists?.some((path) => readPath(ctx.arguments, path) === undefined)) return false;
  if (filters.fieldAbsent?.some((path) => readPath(ctx.arguments, path) !== undefined)) return false;
  return Boolean(
    filters.exactHash
    || filters.allowedHashes?.length
    || filters.fieldEquals
    || filters.fieldNotEquals
    || filters.fieldIn
    || filters.fieldMatches
    || filters.fieldExists?.length
    || filters.fieldAbsent?.length,
  );
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

function sideEffectIdempotencyKey(ctx: ToolAccessContext, argumentsHash: string, version: 1 | 2 = 2): string {
  return `side_effect:${version === 2 ? "v2:" : ""}${sha256({
    ...(version === 2 ? { actorType: ctx.actorType, actorId: ctx.actorId, agentId: ctx.agentId } : {}),
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

function summarizeAndRedact(value: unknown, normalizeSensitiveKeys = true): RedactionResult {
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
      if (SENSITIVE_KEY_RE.test(normalizeSensitiveKeys ? key.replace(/([a-z0-9])([A-Z])/g, "$1_$2") : key)) {
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

function completeLegacyArguments(invocation: typeof toolInvocations.$inferSelect): { arguments: unknown } | null {
  const summary = invocation.argumentsSummary;
  if (!summary || summary.redactedFields?.length) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(summary.summary); } catch { return null; }
  // Historical previews did not record array truncation separately. At the
  // preview cap, even valid JSON cannot prove that no entries were omitted.
  const mayBeTruncated = (value: unknown): boolean => typeof value === "string"
    ? value.includes("...[truncated]")
    : Array.isArray(value) ? value.length >= 50 || value.some(mayBeTruncated)
      : isRecord(value) && Object.values(value).some(mayBeTruncated);
  return !mayBeTruncated(parsed) && sha256(parsed) === invocation.argumentsHash
    ? { arguments: parsed } : null;
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

function asToolRiskLevel(value: unknown): ToolRiskLevel | null {
  if (
    value === "low"
    || value === "medium"
    || value === "high"
    || value === "critical"
    || value === "read"
    || value === "write"
    || value === "destructive"
  ) {
    return value;
  }
  return null;
}

function selectorMatches(selector: ToolAccessSelector | Record<string, unknown> | null | undefined, ctx: ToolAccessContext): boolean {
  if (!selector || Object.keys(selector).length === 0) return true;
  const s = selector as Record<string, unknown>;
  // Tool/action names are exact selectors. Glob-looking values are treated as literal names.
  const match = (singleKey: string, pluralKey: string, actual: string | null) => {
    const single = typeof s[singleKey] === "string" ? String(s[singleKey]) : null;
    const many = listValues(s[pluralKey]);
    return (!single || actual === single) && (many.length === 0 || Boolean(actual && many.includes(actual)));
  };
  const matchAny = (singleKey: string, pluralKey: string, actuals: Array<string | null>) => {
    const values = actuals.filter((value): value is string => Boolean(value));
    const single = typeof s[singleKey] === "string" ? String(s[singleKey]) : null;
    const many = listValues(s[pluralKey]);
    return (!single || values.includes(single)) && (many.length === 0 || many.some((value) => values.includes(value)));
  };
  return (
    match("actorType", "actorTypes", ctx.actorType) &&
    match("agentId", "agentIds", ctx.agentId) &&
    match("projectId", "projectIds", ctx.projectId) &&
    match("routineId", "routineIds", ctx.routineId) &&
    match("issueId", "issueIds", ctx.issueId) &&
    match("gatewayId", "gatewayIds", ctx.gatewayId) &&
    match("applicationId", "applicationIds", ctx.applicationId) &&
    match("connectionId", "connectionIds", ctx.connectionId) &&
    match("catalogEntryId", "catalogEntryIds", ctx.catalogEntryId) &&
    match("applicationKey", "applicationKeys", ctx.applicationKey) &&
    match("providerType", "providerTypes", ctx.providerType) &&
    matchAny("toolName", "toolNames", [ctx.toolName, ctx.upstreamToolName]) &&
    match("riskLevel", "riskLevels", ctx.riskLevel)
  );
}

function conditionRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && Object.keys(value).length > 0 ? value : null;
}

function argumentConditionMatches(condition: Record<string, unknown>, ctx: ToolAccessContext): boolean {
  const filters: ToolTrustRuleArgumentFilters = {
    fieldEquals: conditionRecord(condition.fieldEquals) ?? undefined,
    fieldNotEquals: conditionRecord(condition.fieldNotEquals) ?? undefined,
    fieldIn: conditionRecord(condition.fieldIn) as Record<string, unknown[]> | undefined,
    fieldMatches: conditionRecord(condition.fieldMatches) as Record<string, string> | undefined,
    fieldExists: listValues(condition.fieldExists),
    fieldAbsent: listValues(condition.fieldAbsent),
  };
  return argumentFiltersMatch(filters, ctx);
}

function riskRank(value: ToolRiskLevel | null): number {
  if (value === "read" || value === "low") return 1;
  if (value === "write" || value === "medium") return 2;
  if (value === "destructive" || value === "high") return 3;
  if (value === "critical") return 4;
  return 0;
}

function boolCondition(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function timeWindowMatches(condition: Record<string, unknown>, now: Date): boolean {
  const startAt = isoDateOrNull(condition.startAt);
  const endAt = isoDateOrNull(condition.endAt);
  if (startAt && now.getTime() < new Date(startAt).getTime()) return false;
  if (endAt && now.getTime() > new Date(endAt).getTime()) return false;

  const days = Array.isArray(condition.daysOfWeekUtc)
    ? condition.daysOfWeekUtc.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)
    : [];
  if (days.length > 0 && !days.includes(now.getUTCDay())) return false;

  const startHour = typeof condition.startHourUtc === "number" ? condition.startHourUtc : null;
  const endHour = typeof condition.endHourUtc === "number" ? condition.endHourUtc : null;
  if (startHour !== null || endHour !== null) {
    const hour = now.getUTCHours();
    const start = startHour ?? 0;
    const end = endHour ?? 24;
    if (start === end) return false;
    if (start < end) {
      if (hour < start || hour >= end) return false;
    } else if (hour < start && hour >= end) {
      return false;
    }
  }
  return true;
}

function policyConditions(policy: typeof toolPolicies.$inferSelect): ToolPolicyConditions | null {
  return isRecord(policy.conditions) && Object.keys(policy.conditions).length > 0
    ? policy.conditions as ToolPolicyConditions
    : null;
}

function conditionGroupFail(group: string, reason: string): PolicyConditionEvaluation {
  return { matched: false, matchedGroups: [], failedGroup: group, reason };
}

function evaluatePolicyConditions(
  conditions: ToolPolicyConditions | null | undefined,
  ctx: ToolAccessContext,
  now = new Date(),
): PolicyConditionEvaluation {
  if (!conditions || Object.keys(conditions).length === 0) return { matched: true, matchedGroups: [] };
  const matchedGroups: string[] = [];

  const argumentCondition = conditionRecord(conditions.arguments ?? conditions.args);
  if (argumentCondition) {
    if (!argumentConditionMatches(argumentCondition, ctx)) {
      return conditionGroupFail("arguments", "Tool arguments did not satisfy the policy condition.");
    }
    matchedGroups.push("arguments");
  }

  if (conditions.actor) {
    if (!selectorMatches(conditions.actor, ctx)) {
      return conditionGroupFail("actor", "Actor did not satisfy the policy condition.");
    }
    matchedGroups.push("actor");
  }

  if (conditions.context) {
    const context = conditions.context as Record<string, unknown>;
    if (boolCondition(context.requireIssue) === true && !ctx.issueId) {
      return conditionGroupFail("context", "Policy condition requires issue context.");
    }
    if (boolCondition(context.requireProject) === true && !ctx.projectId) {
      return conditionGroupFail("context", "Policy condition requires project context.");
    }
    if (boolCondition(context.requireRoutine) === true && !ctx.routineId) {
      return conditionGroupFail("context", "Policy condition requires routine context.");
    }
    if (!selectorMatches(context, ctx)) {
      return conditionGroupFail("context", "Issue, project, or routine context did not satisfy the policy condition.");
    }
    matchedGroups.push("context");
  }

  if (conditions.risk) {
    const risk = conditions.risk as Record<string, unknown>;
    const levels = listValues(risk.levels).map(asToolRiskLevel).filter((level): level is ToolRiskLevel => Boolean(level));
    const max = asToolRiskLevel(risk.max);
    const isWrite = boolCondition(risk.isWrite);
    const isDestructive = boolCondition(risk.isDestructive);
    if (levels.length > 0 && (!ctx.riskLevel || !levels.includes(ctx.riskLevel))) {
      return conditionGroupFail("risk", "Tool risk level did not satisfy the policy condition.");
    }
    if (max && riskRank(ctx.riskLevel) > riskRank(max)) {
      return conditionGroupFail("risk", "Tool risk level is above the policy condition limit.");
    }
    if (isWrite !== null && ((ctx.riskLevel === "write" || ctx.riskLevel === "destructive" || ctx.riskLevel === "medium" || ctx.riskLevel === "high" || ctx.riskLevel === "critical") !== isWrite)) {
      return conditionGroupFail("risk", "Tool write capability did not satisfy the policy condition.");
    }
    if (isDestructive !== null && ((ctx.riskLevel === "destructive" || ctx.riskLevel === "high" || ctx.riskLevel === "critical") !== isDestructive)) {
      return conditionGroupFail("risk", "Tool destructive capability did not satisfy the policy condition.");
    }
    matchedGroups.push("risk");
  }

  if (conditions.credentialScope) {
    const scope = conditions.credentialScope as Record<string, unknown>;
    if (!selectorMatches(scope, ctx)) {
      return conditionGroupFail("credentialScope", "Credential scope did not satisfy the policy condition.");
    }
    if (!selectorMatches({
      applicationKey: scope.applicationKey,
      applicationKeys: scope.applicationKeys,
      providerType: scope.providerType,
      providerTypes: scope.providerTypes,
    }, ctx)) {
      return conditionGroupFail("credentialScope", "Credential provider did not satisfy the policy condition.");
    }
    matchedGroups.push("credentialScope");
  }

  if (conditions.trustBoundary) {
    const boundary = conditions.trustBoundary as Record<string, unknown>;
    if (!selectorMatches({
      applicationKey: boundary.applicationKey,
      applicationKeys: boundary.applicationKeys,
      providerType: boundary.providerType,
      providerTypes: boundary.providerTypes,
    }, ctx)) {
      return conditionGroupFail("trustBoundary", "Trust boundary did not satisfy the policy condition.");
    }
    if (boolCondition(boundary.remoteHttpOnly) === true && ctx.providerType !== "mcp_remote_http") {
      return conditionGroupFail("trustBoundary", "Policy condition requires a remote HTTP MCP tool.");
    }
    if (boolCondition(boundary.paperclipSelfOnly) === true && ctx.providerType !== "paperclip_self") {
      return conditionGroupFail("trustBoundary", "Policy condition requires a Paperclip self tool.");
    }
    matchedGroups.push("trustBoundary");
  }

  if (conditions.timeWindow) {
    if (!timeWindowMatches(conditions.timeWindow as Record<string, unknown>, now)) {
      return conditionGroupFail("timeWindow", "Current UTC time is outside the policy condition window.");
    }
    matchedGroups.push("timeWindow");
  }

  return { matched: true, matchedGroups };
}

function profileEntryMatches(entry: typeof toolProfileEntries.$inferSelect, ctx: ToolAccessContext): boolean {
  const selected = entry.selectorType === "application" ? entry.applicationId === ctx.applicationId
    : entry.selectorType === "connection" ? entry.connectionId === ctx.connectionId
    : entry.selectorType === "catalog_entry" ? entry.catalogEntryId === ctx.catalogEntryId
    : entry.selectorType === "tool_name" ? entry.toolName === ctx.toolName
    : entry.selectorType === "risk_level" ? entry.riskLevel === ctx.riskLevel : false;
  if (!selected) return false;
  const conditions = isRecord(entry.conditions) ? entry.conditions as ToolPolicyConditions : null;
  return evaluatePolicyConditions(conditions, ctx).matched;
}

function targetMatches(binding: typeof toolProfileBindings.$inferSelect, ctx: ToolAccessContext): boolean {
  if (binding.targetType === "company") return binding.targetId === ctx.companyId;
  if (binding.targetType === "agent") return binding.targetId === ctx.agentId;
  if (binding.targetType === "project") return binding.targetId === ctx.projectId;
  if (binding.targetType === "routine") return binding.targetId === ctx.routineId;
  if (binding.targetType === "issue") return binding.targetId === ctx.issueId;
  if (binding.targetType === "gateway") return binding.targetId === ctx.gatewayId;
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
  if (policyType === "redact" || policyType === "validate") {
    throw unprocessable(`Tool policy type '${policyType}' is not supported at runtime`);
  }
}

function isSafePolicyRegex(pattern: string): boolean {
  if (pattern.length > 256) return false;
  if (/\\[1-9]/.test(pattern)) return false;
  if (/(^|[^\\])\|/.test(pattern)) return false;
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) return false;
  return true;
}

function assertSupportedPolicyConditions(conditions: Record<string, unknown> | null | undefined) {
  if (!conditions || Object.keys(conditions).length === 0) return;
  const parsed = toolPolicyConditionsSchema.safeParse(conditions);
  if (!parsed.success) {
    throw unprocessable("Tool policy conditions include unsupported runtime semantics", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const fieldMatches = parsed.data.arguments?.fieldMatches;
  if (fieldMatches) {
    for (const pattern of Object.values(fieldMatches)) {
      if (!isSafePolicyRegex(pattern)) {
        throw unprocessable("Tool policy fieldMatches includes an unsafe regular expression");
      }
    }
  }
}

function unsupportedRuntimePolicyType(policyType: string) {
  return policyType === "redact" || policyType === "validate";
}

function hasConfig(config: Record<string, unknown> | null | undefined) {
  return Boolean(config && Object.keys(config).length > 0);
}

function assertSupportedGenericPolicyShape(
  policyType: string,
  conditions: Record<string, unknown> | null | undefined,
  config: Record<string, unknown> | null | undefined,
) {
  assertGenericPolicyType(policyType);
  assertSupportedPolicyConditions(conditions);
  if (policyType !== "rate_limit" && hasConfig(config)) {
    throw unprocessable(`Tool policy type '${policyType}' does not support config`);
  }
  if (policyType === "rate_limit") {
    const raw = isRecord(config?.rateLimit) ? config.rateLimit : config;
    const limit = isRecord(raw) && typeof raw.limit === "number" ? raw.limit : null;
    const windowSeconds = isRecord(raw) && typeof raw.windowSeconds === "number" ? raw.windowSeconds : null;
    if (!limit || !windowSeconds || limit <= 0 || windowSeconds <= 0) {
      throw unprocessable("Rate-limit policy config requires positive numeric limit and windowSeconds");
    }
  }
}

async function getGenericPolicyRow(db: Pick<Db, "select">, companyId: string, policyId: string) {
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
  if (scope === null || scope === undefined) return true;
  if (!isRecord(scope)) return false;
  if (Object.keys(scope).length === 0) return true;
  const { allow, ...selectors } = scope;
  if (Object.hasOwn(scope, "allow")) {
    const values = typeof allow === "string" ? [allow] : allow;
    if (!Array.isArray(values) || values.length === 0 ||
        !values.every((value) => typeof value === "string" && value.trim().length > 0)) return false;
    if (!values.includes(`tool:${ctx.toolName}`) &&
        !(ctx.upstreamToolName && values.includes(`tool:${ctx.upstreamToolName}`)) &&
        !(ctx.connectionId && values.includes(`connection:${ctx.connectionId}`)) &&
        !(ctx.applicationId && values.includes(`application:${ctx.applicationId}`))) return false;
  }
  // Grant restrictions must all be understood and match. The permissive policy
  // selector matcher cannot validate untrusted or historical grant JSON itself.
  const keys = new Set([
    "actorType", "agentId", "projectId", "routineId", "issueId", "gatewayId",
    "applicationId", "connectionId", "catalogEntryId", "applicationKey",
    "providerType", "toolName", "riskLevel",
  ]);
  for (const [key, value] of Object.entries(selectors)) {
    if (keys.has(key)) {
      if (typeof value !== "string" || value.trim().length === 0) return false;
    } else if (key.endsWith("s") && keys.has(key.slice(0, -1))) {
      if (!Array.isArray(value) || value.length === 0 ||
          !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) return false;
    } else return false;
  }
  return selectorMatches(selectors, ctx);
}

export function toolAccessPolicyService(db: Pick<Db, "select" | "insert" | "update" | "delete" | "transaction">, options: { toolActionSigningSecret?: string } = {}) {
  // Policy administration includes authorized self-targeted changes. It cannot
  // resolve governed action requests or modify principal permission grants.
  async function listPolicies(companyId: string) {
    return db
      .select()
      .from(toolPolicies)
      .where(and(eq(toolPolicies.companyId, companyId), ne(toolPolicies.policyType, "trust_rule")))
      .orderBy(asc(toolPolicies.priority), desc(toolPolicies.updatedAt));
  }

  async function reorderPolicies(companyId: string, body: ReorderToolPolicies, managementContext?: ConnectionManagementContext) {
    const uniquePolicyIds = [...new Set(body.policyIds)];
    if (uniquePolicyIds.length !== body.policyIds.length) {
      throw badRequest("policyIds must not contain duplicates");
    }

    await managementContext?.reauthorize();
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(toolPolicies)
        .where(and(
          eq(toolPolicies.companyId, companyId),
          ne(toolPolicies.policyType, "trust_rule"),
        ))
        .orderBy(toolPolicies.id)
        .for("no key update");
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
      await tx.execute(sql`UPDATE tool_policies
        SET priority = (requested.ordinality * 100)::integer, updated_at = ${now.toISOString()}
        FROM jsonb_array_elements_text(${JSON.stringify(uniquePolicyIds)}::jsonb)
          WITH ORDINALITY AS requested(id, ordinality)
        WHERE tool_policies.company_id = ${companyId} AND tool_policies.id = requested.id::uuid`);
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
    managementContext?: ConnectionManagementContext;
  }) {
    const existing = await getGenericPolicyRow(db, input.companyId, input.policyId);
    assertSupportedGenericPolicyShape(existing.policyType, existing.conditions ?? null, existing.config ?? null);
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
    await input.managementContext?.reauthorize();
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
    managementContext?: ConnectionManagementContext,
  ) {
    assertSupportedGenericPolicyShape(body.policyType, body.conditions ?? null, body.config ?? null);
    await managementContext?.reauthorize();
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
    managementContext?: ConnectionManagementContext;
  }) {
    const existing = await getGenericPolicyRow(db, input.companyId, input.policyId);
    const nextPolicyType = input.body.policyType ?? existing.policyType;
    const nextConditions = input.body.conditions !== undefined ? input.body.conditions ?? null : existing.conditions ?? null;
    const nextConfig = input.body.config !== undefined ? input.body.config ?? null : existing.config ?? null;
    assertSupportedGenericPolicyShape(nextPolicyType, nextConditions, nextConfig);
    await input.managementContext?.reauthorize();
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

  async function deletePolicy(input: { companyId: string; policyId: string; managementContext?: ConnectionManagementContext }) {
    const existing = await getGenericPolicyRow(db, input.companyId, input.policyId);
    await input.managementContext?.reauthorize();
    const [deleted] = await db
      .delete(toolPolicies)
      .where(eq(toolPolicies.id, existing.id))
      .returning();
    return deleted;
  }

  async function loadCatalogEntry(companyId: string, catalogEntryId: string, cache?: ToolAccessDecisionCache) {
    const readEntry = async () => {
      const [entry] = await db.select(catalogEntryContextColumns).from(toolCatalogEntries).where(eq(toolCatalogEntries.id, catalogEntryId));
      return entry && entry.companyId === companyId ? entry : null;
    };
    // Only a canonical id can use the in-memory lookup. Any other spelling
    // takes the direct query, so a cached and an uncached decision agree.
    if (!cache || !CANONICAL_UUID_RE.test(catalogEntryId)) return readEntry();
    // A listing decides the active catalog tools of the company, so a batch
    // reads those entries once and looks each one up in memory. Any other
    // entry takes the direct query.
    const entriesById = await cachedRead(cache, `active-catalog-tools:${companyId}`, async () => {
      const entries = await db
        .select(catalogEntryContextColumns)
        .from(toolCatalogEntries)
        .where(and(
          eq(toolCatalogEntries.companyId, companyId),
          eq(toolCatalogEntries.entryKind, "tool"),
          eq(toolCatalogEntries.status, "active"),
          isNull(toolCatalogEntries.quarantinedAt),
        ));
      return new Map(entries.map((entry) => [entry.id, entry]));
    });
    const entry = entriesById.get(catalogEntryId);
    if (!entry) return readEntry();
    return entry.companyId === companyId ? entry : null;
  }

  async function loadContext(input: ToolAccessDecisionInput, cache?: ToolAccessDecisionCache): Promise<
    | { ok: true; ctx: ToolAccessContext; redaction: RedactionResult }
    | { ok: false; decision: ToolAccessDecision; redaction: RedactionResult }
  > {
    const redaction = summarizeAndRedact(input.request.arguments ?? {});
    let agentId = input.actor.agentId ?? (input.actor.actorType === "agent" ? input.actor.actorId : null);
    let heartbeatRunId = input.runContext?.heartbeatRunId ?? null;
    let issueId = input.runContext?.issueId ?? null;
    let projectId = input.runContext?.projectId ?? null;
    let routineId = input.runContext?.routineId ?? null;
    const gatewayId = input.runContext?.gatewayId ?? null;

    if (input.actor.actorType === "agent") {
      const lookupAgentId = agentId ?? "";
      const [agent] = await cachedRead(cache, `agent:${input.companyId}:${lookupAgentId}`, async () =>
        db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, lookupAgentId), eq(agents.companyId, input.companyId))));
      if (!agent) {
        return { ok: false, redaction, decision: decision("deny", "deny_missing_agent", "Authenticated agent was not found in the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      agentId = agent.id;
    }

    const originatingAgentId = input.runContext?.originatingAgentId;
    if (originatingAgentId && (input.actor.actorType !== "agent" || input.actor.actorId !== originatingAgentId)) {
      return { ok: false, redaction, decision: decision("deny", "deny_run_context_mismatch", "Run origin does not match the authenticated actor.", [], [], { redactionPlan: redaction.redactionPlan }) };
    }
    if (heartbeatRunId) {
      const runId = heartbeatRunId;
      const [run] = await cachedRead(cache, `run:${runId}`, async () =>
        db
          .select({
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            issueId: boundRunIssueIdSql(),
            projectId: runContextSnapshotString("projectId"),
            routineId: runContextSnapshotString("routineId"),
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId)));
      if (!run || run.companyId !== input.companyId || (input.actor.actorType === "agent" && run.agentId !== (originatingAgentId ?? agentId))) {
        return { ok: false, redaction, decision: decision("deny", "deny_run_context_mismatch", "Supplied run context does not match the authenticated actor.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      agentId = originatingAgentId ? agentId : run.agentId;
      const runIssueId = nonBlankString(run.issueId);
      const runProjectId = nonBlankString(run.projectId);
      const runRoutineId = nonBlankString(run.routineId);
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
      const contextIssueId = issueId;
      const [issue] = await cachedRead(cache, `issue:${contextIssueId}`, async () =>
        db.select({ companyId: issues.companyId, projectId: issues.projectId }).from(issues).where(eq(issues.id, contextIssueId)));
      if (!issue || issue.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Issue context is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      if (projectId && projectId !== issue.projectId) {
        return { ok: false, redaction, decision: decision("deny", "deny_run_context_mismatch", "Project context does not match the issue context.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      projectId = projectId ?? issue.projectId;
    }
    if (projectId) {
      const contextProjectId = projectId;
      const [project] = await cachedRead(cache, `project:${contextProjectId}`, async () =>
        db.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, contextProjectId)));
      if (!project || project.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Project context is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
    }
    if (routineId) {
      const contextRoutineId = routineId;
      const [routine] = await cachedRead(cache, `routine:${contextRoutineId}`, async () =>
        db.select({ companyId: routines.companyId }).from(routines).where(eq(routines.id, contextRoutineId)));
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
    let providerType = typeof input.request.providerType === "string" ? input.request.providerType : null;
    let applicationKey = typeof input.request.applicationKey === "string" ? input.request.applicationKey : null;
    let upstreamToolName = typeof input.request.upstreamToolName === "string" ? input.request.upstreamToolName : null;
    let riskLevel = asToolRiskLevel(input.request.riskLevel);
    let connectionTransport: string | null = null;
    let applicationType: string | null = null;

    if (catalogEntryId) {
      const entry = await loadCatalogEntry(input.companyId, catalogEntryId, cache);
      if (!entry) {
        return { ok: false, redaction, decision: decision("deny", "deny_missing_tool", "Requested tool is not in the company catalog.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      connectionId = entry.connectionId;
      applicationId = entry.applicationId ?? applicationId;
      riskLevel = entry.riskLevel;
      upstreamToolName = upstreamToolName ?? entry.toolName;
      catalogStatus = entry.status;
      catalogVersionHash = entry.versionHash;
      catalogSchemaHash = entry.schemaHash;
    } else if (connectionId) {
      const entryConnectionId = connectionId;
      const [entry] = await cachedRead(cache, `catalog-entry-name:${input.companyId}:${entryConnectionId}:${input.request.toolName}`, async () =>
        db
          .select(catalogEntryContextColumns)
          .from(toolCatalogEntries)
          .where(and(eq(toolCatalogEntries.companyId, input.companyId), eq(toolCatalogEntries.connectionId, entryConnectionId), eq(toolCatalogEntries.name, input.request.toolName))));
      if (entry) {
        catalogEntryId = entry.id;
        applicationId = entry.applicationId ?? applicationId;
        riskLevel = entry.riskLevel;
        upstreamToolName = upstreamToolName ?? entry.toolName;
        catalogStatus = entry.status;
        catalogVersionHash = entry.versionHash;
        catalogSchemaHash = entry.schemaHash;
      }
    }

    if (connectionId) {
      const contextConnectionId = connectionId;
      const [connection] = await cachedRead(cache, `connection:${contextConnectionId}`, async () =>
        db
          .select({
            companyId: toolConnections.companyId,
            applicationId: toolConnections.applicationId,
            enabled: toolConnections.enabled,
            status: toolConnections.status,
            transport: toolConnections.transport,
          })
          .from(toolConnections)
          .where(eq(toolConnections.id, contextConnectionId)));
      if (!connection || connection.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Connection is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      if (!connection.enabled || connection.status === "disabled" || connection.status === "archived") {
        return { ok: false, redaction, decision: decision("deny", "deny_disabled_connection", "Connection is disabled.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      applicationId = connection.applicationId;
      connectionTransport = connection.transport;
    }
    if (applicationId) {
      const contextApplicationId = applicationId;
      const [application] = await cachedRead(cache, `application:${contextApplicationId}`, async () =>
        db
          .select({
            companyId: toolApplications.companyId,
            applicationKey: toolApplications.applicationKey,
            status: toolApplications.status,
            type: toolApplications.type,
          })
          .from(toolApplications)
          .where(eq(toolApplications.id, contextApplicationId)));
      if (!application || application.companyId !== input.companyId) {
        return { ok: false, redaction, decision: decision("deny", "deny_company_boundary", "Application is outside the company.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      if (application.status === "disabled") {
        return { ok: false, redaction, decision: decision("deny", "deny_disabled_application", "Application is disabled.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      if (application.status === "archived") {
        return { ok: false, redaction, decision: decision("deny", "deny_archived_application", "Application is archived.", [], [], { redactionPlan: redaction.redactionPlan }) };
      }
      applicationKey = applicationKey ?? application.applicationKey;
      applicationType = application.type;
    }
    providerType = providerType
      ?? (applicationType === "mcp_http" && connectionTransport === "mcp_remote"
        ? "mcp_remote_http"
        : applicationType === "mcp_stdio" && connectionTransport === "local_stdio"
        ? "mcp_local_stdio"
        : null);

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
        gatewayId,
        applicationId,
        connectionId,
        catalogEntryId,
        catalogStatus,
        catalogVersionHash,
        catalogSchemaHash,
        providerType,
        applicationKey,
        upstreamToolName,
        toolName: input.request.toolName,
        riskLevel,
        argumentsHash: input.request.sideEffecting
          ? toolRequestIdentityHash(input.request.arguments, options.toolActionSigningSecret)
          : redaction.summary.sha256 ?? sha256(input.request.arguments ?? {}),
        arguments: input.request.arguments ?? {},
      },
    };
  }

  async function effectiveProfiles(ctx: ToolAccessContext, cache?: ToolAccessDecisionCache) {
    const bindings = await cachedRead(cache, `profile-bindings:${ctx.companyId}`, async () =>
      db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, ctx.companyId)));
    const matchingBindings = bindings.filter((binding) => targetMatches(binding, ctx));
    if (matchingBindings.length === 0) return { profiles: [], entries: [] as Array<typeof toolProfileEntries.$inferSelect> };
    const candidateProfileIds = profileIdsInBindingOrder(matchingBindings);
    const candidateProfiles = await cachedRead(cache, `profiles:${ctx.companyId}:${[...candidateProfileIds].sort().join(",")}`, async () =>
      db.select().from(toolProfiles).where(and(
        eq(toolProfiles.companyId, ctx.companyId),
        inArray(toolProfiles.id, candidateProfileIds),
      )));
    const gatewayId = ctx.gatewayId;
    const [gateway] = gatewayId
      ? await cachedRead(cache, `gateway-profile-mode:${ctx.companyId}:${gatewayId}`, async () =>
          db
            .select({ defaultProfileMode: toolMcpGateways.defaultProfileMode })
            .from(toolMcpGateways)
            .where(and(
              eq(toolMcpGateways.companyId, ctx.companyId),
              eq(toolMcpGateways.id, gatewayId),
            ))
            .limit(1))
      : [];
    const activeBindings = effectiveToolProfileBindings(
      matchingBindings,
      candidateProfiles,
      ctx.connectionId,
      { includeAdditiveAppProfiles: gateway?.defaultProfileMode !== "gateway_only" },
    );
    const profileIds = profileIdsInBindingOrder(activeBindings);
    const profilesById = new Map(candidateProfiles.map((profile) => [profile.id, profile]));
    const activeProfiles = profileIds
      .map((profileId) => profilesById.get(profileId) ?? null)
      .filter((profile): profile is typeof toolProfiles.$inferSelect => Boolean(profile && profile.status === "active"));
    const activeProfileIds = activeProfiles.map((profile) => profile.id);
    // The active profile set depends on the connection (additive app profiles),
    // so a batch reads the entries once per distinct set.
    const entries = activeProfileIds.length > 0
      ? await cachedRead(cache, `profile-entries:${ctx.companyId}:${[...activeProfileIds].sort().join(",")}`, async () =>
          db.select().from(toolProfileEntries).where(and(eq(toolProfileEntries.companyId, ctx.companyId), inArray(toolProfileEntries.profileId, activeProfileIds))))
      : [];
    return { profiles: activeProfiles, entries };
  }

  async function explicitGrant(ctx: ToolAccessContext, cache?: ToolAccessDecisionCache): Promise<boolean> {
    const principalType = ctx.actorType === "agent" ? "agent" : ctx.actorType === "user" ? "user" : null;
    const principalId = ctx.actorType === "agent" ? ctx.agentId : ctx.actorId;
    if (!principalType || !principalId) return false;
    const grants = await cachedRead(cache, `tool-grants:${ctx.companyId}:${principalType}:${principalId}`, async () =>
      db
        .select()
        .from(principalPermissionGrants)
        .where(and(
          eq(principalPermissionGrants.companyId, ctx.companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, "tools:use"),
        )));
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
    const counterWhere = and(
      eq(toolRateLimitCounters.companyId, ctx.companyId),
      eq(toolRateLimitCounters.policyId, policy.id),
      eq(toolRateLimitCounters.counterKey, bucketKey),
      eq(toolRateLimitCounters.windowKind, kind),
      eq(toolRateLimitCounters.windowStartAt, start),
    );
    if (!consume) {
      const [existing] = await db.select().from(toolRateLimitCounters).where(counterWhere);
      const count = existing ? Math.max(0, existing.limit - existing.remaining) : 0;
      return { limited: count >= rule.limit, count, limit: rule.limit, windowSeconds: rule.windowSeconds, bucketKey };
    }

    const [counter] = await db
      .insert(toolRateLimitCounters)
      .values({
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
      })
      .onConflictDoUpdate({
        target: [
          toolRateLimitCounters.companyId,
          toolRateLimitCounters.policyId,
          toolRateLimitCounters.counterKey,
          toolRateLimitCounters.windowKind,
          toolRateLimitCounters.windowStartAt,
        ],
        set: {
          limit: rule.limit,
          // Preserve the number already spent when an operator changes the limit.
          remaining: sql`greatest(0, ${rule.limit} - (${toolRateLimitCounters.limit} - ${toolRateLimitCounters.remaining}) - 1)`,
          resetAt,
          updatedAt: now,
        },
        setWhere: sql`${toolRateLimitCounters.limit} - ${toolRateLimitCounters.remaining} < ${rule.limit}`,
      })
      .returning({ remaining: toolRateLimitCounters.remaining });
    if (!counter) {
      return { limited: true, count: rule.limit, limit: rule.limit, windowSeconds: rule.windowSeconds, bucketKey };
    }
    return {
      limited: false,
      count: Math.max(0, rule.limit - counter.remaining),
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
      bucketKey,
    };
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

  async function admittedRateLimitAdmissions(ctx: ToolAccessContext, invocationId: string, previewHash?: string): Promise<ConsumedRateAdmission[] | null> {
    const [invocation] = await db.select({
      actorType: toolInvocations.actorType, actorId: toolInvocations.actorId, agentId: toolInvocations.agentId,
      runId: toolInvocations.runId, issueId: toolInvocations.issueId, gatewayId: toolInvocations.gatewayId,
      applicationId: toolInvocations.applicationId, connectionId: toolInvocations.connectionId,
      catalogEntryId: toolInvocations.catalogEntryId, toolName: toolInvocations.toolName,
      providerType: toolInvocations.providerType, applicationKey: toolInvocations.applicationKey,
      upstreamToolName: toolInvocations.upstreamToolName, argumentsHash: toolInvocations.argumentsHash,
      status: toolInvocations.status, policyDecision: toolInvocations.policyDecision, approvalState: toolInvocations.approvalState,
      policyExplanation: toolInvocations.policyExplanation,
    }).from(toolInvocations).where(and(eq(toolInvocations.companyId, ctx.companyId), eq(toolInvocations.id, invocationId)));
    // A parked request already spent its slot before asking for review. Reusing
    // that admission only skips the same rate rule; current policy and the
    // gateway's approval/claim owners still decide whether it may execute.
    const delegated = invocation?.policyExplanation?.delegatedConnectionTest as { agentId?: string } | undefined;
    const gatewayIssuer = invocation?.gatewayId ? invocation.policyExplanation?.delegatedGatewayIssuer : undefined;
    const isDelegatedCaller = invocation?.actorType === "agent" && invocation.actorId === ctx.agentId
      && (delegated?.agentId === ctx.agentId || gatewayIssuer === ctx.agentId) && invocation.agentId !== ctx.agentId;
    const authorized = invocation && (
      (invocation.status === "executing" && (invocation.policyDecision === "allow" || (invocation.policyDecision === "require_approval" && invocation.approvalState === "approved")))
      || (invocation.status === "awaiting_approval" && invocation.policyDecision === "require_approval" && ["pending", "approved"].includes(invocation.approvalState))
    )
      && invocation.actorType === ctx.actorType && invocation.actorId === ctx.actorId && (invocation.agentId === ctx.agentId || isDelegatedCaller)
      && invocation.runId === ctx.heartbeatRunId && invocation.issueId === ctx.issueId && invocation.gatewayId === ctx.gatewayId
      && invocation.applicationId === ctx.applicationId && invocation.connectionId === ctx.connectionId
      && invocation.catalogEntryId === ctx.catalogEntryId && invocation.toolName === ctx.toolName
      && invocation.providerType === ctx.providerType && invocation.applicationKey === ctx.applicationKey
      && invocation.upstreamToolName === ctx.upstreamToolName
      && (invocation.argumentsHash === ctx.argumentsHash || invocation.argumentsHash === previewHash);
    if (!authorized) return null;
    const stored = invocation.policyExplanation?.[isDelegatedCaller ? "delegatedCallerConsumedRateAdmissions" : "consumedRateAdmissions"];
    return Array.isArray(stored) ? stored.filter((item): item is ConsumedRateAdmission => isRecord(item)
      && typeof item.policyId === "string" && CANONICAL_UUID_RE.test(item.policyId)
      && typeof item.versionHash === "string" && /^[a-f0-9]{64}$/.test(item.versionHash)) : [];
  }

  /** Revalidate claimed work and persist new rate charges before provider dispatch. */
  async function admitInvocation(
    input: ToolAccessDecisionInput,
    invocationId: string,
    claim?: ToolApprovalClaim,
    evaluate?: (
      policy: Pick<ReturnType<typeof toolAccessPolicyService>, "decide" | "writeAudit">,
      input: ToolAccessDecisionInput,
      transaction: Db,
    ) => Promise<ToolAccessDecision>,
  ): Promise<ToolAccessDecision> {
    try {
      return await db.transaction(async tx => {
        const [invocation] = await tx.select().from(toolInvocations)
          .where(and(eq(toolInvocations.companyId, input.companyId), eq(toolInvocations.id, invocationId)))
          .for("update");
        // Historical reviewed requests can still have a pending invocation.
        // Accept that state only with the exact executing claim owned by the
        // gateway, locked in the same invocation-then-request order as dispatch.
        let ownsClaim = false;
        if (claim && claim.invocationId === invocationId) {
          const [request] = await tx.select().from(toolActionRequests).where(and(
            eq(toolActionRequests.id, claim.actionRequestId),
            eq(toolActionRequests.invocationId, invocationId),
            eq(toolActionRequests.companyId, input.companyId),
          )).for("update");
          ownsClaim = request?.status === "executing" && request.updatedAt.getTime() === claim.claimedAt.getTime();
        }
        if (!invocation || (claim && !ownsClaim)
          || !(invocation.status === "executing" && invocation.policyDecision === "allow"
            || ["awaiting_approval", "executing"].includes(invocation.status)
              && invocation.policyDecision === "require_approval" && invocation.approvalState === "approved"
            || invocation.status === "awaiting_approval" && invocation.policyDecision === "require_approval"
              && invocation.approvalState === "pending" && ownsClaim)) {
          return decision("deny", "deny_policy_block", "Tool invocation admission is unavailable.", [], []);
        }
        const admissionPolicy = toolAccessPolicyService(tx, options);
        const admissionInput = { ...input, consumeRateLimit: true };
        // Composed caller/target policy must share this claim transaction so
        // either all new charges and receipts commit or all roll back.
        const result = evaluate
          ? await evaluate(admissionPolicy, admissionInput, tx as unknown as Db)
          : await admissionPolicy.decide(admissionInput, { admittedInvocationId: invocationId });
        if (!result.allowed && result.decision !== "require_approval") {
          // A later policy can reject after an earlier rate rule spent a slot.
          // Roll back both the new charges and their receipt on any rejection.
          throw new RejectedInvocationAdmission(result);
        }
        const admissions = result.policyExplanation?.consumedRateAdmissions;
        const delegatedAdmissions = result.policyExplanation?.delegatedCallerConsumedRateAdmissions;
        if (Array.isArray(admissions) || Array.isArray(delegatedAdmissions)) {
          await tx.update(toolInvocations).set({
            policyExplanation: {
              ...invocation.policyExplanation,
              ...(Array.isArray(admissions) ? { consumedRateAdmissions: admissions } : {}),
              ...(Array.isArray(delegatedAdmissions) ? { delegatedCallerConsumedRateAdmissions: delegatedAdmissions } : {}),
            },
          }).where(and(eq(toolInvocations.companyId, input.companyId), eq(toolInvocations.id, invocationId)));
        }
        return result;
      });
    } catch (error) {
      if (error instanceof RejectedInvocationAdmission) return error.decision;
      throw error;
    }
  }

  /**
   * Decides one tool access request. Pass the same `cache` to every call of a
   * batch that shares one actor and run context (for example, one tools/list
   * response) so the batch reads the shared policy inputs once.
   */
  async function decide(
    input: ToolAccessDecisionInput,
    options: { cache?: ToolAccessDecisionCache; admittedInvocationId?: string; admittedPreviewHash?: string; sharedRateDecision?: ToolAccessDecision } = {},
  ): Promise<ToolAccessDecision> {
    const consumedRateAdmissions: ConsumedRateAdmission[] = [];
    const result = await decideInternal(input, options, consumedRateAdmissions);
    return consumedRateAdmissions.length ? { ...result,
      policyExplanation: { ...result.policyExplanation, consumedRateAdmissions },
    } : result;
  }

  async function decideInternal(
    input: ToolAccessDecisionInput,
    options: { cache?: ToolAccessDecisionCache; admittedInvocationId?: string; admittedPreviewHash?: string; sharedRateDecision?: ToolAccessDecision },
    consumedRateAdmissions: ConsumedRateAdmission[],
  ): Promise<ToolAccessDecision> {
    // A decision that consumes a rate limit can also record a trust-rule hit
    // from the policy row, so it always reads fresh rows.
    const cache = input.consumeRateLimit === true || options.admittedInvocationId ? undefined : options.cache;
    const loaded = await loadContext(input, cache);
    if (!loaded.ok) return loaded.decision;
    const { ctx, redaction } = loaded;
    // A final handoff rechecks current permissions for work already admitted by
    // the gateway. Its own last consumed slot cannot reject that same work.
    // Only durable consumption of an unchanged rule retains that slot; new or
    // edited rules still apply. admitInvocation owns atomic consuming rechecks;
    // ordinary preflight and browser handoff callers remain read-only.
    const admittedRates = options.admittedInvocationId
      ? await admittedRateLimitAdmissions(ctx, options.admittedInvocationId, input.consumeRateLimit === true ? undefined : options.admittedPreviewHash) : [];
    if (options.admittedInvocationId && input.consumeRateLimit === true && admittedRates === null) {
      return decision("deny", "deny_policy_block", "Tool invocation no longer matches this admission.", [], []);
    }
    if (input.consumeRateLimit === true) consumedRateAdmissions.push(...(admittedRates ?? []));
    const profileState = await effectiveProfiles(ctx, cache);
    const effectiveProfileIds = profileState.profiles.map((profile) => profile.id);
    const permittedByProfile = profileState.profiles.some((profile) => {
      const matchingEntries = profileState.entries.filter((entry) => entry.profileId === profile.id && profileEntryMatches(entry, ctx));
      return !matchingEntries.some((entry) => entry.effect === "exclude")
        && (profile.defaultAction === "allow" || matchingEntries.some((entry) => entry.effect === "include"));
    });
    const policies = await cachedRead(cache, `enabled-policies:${ctx.companyId}`, async () =>
      db.select().from(toolPolicies).where(and(eq(toolPolicies.companyId, ctx.companyId), eq(toolPolicies.enabled, true))).orderBy(asc(toolPolicies.priority), asc(toolPolicies.createdAt)));
    for (const policy of policies) {
      const conditions = policyConditions(policy);
      if (conditions && selectorMatches(policy.selectors, ctx)) {
        const parsed = toolPolicyConditionsSchema.safeParse(conditions);
        if (!parsed.success) {
          return decision(
            "deny",
            "deny_policy_block",
            "Tool access denied because a matching policy uses unsupported runtime conditions.",
            effectiveProfileIds,
            [policy.id],
            {
              redactionPlan: redaction.redactionPlan,
              policyExplanation: {
                policyId: policy.id,
                policyType: policy.policyType,
                selectorMatched: true,
                conditionsError: parsed.error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  message: issue.message,
                })),
              },
            },
          );
        }
      }
    }
    const matchingPolicies = policies
      .map((policy) => ({ policy, conditionEvaluation: evaluatePolicyConditions(policyConditions(policy), ctx) }))
      .filter(({ policy, conditionEvaluation }) => selectorMatches(policy.selectors, ctx) && conditionEvaluation.matched);
    const explicitBlock = matchingPolicies.find(({ policy }) => policy.policyType === "block");
    for (const { policy, conditionEvaluation } of matchingPolicies) {
      const policyExplanation = {
        policyId: policy.id,
        policyType: policy.policyType,
        selectorMatched: true,
        conditionsMatched: conditionEvaluation.matchedGroups,
      };
      if (unsupportedRuntimePolicyType(policy.policyType)) {
        return decision(
          "deny",
          "deny_policy_block",
          "Tool access denied because a matching policy uses unsupported runtime semantics.",
          effectiveProfileIds,
          [policy.id],
          { redactionPlan: redaction.redactionPlan, policyExplanation },
        );
      }
      if (policy.policyType === "block") {
        return decision("deny", "deny_policy_block", policy.description ?? "Tool access is blocked by policy.", effectiveProfileIds, [policy.id], { redactionPlan: redaction.redactionPlan, policyExplanation });
      }
      if (policy.policyType === "rate_limit") {
        if (!rateLimitRule(policy)) {
          return decision(
            "deny",
            "deny_policy_block",
            "Tool access denied because a matching rate-limit policy has invalid runtime config.",
            effectiveProfileIds,
            [policy.id],
            { redactionPlan: redaction.redactionPlan, policyExplanation },
          );
        }
        const versionHash = ratePolicyVersionHash(policy);
        if (admittedRates?.some(admission => admission.policyId === policy.id && admission.versionHash === versionHash)) continue;
        // Paired caller/target checks for one delegated test share a slot only
        // when the exact policy version and counter bucket are identical.
        const shared = options.sharedRateDecision?.policyExplanation?.consumedRateAdmissions;
        const bucketKey = `${policy.id}:${rateBucket(rateLimitRule(policy)!, ctx)}`;
        if (input.consumeRateLimit === true && Array.isArray(shared) && shared.some(item => isRecord(item)
          && item.policyId === policy.id && item.versionHash === versionHash && item.bucketKey === bucketKey)) {
          consumedRateAdmissions.push({ policyId: policy.id, versionHash, bucketKey });
          continue;
        }
        const state = await enforceRateLimit(policy, ctx, input.consumeRateLimit === true);
        if (state?.limited) {
          return decision("rate_limited", "rate_limited", "Tool access rate limit exceeded.", effectiveProfileIds, [policy.id], { rateLimitState: state, redactionPlan: redaction.redactionPlan, policyExplanation });
        }
        if (state && input.consumeRateLimit === true) consumedRateAdmissions.push({ policyId: policy.id, versionHash, bucketKey: state.bucketKey });
        continue;
      }
      if (policy.policyType === "trust_rule") {
        const rule = trustRuleConfig(policy);
        if (!rule || !trustRuleIsActive(policy)) continue;
        if (!argumentFiltersMatch(rule.argumentFilters, ctx)) continue;
        // Remembered permissions cannot override an explicit block. Preserve
        // priority semantics for ordinary allow/require-approval policies.
        if (explicitBlock) return decision("deny", "deny_policy_block", explicitBlock.policy.description ?? "Tool access is blocked by policy.", effectiveProfileIds, [explicitBlock.policy.id], { redactionPlan: redaction.redactionPlan });

        if (trustRuleNeedsReview(policy, ctx)) {
          return decision(
            "require_approval",
            "requires_review_changed_tool",
            "Tool definition changed or was quarantined after this trust rule was created; review is required.",
            effectiveProfileIds,
            [policy.id],
            { redactionPlan: redaction.redactionPlan, policyExplanation },
          );
        }
        if (input.consumeRateLimit === true && !options.admittedInvocationId) {
          await recordTrustRuleHit(policy, ctx, redaction);
        }
        return decision("allow", "allow_trust_rule", policy.description ?? "Tool access allowed by trust rule.", effectiveProfileIds, [policy.id], { redactionPlan: redaction.redactionPlan, policyExplanation });
      }
      if (policy.policyType === "require_approval") {
        // The connection's Ask first control restricts an existing action grant;
        // it must never grant access to agents outside that connection's profile.
        if (["app_gallery_finish", "connection_intent"].includes(String(policy.config?.source)) && !permittedByProfile) continue;
        if (policy.config?.source === "connection_intent" && explicitBlock) {
          return decision("deny", "deny_policy_block", explicitBlock.policy.description ?? "Tool access is blocked by policy.", effectiveProfileIds, [explicitBlock.policy.id], { redactionPlan: redaction.redactionPlan });
        }
        return decision("require_approval", "requires_approval_policy", policy.description ?? "Tool access requires approval.", effectiveProfileIds, [policy.id], { redactionPlan: redaction.redactionPlan, policyExplanation });
      }
      if (policy.policyType === "allow") {
        return decision("allow", "allow_policy", "Tool access allowed by policy.", effectiveProfileIds, [policy.id], { redactionPlan: redaction.redactionPlan, policyExplanation });
      }
    }
    if (await explicitGrant(ctx, cache)) {
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
      gatewayId: input.runContext?.gatewayId ?? null,
      runId: input.runContext?.heartbeatRunId ?? null,
      connectionId: input.request.connectionId ?? null,
      catalogEntryId: input.request.catalogEntryId ?? null,
      applicationId: input.request.applicationId ?? null,
      providerType: input.request.providerType ?? null,
      applicationKey: input.request.applicationKey ?? null,
      upstreamToolName: input.request.upstreamToolName ?? null,
      toolName: input.request.toolName,
      riskLevel: input.request.riskLevel ?? null,
    };
    const runId = "runId" in ctx ? ctx.runId : ctx.heartbeatRunId;
    try {
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
          applicationKey: ctx.applicationKey,
          providerType: ctx.providerType,
          upstreamToolName: ctx.upstreamToolName,
          agentId: ctx.agentId,
          issueId: ctx.issueId,
          runId,
          toolName: ctx.toolName,
          riskLevel: ctx.riskLevel,
          argumentsSummary: redaction.summary,
          redactionPlan: redaction.redactionPlan,
          policyExplanation: accessDecision.policyExplanation ?? null,
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
          policyExplanation: accessDecision.policyExplanation ?? null,
          providerType: ctx.providerType,
          applicationKey: ctx.applicationKey,
          upstreamToolName: ctx.upstreamToolName,
          riskLevel: ctx.riskLevel,
        },
      }).returning();
      return { legacyAuditEvent, toolCallEvent };
    } catch (error) {
      await recordToolRuntimeAuditWriteFailure(db, input.companyId);
      throw error;
    }
  }

  async function recordInvocation(input: ToolAccessDecisionInput, accessDecision: ToolAccessDecision) {
    const loaded = await loadContext(input);
    if (!loaded.ok) throw new Error("Cannot record invocation for invalid tool access context");
    const { ctx, redaction } = loaded;
    const requestIdentityHash = input.request.sideEffecting || accessDecision.decision === "require_approval"
      ? toolRequestIdentityHash(input.request.arguments, options.toolActionSigningSecret)
      : null;
    const argumentsHash = input.request.sideEffecting ? requestIdentityHash! : ctx.argumentsHash;
    const idempotencyKey = input.request.idempotencyKey
      ?? (input.request.sideEffecting ? sideEffectIdempotencyKey(ctx, requestIdentityHash!) : null);
    if (idempotencyKey) {
      const [existing] = await db.select().from(toolInvocations).where(and(
        eq(toolInvocations.companyId, input.companyId),
        eq(toolInvocations.idempotencyKey, idempotencyKey),
      ));
      if (existing) return { invocation: existing, replayed: true, actionRequest: null };
    }
    if (input.request.sideEffecting && input.request.idempotencyKey == null) {
      // Before complete request identities, default keys used shortened and
      // redacted preview hashes. Check both historical key-redaction variants
      // so upgrading cannot silently repeat a completed or uncertain write.
      const legacyKeys = [...new Set([
        requestIdentityHash!,
        redaction.summary.sha256!,
        summarizeAndRedact(input.request.arguments, false).summary.sha256!,
      ].map(hash => sideEffectIdempotencyKey(ctx, hash, 1)))];
      const legacyInvocations = legacyKeys.length ? await db.select().from(toolInvocations).where(and(
        eq(toolInvocations.companyId, input.companyId),
        inArray(toolInvocations.idempotencyKey, legacyKeys),
      )) : [];
      for (const legacy of legacyInvocations) {
        if (legacy.actorType !== ctx.actorType || legacy.actorId !== ctx.actorId || legacy.agentId !== ctx.agentId) {
          throw conflict("An earlier operation belongs to another actor. Reconcile it before retrying; use a new explicit idempotency key only for an intentional new operation.",
            { reasonCode: "legacy_tool_idempotency_unverifiable" });
        }
        // An interim complete-identity row may still have the old key prefix.
        // Its digest covers the full request when it differs from its preview.
        if (legacy.argumentsSummary?.sha256 && legacy.argumentsHash === requestIdentityHash
            && legacy.argumentsHash !== legacy.argumentsSummary.sha256) {
          return { invocation: legacy, replayed: true, actionRequest: null };
        }
        const [actionRequest] = await db.select({ signedArguments: toolActionRequests.signedArguments })
          .from(toolActionRequests).where(and(eq(toolActionRequests.companyId, input.companyId),
            eq(toolActionRequests.invocationId, legacy.id))).limit(1);
        const original = actionRequest?.signedArguments
          ? readSignedToolArgumentsPayload({ signedArguments: actionRequest.signedArguments,
            invocationId: legacy.id, toolName: legacy.toolName, signingSecret: options.toolActionSigningSecret })
          : completeLegacyArguments(legacy);
        if (!original) throw conflict(
          "An earlier operation has incomplete saved arguments. Reconcile its result before retrying; use a new explicit idempotency key only for an intentional new operation.",
          { reasonCode: "legacy_tool_idempotency_unverifiable", invocationId: legacy.id },
        );
        if (canonicalToolArguments(original.arguments) === canonicalToolArguments(input.request.arguments)) {
          return { invocation: legacy, replayed: true, actionRequest: null };
        }
      }
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
      gatewayId: ctx.gatewayId,
      ...(input.runContext?.gatewayTokenId ? { gatewayTokenId: sql`(select ${toolMcpGatewayTokens.id} from ${toolMcpGatewayTokens}
        where ${toolMcpGatewayTokens.id} = ${input.runContext.gatewayTokenId} and ${toolMcpGatewayTokens.companyId} = ${ctx.companyId}
          and ${toolMcpGatewayTokens.gatewayId} = ${ctx.gatewayId})` } : {}),
      applicationId: ctx.applicationId,
      connectionId: ctx.connectionId,
      catalogEntryId: ctx.catalogEntryId,
      catalogVersionHash: ctx.catalogVersionHash,
      catalogSchemaHash: ctx.catalogSchemaHash,
      providerType: ctx.providerType,
      applicationKey: ctx.applicationKey,
      upstreamToolName: ctx.upstreamToolName,
      riskLevel: ctx.riskLevel,
      toolName: ctx.toolName,
      argumentsHash,
      argumentsSummary: redaction.summary,
      policyDecision: accessDecision.decision,
      policyExplanation: accessDecision.policyExplanation ?? null,
      matchedPolicyIds: accessDecision.matchedPolicyIds,
      approvalState: accessDecision.decision === "require_approval" ? "pending" : "not_required",
      status,
      errorCode: accessDecision.allowed || accessDecision.decision === "require_approval" ? null : accessDecision.reasonCode,
      errorMessage: accessDecision.allowed || accessDecision.decision === "require_approval" ? null : accessDecision.explanation,
      completedAt: accessDecision.allowed || accessDecision.decision === "require_approval" ? null : new Date(),
    }).returning();
    let actionRequest = null;
    if (accessDecision.decision === "require_approval") {
      [actionRequest] = await db.insert(toolActionRequests).values({
        companyId: ctx.companyId,
        invocationId: invocation.id,
        issueId: ctx.issueId,
        status: "pending",
        canonicalArgumentsHash: requestIdentityHash!,
        canonicalArgumentsSummary: redaction.summary,
        requestedByAgentId: ctx.actorType === "agent" ? ctx.actorId : null,
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
        gatewayId: null,
        applicationId: invocation.applicationId,
        connectionId: invocation.connectionId,
        catalogEntryId: invocation.catalogEntryId,
        catalogStatus: null,
        catalogVersionHash: invocation.catalogVersionHash,
        catalogSchemaHash: invocation.catalogSchemaHash,
        providerType: invocation.providerType,
        applicationKey: invocation.applicationKey,
        upstreamToolName: invocation.upstreamToolName,
        toolName: invocation.toolName,
        riskLevel: invocation.riskLevel,
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

  const REQUIRED_REVIEWED_TRUST_RULE_SELECTOR_KEYS = [
    "agentId",
    "projectId",
    "applicationId",
    "connectionId",
    "toolName",
  ] as const;

  const OPTIONAL_REVIEWED_TRUST_RULE_SELECTOR_KEYS = ["issueId", "catalogEntryId"] as const;

  function reviewedTrustRuleSelectorValues(input: {
    invocation: typeof toolInvocations.$inferSelect;
    issueProjectId: string | null;
  }): Record<string, string> {
    const reviewed: Record<string, string> = {};
    if (input.invocation.agentId) reviewed.agentId = input.invocation.agentId;
    if (input.issueProjectId) reviewed.projectId = input.issueProjectId;
    if (input.invocation.applicationId) reviewed.applicationId = input.invocation.applicationId;
    if (input.invocation.connectionId) reviewed.connectionId = input.invocation.connectionId;
    if (input.invocation.toolName) reviewed.toolName = input.invocation.toolName;
    if (input.invocation.issueId) reviewed.issueId = input.invocation.issueId;
    if (input.invocation.catalogEntryId) reviewed.catalogEntryId = input.invocation.catalogEntryId;
    return reviewed;
  }

  function exactReviewedTrustRuleFilters(invocation: typeof toolInvocations.$inferSelect): ToolTrustRuleArgumentFilters {
    if (!invocation.argumentsHash) {
      throw unprocessable("Trust rule promotion requires an exact reviewed argument hash on the source action request");
    }
    return { exactHash: invocation.argumentsHash };
  }

  function assertReviewedTrustRuleSelectors(selectors: Record<string, unknown>, reviewed: Record<string, string>) {
    const allowedKeys = new Set<string>([
      ...REQUIRED_REVIEWED_TRUST_RULE_SELECTOR_KEYS,
      ...OPTIONAL_REVIEWED_TRUST_RULE_SELECTOR_KEYS,
    ]);
    for (const [key, value] of Object.entries(selectors)) {
      if (!allowedKeys.has(key)) {
        throw unprocessable(
          `Trust rule promotion only supports the reviewed actor/tool scope. Unsupported selector '${key}'.`,
        );
      }
      const expected = reviewed[key];
      if (!expected || value !== expected) {
        throw unprocessable(
          `Trust rule promotion selector '${key}' must exactly match the reviewed scope.`,
        );
      }
    }
    for (const key of REQUIRED_REVIEWED_TRUST_RULE_SELECTOR_KEYS) {
      const expected = reviewed[key];
      if (!expected) continue;
      if (selectors[key] !== expected) {
        throw unprocessable(
          `Trust rule promotion must keep the reviewed actor/tool scope. Missing exact selector '${key}'.`,
        );
      }
    }
  }

  function assertReviewedTrustRuleArgumentFilters(
    invocation: typeof toolInvocations.$inferSelect,
    filters: ToolTrustRuleArgumentFilters | null | undefined,
  ): ToolTrustRuleArgumentFilters {
    const exact = exactReviewedTrustRuleFilters(invocation);
    if (!filters) return exact;
    if (
      filters.allowAny === true
      || filters.allowedHashes?.length
      || filters.fieldEquals
      || filters.fieldNotEquals
      || filters.fieldIn
      || filters.fieldMatches
      || filters.fieldExists?.length
      || filters.fieldAbsent?.length
    ) {
      throw unprocessable("Trust rule promotion only supports the exact reviewed argument hash.");
    }
    if (filters.exactHash !== exact.exactHash) {
      throw unprocessable("Trust rule promotion exactHash must match the reviewed argument hash.");
    }
    return exact;
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

    const [issue] = invocation.issueId
      ? await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, invocation.issueId), eq(issues.companyId, input.companyId)))
        .limit(1)
      : [null];
    const reviewedSelectors = reviewedTrustRuleSelectorValues({
      invocation,
      issueProjectId: issue?.projectId ?? null,
    });
    const selectors = trustRuleSelectors({
      invocation,
      issueProjectId: issue?.projectId ?? null,
      selectors: input.body.selectors,
      scope: input.body.scope,
    });
    assertReviewedTrustRuleSelectors(selectors, reviewedSelectors);
    if (input.body.argumentMode === "action" && (input.actor?.agentId || !invocation.agentId || !invocation.connectionId || actionRequest.approvalId)) {
      throw unprocessable("Action-wide permission requires a human-approved agent connection action without a formal approval gate");
    }
    const filters = input.body.argumentMode === "action"
      ? { allowAny: true }
      : assertReviewedTrustRuleArgumentFilters(invocation, input.body.argumentFilters);
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
    admitInvocation,
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
