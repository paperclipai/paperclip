type CompletionGuardIssue = {
  title?: string | null;
  description?: string | null;
};

type CompletionGuardComment = {
  body?: string | null;
};

export type OperationalCompletionEvidenceGateAssessment =
  | { allowed: true }
  | { allowed: false; reason: string };

const MERGE_ONLY_RECONCILIATION_PATTERN =
  /post-merge reconciliation|linked github pr|github pr #\d+ is merged|branch-protection path passed|marking issue done/i;

const OPERATIONAL_GATE_PATTERN =
  /operational execution issue|manual run|supervised .*run|runtime evidence|run truly happens|report\/sarif|sarif evidence|phase-\d|prod(?:uction)? passive\/recon|deploy host/i;

const RUNTIME_COMPLETION_EVIDENCE_PATTERN =
  /(?:green report|sarif artifact|report\/sarif).*(?:attached|produced|complete|uploaded)|(?:dry-run|runtime|phase-\d|prod(?:uction)? passive\/recon).*completed|(?:dry-run|runtime|phase-\d).*succeeded|go evidence/i;

const MISSING_RUNTIME_EVIDENCE_PATTERN =
  /blocked,? not done|disposition:\s*blocked|no (?:green )?report\/sarif|no .*sarif artifact|no phase-\d|failed on .*429|too many requests|rate limit|capacity path|missing runtime evidence|acceptance evidence is still missing/i;

function compactText(parts: Array<string | null | undefined>) {
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n");
}

export function assessOperationalCompletionEvidenceGate(input: {
  issue: CompletionGuardIssue;
  recentComments: readonly CompletionGuardComment[];
  completionCommentBody?: string | null;
}): OperationalCompletionEvidenceGateAssessment {
  const issueText = compactText([input.issue.title, input.issue.description]);
  if (!OPERATIONAL_GATE_PATTERN.test(issueText)) return { allowed: true };

  const completionText = compactText([input.completionCommentBody]);
  if (completionText && RUNTIME_COMPLETION_EVIDENCE_PATTERN.test(completionText)) return { allowed: true };

  const recentThreadText = compactText(input.recentComments.slice(0, 12).map((comment) => comment.body));
  const hasMergeOnlyEvidence = MERGE_ONLY_RECONCILIATION_PATTERN.test(completionText);
  const hasMissingRuntimeEvidence = MISSING_RUNTIME_EVIDENCE_PATTERN.test(recentThreadText);

  if (!completionText || hasMergeOnlyEvidence || hasMissingRuntimeEvidence) {
    return {
      allowed: false,
      reason:
        "Operational/manual-run issue requires explicit runtime completion evidence; merge-only PR evidence cannot mark it done.",
    };
  }

  return { allowed: true };
}
