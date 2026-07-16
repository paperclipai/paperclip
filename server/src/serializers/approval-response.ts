import type { ApprovalResponse, ApprovalStatus, ApprovalType } from "@paperclipai/shared";
import {
  projectAgentAdapterConfig,
  projectAgentPermissions,
  projectAgentRuntimeConfig,
} from "./agent-response.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function copyStringFields(source: UnknownRecord, keys: readonly string[]): UnknownRecord {
  const result: UnknownRecord = {};
  for (const key of keys) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}

function copyNumberFields(source: UnknownRecord, result: UnknownRecord, keys: readonly string[]): void {
  for (const key of keys) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) result[key] = source[key];
  }
}

function projectStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return [...value];
}

function projectDesiredSkills(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: unknown[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      result.push(entry);
      continue;
    }
    const source = asRecord(entry);
    if (!source) continue;
    const projected = copyStringFields(source, ["key", "slug", "name", "version", "versionId"]);
    if (Object.keys(projected).length > 0) result.push(projected);
  }
  return result;
}

function projectHireConfigurationSnapshot(value: unknown): UnknownRecord | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const result = copyStringFields(source, [
    "name",
    "role",
    "title",
    "icon",
    "reportsTo",
    "capabilities",
    "adapterType",
    "defaultEnvironmentId",
    "budgetMonthlyCents",
  ]);
  copyNumberFields(source, result, ["budgetMonthlyCents"]);
  if (source.adapterConfig !== undefined) result.adapterConfig = projectAgentAdapterConfig(source.adapterConfig);
  if (source.runtimeConfig !== undefined) result.runtimeConfig = projectAgentRuntimeConfig(source.runtimeConfig);
  if (source.permissions !== undefined) result.permissions = projectAgentPermissions(source.permissions);
  const desiredSkills = projectDesiredSkills(source.desiredSkills);
  if (desiredSkills) result.desiredSkills = desiredSkills;
  return result;
}

function projectHirePayload(source: UnknownRecord): UnknownRecord {
  const result = copyStringFields(source, [
    "name",
    "role",
    "title",
    "icon",
    "reportsTo",
    "capabilities",
    "adapterType",
    "defaultEnvironmentId",
    "budgetMonthlyCents",
    "agentId",
    "requestedByAgentId",
    "sourceBuiltInAgentKey",
    "sourcePluginId",
    "sourcePluginKey",
    "managedResourceKey",
  ]);
  copyNumberFields(source, result, ["budgetMonthlyCents"]);
  if (source.adapterConfig !== undefined) result.adapterConfig = projectAgentAdapterConfig(source.adapterConfig);
  if (source.runtimeConfig !== undefined) result.runtimeConfig = projectAgentRuntimeConfig(source.runtimeConfig);
  if (source.permissions !== undefined) result.permissions = projectAgentPermissions(source.permissions);
  const desiredSkills = projectDesiredSkills(source.desiredSkills);
  if (desiredSkills) result.desiredSkills = desiredSkills;
  const featureKeys = projectStringArray(source.featureKeys);
  if (featureKeys) result.featureKeys = featureKeys;
  const snapshot = projectHireConfigurationSnapshot(source.requestedConfigurationSnapshot);
  if (snapshot) result.requestedConfigurationSnapshot = snapshot;
  return result;
}

const CEO_STRATEGY_FIELDS = [
  "title",
  "summary",
  "plan",
  "description",
  "strategy",
  "text",
  "recommendedAction",
  "nextActionOnApproval",
] as const;

const BUDGET_STRING_FIELDS = [
  "scopeType",
  "scopeId",
  "scopeName",
  "metric",
  "windowKind",
  "thresholdType",
  "windowStart",
  "windowEnd",
  "policyId",
  "guidance",
] as const;

const BUDGET_NUMBER_FIELDS = [
  "budgetAmount",
  "observedAmount",
  "warnPercent",
] as const;

const BOARD_APPROVAL_FIELDS = [
  "title",
  "summary",
  "recommendedAction",
  "nextActionOnApproval",
  "proposedComment",
  "source",
  "issueId",
  "taskId",
  "taskKey",
  "commentId",
  "invocationId",
  "actionRequestId",
  "tool",
  "risk",
  "argumentsHash",
] as const;

function projectApprovalPayload(type: unknown, payload: unknown): UnknownRecord {
  const source = asRecord(payload) ?? {};
  switch (type) {
    case "hire_agent":
      return projectHirePayload(source);
    case "approve_ceo_strategy":
      return copyStringFields(source, CEO_STRATEGY_FIELDS);
    case "budget_override_required": {
      const result = copyStringFields(source, BUDGET_STRING_FIELDS);
      copyNumberFields(source, result, BUDGET_NUMBER_FIELDS);
      return result;
    }
    case "request_board_approval": {
      const result = copyStringFields(source, BOARD_APPROVAL_FIELDS);
      const risks = projectStringArray(source.risks);
      if (risks) result.risks = risks;
      return result;
    }
    default:
      return {};
  }
}

/** Positive response DTO projector for every current approval type. */
export function projectApprovalResponse(approval: UnknownRecord): ApprovalResponse {
  return {
    id: approval.id as string,
    companyId: approval.companyId as string,
    type: approval.type as ApprovalType,
    requestedByAgentId: typeof approval.requestedByAgentId === "string" ? approval.requestedByAgentId : null,
    requestedByUserId: typeof approval.requestedByUserId === "string" ? approval.requestedByUserId : null,
    status: approval.status as ApprovalStatus,
    payload: projectApprovalPayload(approval.type, approval.payload),
    decisionNote: typeof approval.decisionNote === "string" ? approval.decisionNote : null,
    decidedByUserId: typeof approval.decidedByUserId === "string" ? approval.decidedByUserId : null,
    decidedAt: approval.decidedAt instanceof Date ? approval.decidedAt : null,
    createdAt: approval.createdAt as Date,
    updatedAt: approval.updatedAt as Date,
  };
}
