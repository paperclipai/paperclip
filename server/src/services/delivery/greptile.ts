import type { Db } from "@paperclipai/db";
import type { ToolGatewayService } from "../tool-gateway.js";
import type { GitHubDeliveryClient, GitHubReviewThread } from "./github-client.js";

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
 * therefore never taken from the provider payload or from the candidate under
 * evaluation. It is proven from GitHub's own records: each governed finding
 * identity correlated with GitHub's review comment record (`commit_id`), the
 * GitHub Greptile review record, or — when GitHub emits no review object for
 * the current head — the Greptile GitHub App's own completed successful check
 * run bound to that exact head. A check run is proof only with authenticated
 * app provenance (GitHub's `app.slug`, not a check name), an exact head match,
 * and the latest Greptile outcome on that head; anything unreadable,
 * unauthenticated, mismatched, or superseded by a later Greptile run proves
 * nothing.
 *
 * Every failure fails closed: an unreadable comments list, an unresolvable
 * blocking finding, an unknown provider review state, or an unprovable reviewed
 * head is a read failure — never a pass and never a fabricated revision.
 *
 * Clearing a finding is not the provider's call alone. GitHub's own review
 * thread is the host-side authority, but only for the revision it belongs to: a
 * thread the pull request resolved on the evaluated head — or on a revision
 * that head provably contains — clears the finding it carries even while the
 * provider still reports it; a resolution on a superseded or divergent revision
 * clears nothing and is reported as a review-provenance wait, never silently
 * promoted to current-head evidence by a later read. An unresolved thread never
 * clears, and a finding whose identity GitHub did not return stays
 * unresolved/unknown rather than being read as addressed by omission. The
 * thread read is complete or it fails, so a resolution can never hide past a
 * page bound and a truncated comment list can never lose the identity a finding
 * correlates through.
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
  /**
   * GitHub's own review-thread record carrying this finding identity, when
   * GitHub returned it. `null` means GitHub did not publish the identity: the
   * finding stays unresolved/unknown, because a thread that is not in the
   * record is a coverage gap and never resolution evidence.
   */
  reviewThread: GreptileFindingThread | null;
};

/**
 * GitHub's own resolution record for the thread that carries a finding.
 *
 * `resolved` is GitHub's own flag, but a resolution is only evidence for a
 * revision when its provenance binds to that revision: `commitSha` is GitHub's
 * own commit for the thread's newest comment, and `currentHead` says whether
 * that revision is the head under evaluation (or is provably contained in it).
 * A thread resolved on a revision the head does not carry is *not*
 * current-head evidence — it clears nothing, and it never silently becomes
 * current by being read again later. `outdated` only says the thread's diff
 * moved, which is not resolution either.
 */
export type GreptileFindingThread = {
  id: string;
  resolved: boolean;
  outdated: boolean;
  commitSha: string | null;
  currentHead: boolean;
};

export type GreptileReview = {
  ok: true;
  status: "approved" | "changes_requested" | "commented" | "none" | "pending";
  reviewState: GreptileReviewState;
  /**
   * The provider's own verdict text, when it published one. It is reported
   * separately from `status` because `status` is derived from the finding set
   * as well: an explicit provider rejection stands on its own, while a
   * `changes_requested` derived from findings shares their fate.
   */
  providerVerdict: string | null;
  /** Verified reviewed revision; `null` only when no finding resolved a head. */
  headSha: string | null;
  score: number | null;
  findings: GreptileFinding[];
  /** Blocking findings that hold for `headSha`. */
  blockingFindings: number;
  /**
   * Blocking findings whose exact review thread is resolved on a revision this
   * head does not carry. They are review-provenance waits — a fresh review of
   * the head is the next step — never code repair, and never cleared by
   * re-reading the same stale thread.
   */
  staleResolutionFindings: number;
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
    /**
     * GitHub's own head of the pull request under evaluation — the revision
     * acceptance is being evaluated for. It is the lookup key for head-proof
     * evidence and is never itself returned as a reviewed head.
     */
    headSha: string;
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
    // Correlated later, against GitHub's own review-thread record; until then
    // the finding has no resolution evidence at all.
    reviewThread: null,
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

/**
 * Whether a provider's own verdict text is a rejection.
 *
 * One definition, used by the review status and by both evidence assemblers, so
 * an explicit provider rejection can never drift into being treated as
 * harmless at one call site and blocking at another. A rejection here stands on
 * its own; a `changes_requested` status derived from findings does not.
 */
export function providerVerdictRejects(verdict: string | null): boolean {
  return verdict === "changes_requested"
    || verdict === "failed"
    || verdict === "failure"
    || verdict === "error";
}

function statusOf(input: {
  reviewState: GreptileReviewState;
  blockingFindings: number;
  providerStatus: string | null;
  providerFindings: number;
}): GreptileReview["status"] {
  if (input.blockingFindings > 0) return "changes_requested";
  if (providerVerdictRejects(input.providerStatus)) {
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

/**
 * The GitHub App slug that proves a check run was produced by the real
 * Greptile app. GitHub records `app.slug` from the app's own authenticated
 * request, so a check run created by any other integration — however it names
 * itself — never carries this provenance.
 */
function isGreptileCheckApp(slug: string): boolean {
  return slug.toLowerCase() === "greptile-apps";
}

/**
 * GitHub-side proof that the Greptile app itself completed a successful review
 * of the exact head under evaluation.
 *
 * GitHub's review list only carries review objects, and a clean Greptile
 * re-review adds no comments and no new review object — the app reports the
 * completed review of the new head as a check run instead. Such a run proves
 * the reviewed head only when every layer binds to the same facts:
 *
 * - the run was created by the Greptile app itself (`app.slug`), not by any
 *   other check that happens to be named "Greptile";
 * - GitHub's own `head_sha` for the run is the exact head under evaluation;
 *   the head is only ever the lookup key, never substituted as evidence;
 * - the run is `completed` with conclusion `success`;
 * - it is the latest Greptile outcome on that head, ordered by GitHub's own
 *   completion time: a later in-progress or failed Greptile run supersedes an
 *   older success, and an outcome without a usable completion time cannot be
 *   ordered, so the latest outcome is unknown.
 *
 * A failed or unreadable read, or any run failing these conditions, is no
 * proof and the caller keeps its existing conservative evidence.
 */
async function greptileHeadProof(
  github: Pick<GitHubDeliveryClient, "getCheckRuns">,
  input: GreptileReadInput,
): Promise<boolean> {
  const headSha = input.correlation.headSha.toLowerCase();
  if (!SHA_PATTERN.test(headSha)) return false;
  const runs = await github.getCheckRuns(
    input.companyId,
    input.correlation.connectionId,
    input.correlation.host,
    input.correlation.owner,
    input.correlation.repo,
    headSha,
  );
  if (!runs.ok) return false;
  const greptileRuns = runs.value.filter((run) =>
    run.appSlug !== null
    && isGreptileCheckApp(run.appSlug)
    && run.headSha !== null
    && SHA_PATTERN.test(run.headSha)
    && run.headSha.toLowerCase() === headSha
  );
  if (greptileRuns.length === 0) return false;
  const completedAt = (run: (typeof greptileRuns)[number]) => {
    const parsed = Date.parse(run.completedAt ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  if (greptileRuns.some((run) => completedAt(run) === 0)) return false;
  greptileRuns.sort((a, b) => completedAt(b) - completedAt(a) || (b.id ?? 0) - (a.id ?? 0));
  const latest = greptileRuns[0]!;
  return latest.status?.toLowerCase() === "completed" && latest.conclusion?.toLowerCase() === "success";
}

export interface GreptileReviewService {
  read(input: GreptileReadInput): Promise<GreptileReadResult>;
}

export function greptileReviewService(
  db: Db,
  deps: {
    toolGateway: Pick<ToolGatewayService, "readConnectedTool">;
    github: Pick<GitHubDeliveryClient, "getReviewComments" | "getReviews" | "getCheckRuns" | "getReviewThreads" | "compareCommits">;
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
    // to GitHub's own record of the commit that comment belongs to, and to the
    // review thread that carries it. The thread record is required exactly when
    // there is a finding identity it could clear — with no findings nothing can
    // be resolved and the read would add no evidence — and when it is required
    // an unreadable record is a failed read, never a partial one.
    const args = [
      input.companyId, input.correlation.connectionId, input.correlation.host,
      input.correlation.owner, input.correlation.repo, input.prNumber,
    ] as const;
    const [githubComments, githubReviews, githubThreads] = await Promise.all([
      deps.github.getReviewComments(...args),
      deps.github.getReviews(...args),
      findings.length > 0
        ? deps.github.getReviewThreads(...args)
        : Promise.resolve({ ok: true as const, value: [] as GitHubReviewThread[] }),
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
    if (!githubThreads.ok) {
      return {
        ok: false,
        errorCode: "provider_unknown",
        message: `Greptile findings could not be matched to GitHub's review threads: ${githubThreads.message}`,
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
    // A finding resolves through the exact comment identity GitHub published.
    // An identity GitHub reported in more than one thread is ambiguous, so it
    // proves nothing and the finding keeps its unresolved/unknown state.
    const threadsByCommentId = new Map<string, { thread: GitHubReviewThread; ambiguous: boolean }>();
    for (const thread of githubThreads.value) {
      for (const comment of thread.comments) {
        const existing = threadsByCommentId.get(comment.id);
        if (!existing) {
          threadsByCommentId.set(comment.id, { thread, ambiguous: false });
          continue;
        }
        if (existing.thread.id !== thread.id) existing.ambiguous = true;
      }
    }

    const headCandidates = new Map<string, number>();
    for (const finding of findings) {
      const correlated = commentsByIdentity.get(finding.externalId);
      if (!correlated || correlated.ambiguous || !correlated.commitSha) continue;
      finding.commitSha = correlated.commitSha.toLowerCase();
      headCandidates.set(finding.commitSha, (headCandidates.get(finding.commitSha) ?? 0) + 1);
    }
    /**
     * Whether a resolved thread's revision is the head under evaluation, or is
     * provably contained in it (GitHub's own compare).
     *
     * A resolution clears a finding only for the revision it belongs to. The
     * evaluated head, or a revision the head provably contains, is that
     * revision. Anything else — a superseded or divergent revision, a comment
     * with no published commit, an unreadable compare — is not current-head
     * evidence: the finding keeps its unresolved state instead of being cleared
     * by a resolution that was never about this revision. Ancestry is asked
     * once per resolved revision and never inferred from the candidate head.
     */
    const evaluatedHead = input.correlation.headSha.toLowerCase();
    const ancestry = new Map<string, boolean>();
    const resolutionIsCurrentHead = async (resolutionCommitSha: string | null): Promise<boolean> => {
      if (!resolutionCommitSha) return false;
      const revision = resolutionCommitSha.toLowerCase();
      if (revision === evaluatedHead) return true;
      const cached = ancestry.get(revision);
      if (cached !== undefined) return cached;
      const compared = await deps.github.compareCommits(
        input.companyId, input.correlation.connectionId, input.correlation.host,
        input.correlation.owner, input.correlation.repo, revision, evaluatedHead,
      );
      const included = compared.ok && compared.value.included;
      ancestry.set(revision, included);
      return included;
    };
    for (const finding of findings) {
      const correlated = threadsByCommentId.get(finding.externalId);
      if (!correlated || correlated.ambiguous) {
        finding.reviewThread = null;
        continue;
      }
      const thread = correlated.thread;
      // GitHub returns a thread's comments oldest first, so the last one is the
      // newest revision the thread has actually been discussed on.
      const resolutionCommitSha = thread.comments.at(-1)?.commitSha ?? null;
      finding.reviewThread = {
        id: thread.id,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
        commitSha: resolutionCommitSha,
        currentHead: thread.isResolved && await resolutionIsCurrentHead(resolutionCommitSha),
      };
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
    // GitHub's review record can lag the provider: a clean Greptile re-review
    // of the current head adds no comments and no new review object, so the
    // latest review entry still names the older revision. The Greptile app's
    // own completed successful check run on the exact head is then GitHub's
    // authoritative record that this head was reviewed (see
    // `greptileHeadProof`). The provider must itself report the review
    // completed — a check run never outranks a review the provider still has
    // in flight.
    if (provider.state === "completed" && headSha !== input.correlation.headSha.toLowerCase()) {
      if (await greptileHeadProof(deps.github, input)) headSha = input.correlation.headSha.toLowerCase();
    }
    if (!headSha && provider.state === "completed") {
      return {
        ok: false,
        errorCode: "provider_unknown",
        message: "Greptile evidence does not resolve to an authoritative revision",
      };
    }
    // Unaddressed findings remain blocking across revisions until Greptile
    // clears them or the pull request resolves the thread that carries them, on
    // a revision this head carries. A resolution on a revision the head does
    // not carry is not current-head evidence: it clears nothing, it is never
    // silently promoted by being read again later, and it is reported
    // separately so the controller can treat it as a review-provenance wait
    // instead of code repair. An old comment commit is not evidence that a
    // finding was fixed, and an unresolved or outdated thread clears nothing.
    const clears = (finding: GreptileFinding) =>
      finding.reviewThread?.resolved === true && finding.reviewThread.currentHead === true;
    const blockingFindings = findings.filter((finding) => finding.blocking && !clears(finding)).length;
    const staleResolutionFindings = findings.filter((finding) => finding.blocking && !clears(finding)
      && finding.reviewThread?.resolved === true).length;
    const providerVerdict = provider.verdict ?? providerStatusOf(reviewPayload);
    return {
      ok: true,
      status: statusOf({
        reviewState: provider.state,
        blockingFindings,
        providerStatus: providerVerdict,
        providerFindings: findings.length,
      }),
      reviewState: provider.state,
      providerVerdict,
      headSha,
      score: provider.score,
      findings,
      blockingFindings,
      staleResolutionFindings,
      providerFindings: findings.length,
      raw: { review: reviewPayload, comments: commentsPayload },
    };
  }

  return { read };
}
