export type LearningPostmortemOutcome = "passed" | "failed" | "blocked" | "cancelled" | "partial";
export type LearningCandidateTarget = "skill" | "prompt" | "agent_instruction" | "validator" | "governance_brief";
export type LearningCandidateStatus = "pending_review" | "approved_for_manual_apply" | "rejected";

export interface LearningPostmortemInput {
  issue: {
    id: string;
    identifier?: string | null;
    title: string;
    status: string;
  };
  run?: {
    id?: string | null;
    status?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  } | null;
  outcome?: LearningPostmortemOutcome;
  validatorVerdicts?: string[];
  commandEvidence?: string[];
  finalDelivery?: {
    outcome?: string | null;
    error?: string | null;
    attemptCount?: number | null;
  } | null;
  recoveryNotes?: string[];
}

export interface LearningCandidate {
  id: string;
  target: LearningCandidateTarget;
  status: LearningCandidateStatus;
  title: string;
  rationale: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  requiresApproval: true;
  appliesAutomatically: false;
}

export interface LearningPostmortem {
  version: 1;
  issue: LearningPostmortemInput["issue"];
  run: NonNullable<LearningPostmortemInput["run"]> | null;
  outcome: LearningPostmortemOutcome;
  validatorVerdicts: string[];
  evidence: string[];
  finalDelivery: {
    outcome: string | null;
    error: string | null;
    attemptCount: number;
  } | null;
  recoveryNotes: string[];
  candidates: LearningCandidate[];
}

export interface LearningPromotionDecisionInput {
  action: "promote" | "reject";
  reviewerId: string;
  note?: string | null;
}

export interface LearningPromotionDecision {
  candidateId: string;
  status: "approved_for_manual_apply" | "rejected";
  requiresApproval: true;
  appliesAutomatically: false;
  reviewerId: string;
  note: string | null;
  auditSummary: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._:-]+/gi, "Bearer [REDACTED]"],
  [/(authorization|api[_-]?key|token|password|passwd|secret)(\s*[:=]\s*)(["']?)[^\s"',;)]+/gi, "$1$2$3[REDACTED]"],
  [/(postgres(?:ql)?|mysql|redis|mongodb):\/\/[^\s"')]+/gi, "$1://[REDACTED]"],
  [/bot\d+:[A-Za-z0-9_-]+/gi, "bot[REDACTED]"],
  [/[A-Za-z0-9._%+-]+:[^\s@]+@[A-Za-z0-9.-]+/gi, "[REDACTED]@[REDACTED]"],
];

function stableId(parts: readonly string[]): string {
  const joined = parts.join(":");
  let hash = 0;
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 31 + joined.charCodeAt(index)) >>> 0;
  }
  return `learn_${hash.toString(16).padStart(8, "0")}`;
}

export function redactLearningEvidence(value: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function redactList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => redactLearningEvidence(value)).filter((value) => value.trim().length > 0);
}

function inferOutcome(input: LearningPostmortemInput): LearningPostmortemOutcome {
  if (input.outcome) return input.outcome;
  const normalized = input.issue.status.toLowerCase();
  if (["done", "completed", "closed"].includes(normalized)) return "passed";
  if (["blocked"].includes(normalized)) return "blocked";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["in_review", "partial"].includes(normalized)) return "partial";
  return "failed";
}

function buildCandidates(input: LearningPostmortemInput, evidence: string[], outcome: LearningPostmortemOutcome): LearningCandidate[] {
  const candidates: LearningCandidate[] = [];
  const issueLabel = input.issue.identifier ?? input.issue.id;
  const hasFinalDeliveryFailure = input.finalDelivery?.outcome === "failed" || Boolean(input.finalDelivery?.error);
  const failedValidator = (input.validatorVerdicts ?? []).some((verdict) => verdict !== "PASS");

  if (outcome !== "passed" || hasFinalDeliveryFailure || failedValidator) {
    candidates.push({
      id: stableId([input.issue.id, "validator", evidence.join("|")]),
      target: "validator",
      status: "pending_review",
      title: `Tighten validator/recovery checks for ${issueLabel}`,
      rationale: "A failed, blocked, partial, or delivery-error run should become a reviewed validator or recovery checklist improvement.",
      evidence: evidence.slice(0, 6),
      confidence: failedValidator || hasFinalDeliveryFailure ? "high" : "medium",
      requiresApproval: true,
      appliesAutomatically: false,
    });
  }

  if (evidence.some((line) => /skill|checklist|procedure|workflow/i.test(line))) {
    candidates.push({
      id: stableId([input.issue.id, "skill", evidence.join("|")]),
      target: "skill",
      status: "pending_review",
      title: `Promote reusable workflow from ${issueLabel}`,
      rationale: "Evidence mentions a reusable checklist/procedure; queue it as a skill candidate instead of mutating skills automatically.",
      evidence: evidence.slice(0, 6),
      confidence: "medium",
      requiresApproval: true,
      appliesAutomatically: false,
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      id: stableId([input.issue.id, "brief", evidence.join("|")]),
      target: "governance_brief",
      status: "pending_review",
      title: `Capture governance brief for ${issueLabel}`,
      rationale: "Successful runs still produce reviewable operating-history notes; no prompt or skill is changed automatically.",
      evidence: evidence.slice(0, 6),
      confidence: "low",
      requiresApproval: true,
      appliesAutomatically: false,
    });
  }

  return candidates;
}

export function buildLearningPostmortem(input: LearningPostmortemInput): LearningPostmortem {
  const outcome = inferOutcome(input);
  const commandEvidence = redactList(input.commandEvidence);
  const recoveryNotes = redactList(input.recoveryNotes);
  const deliveryError = input.finalDelivery?.error ? redactLearningEvidence(input.finalDelivery.error) : null;
  const deliveryEvidence = input.finalDelivery
    ? [
        `final_delivery outcome=${input.finalDelivery.outcome ?? "unknown"}`,
        deliveryError ? `final_delivery error=${deliveryError}` : null,
        `final_delivery attempts=${input.finalDelivery.attemptCount ?? 0}`,
      ].filter((value): value is string => Boolean(value))
    : [];
  const verdictEvidence = (input.validatorVerdicts ?? []).map((verdict) => `validator verdict=${redactLearningEvidence(verdict)}`);
  const evidence = [...commandEvidence, ...deliveryEvidence, ...recoveryNotes, ...verdictEvidence];

  return {
    version: 1,
    issue: input.issue,
    run: input.run ?? null,
    outcome,
    validatorVerdicts: (input.validatorVerdicts ?? []).map((verdict) => redactLearningEvidence(verdict)),
    evidence,
    finalDelivery: input.finalDelivery
      ? {
          outcome: input.finalDelivery.outcome ?? null,
          error: deliveryError,
          attemptCount: input.finalDelivery.attemptCount ?? 0,
        }
      : null,
    recoveryNotes,
    candidates: buildCandidates(input, evidence, outcome),
  };
}

export function decideLearningPromotion(
  candidate: LearningCandidate,
  decision: LearningPromotionDecisionInput,
): LearningPromotionDecision {
  const approved = decision.action === "promote";
  return {
    candidateId: candidate.id,
    status: approved ? "approved_for_manual_apply" : "rejected",
    requiresApproval: true,
    appliesAutomatically: false,
    reviewerId: decision.reviewerId,
    note: decision.note ?? null,
    auditSummary: approved
      ? `Learning ${candidate.id} approved for manual apply to ${candidate.target}; no prompt/skill is changed automatically.`
      : `Learning ${candidate.id} rejected; no prompt/skill is changed automatically.`,
  };
}
