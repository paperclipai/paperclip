import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { GitHubClient } from "../auth.js";
import type { ResolvedConfig } from "../config.js";
import { RefusalError, type HandlerEnv } from "../audit.js";

export interface OpenPrParams {
  issueId: string;
  branch: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
}

export interface OpenPrResult {
  prNumber: number;
  htmlUrl: string;
  headSha: string;
}

const ISSUE_REF_PATTERN = /(#\d+|paperclip[:/][a-z0-9-]+)/i;

export async function openPr(
  client: GitHubClient,
  cfg: ResolvedConfig,
  params: unknown,
  _runCtx: ToolRunContext,
  _env: HandlerEnv,
): Promise<ToolResult> {
  const p = parseOpenPr(params);

  // Refusal rule: "no merge without a tracked task". PRs that do not mention
  // an issue or paperclip task in the body bypass Delivery Lead.
  const bodyWithIssue = ensureIssueRef(p.body, p.issueId);
  if (!ISSUE_REF_PATTERN.test(bodyWithIssue)) {
    throw new RefusalError("missing_issue_ref", "PR body must reference issueId");
  }

  const { data } = await client.rest.pulls.create({
    owner: client.owner,
    repo: client.name,
    title: p.title,
    head: p.branch,
    base: cfg.defaultBranch,
    body: bodyWithIssue,
    draft: p.draft ?? true,
  });

  if (p.labels && p.labels.length > 0) {
    await client.rest.issues.addLabels({
      owner: client.owner,
      repo: client.name,
      issue_number: data.number,
      labels: p.labels,
    });
  }

  const result: OpenPrResult = {
    prNumber: data.number,
    htmlUrl: data.html_url,
    headSha: data.head.sha,
  };
  return { content: `opened PR #${data.number}`, data: result };
}

export interface GetPrResult {
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeStateStatus: string;
  headSha: string;
  baseSha: string;
  allChecks: string[];
  failingChecks: string[];
  passingChecks: string[];
  reviewDecision: string | null;
}

export interface PrMutationGuardParams {
  repository: string;
  prNumber: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
}

export interface UpdatePrBodyParams extends PrMutationGuardParams {
  body: string;
  expectedCurrentBody?: string;
}

export interface UpdatePrParams extends PrMutationGuardParams {
  title?: string;
  body?: string;
  base?: string;
  expectedCurrentTitle?: string;
  expectedCurrentBody?: string;
}

export interface ClosePrParams extends PrMutationGuardParams {
  reason: string;
  commentBody?: string;
}

export interface ConvertPrToDraftParams extends PrMutationGuardParams {}
export interface MarkPrReadyForReviewParams extends PrMutationGuardParams {}

export interface RepairPrHeadParams extends PrMutationGuardParams {
  targetHeadSha: string;
  sourceRepository?: string;
  force?: boolean;
}

export interface PrMutationResult {
  repository: string;
  prNumber: number;
  htmlUrl: string;
  headSha: string;
  baseSha: string;
  state: string;
  title: string;
  baseRef: string;
  draft: boolean;
  mutation: string;
  verified: boolean;
  changed: boolean;
  actor: {
    agentId: string;
    runId: string;
  };
}

const GET_PR_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        isDraft
        mergeable
        mergeStateStatus
        baseRefOid
        headRefOid
        reviewDecision
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      status
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PR_ID_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
      }
    }
  }
`;

const CONVERT_TO_DRAFT_MUTATION = /* GraphQL */ `
  mutation ($prId: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $prId }) {
      pullRequest {
        id
        isDraft
      }
    }
  }
`;

const MARK_READY_MUTATION = /* GraphQL */ `
  mutation ($prId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $prId }) {
      pullRequest {
        id
        isDraft
      }
    }
  }
`;

interface PrGraphqlResponse {
  repository: {
    pullRequest: {
      state: string;
      isDraft: boolean;
      mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
      mergeStateStatus: string;
      baseRefOid: string;
      headRefOid: string;
      reviewDecision: string | null;
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: Array<
                  | { __typename: "CheckRun"; name: string; conclusion: string | null; status: string }
                  | { __typename: "StatusContext"; context: string; state: string }
                >;
              };
            } | null;
          };
        }>;
      };
    };
  };
}

interface PrIdResponse {
  repository: { pullRequest: { id: string } | null } | null;
}

interface PullRequestSnapshot {
  repository: string;
  prNumber: number;
  htmlUrl: string;
  state: string;
  title: string;
  draft: boolean;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  headRepository: string;
  body: string;
}

export async function getPr(
  client: GitHubClient,
  params: unknown,
  _runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseGetPr(params);
  const resp = await client.graphql<PrGraphqlResponse>(GET_PR_QUERY, {
    owner: client.owner,
    repo: client.name,
    number: p.prNumber,
  });
  const pr = resp.repository.pullRequest;
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;

  const passingChecks: string[] = [];
  const failingChecks: string[] = [];

  for (const ctxNode of rollup?.contexts.nodes ?? []) {
    if (ctxNode.__typename === "CheckRun") {
      if (ctxNode.status !== "COMPLETED") continue;
      const ok = ctxNode.conclusion === "SUCCESS" || ctxNode.conclusion === "NEUTRAL" || ctxNode.conclusion === "SKIPPED";
      (ok ? passingChecks : failingChecks).push(ctxNode.name);
    } else {
      if (ctxNode.state === "PENDING") continue;
      const ok = ctxNode.state === "SUCCESS";
      (ok ? passingChecks : failingChecks).push(ctxNode.context);
    }
  }

  const result: GetPrResult = {
    state: pr.state,
    draft: pr.isDraft,
    mergeable: pr.mergeable === "UNKNOWN" ? null : pr.mergeable === "MERGEABLE",
    mergeStateStatus: pr.mergeStateStatus,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    allChecks: passingChecks.concat(failingChecks),
    passingChecks,
    failingChecks,
    reviewDecision: pr.reviewDecision,
  };
  return { content: `PR #${p.prNumber}: ${pr.state} (${pr.mergeStateStatus})`, data: result };
}

export async function updatePrBody(
  client: GitHubClient,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseUpdatePrBody(params);
  const before = await readGuardedPr(client, p);
  if (p.expectedCurrentBody !== undefined && before.body !== p.expectedCurrentBody) {
    throw new RefusalError("expected_body_mismatch", `PR #${p.prNumber} body changed before update`);
  }

  await githubCall(
    () =>
      client.rest.pulls.update({
        owner: client.owner,
        repo: client.name,
        pull_number: p.prNumber,
        body: p.body,
      }),
    "update pull request body",
  );

  const after = await readPrSnapshot(client, p.prNumber);
  verifyReadback(client, p, after);
  if (after.body !== p.body) {
    throw new RefusalError("github_api_failed", `PR #${p.prNumber} body readback did not match requested body`);
  }

  return {
    content: `PR #${p.prNumber} body updated`,
    data: buildMutationResult("update_body", before, after, runCtx),
  };
}

export async function updatePr(
  client: GitHubClient,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseUpdatePr(params);
  const before = await readGuardedPr(client, p);
  if (p.expectedCurrentTitle !== undefined && before.title !== p.expectedCurrentTitle) {
    throw new RefusalError("expected_title_mismatch", `PR #${p.prNumber} title changed before update`);
  }
  if (p.expectedCurrentBody !== undefined && before.body !== p.expectedCurrentBody) {
    throw new RefusalError("expected_body_mismatch", `PR #${p.prNumber} body changed before update`);
  }

  await githubCall(
    () =>
      client.rest.pulls.update({
        owner: client.owner,
        repo: client.name,
        pull_number: p.prNumber,
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(p.body === undefined ? {} : { body: p.body }),
        ...(p.base === undefined ? {} : { base: p.base }),
      }),
    "update pull request",
  );

  const after = await readPrSnapshot(client, p.prNumber);
  verifyMutationReadback(client, p, after);
  if (p.title !== undefined && after.title !== p.title) {
    throw new RefusalError("github_api_failed", `PR #${p.prNumber} title readback did not match requested title`);
  }
  if (p.body !== undefined && after.body !== p.body) {
    throw new RefusalError("github_api_failed", `PR #${p.prNumber} body readback did not match requested body`);
  }
  if (p.base !== undefined && after.baseRef !== p.base) {
    throw new RefusalError("github_api_failed", `PR #${p.prNumber} base readback did not match requested base`);
  }

  return {
    content: `PR #${p.prNumber} updated`,
    data: buildMutationResult("update_pr", before, after, runCtx),
  };
}

export async function closePr(
  client: GitHubClient,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseClosePr(params);
  const before = await readGuardedPr(client, p);

  await githubCall(
    () =>
      client.rest.issues.createComment({
        owner: client.owner,
        repo: client.name,
        issue_number: p.prNumber,
        body: buildCloseComment(p, runCtx),
      }),
    "write pull request close audit comment",
  );

  await githubCall(
    () =>
      client.rest.pulls.update({
        owner: client.owner,
        repo: client.name,
        pull_number: p.prNumber,
        state: "closed",
      }),
    "close pull request",
  );

  const after = await readPrSnapshot(client, p.prNumber);
  verifyReadback(client, p, after);
  if (after.state !== "closed") {
    throw new RefusalError("github_api_failed", `PR #${p.prNumber} state readback did not match closed`);
  }

  return {
    content: `PR #${p.prNumber} closed`,
    data: buildMutationResult("close_pr", before, after, runCtx),
  };
}

export async function convertPrToDraft(
  client: GitHubClient,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseConvertPrToDraft(params);
  const before = await readGuardedPr(client, p);

  if (!before.draft) {
    const prId = await readPrId(client, p.prNumber);
    await githubCall(
      () => client.graphql(CONVERT_TO_DRAFT_MUTATION, { prId }),
      "convert pull request to draft",
    );
  }

  const after = await readPrSnapshot(client, p.prNumber);
  verifyReadback(client, p, after);
  if (!after.draft) {
    throw new RefusalError("github_api_failed", `PR #${p.prNumber} draft readback did not match requested state`);
  }

  return {
    content: `PR #${p.prNumber} is draft`,
    data: buildMutationResult("convert_to_draft", before, after, runCtx),
  };
}

export async function markPrReadyForReview(
  client: GitHubClient,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseMarkPrReadyForReview(params);
  const before = await readGuardedPr(client, p);

  if (before.draft) {
    const prId = await readPrId(client, p.prNumber);
    await githubCall(
      () => client.graphql(MARK_READY_MUTATION, { prId }),
      "mark pull request ready for review",
    );
  }

  const after = await readPrSnapshot(client, p.prNumber);
  verifyReadback(client, p, after);
  if (after.draft) {
    throw new RefusalError("github_api_failed", `PR #${p.prNumber} draft readback did not match requested state`);
  }

  return {
    content: `PR #${p.prNumber} is ready for review`,
    data: buildMutationResult("mark_ready_for_review", before, after, runCtx),
  };
}

export async function repairPrHead(
  client: GitHubClient,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseRepairPrHead(params);
  const before = await readGuardedPr(client, p);
  const configuredRepository = getConfiguredRepository(client);
  if (!sameRepository(before.headRepository, configuredRepository)) {
    throw new RefusalError(
      "unauthorized_head_branch",
      `PR #${p.prNumber} head repository ${before.headRepository} is not ${configuredRepository}`,
    );
  }

  const sourceRepository = p.sourceRepository ?? configuredRepository;
  if (!sameRepository(sourceRepository, configuredRepository)) {
    throw new RefusalError(
      "authorization_failed",
      `sourceRepository ${sourceRepository} is not the configured repository ${configuredRepository}`,
    );
  }
  const source = splitRepositoryName(sourceRepository);
  await githubCall(
    () =>
      client.rest.git.getCommit({
        owner: source.owner,
        repo: source.name,
        commit_sha: p.targetHeadSha,
      }),
    "verify target commit",
  );

  await githubCall(
    () =>
      client.rest.git.updateRef({
        owner: client.owner,
        repo: client.name,
        ref: toHeadsRef(before.headRef),
        sha: p.targetHeadSha,
        force: p.force ?? false,
      }),
    "update pull request head branch",
  );

  const after = await readPrSnapshot(client, p.prNumber);
  verifyReadback(client, { ...p, expectedHeadSha: p.targetHeadSha }, after);

  return {
    content: `PR #${p.prNumber} head repaired`,
    data: buildMutationResult("repair_head", before, after, runCtx),
  };
}

function ensureIssueRef(body: string, issueId: string): string {
  if (ISSUE_REF_PATTERN.test(body)) return body;
  return `${body}\n\nFixes #${issueId}`;
}

function parseOpenPr(params: unknown): OpenPrParams {
  if (typeof params !== "object" || params === null) {
    throw new Error("openPr: params must be an object");
  }
  const p = params as Record<string, unknown>;
  if (typeof p.issueId !== "string" || !p.issueId.trim()) throw new Error("issueId required");
  if (typeof p.branch !== "string" || !p.branch.trim()) throw new Error("branch required");
  if (typeof p.title !== "string" || !p.title.trim()) throw new Error("title required");
  if (typeof p.body !== "string") throw new Error("body required");
  return {
    issueId: p.issueId,
    branch: p.branch,
    title: p.title,
    body: p.body,
    draft: typeof p.draft === "boolean" ? p.draft : undefined,
    labels: Array.isArray(p.labels) ? p.labels.filter((x): x is string => typeof x === "string") : undefined,
  };
}

function parseGetPr(params: unknown): { prNumber: number } {
  if (typeof params !== "object" || params === null) throw new Error("getPr: params must be an object");
  const p = params as Record<string, unknown>;
  if (typeof p.prNumber !== "number") throw new Error("prNumber required");
  return { prNumber: p.prNumber };
}

function parseUpdatePrBody(params: unknown): UpdatePrBodyParams {
  const p = parseGuardParams(params, "updatePrBody");
  const raw = params as Record<string, unknown>;
  if (typeof raw.body !== "string") throw new Error("body required");
  if (raw.expectedCurrentBody !== undefined && typeof raw.expectedCurrentBody !== "string") {
    throw new Error("expectedCurrentBody must be a string");
  }
  return {
    ...p,
    body: raw.body,
    expectedCurrentBody:
      typeof raw.expectedCurrentBody === "string" ? raw.expectedCurrentBody : undefined,
  };
}

function parseUpdatePr(params: unknown): UpdatePrParams {
  const p = parseGuardParams(params, "updatePr");
  const raw = params as Record<string, unknown>;
  const title = readOptionalNonEmptyString(raw, "title");
  const body = readOptionalString(raw, "body");
  const base = readOptionalBaseRef(raw, "base");
  if (title === undefined && body === undefined && base === undefined) {
    throw new Error("title, body, or base required");
  }
  return {
    ...p,
    title,
    body,
    base,
    expectedCurrentTitle: readOptionalString(raw, "expectedCurrentTitle"),
    expectedCurrentBody: readOptionalString(raw, "expectedCurrentBody"),
  };
}

function parseClosePr(params: unknown): ClosePrParams {
  const p = parseGuardParams(params, "closePr");
  const raw = params as Record<string, unknown>;
  const reason = readNonEmptyString(raw, "reason");
  const commentBody = readOptionalString(raw, "commentBody");
  if (commentBody !== undefined && commentBody.trim() === "") {
    throw new Error("commentBody must not be empty");
  }
  return {
    ...p,
    reason,
    commentBody,
  };
}

function parseConvertPrToDraft(params: unknown): ConvertPrToDraftParams {
  return parseGuardParams(params, "convertPrToDraft");
}

function parseMarkPrReadyForReview(params: unknown): MarkPrReadyForReviewParams {
  return parseGuardParams(params, "markPrReadyForReview");
}

function parseRepairPrHead(params: unknown): RepairPrHeadParams {
  const p = parseGuardParams(params, "repairPrHead");
  const raw = params as Record<string, unknown>;
  return {
    ...p,
    targetHeadSha: readSha(raw, "targetHeadSha"),
    sourceRepository: readOptionalRepository(raw, "sourceRepository"),
    force: typeof raw.force === "boolean" ? raw.force : undefined,
  };
}

function parseGuardParams(params: unknown, toolName: string): PrMutationGuardParams {
  if (typeof params !== "object" || params === null) {
    throw new Error(`${toolName}: params must be an object`);
  }
  const p = params as Record<string, unknown>;
  return {
    repository: readRepository(p, "repository"),
    prNumber: readPositiveInteger(p, "prNumber"),
    expectedHeadSha: readSha(p, "expectedHeadSha"),
    expectedBaseSha: readSha(p, "expectedBaseSha"),
  };
}

async function readGuardedPr(
  client: GitHubClient,
  p: PrMutationGuardParams,
): Promise<PullRequestSnapshot> {
  assertConfiguredRepository(client, p.repository);
  const snapshot = await readPrSnapshot(client, p.prNumber);
  verifyReadback(client, p, snapshot);
  if (snapshot.state !== "open") {
    throw new RefusalError("pr_not_open", `PR #${p.prNumber} state=${snapshot.state}`);
  }
  return snapshot;
}

async function readPrSnapshot(client: GitHubClient, prNumber: number): Promise<PullRequestSnapshot> {
  const { data } = await githubCall(
    () =>
      client.rest.pulls.get({
        owner: client.owner,
        repo: client.name,
        pull_number: prNumber,
      }),
    "read pull request",
  );
  const headRepository = data.head.repo?.full_name ?? "";
  return {
    repository: getConfiguredRepository(client),
    prNumber: data.number,
    htmlUrl: data.html_url,
    state: data.state,
    title: data.title,
    draft: data.draft ?? false,
    headSha: data.head.sha,
    baseSha: data.base.sha,
    baseRef: data.base.ref,
    headRef: data.head.ref,
    headRepository,
    body: data.body ?? "",
  };
}

async function readPrId(client: GitHubClient, prNumber: number): Promise<string> {
  const resp = await githubCall(
    () =>
      client.graphql<PrIdResponse>(PR_ID_QUERY, {
        owner: client.owner,
        repo: client.name,
        number: prNumber,
      }),
    "read pull request id",
  );
  const prId = resp.repository?.pullRequest?.id;
  if (!prId) {
    throw new RefusalError("github_api_failed", `GitHub returned no pull request id for PR #${prNumber}`);
  }
  return prId;
}

function verifyReadback(
  client: GitHubClient,
  p: PrMutationGuardParams,
  snapshot: PullRequestSnapshot,
): void {
  assertConfiguredRepository(client, p.repository);
  if (!sameSha(snapshot.headSha, p.expectedHeadSha)) {
    throw new RefusalError(
      "expected_head_mismatch",
      `PR #${p.prNumber} expected head ${p.expectedHeadSha}, found ${snapshot.headSha}`,
    );
  }
  if (!sameSha(snapshot.baseSha, p.expectedBaseSha)) {
    throw new RefusalError(
      "expected_base_mismatch",
      `PR #${p.prNumber} expected base ${p.expectedBaseSha}, found ${snapshot.baseSha}`,
    );
  }
}

function verifyMutationReadback(
  client: GitHubClient,
  p: UpdatePrParams,
  snapshot: PullRequestSnapshot,
): void {
  assertConfiguredRepository(client, p.repository);
  if (!sameSha(snapshot.headSha, p.expectedHeadSha)) {
    throw new RefusalError(
      "expected_head_mismatch",
      `PR #${p.prNumber} expected head ${p.expectedHeadSha}, found ${snapshot.headSha}`,
    );
  }
  if (p.base === undefined && !sameSha(snapshot.baseSha, p.expectedBaseSha)) {
    throw new RefusalError(
      "expected_base_mismatch",
      `PR #${p.prNumber} expected base ${p.expectedBaseSha}, found ${snapshot.baseSha}`,
    );
  }
}

function buildMutationResult(
  mutation: string,
  before: PullRequestSnapshot,
  after: PullRequestSnapshot,
  runCtx: ToolRunContext,
): PrMutationResult {
  return {
    repository: after.repository,
    prNumber: after.prNumber,
    htmlUrl: after.htmlUrl,
    headSha: after.headSha,
    baseSha: after.baseSha,
    state: after.state,
    title: after.title,
    baseRef: after.baseRef,
    draft: after.draft,
    mutation,
    verified: true,
    changed:
      before.headSha !== after.headSha ||
      before.baseSha !== after.baseSha ||
      before.baseRef !== after.baseRef ||
      before.state !== after.state ||
      before.title !== after.title ||
      before.draft !== after.draft ||
      before.body !== after.body,
    actor: {
      agentId: runCtx.agentId,
      runId: runCtx.runId,
    },
  };
}

function buildCloseComment(p: ClosePrParams, runCtx: ToolRunContext): string {
  const lines = [
    "Paperclip typed PR close",
    "",
    `Reason: ${p.reason.trim()}`,
    `Agent: ${runCtx.agentId}`,
    `Run: ${runCtx.runId}`,
  ];
  if (p.commentBody !== undefined) {
    lines.push("", p.commentBody.trim());
  }
  return lines.join("\n");
}

async function githubCall<T>(operation: () => Promise<T>, action: string): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof RefusalError) throw err;
    throw mapGitHubError(err, action);
  }
}

function mapGitHubError(err: unknown, action: string): RefusalError {
  const status = readStatus(err);
  const message = readErrorMessage(err);
  const lower = message.toLowerCase();
  const code =
    lower.includes("protected") || lower.includes("branch protection") || lower.includes("ruleset")
      ? "branch_protected"
      : status === 401 || status === 403
        ? "authorization_failed"
        : "github_api_failed";
  const statusText = status === undefined ? "" : ` (${status})`;
  return new RefusalError(code, `${action} failed${statusText}: ${message}`);
}

function readStatus(err: unknown): number | undefined {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
}

function readErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "object" && err !== null) {
    const responseMessage = (err as { response?: { data?: { message?: unknown } } }).response?.data?.message;
    if (typeof responseMessage === "string" && responseMessage.trim()) return responseMessage;
  }
  return String(err);
}

function assertConfiguredRepository(client: GitHubClient, repository: string): void {
  const configured = getConfiguredRepository(client);
  if (!sameRepository(repository, configured)) {
    throw new RefusalError("authorization_failed", `repository ${repository} is not configured repository ${configured}`);
  }
}

function getConfiguredRepository(client: GitHubClient): string {
  return `${client.owner}/${client.name}`;
}

function splitRepositoryName(repository: string): { owner: string; name: string } {
  const [owner, name] = repository.split("/");
  return { owner: owner!, name: name! };
}

function toHeadsRef(headRef: string): string {
  if (
    !headRef ||
    headRef.startsWith("/") ||
    headRef.endsWith("/") ||
    headRef.startsWith("refs/") ||
    headRef.includes("..") ||
    headRef.includes("\\") ||
    headRef.endsWith(".lock")
  ) {
    throw new RefusalError("authorization_failed", `unsafe pull request head ref: ${headRef}`);
  }
  return `heads/${headRef}`;
}

function readRepository(p: Record<string, unknown>, key: string): string {
  const value = p[key];
  if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value.trim())) {
    throw new Error(`${key} required in owner/name form`);
  }
  return value.trim();
}

function readOptionalRepository(p: Record<string, unknown>, key: string): string | undefined {
  if (p[key] === undefined) return undefined;
  return readRepository(p, key);
}

function readOptionalString(p: Record<string, unknown>, key: string): string | undefined {
  const value = p[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function readOptionalNonEmptyString(p: Record<string, unknown>, key: string): string | undefined {
  const value = readOptionalString(p, key);
  if (value !== undefined && value.trim() === "") throw new Error(`${key} must not be empty`);
  return value;
}

function readNonEmptyString(p: Record<string, unknown>, key: string): string {
  const value = readOptionalNonEmptyString(p, key);
  if (value === undefined) throw new Error(`${key} required`);
  return value.trim();
}

function readOptionalBaseRef(p: Record<string, unknown>, key: string): string | undefined {
  const value = readOptionalNonEmptyString(p, key);
  if (value === undefined) return undefined;
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith("refs/") ||
    value.includes("..") ||
    value.includes("\\") ||
    value.endsWith(".lock")
  ) {
    throw new Error(`${key} must be a branch name, not a raw ref`);
  }
  return value;
}

function readPositiveInteger(p: Record<string, unknown>, key: string): number {
  const value = p[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} required`);
  }
  return value;
}

function readSha(p: Record<string, unknown>, key: string): string {
  const value = p[key];
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value.trim())) {
    throw new Error(`${key} must be a full 40-character git SHA`);
  }
  return value.trim();
}

function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameSha(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
