type IssueLabelLike = { name?: string | null } | null | undefined;
type IssueLike = {
  id?: string;
  identifier?: string | null;
  priority?: string | null;
  labels?: IssueLabelLike[] | null;
  labelIds?: string[] | null;
};

type IssueCommentLike = {
  id: string;
  issueId: string;
  authorAgentId: string | null;
};

type IssuesServiceLike = {
  getComment(commentId: string): Promise<IssueCommentLike | null>;
};

type AgentsServiceLike = {
  getById(agentId: string): Promise<{ role?: string | null } | null>;
};

type EvidenceKey =
  | "urlScopeList"
  | "kpiSnapshot"
  | "technicalValidation"
  | "deploymentProof"
  | "postDeployVerification";

type ParsedSeoEvidence = Record<EvidenceKey, string>;

const REQUIRED_EVIDENCE_KEYS: EvidenceKey[] = [
  "urlScopeList",
  "kpiSnapshot",
  "technicalValidation",
  "deploymentProof",
  "postDeployVerification",
];

const HEADING_TO_KEY: Record<string, EvidenceKey> = {
  scope: "urlScopeList",
  "url scope": "urlScopeList",
  "url scope list": "urlScopeList",
  "before/after kpi": "kpiSnapshot",
  "kpi snapshot": "kpiSnapshot",
  "metrics delta": "kpiSnapshot",
  "technical validation": "technicalValidation",
  "checks passed": "technicalValidation",
  "validation outputs": "technicalValidation",
  "deployment proof": "deploymentProof",
  deployment: "deploymentProof",
  pr: "deploymentProof",
  commit: "deploymentProof",
  release: "deploymentProof",
  "post-deploy verification": "postDeployVerification",
  verification: "postDeployVerification",
  "post deploy": "postDeployVerification",
};

const UUID_LOOKING =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ValidationResult =
  | { ok: true; comment: IssueCommentLike }
  | { ok: false; reason: "comment_not_found" | "wrong_issue" | "author_not_cmo" };

function normalizeHeaderCandidate(line: string) {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/\s*:\s*$/, "")
    .toLowerCase();
}

function getEvidenceKeyFromHeading(line: string): EvidenceKey | null {
  const normalized = normalizeHeaderCandidate(line);
  return HEADING_TO_KEY[normalized] ?? null;
}

function hasAnyPatternMatch(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

function sectionHasFailureLanguage(value: string) {
  return hasAnyPatternMatch(value, [
    /\bfail(?:ed|ing|ure)?\b/i,
    /\berror(?:s)?\b/i,
    /\binvalid\b/i,
    /\bmissing\b/i,
    /\bnot\s+(?:run|checked|verified|present|indexed)\b/i,
    /\bpending\b/i,
    /\btbd\b/i,
    /\btodo\b/i,
    /\bblocked\b/i,
  ]);
}

function sectionHasEvidence(key: EvidenceKey, body: string) {
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;

  switch (key) {
    case "urlScopeList":
      return hasAnyPatternMatch(trimmed, [
        /(^|\n)\s*[-*]\s+(\/|https?:\/\/|www\.)/i,
        /\b[a-z0-9._-]+\/[a-z0-9/_-]+\b/i,
        /\b(?:urls?|pages?|patterns?)\b/i,
      ]);
    case "kpiSnapshot":
      return hasAnyPatternMatch(trimmed, [
        /\bbefore\b[\s\S]{0,80}\d/i,
        /\bafter\b[\s\S]{0,80}\d/i,
        /\b(?:ctr|clicks|impressions|position|traffic|sessions|conversions|rank)\b[\s\S]{0,80}\d/i,
        /\bdelta\b[\s\S]{0,40}(?:\d|%)/i,
      ]) && /\d/.test(trimmed);
    case "technicalValidation":
      return !sectionHasFailureLanguage(trimmed)
        && hasAnyPatternMatch(trimmed, [
          /\b(?:schema|canonical|hreflang|sitemap|validator)\b/i,
          /\bvalidation outputs?\b/i,
        ])
        && hasAnyPatternMatch(trimmed, [
          /\b(?:passed|clean|valid|ok|attached|output|report|screenshot|200)\b/i,
          /\bno issues\b/i,
        ]);
    case "deploymentProof":
      return hasAnyPatternMatch(trimmed, [
        /\bpr\s*#\d+\b/i,
        /\bcommit\s+[0-9a-f]{6,40}\b/i,
        /\brelease\s+[a-z0-9._-]+\b/i,
        /\bdeploy(?:ed|ment)?\b[\s\S]{0,40}\b(?:sha|commit|tag|build)\b/i,
      ]);
    case "postDeployVerification":
      return hasAnyPatternMatch(trimmed, [
        /\bverif(?:y|ied|ication)\b/i,
        /\bchecked\b/i,
        /\bcrawled\b/i,
        /\breindex(?:ed)?\b/i,
        /\bsearch console\b/i,
        /\bindex coverage\b/i,
        /\brender(?:ing)?\b/i,
        /\bsmoke test\b/i,
      ]);
  }
}

export function isSeoTaggedIssue(issue: IssueLike) {
  if (!Array.isArray(issue.labels)) return false;
  return issue.labels.some((label) => {
    if (!label || typeof label.name !== "string") return false;
    return label.name.trim().toLowerCase() === "seo";
  });
}

export function parseSeoClosureEvidence(commentBody: string | undefined) {
  const sections: Array<{ key: EvidenceKey; alias: string; bodyLines: string[] }> = [];
  let active: { key: EvidenceKey; alias: string; bodyLines: string[] } | null = null;
  const lines = String(commentBody ?? "").split(/\r?\n/);
  for (const line of lines) {
    const headingKey = getEvidenceKeyFromHeading(line);
    if (headingKey) {
      if (active) sections.push(active);
      active = {
        key: headingKey,
        alias: normalizeHeaderCandidate(line),
        bodyLines: [],
      };
      continue;
    }
    if (active) active.bodyLines.push(line);
  }
  if (active) sections.push(active);

  const parsed = {
    urlScopeList: "",
    kpiSnapshot: "",
    technicalValidation: "",
    deploymentProof: "",
    postDeployVerification: "",
  } satisfies ParsedSeoEvidence;

  for (const key of REQUIRED_EVIDENCE_KEYS) {
    const matchingSections = sections.filter((section) => section.key === key);
    const firstWithEvidence = matchingSections.find((section) =>
      sectionHasEvidence(section.key, section.bodyLines.join("\n")));
    if (firstWithEvidence) {
      parsed[key] = firstWithEvidence.bodyLines.join("\n").trim();
    }
  }
  return parsed;
}

export function buildSeoClosureTemplate(missingKeys: EvidenceKey[] = []) {
  const missingLine = missingKeys.length > 0
    ? `Missing evidence: ${missingKeys.join(", ")}`
    : "Fill all required sections:";
  return [
    "## SEO Closure Evidence",
    "",
    missingLine,
    "",
    "### URL scope list",
    "- Affected URLs/patterns:",
    "",
    "### KPI snapshot",
    "- Before/after KPI:",
    "",
    "### Technical validation",
    "- Include validator/schema/canonical/hreflang/sitemap evidence:",
    "",
    "### Deployment proof",
    "- PR/commit/release:",
    "",
    "### Post-deploy verification",
    "- Verification checks:",
    "",
    "CMO exception comment: <uuid> (optional for medium/low only)",
  ].join("\n");
}

export function extractCmoExceptionCommentId(commentBody: string | undefined) {
  const body = String(commentBody ?? "");
  const match = body.match(/^\s*CMO exception comment:\s*([0-9a-f-]{36})\s*$/im);
  if (!match) return null;
  const candidate = match[1]?.trim();
  return candidate && UUID_LOOKING.test(candidate) ? candidate : null;
}

export async function validateCmoExceptionComment({
  issueId,
  exceptionCommentId,
  issuesSvc,
  agentsSvc,
}: {
  issueId: string;
  exceptionCommentId: string;
  issuesSvc: IssuesServiceLike;
  agentsSvc: AgentsServiceLike;
}): Promise<ValidationResult> {
  const comment = await issuesSvc.getComment(exceptionCommentId);
  if (!comment) return { ok: false, reason: "comment_not_found" };
  if (comment.issueId !== issueId) return { ok: false, reason: "wrong_issue" };
  if (!comment.authorAgentId) return { ok: false, reason: "author_not_cmo" };
  const author = await agentsSvc.getById(comment.authorAgentId);
  if (!author || author.role !== "cmo") return { ok: false, reason: "author_not_cmo" };
  return { ok: true, comment };
}

export async function evaluateSeoClosureGate({
  issue,
  requestedStatus,
  commentBody,
  issuesSvc,
  agentsSvc,
}: {
  issue: IssueLike & { id: string };
  requestedStatus: string | undefined;
  commentBody: string | undefined;
  issuesSvc: IssuesServiceLike;
  agentsSvc: AgentsServiceLike;
}) {
  if (requestedStatus !== "done" || !isSeoTaggedIssue(issue)) {
    return { ok: true as const, auditBypass: null };
  }

  const evidence = parseSeoClosureEvidence(commentBody);
  const missingEvidence = REQUIRED_EVIDENCE_KEYS.filter((key) => evidence[key].trim().length === 0);
  if (missingEvidence.length === 0) {
    return { ok: true as const, auditBypass: null };
  }

  const priority = String(issue.priority ?? "medium").toLowerCase();
  const closureTemplate = buildSeoClosureTemplate(missingEvidence);
  if (priority === "high" || priority === "critical") {
    return {
      ok: false as const,
      error: "SEO closure evidence is incomplete",
      details: {
        missingEvidence,
        priority,
        requiresCmoException: false,
        closureTemplate,
      },
      auditBypass: null,
    };
  }

  const exceptionCommentId = extractCmoExceptionCommentId(commentBody);
  if (!exceptionCommentId) {
    return {
      ok: false as const,
      error: "SEO closure evidence is incomplete",
      details: {
        missingEvidence,
        priority,
        requiresCmoException: true,
        closureTemplate,
      },
      auditBypass: null,
    };
  }

  const exceptionValidation = await validateCmoExceptionComment({
    issueId: issue.id,
    exceptionCommentId,
    issuesSvc,
    agentsSvc,
  });
  if (!exceptionValidation.ok) {
    return {
      ok: false as const,
      error: "SEO closure evidence is incomplete",
      details: {
        missingEvidence,
        priority,
        requiresCmoException: true,
        exceptionCommentId,
        exceptionReason: exceptionValidation.reason,
        closureTemplate,
      },
      auditBypass: null,
    };
  }

  return {
    ok: true as const,
    auditBypass: {
      identifier: issue.identifier ?? null,
      priority,
      missingEvidence,
      exceptionCommentId,
      source: "seo_closure_gate",
    },
  };
}
