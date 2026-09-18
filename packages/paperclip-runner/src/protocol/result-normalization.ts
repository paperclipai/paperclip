import {
  PRP_ACTIONABLE_ATTENTION_KINDS,
  PRP_ATTENTION_OWNER_CLASSES,
  PRP_VERIFICATION_REASON_CODES,
} from "../contracts/completion-result.js";

export type PrpVerificationReasonCode = (typeof PRP_VERIFICATION_REASON_CODES)[number];
export type PrpActionableAttentionKind = (typeof PRP_ACTIONABLE_ATTENTION_KINDS)[number];
export type PrpAttentionOwnerClass = (typeof PRP_ATTENTION_OWNER_CLASSES)[number];

export interface PrpNormalizedVerification {
  commandOrCheck: string;
  status: "passed" | "failed" | "not_run";
  reasonCode: PrpVerificationReasonCode | null;
  detail: string | null;
  artifactRef: string | null;
  sourceIndex: number;
}

export interface PrpNormalizedAttentionRequest {
  kind: PrpActionableAttentionKind;
  summary: string;
  ownerClass: PrpAttentionOwnerClass;
  targetAgentId: string | null;
  sourceIndex: number;
  sourceKind: string;
  legacy: boolean;
}

export interface PrpIgnoredAttentionRequest {
  sourceIndex: number;
  sourceKind: string | null;
  summary: string | null;
  disposition: "verification_caveat" | "ignored" | "rejected";
  reasonCode: string;
}

export interface PrpResultSignals {
  verification: PrpNormalizedVerification[];
  actionableAttentionRequests: PrpNormalizedAttentionRequest[];
  ignoredAttentionRequests: PrpIgnoredAttentionRequest[];
}

const verificationReasonCodes = new Set<string>(PRP_VERIFICATION_REASON_CODES);
const unavailableVerificationReasonCodes = new Set<string>(
  PRP_VERIFICATION_REASON_CODES.filter((reasonCode) => reasonCode !== "other"),
);
const attentionKinds = new Set<string>(PRP_ACTIONABLE_ATTENTION_KINDS);
const ownerClasses = new Set<string>(PRP_ATTENTION_OWNER_CLASSES);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function inferVerificationReason(value: string): PrpVerificationReasonCode {
  const lower = value.toLowerCase();
  if (/budget|quota|token limit/.test(lower)) return "budget_exhausted";
  if (/credential|api key|secret|login|auth(?:entication)? required/.test(lower)) return "credential_missing";
  if (/permission|denied|forbidden|not allowed/.test(lower)) return "permission_denied";
  if (/policy|governance|approval policy/.test(lower)) return "policy_restricted";
  if (/external|service|upstream|network|offline|dns/.test(lower)) return "external_service_unavailable";
  if (/dependency|package|module|library/.test(lower)) return "dependency_missing";
  if (/tool|command|binary|node|npm|sandbox/.test(lower)) return "tool_unavailable";
  if (/environment|runtime|platform/.test(lower)) return "environment_unavailable";
  return "other";
}

function normalizeVerification(result: Record<string, unknown>): PrpNormalizedVerification[] {
  const entries = Array.isArray(result.verification) ? result.verification : [];
  return entries.map((value, sourceIndex) => {
    const entry = record(value);
    const rawStatus = String(entry.status);
    const reportedStatus: PrpNormalizedVerification["status"] = ["pass", "success", "succeeded"].includes(rawStatus)
      ? "passed"
      : rawStatus === "fail"
        ? "failed"
        : ["passed", "failed", "not_run"].includes(rawStatus)
          ? rawStatus as PrpNormalizedVerification["status"]
          : "not_run";
    const detail = text(entry.detail) ?? text(entry.result);
    const commandOrCheck = text(entry.commandOrCheck) ?? text(entry.command) ?? `verification-${sourceIndex + 1}`;
    const reportedReason = text(entry.reasonCode);
    const normalizedReportedReason = reportedReason && verificationReasonCodes.has(reportedReason)
      ? reportedReason as PrpVerificationReasonCode
      : null;
    // Provider models sometimes report an unavailable command as `failed`
    // because the shell returned non-zero, while also supplying a reason code
    // that explicitly says no meaningful verification verdict was possible.
    // The reason code is the stronger semantic signal: reserve `failed` for a
    // check that actually ran and found the work incorrect.
    const status = reportedStatus === "failed"
      && normalizedReportedReason
      && unavailableVerificationReasonCodes.has(normalizedReportedReason)
      ? "not_run"
      : reportedStatus;
    const reasonCode = normalizedReportedReason
      ?? (status === "not_run"
        ? inferVerificationReason(`${commandOrCheck} ${detail ?? ""}`)
        : null);
    return {
      commandOrCheck,
      status,
      reasonCode,
      detail,
      artifactRef: text(entry.artifactRef),
      sourceIndex,
    };
  });
}

/** Normalize accepted PRP v1 aliases before strict canonical validation. */
export function normalizeLegacyPrpStructuredRunResult(value: unknown): unknown {
  const source = record(value);
  if (Object.keys(source).length === 0) return value;
  const normalized: Record<string, unknown> = { ...source };
  // Provider tool-callers do not consistently echo constant discriminator
  // fields even when they are present in the advertised JSON schema. The
  // transport already selected the semantic-result tool, so adding its
  // canonical discriminator here is deterministic rather than inferential.
  const reportedSchema = text(normalized.schema);
  if (
    reportedSchema === null
    || ["paperclip_finish", "paperclip_paperclip_finish", "paperclip_finish.v1"].includes(reportedSchema)
  ) {
    normalized.schema = "paperclip.run_result.v1";
  }
  const signals = normalizePrpResultSignals(source);
  if (["complete", "completed"].includes(String(normalized.reportedWorkDisposition))) {
    normalized.reportedWorkDisposition = "done";
  }
  const completionClaim = record(normalized.completionClaim);
  if (Array.isArray(completionClaim.criteria)) {
    normalized.completionClaim = {
      ...completionClaim,
      criteria: completionClaim.criteria.map((value) => {
        const criterion = record(value);
        const reportedStatus = text(criterion.status);
        const status = reportedStatus && ["pass", "passed", "complete", "completed"].includes(reportedStatus)
          ? "satisfied"
          : reportedStatus && ["fail", "failed", "incomplete"].includes(reportedStatus)
            ? "not_satisfied"
            : criterion.status;
        return { ...criterion, status };
      }),
    };
  }
  normalized.attentionRequests = signals.actionableAttentionRequests.map((entry) => ({
    kind: entry.kind,
    summary: entry.summary,
    ownerClass: entry.ownerClass,
    ...(entry.targetAgentId ? { targetAgentId: entry.targetAgentId } : {}),
  }));
  normalized.artifacts = Array.isArray(source.artifacts) ? source.artifacts : [];
  normalized.verification = signals.verification.map((entry) => ({
    commandOrCheck: entry.commandOrCheck,
    status: entry.status,
    ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
    ...(entry.detail ? { detail: entry.detail } : {}),
    ...(entry.artifactRef ? { artifactRef: entry.artifactRef } : {}),
  }));
  return normalized;
}

function legacyAttentionRequest(
  entry: Record<string, unknown>,
  sourceIndex: number,
  sourceKind: string,
  summary: string,
): PrpNormalizedAttentionRequest | null {
  const target = record(entry.target);
  const targetAgentId = text(entry.targetAgentId) ?? text(target.agentId);
  const ownerClass = text(entry.ownerClass) ?? text(target.ownerClass);
  const requiredAuthority = text(entry.requiredAuthority);
  switch (sourceKind) {
    case "credential_grant":
      return { kind: "credential", summary, ownerClass: "human", targetAgentId: null, sourceIndex, sourceKind, legacy: true };
    case "governed_approval":
      return { kind: "approval", summary, ownerClass: "human", targetAgentId: null, sourceIndex, sourceKind, legacy: true };
    case "subjective_decision":
      return { kind: "human_input", summary, ownerClass: "human", targetAgentId: null, sourceIndex, sourceKind, legacy: true };
    case "domain_expertise":
      return targetAgentId
        ? { kind: "agent_handoff", summary, ownerClass: "agent", targetAgentId, sourceIndex, sourceKind, legacy: true }
        : null;
    case "external_action":
      return {
        kind: "external_action",
        summary,
        ownerClass: ownerClass === "external_system" || requiredAuthority === "external" ? "external_system" : "human",
        targetAgentId: null,
        sourceIndex,
        sourceKind,
        legacy: true,
      };
    default:
      return null;
  }
}

/**
 * Normalize model-authored result signals without rewriting the immutable PRP result.
 * Unknown legacy attention is diagnostic data, never a finalization exception.
 */
export function normalizePrpResultSignals(value: unknown): PrpResultSignals {
  const result = record(value);
  const verification = normalizeVerification(result);
  const actionableAttentionRequests: PrpNormalizedAttentionRequest[] = [];
  const ignoredAttentionRequests: PrpIgnoredAttentionRequest[] = [];
  const requests = Array.isArray(result.attentionRequests) ? result.attentionRequests : [];

  requests.forEach((value, sourceIndex) => {
    const entry = record(value);
    const sourceKind = text(entry.kind) ?? text(entry.requestedCapability);
    const summary = text(entry.summary);
    if (!sourceKind || !summary) {
      ignoredAttentionRequests.push({
        sourceIndex,
        sourceKind,
        summary,
        disposition: "rejected",
        reasonCode: "attention_request_malformed",
      });
      return;
    }

    if (sourceKind === "environment_constraint") {
      const target = verification.find((candidate) => candidate.status === "not_run");
      if (target) {
        target.detail = target.detail
          ? target.detail.includes(summary) ? target.detail : `${target.detail}\n${summary}`
          : summary;
        target.reasonCode = inferVerificationReason(`${target.commandOrCheck} ${target.detail}`);
      }
      ignoredAttentionRequests.push({
        sourceIndex,
        sourceKind,
        summary,
        disposition: "verification_caveat",
        reasonCode: target ? "legacy_environment_constraint_normalized" : "legacy_environment_constraint_unbound",
      });
      return;
    }

    if (attentionKinds.has(sourceKind) && text(entry.ownerClass)) {
      const ownerClass = text(entry.ownerClass);
      const targetAgentId = text(entry.targetAgentId);
      if (!ownerClass || !ownerClasses.has(ownerClass) || (ownerClass === "agent" && !targetAgentId)) {
        ignoredAttentionRequests.push({
          sourceIndex,
          sourceKind,
          summary,
          disposition: "rejected",
          reasonCode: "attention_request_owner_invalid",
        });
        return;
      }
      actionableAttentionRequests.push({
        kind: sourceKind as PrpActionableAttentionKind,
        summary,
        ownerClass: ownerClass as PrpAttentionOwnerClass,
        targetAgentId,
        sourceIndex,
        sourceKind,
        legacy: false,
      });
      return;
    }

    if (sourceKind === "review") {
      actionableAttentionRequests.push({
        kind: "review",
        summary,
        ownerClass: "human",
        targetAgentId: null,
        sourceIndex,
        sourceKind,
        legacy: true,
      });
      return;
    }

    const legacy = legacyAttentionRequest(entry, sourceIndex, sourceKind, summary);
    if (legacy) {
      actionableAttentionRequests.push(legacy);
      return;
    }

    ignoredAttentionRequests.push({
      sourceIndex,
      sourceKind,
      summary,
      disposition: "ignored",
      reasonCode: ["context_lookup", "retry", "duplicate", "alternate_track"].includes(sourceKind)
        ? "attention_request_internal_capability_not_provider_actionable"
        : "attention_request_kind_unsupported",
    });
  });

  return { verification, actionableAttentionRequests, ignoredAttentionRequests };
}
