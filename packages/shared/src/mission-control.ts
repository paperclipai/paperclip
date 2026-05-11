import { z } from "zod";
import type { IssuePriority, IssueStatus } from "./constants.js";

export const MISSION_CONTROL_VALIDATOR_VERDICTS = ["PASS", "REQUEST_CHANGES", "ESCALATE"] as const;
export type MissionControlValidatorVerdict = (typeof MISSION_CONTROL_VALIDATOR_VERDICTS)[number];

export const MISSION_CONTROL_RISK_CLASSES = ["low", "medium", "high", "critical"] as const;
export type MissionControlRiskClass = (typeof MISSION_CONTROL_RISK_CLASSES)[number];

export const MISSION_CONTROL_ACTION_RISK_LEVELS = [
  "no_side_effect",
  "local_only",
  "paperclip_only",
  "external_dry_run",
  "external_live",
  "destructive",
] as const;
export type MissionControlActionRiskLevel = (typeof MISSION_CONTROL_ACTION_RISK_LEVELS)[number];

export const MISSION_CONTROL_APPROVAL_GATES = ["none", "lead", "validator", "board", "compliance"] as const;
export type MissionControlApprovalGate = (typeof MISSION_CONTROL_APPROVAL_GATES)[number];

export const MISSION_CONTROL_SIDE_EFFECT_APPROVAL_STATUSES = ["requested", "approved", "denied", "expired"] as const;
export type MissionControlSideEffectApprovalStatus =
  (typeof MISSION_CONTROL_SIDE_EFFECT_APPROVAL_STATUSES)[number];

export const MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS = [
  "validation-contract",
  "worker-handoff",
  "validator-report",
] as const;
export type MissionControlDefaultRequiredDocumentKey =
  (typeof MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS)[number];

const textArraySchema = z.array(z.string().trim().min(1));
const nonEmptyTextArraySchema = textArraySchema.default([]);
const requiredTextArraySchema = textArraySchema.min(1);

export const missionControlIssuePolicySchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    riskClass: z.enum(MISSION_CONTROL_RISK_CLASSES).optional().default("medium"),
    requiredDocumentKeys: z
      .array(z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/))
      .optional()
      .default([...MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS]),
    acceptedValidatorVerdicts: z.array(z.enum(MISSION_CONTROL_VALIDATOR_VERDICTS)).optional().default(["PASS"]),
    maxChildIssues: z.number().int().positive().max(25).optional().nullable().default(null),
    maxIterations: z.number().int().positive().max(20).optional().nullable().default(null),
    liveActionGate: z.enum(MISSION_CONTROL_APPROVAL_GATES).optional().default("board"),
    destructiveActionGate: z.enum(MISSION_CONTROL_APPROVAL_GATES).optional().default("board"),
  })
  .strict();
export type MissionControlIssuePolicy = z.infer<typeof missionControlIssuePolicySchema>;

export const missionControlValidationContractSchema = z
  .object({
    version: z.literal(1),
    objective: z.string().trim().min(1),
    outOfScope: nonEmptyTextArraySchema,
    passCriteria: requiredTextArraySchema,
    requiredArtifacts: nonEmptyTextArraySchema,
    allowedTools: nonEmptyTextArraySchema,
    gatedActions: nonEmptyTextArraySchema,
    riskClass: z.enum(MISSION_CONTROL_RISK_CLASSES).default("medium"),
    reportingDestination: z.string().trim().min(1).optional().nullable().default(null),
  })
  .strict();
export type MissionControlValidationContract = z.infer<typeof missionControlValidationContractSchema>;

export const missionControlWorkerHandoffSchema = z
  .object({
    version: z.literal(1),
    completed: requiredTextArraySchema,
    notDone: nonEmptyTextArraySchema,
    commands: requiredTextArraySchema,
    sources: nonEmptyTextArraySchema,
    artifacts: requiredTextArraySchema,
    checks: requiredTextArraySchema,
    risks: nonEmptyTextArraySchema,
    nextStep: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type MissionControlWorkerHandoff = z.infer<typeof missionControlWorkerHandoffSchema>;

export const missionControlValidatorReportSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum(MISSION_CONTROL_VALIDATOR_VERDICTS),
    completionScore: z.number().min(0).max(10),
    criteriaChecked: requiredTextArraySchema,
    evidence: requiredTextArraySchema,
    hallucinationFlags: nonEmptyTextArraySchema,
    regressionChecks: nonEmptyTextArraySchema,
    blockingIssues: nonEmptyTextArraySchema,
    exactFixIfFailed: z.string().trim().min(1).optional().nullable().default(null),
  })
  .strict();
export type MissionControlValidatorReport = z.infer<typeof missionControlValidatorReportSchema>;

export const missionControlOutcomeLearningCardSchema = z
  .object({
    version: z.literal(1),
    result: z.enum(MISSION_CONTROL_VALIDATOR_VERDICTS),
    acceptedDeliverables: nonEmptyTextArraySchema,
    failureModes: nonEmptyTextArraySchema,
    memoryCandidates: nonEmptyTextArraySchema,
    skillOrPromptCandidates: nonEmptyTextArraySchema,
    promoted: z.boolean().optional().default(false),
  })
  .strict();
export type MissionControlOutcomeLearningCard = z.infer<typeof missionControlOutcomeLearningCardSchema>;

export const missionControlSideEffectApprovalEnvelopeSchema = z
  .object({
    version: z.literal(1),
    tool: z.string().trim().min(1),
    action: z.string().trim().min(1),
    actionRiskLevel: z.enum(MISSION_CONTROL_ACTION_RISK_LEVELS),
    requiredApprovalGate: z.enum(MISSION_CONTROL_APPROVAL_GATES),
    status: z.enum(MISSION_CONTROL_SIDE_EFFECT_APPROVAL_STATUSES).default("requested"),
    requestedByAgentId: z.string().trim().min(1).optional().nullable().default(null),
    approvedByUserId: z.string().trim().min(1).optional().nullable().default(null),
    approvedByAgentId: z.string().trim().min(1).optional().nullable().default(null),
    approvedAt: z.string().datetime().optional().nullable().default(null),
    expiresAt: z.string().datetime().optional().nullable().default(null),
    dryRunEvidence: nonEmptyTextArraySchema,
    constraints: nonEmptyTextArraySchema,
  })
  .strict();
export type MissionControlSideEffectApprovalEnvelope = z.infer<
  typeof missionControlSideEffectApprovalEnvelopeSchema
>;

export type MissionControlCompletionGateIssue = {
  priority: IssuePriority | string;
  executionPolicy?: unknown;
};

export type MissionControlCompletionGateDocument = {
  key: string;
  body?: string | null;
};

export type MissionControlCompletionGateResult = {
  allowed: boolean;
  enabled: boolean;
  policy: MissionControlIssuePolicy | null;
  missingDocumentKeys: string[];
  validatorVerdict: MissionControlValidatorVerdict | null;
  requiredApprovalGate: MissionControlApprovalGate;
  reason: "mission_control_disabled" | "missing_documents" | "validator_not_passed" | "allowed";
};

function readMissionControlPolicy(executionPolicy: unknown): MissionControlIssuePolicy | null {
  if (!executionPolicy || typeof executionPolicy !== "object") return null;
  const maybePolicy = (executionPolicy as { missionControl?: unknown }).missionControl;
  if (!maybePolicy || typeof maybePolicy !== "object") return null;
  const parsed = missionControlIssuePolicySchema.safeParse(maybePolicy);
  return parsed.success ? parsed.data : null;
}

function requiredGateForRisk(policy: MissionControlIssuePolicy): MissionControlApprovalGate {
  if (policy.riskClass === "critical") return "board";
  if (policy.riskClass === "high") return "board";
  if (policy.riskClass === "medium") return "validator";
  return "lead";
}

function parseValidatorReportFromBody(body: string | null | undefined): MissionControlValidatorReport | null {
  if (!body?.trim()) return null;
  const trimmed = body.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      const parsedJson = JSON.parse(candidate);
      const parsedReport = missionControlValidatorReportSchema.safeParse(parsedJson);
      if (parsedReport.success) return parsedReport.data;
    } catch {
      // Markdown reports are supported below via a conservative verdict scan.
    }
  }
  const verdictMatch = /\b(PASS|REQUEST_CHANGES|ESCALATE)\b/.exec(trimmed.toUpperCase());
  if (!verdictMatch) return null;
  return {
    version: 1,
    verdict: verdictMatch[1] as MissionControlValidatorVerdict,
    completionScore: verdictMatch[1] === "PASS" ? 8 : 0,
    criteriaChecked: ["markdown validator verdict present"],
    evidence: ["validator-report document body"],
    hallucinationFlags: [],
    regressionChecks: [],
    blockingIssues: verdictMatch[1] === "PASS" ? [] : ["validator did not pass"],
    exactFixIfFailed: null,
  };
}

export function evaluateMissionControlCompletionGate(input: {
  issue: MissionControlCompletionGateIssue;
  documents: MissionControlCompletionGateDocument[];
}): MissionControlCompletionGateResult {
  const policy = readMissionControlPolicy(input.issue.executionPolicy);
  if (!policy?.enabled) {
    return {
      allowed: true,
      enabled: false,
      policy: null,
      missingDocumentKeys: [],
      validatorVerdict: null,
      requiredApprovalGate: "none",
      reason: "mission_control_disabled",
    };
  }

  const docsByKey = new Map(input.documents.map((doc) => [doc.key.trim().toLowerCase(), doc]));
  const requiredKeys = policy.requiredDocumentKeys.length > 0
    ? policy.requiredDocumentKeys
    : [...MISSION_CONTROL_DEFAULT_REQUIRED_DOCUMENT_KEYS];
  const missingDocumentKeys = requiredKeys.filter((key) => !docsByKey.has(key));
  const validatorReport = parseValidatorReportFromBody(docsByKey.get("validator-report")?.body);
  const validatorVerdict = validatorReport?.verdict ?? null;
  const requiredApprovalGate = requiredGateForRisk(policy);

  if (missingDocumentKeys.length > 0) {
    return {
      allowed: false,
      enabled: true,
      policy,
      missingDocumentKeys,
      validatorVerdict,
      requiredApprovalGate,
      reason: "missing_documents",
    };
  }

  if (!validatorVerdict || !policy.acceptedValidatorVerdicts.includes(validatorVerdict)) {
    return {
      allowed: false,
      enabled: true,
      policy,
      missingDocumentKeys: [],
      validatorVerdict,
      requiredApprovalGate,
      reason: "validator_not_passed",
    };
  }

  return {
    allowed: true,
    enabled: true,
    policy,
    missingDocumentKeys: [],
    validatorVerdict,
    requiredApprovalGate,
    reason: "allowed",
  };
}

export type MissionControlActionRiskInput = {
  tool: string;
  action: string;
};

export type MissionControlActionRisk = {
  tool: string;
  action: string;
  level: MissionControlActionRiskLevel;
  requiredApprovalGate: MissionControlApprovalGate;
  reason: string;
};

const LIVE_EXTERNAL_TOOLS = new Set(["telegram", "x", "twitter", "email", "gmail", "dm-bot", "tg-sender", "stripe"]);
const PAPERCLIP_TOOLS = new Set(["paperclip", "paperclip-api", "paperclip-mcp"]);

function normalizeMissionControlTool(tool: string): string {
  return tool.trim().toLowerCase();
}

function normalizeMissionControlAction(action: string): string {
  return action.trim().toLowerCase().replace(/[_-]+/g, " ");
}

export function classifyMissionControlActionRisk(input: MissionControlActionRiskInput): MissionControlActionRisk {
  const tool = normalizeMissionControlTool(input.tool);
  const action = normalizeMissionControlAction(input.action);
  const risk = (
    level: MissionControlActionRiskLevel,
    requiredApprovalGate: MissionControlApprovalGate,
    reason: string,
  ): MissionControlActionRisk => ({ tool, action, level, requiredApprovalGate, reason });
  const destructivePattern = /\b(rm\s+(?:-?rf|r\s+f)|delete|drop\s+table|truncate|destroy|retire|revoke|purge|format|reset\s+--hard)\b/;
  const livePattern = /\b(send|post|publish|reply|dm|follow|unfollow|like|retweet|deploy|merge|charge|buy|spend|warmup|outreach)\b/;
  const dryRunPattern = /\b(dry[-_ ]?run|preview|simulate|plan)\b/;
  const readOnlyPattern = /\b(read|list|get|search|inspect|query|select|status|stats|test|typecheck|build|lint)\b/;

  if (destructivePattern.test(action)) {
    return risk("destructive", "board", "destructive action keyword");
  }
  if (LIVE_EXTERNAL_TOOLS.has(tool) && livePattern.test(action) && !dryRunPattern.test(action)) {
    return risk("external_live", "board", "live external side effect");
  }
  if (LIVE_EXTERNAL_TOOLS.has(tool) && dryRunPattern.test(action)) {
    return risk("external_dry_run", "lead", "external dry-run");
  }
  if (PAPERCLIP_TOOLS.has(tool)) {
    return risk("paperclip_only", livePattern.test(action) ? "lead" : "none", "Paperclip-local action");
  }
  if (tool === "terminal" || tool === "file" || tool === "git") {
    return risk("local_only", readOnlyPattern.test(action) ? "none" : "lead", "local development action");
  }
  return risk("no_side_effect", "none", "unclassified read-only default");
}

const APPROVAL_GATE_RANK: Record<MissionControlApprovalGate, number> = {
  none: 0,
  lead: 1,
  validator: 2,
  board: 3,
  compliance: 4,
};

export type MissionControlSideEffectApprovalDecision = {
  allowed: boolean;
  requiredApprovalGate: MissionControlApprovalGate;
  matchingEnvelope: MissionControlSideEffectApprovalEnvelope | null;
  reason: "approval_not_required" | "approved" | "missing_approval" | "expired_approval";
};

export function evaluateMissionControlSideEffectApproval(input: {
  actionRisk: MissionControlActionRisk;
  envelopes: MissionControlSideEffectApprovalEnvelope[];
  now?: Date | string;
}): MissionControlSideEffectApprovalDecision {
  const requiredGate = input.actionRisk.requiredApprovalGate;
  if (requiredGate === "none") {
    return {
      allowed: true,
      requiredApprovalGate: requiredGate,
      matchingEnvelope: null,
      reason: "approval_not_required",
    };
  }

  const nowMs = input.now
    ? input.now instanceof Date
      ? input.now.getTime()
      : new Date(input.now).getTime()
    : Date.now();
  let sawExpired = false;
  const matchingEnvelope = input.envelopes.find((envelope) => {
    if (envelope.status !== "approved") return false;
    if (normalizeMissionControlTool(envelope.tool) !== input.actionRisk.tool) return false;
    if (normalizeMissionControlAction(envelope.action) !== input.actionRisk.action) return false;
    if (envelope.actionRiskLevel !== input.actionRisk.level) return false;
    if (APPROVAL_GATE_RANK[envelope.requiredApprovalGate] < APPROVAL_GATE_RANK[requiredGate]) return false;
    if (envelope.expiresAt && new Date(envelope.expiresAt).getTime() <= nowMs) {
      sawExpired = true;
      return false;
    }
    return Boolean(envelope.approvedByUserId || envelope.approvedByAgentId || envelope.approvedAt);
  }) ?? null;

  if (matchingEnvelope) {
    return {
      allowed: true,
      requiredApprovalGate: requiredGate,
      matchingEnvelope,
      reason: "approved",
    };
  }

  return {
    allowed: false,
    requiredApprovalGate: requiredGate,
    matchingEnvelope: null,
    reason: sawExpired ? "expired_approval" : "missing_approval",
  };
}

export type MissionControlScorecardInput = {
  verdict: MissionControlValidatorVerdict;
  reworkCount?: number | null;
  costCents?: number | null;
};

export type MissionControlScorecard = {
  total: number;
  accepted: number;
  requestChanges: number;
  escalated: number;
  firstPassAcceptanceRate: number;
  requestChangesRate: number;
  escalateRate: number;
  totalReworkCount: number;
  totalCostCents: number;
  costPerAcceptedArtifactCents: number | null;
};

function ratio(count: number, total: number) {
  return total > 0 ? count / total : 0;
}

export function summarizeMissionControlScorecard(rows: MissionControlScorecardInput[]): MissionControlScorecard {
  const total = rows.length;
  const accepted = rows.filter((row) => row.verdict === "PASS").length;
  const requestChanges = rows.filter((row) => row.verdict === "REQUEST_CHANGES").length;
  const escalated = rows.filter((row) => row.verdict === "ESCALATE").length;
  const totalReworkCount = rows.reduce((sum, row) => sum + (row.reworkCount ?? 0), 0);
  const totalCostCents = rows.reduce((sum, row) => sum + (row.costCents ?? 0), 0);
  return {
    total,
    accepted,
    requestChanges,
    escalated,
    firstPassAcceptanceRate: ratio(accepted, total),
    requestChangesRate: ratio(requestChanges, total),
    escalateRate: ratio(escalated, total),
    totalReworkCount,
    totalCostCents,
    costPerAcceptedArtifactCents: accepted > 0 ? totalCostCents / accepted : null,
  };
}

export type MissionControlArtifactLivenessInput = {
  status: IssueStatus | string;
  runStatus?: string | null;
  documents: MissionControlCompletionGateDocument[];
  comments: Array<{ body: string; createdAt?: Date | string | null }>;
};

export type MissionControlArtifactLivenessResult = {
  substantive: boolean;
  reason: "terminal_status" | "substantive_document" | "substantive_comment" | "no_substantive_artifact";
  artifactKey?: string | null;
};

const NON_FINAL_DOCUMENT_KEYS = new Set(["continuation-summary", "worker-handoff", "validation-contract", "mission-ledger"]);

export function shouldTreatIssueArtifactsAsSubstantive(
  input: MissionControlArtifactLivenessInput,
): MissionControlArtifactLivenessResult {
  if (input.status === "done" || input.status === "in_review") {
    return { substantive: true, reason: "terminal_status", artifactKey: null };
  }

  const substantiveDocument = input.documents.find((doc) => {
    const key = doc.key.trim().toLowerCase();
    const body = doc.body?.trim() ?? "";
    if (NON_FINAL_DOCUMENT_KEYS.has(key)) return false;
    if (/\b(final|blueprint|synthesis|report|spec|deliverable)\b/i.test(key)) return body.length >= 1000;
    return body.length >= 3000;
  });
  if (substantiveDocument) {
    return { substantive: true, reason: "substantive_document", artifactKey: substantiveDocument.key };
  }

  const substantiveComment = input.comments.find((comment) => {
    const body = comment.body.trim();
    return body.length >= 1000 && /\b(final|done|deliverable|attached|completed)\b/i.test(body);
  });
  if (substantiveComment) return { substantive: true, reason: "substantive_comment", artifactKey: null };

  return { substantive: false, reason: "no_substantive_artifact", artifactKey: null };
}
