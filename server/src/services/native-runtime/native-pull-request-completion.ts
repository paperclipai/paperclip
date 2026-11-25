import { and, eq, ne } from "drizzle-orm";
import { heartbeatRuns, issues, issueWorkProducts, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { isConversation } from "../agent-conversations.js";
import { createPullRequestMergeStateResolver, extractGitHubPullRequestReferences } from "../github-pull-request-merge.js";
import { GIT_CREDENTIAL_TOKEN_ENV_KEY, resolveGitHubApiCredential, type GitHubApiCredential } from "../git-credentials.js";
import { resolveGitHubCompletionCredentials } from "../github-operation-credentials.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "./native-review-participant.js";

export class NativePullRequestCompletionError extends Error {}

type Binding = { companyId: string; issueId: string; runId: string; lockSources?: boolean };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function nativePullRequestCompletionReferences(db: Db, binding: Binding, result: unknown) {
  const sourceQuery = db.select({ issue: issues, context: heartbeatRuns.contextSnapshot, agentId: heartbeatRuns.agentId }).from(issues)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.nativeIssueId, binding.issueId)))
    .where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).limit(1);
  const [source] = await (binding.lockSources ? sourceQuery.for("share", { noWait: true }) : sourceQuery);
  if (!source) throw new NativePullRequestCompletionError("Pull request completion source is unavailable.");
  if (["done", "cancelled"].includes(source.issue.status)) return [];
  if (isConversation(source.issue)) return [];
  if (readNativeReviewAssignmentContext(source.context) && await getNativeReviewAssignment(db, {
    ...binding, agentId: source.agentId, contextSnapshot: source.context, allowResolvedByRunId: binding.runId,
  })) return [];
  const query = db.select({ url: issueWorkProducts.url, metadata: issueWorkProducts.metadata }).from(issueWorkProducts)
    .where(and(eq(issueWorkProducts.companyId, binding.companyId), eq(issueWorkProducts.issueId, binding.issueId),
      eq(issueWorkProducts.type, "pull_request"), ne(issueWorkProducts.status, "archived"))).limit(21);
  const products = await (binding.lockSources ? query.for("share", { noWait: true }) : query);
  if (products.length > 20) throw new NativePullRequestCompletionError("Too many pull request deliverables to verify. Keep the task active and verify a bounded delivery scope.");
  const artifacts = record(result).artifacts;
  const references = extractGitHubPullRequestReferences([
    ...(Array.isArray(artifacts) ? artifacts.flatMap(value => {
      const artifact = record(value);
      const ref = typeof value === "string" ? value : artifact.ref;
      if (artifact.kind === "pull_request" && extractGitHubPullRequestReferences([ref]).length !== 1) {
        throw new NativePullRequestCompletionError("A declared PR artifact has no verifiable GitHub identity. Register its canonical PR URL before completing the task.");
      }
      if (artifact.kind !== "pull_request" && (artifact.kind === "review_comment" ||
          (typeof ref === "string" && /\/pull\/[1-9][0-9]*(?:[/?][^#\s]*)?#[^\s]+/u.test(ref)))) return [];
      return [ref];
    }) : []),
    ...products.flatMap(product => {
      const metadata = record(product.metadata);
      const repo = metadata.repo ?? metadata.repository;
      const values = [product.url, metadata.url, typeof repo === "string" && typeof metadata.number === "number"
        ? `${repo}#${metadata.number}` : null];
      if (extractGitHubPullRequestReferences(values).length === 0) throw new NativePullRequestCompletionError(
        "A task pull request deliverable has no verifiable GitHub identity. Register its canonical PR URL before completing the task.",
      );
      return values;
    }),
  ]);
  if (references.length > 20) throw new NativePullRequestCompletionError("Too many pull request deliverables to verify. Keep the task active and verify a bounded delivery scope.");
  return references;
}

export function nativePullRequestCompletionKey(reference: { owner: string; repo: string; number: number }) {
  return `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
}

async function resolveCompletionCredential(db: Db, binding: Binding): Promise<GitHubApiCredential | null> {
  const credential = await resolveGitHubCompletionCredentials(db, binding);
  if (credential.status !== "absent") {
    const token = credential.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]?.trim();
    if (credential.status !== "available" || !token) {
      throw new NativePullRequestCompletionError("The run's GitHub connection is unavailable.");
    }
    return { token, source: "managed_connection", secretName: null };
  }
  return resolveGitHubApiCredential(db, binding.companyId);
}

export async function verifyNativePullRequestCompletion(db: Db, binding: Binding, result?: unknown): Promise<ReadonlySet<string>> {
  if (result === undefined) {
    const [saved] = await db.select({ envelope: nativeRunResults.resultJson }).from(nativeRunFinalizations)
      .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.companyId, binding.companyId), eq(nativeRunResults.issueId, binding.issueId),
        eq(nativeRunResults.runId, binding.runId), eq(nativeRunResults.schemaStatus, "accepted")))
      .where(and(eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.issueId, binding.issueId),
        eq(nativeRunFinalizations.runId, binding.runId))).limit(1);
    if (!saved) throw new NativePullRequestCompletionError("Pull request completion result is unavailable.");
    result = record(saved.envelope).result;
  }
  const references = await nativePullRequestCompletionReferences(db, binding, result);
  if (references.length === 0) return new Set();
  let credential: Promise<GitHubApiCredential | null> | undefined;
  const resolve = createPullRequestMergeStateResolver(db, {
    credentialProvider: () => credential ??= resolveCompletionCredential(db, binding),
  });
  const signal = AbortSignal.timeout(10_000);
  const states = await Promise.all(references.map(async reference => {
    try { return await resolve(binding.companyId, reference, signal); } catch { return "unknown"; }
  }));
  const pending = references.filter((_, index) => states[index] !== "merged");
  if (pending.length) throw new NativePullRequestCompletionError(
    `Task pull request deliverables have not been verified as merged: ${pending.map(nativePullRequestCompletionKey).join(", ")}. ` +
    "Keep the task active through CI, review, and merge. Fix actionable failures within your authority. Use the existing task monitor for an external wait, or report a concrete blocker. An open, draft, closed-unmerged, or unavailable PR cannot complete the task. Do not request a generic completion approval.",
  );
  return new Set(references.map(nativePullRequestCompletionKey));
}
