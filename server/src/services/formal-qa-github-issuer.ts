import { createHash } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { formalQaIssuances, formalQaPolicies, formalQaPreparations, projectWorkspaces } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { formalQaCheckoutService } from "./formal-qa-checkouts.js";
import { secretService } from "./secrets.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;
type PreparationRow = typeof formalQaPreparations.$inferSelect;
type PolicyRow = typeof formalQaPolicies.$inferSelect;

/** The issuer accepts only a durable Board request identifier. */
export type FormalQaGitHubIssuerInput = { preparationId: string };
type GitHubTokenProvider = (input: { companyId: string; responsibleUserId: string }) => Promise<string | null>;
type PullSnapshot = { state: string; draft: boolean; merged: boolean; updatedAt: string; headSha: string; baseRef: string; baseSha: string };
type CheckSnapshot = { id: string; checkSuiteId: string; name: string; appId: number; status: string; conclusion: string; completedAt: string };
type WorkflowSnapshot = { id: string; workflowId: string; checkSuiteId: string; headSha: string };

const SHA40_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const MAX_EXPIRY_MS = 6 * 60 * 60 * 1000;

function asRecord(value: unknown): RecordValue | null { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null; }
function asString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function asId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
function asBoolean(value: unknown): boolean | null { return typeof value === "boolean" ? value : null; }
function nestedString(record: RecordValue, first: string, second: string): string | null { const nested = asRecord(record[first]); return nested ? asString(nested[second]) : null; }
function issuerFailure(message: string, code: string): never { throw conflict(message, { code }); }

function canonicalRepository(value: string): string | null {
  const trimmed = value.trim();
  if (REPOSITORY_RE.test(trimmed)) return trimmed.toLowerCase();
  const ssh = trimmed.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (ssh && REPOSITORY_RE.test(ssh[1]!)) return ssh[1]!.replace(/\.git$/i, "").toLowerCase();
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const pathname = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return REPOSITORY_RE.test(pathname) ? pathname.toLowerCase() : null;
  } catch { return null; }
}

/** Persist canonical bytes, redacting unexpected credential-named fields. */
function sanitizeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 32 * 1024) : value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = /(?:authorization|password|secret|token)/i.test(key)
      ? "[REDACTED]"
      : sanitizeEvidence((value as Record<string, unknown>)[key]);
  }
  return result;
}
function canonicalJson(value: unknown): string { return JSON.stringify(sanitizeEvidence(value)); }

async function readJson(fetchImpl: FetchLike, url: string, token: string, failureCode: string) {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "paperclip-formal-qa-issuer", "x-github-api-version": "2022-11-28" } });
  } catch { issuerFailure("GitHub could not be reached while issuing Formal-QA", failureCode); }
  if (!response!.ok || response!.redirected) issuerFailure("GitHub did not authorize the Formal-QA issuance read", failureCode);
  const body = asRecord(await response!.json().catch(() => null));
  if (!body) issuerFailure("GitHub returned invalid Formal-QA issuance data", failureCode);
  return { body, etag: response!.headers.get("etag") ?? "", link: response!.headers.get("link") ?? "" };
}

function parsePull(body: RecordValue): PullSnapshot {
  const state = asString(body.state);
  const draft = asBoolean(body.draft);
  const merged = asBoolean(body.merged) ?? Boolean(asString(body.merged_at));
  const updatedAt = asString(body.updated_at);
  const headSha = nestedString(body, "head", "sha")?.toLowerCase() ?? null;
  const baseRef = nestedString(body, "base", "ref");
  const baseSha = nestedString(body, "base", "sha")?.toLowerCase() ?? null;
  if (!state || draft === null || !updatedAt || !headSha || !baseRef || !baseSha || !SHA40_RE.test(headSha) || !SHA40_RE.test(baseSha)) issuerFailure("GitHub pull request snapshot is incomplete", "formal_qa_github_invalid_response");
  if (state !== "open" || draft || merged) issuerFailure("GitHub pull request is not an open, ready Formal-QA candidate", "formal_qa_pull_not_eligible");
  return { state, draft, merged, updatedAt, headSha, baseRef, baseSha };
}
function parseTree(body: RecordValue, expectedHeadSha: string): string {
  const commitSha = asString(body.sha)?.toLowerCase() ?? null;
  const tree = asRecord(body.tree);
  const treeSha = tree ? asString(tree.sha)?.toLowerCase() ?? null : null;
  if (commitSha !== expectedHeadSha || !treeSha || !SHA40_RE.test(treeSha)) issuerFailure("GitHub exact commit/tree snapshot is incomplete", "formal_qa_github_invalid_response");
  return treeSha;
}
function parseRequiredCheck(input: { body: RecordValue; hasNextPage: boolean; policy: PolicyRow; headSha: string }): CheckSnapshot {
  if (typeof input.body.total_count !== "number" || !Number.isSafeInteger(input.body.total_count) || input.body.total_count < 0 || input.hasNextPage) issuerFailure("GitHub required Formal-QA trigger checks are incomplete", "formal_qa_required_check_incomplete");
  const runs = Array.isArray(input.body.check_runs) ? input.body.check_runs.map(asRecord).filter((row): row is RecordValue => Boolean(row)) : [];
  if (runs.length !== input.body.total_count) issuerFailure("GitHub required Formal-QA trigger checks are incomplete", "formal_qa_required_check_incomplete");
  const candidates = runs.map((run) => {
    const app = asRecord(run.app); const suite = asRecord(run.check_suite);
    return { id: asId(run.id), name: asString(run.name), appId: typeof app?.id === "number" ? app.id : null, checkSuiteId: asId(run.check_suite_id) ?? asId(suite?.id), headSha: asString(run.head_sha)?.toLowerCase() ?? null, status: asString(run.status), conclusion: asString(run.conclusion), completedAt: asString(run.completed_at) };
  }).filter((run) => run.id && run.checkSuiteId && run.name === input.policy.requiredCheckName && run.appId === input.policy.requiredCheckAppId);
  if (candidates.length === 0 || candidates.some((run) => !run.completedAt || !run.status || !run.conclusion || run.headSha !== input.headSha)) issuerFailure("GitHub required Formal-QA trigger check is missing or ambiguous", "formal_qa_required_check_missing");
  candidates.sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!));
  const latest = candidates[0]!;
  if (!Number.isFinite(Date.parse(latest.completedAt!)) || (candidates[1] && Date.parse(candidates[1].completedAt!) === Date.parse(latest.completedAt!)) || latest.status !== "completed" || latest.conclusion !== "success") issuerFailure("GitHub required Formal-QA trigger check is not an exact successful result", "formal_qa_required_check_missing");
  return { id: latest.id!, checkSuiteId: latest.checkSuiteId!, name: latest.name!, appId: latest.appId!, status: latest.status!, conclusion: latest.conclusion!, completedAt: latest.completedAt! };
}
function parseWorkflowRun(input: { body: RecordValue; hasNextPage: boolean; policy: PolicyRow; headSha: string; prNumber: number; checkSuiteId: string }): WorkflowSnapshot {
  if (input.hasNextPage) issuerFailure("GitHub protected workflow results are incomplete", "formal_qa_required_workflow_incomplete");
  const all = Array.isArray(input.body.workflow_runs) ? input.body.workflow_runs.map(asRecord).filter((row): row is RecordValue => Boolean(row)) : [];
  const candidates = all.map((run) => ({ id: asId(run.id), workflowId: asId(run.workflow_id), checkSuiteId: asId(run.check_suite_id), headSha: asString(run.head_sha)?.toLowerCase() ?? null, event: asString(run.event), status: asString(run.status), conclusion: asString(run.conclusion), prs: Array.isArray(run.pull_requests) ? run.pull_requests.map(asRecord).filter((row): row is RecordValue => Boolean(row)) : [] }))
    .filter((run) => run.id && run.workflowId === input.policy.requiredWorkflowId && run.checkSuiteId === input.checkSuiteId && run.headSha === input.headSha && run.event === "pull_request" && run.status === "completed" && run.conclusion === "success" && run.prs.some((pr) => asId(pr.number) === String(input.prNumber)));
  if (candidates.length !== 1) issuerFailure("GitHub protected workflow result is missing or ambiguous", "formal_qa_required_workflow_missing");
  const run = candidates[0]!;
  return { id: run.id!, workflowId: run.workflowId!, checkSuiteId: run.checkSuiteId!, headSha: run.headSha! };
}

async function defaultTokenProvider(db: Db, input: { companyId: string; responsibleUserId: string }) {
  const secrets = secretService(db);
  for (const secretName of DEFAULT_GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await secrets.getByName(input.companyId, secretName).catch(() => null);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(input.companyId, secret.id, "latest", { accessContext: { consumerType: "system", consumerId: "formal-qa-github-issuer", actorType: "system", responsibleUserId: input.responsibleUserId } }).then((value) => value.trim()).catch(() => "");
    if (token) return token;
  }
  return null;
}
async function loadRequestAndPolicy(db: Db, preparationId: string) {
  const [preparation] = await db.select().from(formalQaPreparations).where(eq(formalQaPreparations.id, preparationId)).limit(1);
  if (!preparation) throw notFound("Formal-QA preparation not found");
  const [policy] = await db.select().from(formalQaPolicies).where(and(eq(formalQaPolicies.companyId, preparation.companyId), eq(formalQaPolicies.projectId, preparation.projectId), eq(formalQaPolicies.projectWorkspaceId, preparation.projectWorkspaceId))).limit(1);
  if (!policy || !policy.enabled) issuerFailure("No enabled Formal-QA policy is configured for this project workspace", "formal_qa_policy_unavailable");
  const [workspace] = await db.select({ repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces).where(and(eq(projectWorkspaces.id, preparation.projectWorkspaceId), eq(projectWorkspaces.companyId, preparation.companyId), eq(projectWorkspaces.projectId, preparation.projectId))).limit(1);
  if (!workspace || canonicalRepository(workspace.repoUrl ?? "") !== canonicalRepository(policy.repository)) issuerFailure("Formal-QA policy does not match the configured project repository", "formal_qa_repository_mismatch");
  return { preparation, policy };
}

/** Server-only transition: policy + GitHub derive the authority, never a caller. */
export function formalQaGitHubIssuerService(db: Db, options?: {
  fetch?: FetchLike;
  tokenProvider?: GitHubTokenProvider;
  checkoutInstanceRoot?: string;
  /** Test seams; production has no local or file-transport checkout path. */
  checkoutTestOnlyRemoteUrl?: string;
  checkoutTestOnlyAllowFileProtocol?: boolean;
}) {
  const fetchImpl = options?.fetch ?? ghFetch;
  const checkouts = formalQaCheckoutService(db, {
    instanceRoot: options?.checkoutInstanceRoot,
    testOnlyRemoteUrl: options?.checkoutTestOnlyRemoteUrl,
    testOnlyAllowFileProtocol: options?.checkoutTestOnlyAllowFileProtocol,
  });
  const resolveToken = options?.tokenProvider ?? ((input: { companyId: string; responsibleUserId: string }) => defaultTokenProvider(db, input));
  const issue = async ({ preparationId }: FormalQaGitHubIssuerInput) => {
    const initial = await loadRequestAndPolicy(db, preparationId);
    if (initial.preparation.status === "issued") {
      const [issuance] = await db.select().from(formalQaIssuances).where(eq(formalQaIssuances.preparationId, preparationId)).limit(1);
      if (!issuance) issuerFailure("Formal-QA issued request lacks immutable evidence", "formal_qa_issuance_missing");
      const checkout = await checkouts.materialize({ preparationId });
      return { preparation: initial.preparation, issuance, checkout: checkout.checkout, replayed: true };
    }
    if (initial.preparation.status !== "prepared" && initial.preparation.status !== "issuing") issuerFailure("Formal-QA request is not eligible for issuance", "formal_qa_request_not_eligible");
    if (initial.preparation.expiresAt.getTime() <= Date.now()) issuerFailure("Formal-QA request expired before issuance", "formal_qa_request_expired");
    if (!Number.isSafeInteger(initial.preparation.prNumber) || initial.preparation.prNumber <= 0) issuerFailure("Formal-QA request has an invalid pull request number", "formal_qa_request_not_eligible");
    const repository = canonicalRepository(initial.policy.repository);
    if (!repository) issuerFailure("Formal-QA policy repository is invalid", "formal_qa_policy_unavailable");
    const token = await resolveToken({ companyId: initial.preparation.companyId, responsibleUserId: initial.preparation.issuedByUserId });
    if (!token?.trim()) issuerFailure("No scoped GitHub credential is available for Formal-QA issuance", "formal_qa_github_token_unavailable");
    const [owner, repo] = repository.split("/") as [string, string]; const apiBase = gitHubApiBase("github.com");
    const pullUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${initial.preparation.prNumber}`;
    const pullFirstResponse = await readJson(fetchImpl, pullUrl, token, "formal_qa_github_read_failed"); const pullFirst = parsePull(pullFirstResponse.body);
    const commitResponse = await readJson(fetchImpl, `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${pullFirst.headSha}`, token, "formal_qa_github_read_failed"); const treeSha = parseTree(commitResponse.body, pullFirst.headSha);
    const checksUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${pullFirst.headSha}/check-runs?filter=all&per_page=100`;
    const checksFirstResponse = await readJson(fetchImpl, checksUrl, token, "formal_qa_github_read_failed"); const checkFirst = parseRequiredCheck({ body: checksFirstResponse.body, hasNextPage: /(?:^|,)\s*<[^>]+>;\s*rel="?next"?/i.test(checksFirstResponse.link), policy: initial.policy, headSha: pullFirst.headSha });
    const pullSecondResponse = await readJson(fetchImpl, pullUrl, token, "formal_qa_github_read_failed"); const pullSecond = parsePull(pullSecondResponse.body);
    if (canonicalJson(pullSecond) !== canonicalJson(pullFirst)) issuerFailure("GitHub pull request changed during Formal-QA issuance", "formal_qa_pull_changed_during_issue");
    const checksSecondResponse = await readJson(fetchImpl, checksUrl, token, "formal_qa_github_read_failed"); const checkSecond = parseRequiredCheck({ body: checksSecondResponse.body, hasNextPage: /(?:^|,)\s*<[^>]+>;\s*rel="?next"?/i.test(checksSecondResponse.link), policy: initial.policy, headSha: pullFirst.headSha });
    if (canonicalJson(checkSecond) !== canonicalJson(checkFirst)) issuerFailure("GitHub protected check changed during Formal-QA issuance", "formal_qa_required_check_changed");
    const workflowsResponse = await readJson(fetchImpl, `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?event=pull_request&head_sha=${pullFirst.headSha}&per_page=100`, token, "formal_qa_github_read_failed");
    const workflow = parseWorkflowRun({ body: workflowsResponse.body, hasNextPage: /(?:^|,)\s*<[^>]+>;\s*rel="?next"?/i.test(workflowsResponse.link), policy: initial.policy, headSha: pullFirst.headSha, prNumber: initial.preparation.prNumber, checkSuiteId: checkSecond.checkSuiteId });
    const evidenceJson = canonicalJson({ schema: "paperclip.formal-qa-github-evidence/v2", repository, prNumber: initial.preparation.prNumber, pullFirst: pullFirstResponse.body, commit: commitResponse.body, checksFirst: checksFirstResponse.body, pullSecond: pullSecondResponse.body, checksSecond: checksSecondResponse.body, workflows: workflowsResponse.body, etags: { pullFirst: pullFirstResponse.etag, commit: commitResponse.etag, checksFirst: checksFirstResponse.etag, pullSecond: pullSecondResponse.etag, checksSecond: checksSecondResponse.etag, workflows: workflowsResponse.etag } });
    const snapshotSha256 = createHash("sha256").update(evidenceJson).digest("hex");
    const persisted = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_issuance:${preparationId}`}, 0))`);
      const [preparation] = await tx.select().from(formalQaPreparations).where(eq(formalQaPreparations.id, preparationId)).limit(1);
      if (!preparation) throw notFound("Formal-QA preparation not found");
      const [policy] = await tx.select().from(formalQaPolicies).where(eq(formalQaPolicies.id, initial.policy.id)).limit(1);
      if (!policy || !policy.enabled || policy.version !== initial.policy.version) issuerFailure("Formal-QA policy changed during issuance", "formal_qa_policy_changed");
      if (preparation.status === "issued") {
        const [issuance] = await tx.select().from(formalQaIssuances).where(eq(formalQaIssuances.preparationId, preparation.id)).limit(1);
        if (!issuance) issuerFailure("Formal-QA issued request lacks immutable evidence", "formal_qa_issuance_missing");
        return { preparation, issuance, replayed: true };
      }
      if (preparation.status !== "prepared" && preparation.status !== "issuing") issuerFailure("Formal-QA request changed during issuance", "formal_qa_request_not_eligible");
      if (preparation.expiresAt.getTime() <= Date.now()) issuerFailure("Formal-QA request expired during issuance", "formal_qa_request_expired");
      const [prior] = await tx.select().from(formalQaIssuances).where(and(eq(formalQaIssuances.companyId, preparation.companyId), eq(formalQaIssuances.policyId, policy.id), eq(formalQaIssuances.repository, repository), eq(formalQaIssuances.prNumber, String(preparation.prNumber)), eq(formalQaIssuances.headSha, pullFirst.headSha))).limit(1);
      if (prior) {
        const [priorPreparation] = await tx.select().from(formalQaPreparations).where(eq(formalQaPreparations.id, prior.preparationId)).limit(1);
        if (!priorPreparation) issuerFailure("Formal-QA semantic replay lacks its request", "formal_qa_issuance_missing");
        return { preparation: priorPreparation, issuance: prior, replayed: true };
      }
      const expiresAt = new Date(Date.now() + MAX_EXPIRY_MS);
      const [updated] = await tx.update(formalQaPreparations).set({ repository, headSha: pullFirst.headSha, baseRef: pullFirst.baseRef, baseSha: pullFirst.baseSha, treeSha, evidenceSha256: snapshotSha256, issuerReceiptSha256: snapshotSha256, issuerOperationId: `github-pr:${repository}#${preparation.prNumber}@${pullFirst.headSha}:policy:${policy.id}:v${policy.version}`, requestSha256: createHash("sha256").update(`${preparation.id}:${policy.id}:${policy.version}:${snapshotSha256}`).digest("hex"), status: "issued", expiresAt, updatedAt: new Date() }).where(and(eq(formalQaPreparations.id, preparation.id), eq(formalQaPreparations.status, preparation.status))).returning();
      if (!updated) issuerFailure("Formal-QA request changed during issuance", "formal_qa_request_not_eligible");
      const [issuance] = await tx.insert(formalQaIssuances).values({ preparationId: updated.id, policyId: policy.id, policyVersion: policy.version, companyId: updated.companyId, projectId: updated.projectId, projectWorkspaceId: updated.projectWorkspaceId, repository, prNumber: String(updated.prNumber), headSha: pullFirst.headSha, baseRef: pullFirst.baseRef, baseSha: pullFirst.baseSha, treeSha, requiredCheckName: policy.requiredCheckName, requiredCheckAppId: policy.requiredCheckAppId, checkRunId: checkSecond.id, checkSuiteId: checkSecond.checkSuiteId, workflowRunId: workflow.id, workflowId: workflow.workflowId, evidenceJson, snapshotSha256 }).returning();
      return { preparation: updated!, issuance: issuance!, replayed: false };
    });
    const checkout = await checkouts.materialize({ preparationId: persisted.preparation.id });
    return { ...persisted, checkout: checkout.checkout, replayed: persisted.replayed && checkout.replayed };
  };

  /**
   * The scheduler owns promotion from an inert Board request to GitHub-bound
   * evidence. A temporary GitHub/credential failure leaves the durable request
   * `prepared` for a later tick; no browser retry or agent-side input can
   * widen the authority.
   */
  const reconcilePrepared = async (input: { companyId?: string; limit?: number } = {}) => {
    const candidates = await db.select({ id: formalQaPreparations.id }).from(formalQaPreparations)
      .where(and(
        eq(formalQaPreparations.status, "prepared"),
        gt(formalQaPreparations.expiresAt, new Date()),
        input.companyId ? eq(formalQaPreparations.companyId, input.companyId) : undefined,
      ))
      .orderBy(asc(formalQaPreparations.createdAt))
      .limit(Math.max(1, Math.min(input.limit ?? 25, 100)));
    let issued = 0;
    let deferred = 0;
    for (const candidate of candidates) {
      try {
        await issue({ preparationId: candidate.id });
        issued += 1;
      } catch {
        // The exact failure remains discoverable through the request's next
        // controlled attempt and server logs. Do not write caller-visible or
        // mutable error authority into the preparation receipt.
        deferred += 1;
      }
    }
    return { scanned: candidates.length, issued, deferred };
  };

  return { issue, reconcilePrepared };
}

export const formalQaIssuerTestOnly = { canonicalJson, parseRequiredCheck, parseWorkflowRun };
