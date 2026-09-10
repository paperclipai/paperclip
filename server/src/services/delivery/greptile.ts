import type { Db } from "@paperclipai/db";
import type { ToolGatewayService } from "../tool-gateway.js";
import type { GitHubDeliveryClient } from "./github-client.js";

/**
 * Scoped Greptile read.
 *
 * Greptile is reached through the connected MCP tool gateway. The controller
 * passes only identifiers derived from the delivery unit — never a
 * caller-supplied repository, tool name, or argument — and the gateway
 * allowlists both the tool and the argument keys.
 *
 * A Greptile finding carries no trustworthy revision of its own: MCP
 * `get_merge_request`/`list_merge_request_comments` responses expose review
 * status text and comment bodies, not an accepted head. The reviewed head is
 * therefore never taken from the provider payload, from a CI check conclusion,
 * or from the candidate under evaluation. It is proven by correlating each
 * governed finding identity with GitHub's own review comment record
 * (`commit_id`), which is the authoritative commit that comment was written
 * against.
 *
 * Every failure fails closed: an unreadable comments list, an unresolvable
 * blocking finding, an unknown provider review state, or an unprovable reviewed
 * head is a read failure — never a pass and never a fabricated revision.
 */

export const GREPTILE_READ_TOOL_NAMES = [
  "get_merge_request",
  "list_merge_request_comments",
] as const;

export const GREPTILE_READ_PARAMETER_KEYS = [
  "name",
  "remote",
  "defaultBranch",
  "prNumber",
] as const;

/** Provider review state. `pending` is an in-flight review, not a verdict. */
export type GreptileReviewState = "completed" | "pending";

/**
 * Persisted severities that block when a finding is open or disputed.
 *
 * Greptile does not always publish a severity field, so an unclassified
 * finding is stored as `unknown` and counted as blocking here: unknown
 * severity must never be the gap through which a real finding reaches the
 * merge queue.
 */
export const GREPTILE_BLOCKING_SEVERITIES = [
  "critical",
  "high",
  "error",
  "blocker",
  "unknown",
] as const;

export type GreptileFinding = {
  /** Governed identity: GitHub review comment id when the provider exposes it. */
  externalId: string;
  severity: string;
  title: string;
  body: string | null;
  filePath: string | null;
  line: number | null;
  url: string | null;
  /** Provider-blocking on the reviewed head, after correlation. */
  blocking: boolean;
  /** Provider's own `addressed` flag, when present. */
  addressed: boolean | null;
  /** GitHub `commit_id` this finding was correlated to, when it resolved. */
  commitSha: string | null;
};

export type GreptileReview = {
  ok: true;
  status: "approved" | "changes_requested" | "commented" | "none" | "pending";
  reviewState: GreptileReviewState;
  /** Verified reviewed revision; `null` only when no finding resolved a head. */
  headSha: string | null;
  score: number | null;
  findings: GreptileFinding[];
  /** Blocking findings that hold for `headSha`. */
  blockingFindings: number;
  /** Findings the provider reports across the pull request. */
  providerFindings: number;
  raw: unknown;
};

export type GreptileReadFailure = {
  ok: false;
  errorCode: string;
  message: string;
};

export type GreptileReadResult = GreptileReview | GreptileReadFailure;

export type GreptileReadInput = {
  companyId: string;
  connectionId: string;
  repositoryName: string;
  defaultBranch: string;
  prNumber: number;
  /** Authoritative GitHub correlation target for the same pull request. */
  correlation: {
    host: string;
    connectionId: string | null;
    owner: string;
    repo: string;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** MCP tool results may be a JSON-RPC result object or a bare payload. */
export function parseMcpToolPayload(result: unknown): unknown {
  const outer = record(result);
  if (!outer) return result;
  if (outer.structuredContent !== undefined) return outer.structuredContent;
  if (typeof outer.content === "string") {
    try {
      return JSON.parse(outer.content);
    } catch {
      return outer.content;
    }
  }
  const content = array(outer.content);
  for (const entry of content) {
    const item = record(entry);
    const text = str(item?.text);
    if (!text) continue;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return outer;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

type Priority = "p0" | "p1" | "p2" | "p3";

const PRIORITY_SEVERITY: Record<Priority, string> = {
  p0: "critical",
  p1: "high",
  p2: "medium",
  p3: "low",
};

/**
 * Provider priority.
 *
 * Greptile comments carry the priority in the comment body while the
 * structured payload may have no severity field at all, so a priority is
 * recognised in a discrete field first and then in the body text.
 */
function priorityOf(row: Record<string, unknown>): Priority | null {
  const raw = str(row.priority) ?? str(row.priorityLevel) ?? str(row.severity) ?? str(row.level);
  const field = raw ? /^p?([0-3])$/i.exec(raw.trim()) : null;
  if (field) return `p${field[1]}` as Priority;
  const body = str(row.body) ?? str(row.comment) ?? str(row.details) ?? str(row.description) ?? str(row.message) ?? str(row.summary);
  // Only the opening line states a comment's priority; later prose mentions of
  // "P1" are references, not classification.
  const head = body?.slice(0, 120) ?? "";
  const inline = /\bP([0-3])\b/i.exec(head);
  return inline ? (`p${inline[1]}` as Priority) : null;
}

function hasPublishedSeverity(row: Record<string, unknown>): boolean {
  return str(row.priority) !== null
    || str(row.priorityLevel) !== null
    || str(row.severity) !== null
    || str(row.level) !== null
    || str(row.category) !== null;
}

function severityOf(row: Record<string, unknown>) {
  const priority = priorityOf(row);
  if (priority) return PRIORITY_SEVERITY[priority];
  const raw = str(row.severity) ?? str(row.level) ?? str(row.category);
  return raw ? raw.trim().toLowerCase() : "unknown";
}

/**
 * Whether the provider itself reports this finding as blocking.
 *
 * An explicit `addressed` flag wins: a finding the provider has already
 * addressed is not blocking, even if its priority is P1. Without a flag, a
 * blocking priority or severity blocks, and a finding that carries no severity
 * information at all is treated as blocking rather than assumed harmless.
 */
function isProviderBlocking(row: Record<string, unknown>, severity: string): boolean {
  if (row.addressed === true) return false;
  if (typeof row.blocking === "boolean") return row.blocking;
  const priority = priorityOf(row);
  if (priority) return priority === "p0" || priority === "p1";
  return severity === "unknown"
    || severity === "p0"
    || severity === "p1"
    || severity === "critical"
    || severity === "high"
    || severity === "error"
    || severity === "blocker";
}

/**
 * A finding's provider identity.
 *
 * Only an identity the provider actually published is accepted, because only
 * such an identity can be correlated with GitHub's authoritative record. A
 * row without one is not a finding, and is never given a synthesized identity
 * that would be impossible to correlate.
 */
function identityOf(row: Record<string, unknown>): string | null {
  for (const value of [row.commentId, row.id, row.uuid]) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    const candidate = str(value);
    if (candidate) return candidate;
  }
  return null;
}

function normalizeFinding(row: Record<string, unknown>): GreptileFinding | null {
  const externalId = identityOf(row);
  if (!externalId) return null;
  if (row.isGreptileComment === false) return null;
  const author = str(row.authorLogin);
  if (author && !isGreptileReviewer(author)) return null;
  // The PR-level overview is a summary, not an actionable inline finding.
  if (externalId.startsWith("IC_") && !hasPublishedSeverity(row)) return null;
  const severity = severityOf(row);
  const body = str(row.body)
    ?? str(row.comment)
    ?? str(row.details)
    ?? str(row.description)
    ?? str(row.message)
    ?? str(row.summary)
    ?? null;
  const title = str(row.title) ?? str(row.summary) ?? str(row.message) ?? body;
  if (!title) return null;
  return {
    externalId,
    severity,
    title: title.length > 2000 ? `${title.slice(0, 2000)}…` : title,
    body,
    filePath: str(row.filePath) ?? str(row.file) ?? str(row.path) ?? str(row.filename),
    line: num(row.line) ?? num(row.lineNumber) ?? num(row.startLine) ?? num(row.lineStart),
    url: str(row.url) ?? str(row.htmlUrl) ?? str(row.link),
    blocking: isProviderBlocking(row, severity),
    addressed: typeof row.addressed === "boolean" ? row.addressed : null,
    commitSha: null,
  };
}

/**
 * Provider payload keys that carry findings. The value says whether a row
 * found there must publish its own severity: comment lists are findings by
 * construction, while an analysis container also holds prose that is not a
 * finding and must not become a fabricated blocker.
 */
const FINDING_CONTAINER_KEYS: Record<string, boolean> = {
  comments: false,
  greptile: false,
  unaddressedComments: false,
  addressedComments: false,
  commentThreads: false,
  threads: false,
  reviewComments: false,
  review_comments: false,
  findings: false,
  issues: false,
  analysis: true,
  reviewAnalysis: true,
};
const MAX_PAYLOAD_DEPTH = 8;

/** Provider keys that wrap the actual merge-request payload or a review. */
const WRAPPER_CONTAINER_KEYS: Record<string, true> = {
  mergeRequest: true,
  merge_request: true,
  data: true,
  pullRequest: true,
  result: true,
  codeReviews: true,
  reviews: true,
};

type FindingSink = Map<string, GreptileFinding>;

/**
 * Findings reported by a governed provider payload.
 *
 * Nested provider shapes (`data`, `mergeRequest`, comment threads, review
 * analysis) are walked so a real payload is never silently read as an empty
 * review, and only rows carrying a published identity count as findings.
 */
function collectFindings(value: unknown, sink: FindingSink, depth: number, requireSeverity: boolean, findingContainer: boolean): void {
  if (depth > MAX_PAYLOAD_DEPTH) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectFindings(entry, sink, depth + 1, requireSeverity, findingContainer);
    return;
  }
  const row = record(value);
  if (!row) return;
  if (findingContainer && (!requireSeverity || hasPublishedSeverity(row))) {
    const finding = normalizeFinding(row);
    if (finding && !sink.has(finding.externalId)) sink.set(finding.externalId, finding);
  }
  for (const [key, child] of Object.entries(row)) {
    const nested = FINDING_CONTAINER_KEYS[key];
    if (nested !== undefined) {
      // A comment list nested inside an analysis container is still a comment
      // list, so the requirement is per container rather than inherited.
      collectFindings(child, sink, depth + 1, nested, true);
      continue;
    }
    if (WRAPPER_CONTAINER_KEYS[key]) collectFindings(child, sink, depth + 1, requireSeverity, false);
  }
}

function extractFindings(payload: unknown): GreptileFinding[] {
  const sink: FindingSink = new Map();
  collectFindings(payload, sink, 0, false, Array.isArray(payload));
  return [...sink.values()];
}

type ProviderReviewStatus = {
  state: GreptileReviewState;
  score: number | null;
  /** Provider verdict for the completed review, when it publishes one. */
  verdict: string | null;
};


const MERGE_REQUEST_CONTAINER_KEYS: Record<string, true> = {
  mergeRequest: true,
  merge_request: true,
  data: true,
  pullRequest: true,
};

function hasReadableCommentCollection(value: unknown, depth = 0): boolean {
  if (depth > MAX_PAYLOAD_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.every((entry) => {
      const row = record(entry);
      if (!row || row.isError === true || row.error != null) return false;
      if (hasReadableCommentCollection(row, depth + 1)) return true;
      return identityOf(row) !== null && [
        row.title, row.body, row.comment, row.details, row.description, row.message, row.summary,
      ].some((text) => str(text) !== null);
    });
  }
  const row = record(value);
  if (!row || row.isError === true || row.error != null) return false;
  let found = false;
  for (const [key, child] of Object.entries(row)) {
    if (FINDING_CONTAINER_KEYS[key] !== false && !MERGE_REQUEST_CONTAINER_KEYS[key]
      && key !== "result" && key !== "human") continue;
    if (!hasReadableCommentCollection(child, depth + 1)) return false;
    found = true;
  }
  return found;
}

/**
 * Provider review status from `get_merge_request`.
 *
 * Completion belongs to the latest review, not an older completed entry.
 * Empty or unfinished reviews and new commits are pending; an unrecognized
 * payload is unknown. GitHub supplies revision provenance separately.
 */
function readProviderReviewStatus(payload: unknown): ProviderReviewStatus | null {
  const rows: Record<string, unknown>[] = [];
  let hasNewCommits = false;
  let emptyReviewCollection = false;
  let invalidReviewEntry = false;
  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_PAYLOAD_DEPTH) return;
    const container = record(value);
    if (!container) return;
    const analysis = record(container.reviewAnalysis);
    if (analysis?.hasNewCommitsSinceReview === true) hasNewCommits = true;
    for (const [key, child] of Object.entries(container)) {
      if (key === "codeReviews" || key === "reviews") {
        if (Array.isArray(child) && child.length === 0) emptyReviewCollection = true;
        for (const entry of Array.isArray(child) ? child : [child]) {
          const row = record(entry);
          if (row && str(row.status)) rows.push(row);
          else invalidReviewEntry = true;
        }
      } else if (MERGE_REQUEST_CONTAINER_KEYS[key]) {
        visit(child, depth + 1);
      }
    }
  };
  visit(payload, 0);
  if (invalidReviewEntry) return null;
  if (rows.length === 0) return emptyReviewCollection
    ? { state: "pending", score: null, verdict: null }
    : null;
  const time = (row: Record<string, unknown>) => {
    const parsed = Date.parse(str(row.createdAt) ?? str(row.completedAt) ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  rows.sort((a, b) => time(b) - time(a));
  const latest = rows[0]!;
  const latestTime = time(latest);
  const orderingUnknown = rows.length > 1 && rows.some((row) => time(row) === 0);
  const pending = rows.some((row) =>
    time(row) === latestTime && str(row.status)?.toUpperCase() !== "COMPLETED");
  const verdict = str(latest.state) ?? str(latest.verdict) ?? str(latest.result) ?? str(latest.reviewStatus);
  return {
    state: pending || orderingUnknown || hasNewCommits ? "pending" : "completed",
    score: num(latest.score) ?? num(latest.reviewScore),
    verdict: verdict?.trim().toLowerCase() ?? null,
  };
}

function providerStatusOf(payload: unknown): string | null {
  const root = record(payload);
  const nested = record(root?.mergeRequest) ?? record(record(root?.data)?.mergeRequest) ?? root;
  const raw = str(nested?.status) ?? str(nested?.state) ?? str(nested?.reviewStatus);
  return raw ? raw.trim().toLowerCase() : null;
}

function statusOf(input: {
  reviewState: GreptileReviewState;
  blockingFindings: number;
  providerStatus: string | null;
  providerFindings: number;
}): GreptileReview["status"] {
  if (input.blockingFindings > 0) return "changes_requested";
  if (
    input.providerStatus === "changes_requested"
    || input.providerStatus === "failed"
    || input.providerStatus === "failure"
    || input.providerStatus === "error"
  ) {
    // An explicit provider rejection is a blocking verdict even when the
    // payload carries no per-finding severity.
    return "changes_requested";
  }
  if (input.reviewState !== "completed") return "pending";
  if (input.providerStatus === "approved" || input.providerStatus === "approved_with_comments") return "approved";
  return input.providerFindings > 0 ? "commented" : "none";
}

function isGreptileReviewer(login: string): boolean {
  return login.toLowerCase() === "greptile-apps[bot]" || login.toLowerCase() === "greptile-apps";
}

export interface GreptileReviewService {
  read(input: GreptileReadInput): Promise<GreptileReadResult>;
}

export function greptileReviewService(
  db: Db,
  deps: {
    toolGateway: Pick<ToolGatewayService, "readConnectedTool">;
    github: Pick<GitHubDeliveryClient, "getReviewComments" | "getReviews">;
  },
): GreptileReviewService {
  async function read(input: GreptileReadInput): Promise<GreptileReadResult> {
    const parameters = {
      name: input.repositoryName,
      remote: "github",
      defaultBranch: input.defaultBranch,
      prNumber: input.prNumber,
    };
    const review = await deps.toolGateway.readConnectedTool({
      companyId: input.companyId,
      connectionId: input.connectionId,
      toolName: "get_merge_request",
      allowedToolNames: GREPTILE_READ_TOOL_NAMES,
      allowedParameterKeys: GREPTILE_READ_PARAMETER_KEYS,
      parameters,
      reason: "delivery_review_read",
    });
    if (!review.ok) return { ok: false, errorCode: review.errorCode, message: review.message };
    const comments = await deps.toolGateway.readConnectedTool({
      companyId: input.companyId,
      connectionId: input.connectionId,
      toolName: "list_merge_request_comments",
      allowedToolNames: GREPTILE_READ_TOOL_NAMES,
      allowedParameterKeys: GREPTILE_READ_PARAMETER_KEYS,
      parameters,
      reason: "delivery_review_comments",
    });
    // Both reads are required for a complete review: a failed comments read
    // is a failed read, never a silent partial success over review-only
    // findings.
    if (!comments.ok) return { ok: false, errorCode: comments.errorCode, message: comments.message };
    const reviewPayload = parseMcpToolPayload(review.result);
    const commentsPayload = parseMcpToolPayload(comments.result);
    const failedEnvelope = [review.result, comments.result, reviewPayload].some((value) => {
      const row = record(value);
      return row?.isError === true || row?.error != null || record(row?.data)?.isError === true;
    });
    if (failedEnvelope || !hasReadableCommentCollection(commentsPayload)) {
      return {
        ok: false,
        errorCode: "provider_unknown",
        message: "Greptile returned an unreadable or failed review/comments response",
      };
    }

    const provider = readProviderReviewStatus(reviewPayload);
    if (!provider) {
      return {
        ok: false,
        errorCode: "provider_unknown",
        message: "Greptile did not report a review state for this pull request",
      };
    }

    const findings = extractFindings(commentsPayload);
    const reviewFindings = extractFindings(reviewPayload);
    for (const finding of reviewFindings) {
      if (!findings.some((existing) => existing.externalId === finding.externalId)) findings.push(finding);
    }

    // Authoritative correlation: every governed finding identity must resolve
    // to GitHub's own record of the commit that comment belongs to.
    const args = [
      input.companyId, input.correlation.connectionId, input.correlation.host,
      input.correlation.owner, input.correlation.repo, input.prNumber,
    ] as const;
    const [githubComments, githubReviews] = await Promise.all([
      deps.github.getReviewComments(...args),
      deps.github.getReviews(...args),
    ]);
    if (!githubComments.ok) {
      return {
        ok: false,
        errorCode: "provider_unknown",
        message: `Greptile findings could not be correlated with GitHub review comments: ${githubComments.message}`,
      };
    }
    if (!githubReviews.ok) {
      return {
        ok: false,
        errorCode: "provider_unknown",
        message: `Greptile reviewed revision could not be read from GitHub: ${githubReviews.message}`,
      };
    }
    const commentsByIdentity = new Map<string, { commitSha: string | null; ambiguous: boolean }>();
    for (const comment of githubComments.value) {
      const existing = commentsByIdentity.get(comment.id);
      if (!existing) {
        commentsByIdentity.set(comment.id, { commitSha: comment.commitSha, ambiguous: false });
        continue;
      }
      if (existing.commitSha !== comment.commitSha) existing.ambiguous = true;
    }

    const headCandidates = new Map<string, number>();
    for (const finding of findings) {
      const correlated = commentsByIdentity.get(finding.externalId);
      if (!correlated || correlated.ambiguous || !correlated.commitSha) continue;
      finding.commitSha = correlated.commitSha.toLowerCase();
      headCandidates.set(finding.commitSha, (headCandidates.get(finding.commitSha) ?? 0) + 1);
    }

    const reviews = githubReviews.value.reviews
      .filter((entry) => entry.login && isGreptileReviewer(entry.login)
        && entry.state !== "PENDING" && entry.state !== "DISMISSED"
        && entry.commitSha && SHA_PATTERN.test(entry.commitSha))
      .sort((a, b) => Date.parse(b.submittedAt ?? "") - Date.parse(a.submittedAt ?? ""));
    // A clean review has no inline comments. GitHub's review record still
    // identifies its exact commit; never substitute a provider/candidate SHA.
    let headSha = reviews[0]?.commitSha?.toLowerCase() ?? null;
    if (!headSha && headCandidates.size === 1) headSha = headCandidates.keys().next().value ?? null;
    if (!headSha && provider.state === "completed") {
      return {
        ok: false,
        errorCode: "provider_unknown",
        message: "Greptile evidence does not resolve to an authoritative revision",
      };
    }
    // Unaddressed findings remain blocking across revisions until Greptile
    // clears them. An old comment commit is not evidence that it was fixed.
    const blockingFindings = findings.filter((finding) => finding.blocking).length;
    return {
      ok: true,
      status: statusOf({
        reviewState: provider.state,
        blockingFindings,
        providerStatus: provider.verdict ?? providerStatusOf(reviewPayload),
        providerFindings: findings.length,
      }),
      reviewState: provider.state,
      headSha,
      score: provider.score,
      findings,
      blockingFindings,
      providerFindings: findings.length,
      raw: { review: reviewPayload, comments: commentsPayload },
    };
  }

  return { read };
}
