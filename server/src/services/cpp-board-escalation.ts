export interface CppEscalationIssueContext {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface CppEscalationCommentContext {
  id?: string | null;
  issueId?: string | null;
  body: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  authorType?: string | null;
  createdAt?: Date | string | null;
}

export interface CppBindingContext {
  source: string;
  constraints: string | null;
  reviewGate: string | null;
}

export interface CppOverrideContext {
  commentId: string | null;
  issueId: string | null;
  author: string | null;
  optionId: string | null;
  bodyExcerpt: string;
  createdAt: string | null;
}

export interface CppRecommendationFingerprint {
  interactionId: string | null;
  optionId: string | null;
}

const OPTION_ID_RE = /^[a-z][a-z0-9_:-]{2,}$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SWEEP_COMMENT_RE =
  /^\s*(?:ESCALATION:|Autonomous (?:CPP |interaction )?decision|NOX-\d+\s+sweep attempted|Sweep echo\b|What I tried\/delegated:)/i;
const OVERRIDE_COMMENT_RE =
  /\b(override|standing recommendation|operative decision|recommendation stands|binding|cameron|local-board|nox)\b/i;
const BOARD_ACCESS_RE = /\b(?:403\s+)?board access required\b/i;
const NEW_CLERK_E2E_SCOPE_RE =
  /\b(clerk(?:\s+\w+){0,4}\s+e2e|e2e(?:\s+\w+){0,4}\s+clerk|clerk_replacement|replacement(?:\s+\w+){0,5}\s+clerk|new(?:\s+\w+){0,5}\s+e2e)\b/i;
const NEW_FEATURE_BAN_RE =
  /\b(no|not|without|unless|must not|do not|bar|bans?|forbid|reject)\b[\s\S]{0,180}\b(new|dispatch|feature|clerk|e2e|replacement|scope)\b/i;

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max = 700) {
  const compacted = compactWhitespace(value);
  return compacted.length > max ? `${compacted.slice(0, max - 1)}...` : compacted;
}

export function extractMarkdownSection(body: string | null | undefined, heading: string): string | null {
  if (!body) return null;
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`(?:^|\n)\s*(?:#{1,6}\s*)?\*\*${escapedHeading}:\*\*\s*\n?([\s\S]*?)(?=\n\s*(?:#{1,6}\s*)?\*\*[^*\n]+:\*\*|\n\s*#{1,6}\s+|$)`,
    "i",
  );
  const match = body.match(pattern);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function contextLabel(issue: CppEscalationIssueContext) {
  return issue.identifier ?? issue.title ?? issue.id ?? "unknown issue";
}

export function extractBindingContexts(issues: CppEscalationIssueContext[]): CppBindingContext[] {
  const contexts: CppBindingContext[] = [];
  for (const issue of issues) {
    const constraints = extractMarkdownSection(issue.description, "Constraints / Risks");
    const reviewGate = extractMarkdownSection(issue.description, "Review Gate");
    if (!constraints && !reviewGate) continue;
    contexts.push({
      source: contextLabel(issue),
      constraints: constraints ? truncate(constraints, 900) : null,
      reviewGate: reviewGate ? truncate(reviewGate, 500) : null,
    });
  }
  return contexts;
}

function extractBacktickOptionIds(body: string) {
  const ids: string[] = [];
  for (const match of body.matchAll(/`([^`]+)`/g)) {
    const value = match[1]?.trim();
    if (!value || UUID_RE.test(value) || !OPTION_ID_RE.test(value)) continue;
    ids.push(value);
  }
  return ids;
}

export function extractPreferredOptionId(body: string): string | null {
  const backtickIds = extractBacktickOptionIds(body);
  const ranked = backtickIds.find((id) => /^(accept_|clerk_|reset_|owner_|create_|reject_|defer_)/i.test(id));
  if (ranked) return ranked;
  return backtickIds[0] ?? null;
}

function isSweepGeneratedComment(comment: CppEscalationCommentContext) {
  return SWEEP_COMMENT_RE.test(comment.body);
}

function isOverrideComment(comment: CppEscalationCommentContext) {
  const author = `${comment.authorType ?? ""} ${comment.authorUserId ?? ""}`.toLowerCase();
  if (author.includes("local-board")) return true;
  return OVERRIDE_COMMENT_RE.test(comment.body) && !isSweepGeneratedComment(comment);
}

export function findLatestOverrideComment(comments: CppEscalationCommentContext[]): CppOverrideContext | null {
  const sorted = [...comments].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });

  for (const comment of sorted) {
    if (!isOverrideComment(comment)) continue;
    return {
      commentId: comment.id ?? null,
      issueId: comment.issueId ?? null,
      author: comment.authorUserId ?? comment.authorAgentId ?? comment.authorType ?? null,
      optionId: extractPreferredOptionId(comment.body),
      bodyExcerpt: truncate(comment.body, 700),
      createdAt: comment.createdAt ? new Date(comment.createdAt).toISOString() : null,
    };
  }
  return null;
}

export function optionViolatesBindingConstraints(input: {
  optionId?: string | null;
  optionDescription?: string | null;
  bindingContexts: CppBindingContext[];
}): { rejected: boolean; reason: string | null } {
  const optionText = `${input.optionId ?? ""} ${input.optionDescription ?? ""}`;
  if (!NEW_CLERK_E2E_SCOPE_RE.test(optionText)) return { rejected: false, reason: null };

  for (const context of input.bindingContexts) {
    const bindingText = `${context.constraints ?? ""}\n${context.reviewGate ?? ""}`;
    if (!NEW_FEATURE_BAN_RE.test(bindingText) && !NEW_CLERK_E2E_SCOPE_RE.test(bindingText)) continue;
    return {
      rejected: true,
      reason: `${input.optionId ?? "option"} maps onto banned new Clerk e2e/replacement scope in ${context.source}`,
    };
  }

  return { rejected: false, reason: null };
}

export function extractBoardAccessRecommendationFingerprint(body: string): CppRecommendationFingerprint | null {
  if (!BOARD_ACCESS_RE.test(body)) return null;
  const interactionId = body.match(UUID_RE)?.[0] ?? null;
  const optionId = extractPreferredOptionId(body);
  if (!interactionId && !optionId) return null;
  return { interactionId, optionId };
}

function sameFingerprint(left: CppRecommendationFingerprint, right: CppRecommendationFingerprint) {
  return (left.interactionId ?? null) === (right.interactionId ?? null) &&
    (left.optionId ?? null) === (right.optionId ?? null);
}

export function shouldSuppressDuplicateBoardAccessRecommendation(
  nextBody: string,
  recentComments: CppEscalationCommentContext[],
) {
  return Boolean(findUnchangedBoardAccessRecommendation(nextBody, recentComments));
}

export function findUnchangedBoardAccessRecommendation(
  nextBody: string,
  recentComments: CppEscalationCommentContext[],
): CppEscalationCommentContext | null {
  const next = extractBoardAccessRecommendationFingerprint(nextBody);
  if (!next) return null;

  const sorted = [...recentComments].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });

  for (const comment of sorted) {
    const previous = extractBoardAccessRecommendationFingerprint(comment.body);
    if (!previous) continue;
    return sameFingerprint(next, previous) ? comment : null;
  }

  return null;
}

export function buildCppBoardEscalationContext(input: {
  issues: CppEscalationIssueContext[];
  comments: CppEscalationCommentContext[];
}) {
  const bindingContexts = extractBindingContexts(input.issues);
  const latestOverride = findLatestOverrideComment(input.comments);
  const clerkReplacementCheck = optionViolatesBindingConstraints({
    optionId: "clerk_replacement",
    optionDescription: "Create Clerk e2e replacement / new Clerk Playwright proof path",
    bindingContexts,
  });

  if (bindingContexts.length === 0 && !latestOverride && !clerkReplacementCheck.rejected) return null;

  return {
    bindingContexts,
    latestOverride,
    bannedOptions: clerkReplacementCheck.rejected
      ? [{ optionId: "clerk_replacement", reason: clerkReplacementCheck.reason }]
      : [],
  };
}
