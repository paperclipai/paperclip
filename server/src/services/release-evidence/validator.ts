import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  issueComments,
  issues,
  releaseEvidenceAuditLog,
} from "@paperclipai/db";
import {
  releaseEvidenceSchema,
  type ReleaseEvidence,
  type ReleaseEvidenceKind,
} from "@paperclipai/shared";
import { detectCodeTouching } from "./code-touching.js";
import {
  type ClosureGateOutcome,
  CLOSURE_GATE_HINT,
} from "./types.js";

type IssueForClosureGate = typeof issues.$inferSelect;

export type ReleaseEvidenceConfig = {
  requireReleaseEvidence: boolean;
  releaseOwnerAgentId?: string;
  githubToken?: string;
};

export type ValidateReleaseEvidenceInput = {
  issue: IssueForClosureGate;
  patchReleaseEvidence: unknown;
  actorAgentId: string | null;
  actorUserId: string | null;
  config: ReleaseEvidenceConfig;
};

type GithubRepo = {
  owner: string;
  repo: string;
  normalizedUrl: string;
};

type GithubClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; unavailable: true; message: string }
  | { ok: false; unavailable: false; status: number; message: string };

export async function validateReleaseEvidenceForIssueClose(
  db: Db,
  input: ValidateReleaseEvidenceInput,
): Promise<ClosureGateOutcome & { codeTouching: boolean; codeTouchingReason: string }> {
  const codeTouching = await detectCodeTouching(db, {
    issueId: input.issue.id,
    companyId: input.issue.companyId,
    parentId: input.issue.parentId,
    executionWorkspaceId: input.issue.executionWorkspaceId,
    assigneeAgentId: input.issue.assigneeAgentId,
  });
  const rawEvidence = input.patchReleaseEvidence ?? input.issue.releaseEvidence ?? null;

  if (!codeTouching.codeTouching && rawEvidence === null) {
    return {
      ok: true,
      validated: { kind: "not_code", notCodeReason: "Issue is not classified as code-touching by the closure gate." },
      githubApiCalled: false,
      degraded: false,
      detail: { codeTouchingReason: codeTouching.reason, skipped: true },
      codeTouching: false,
      codeTouchingReason: codeTouching.reason,
    };
  }

  if (codeTouching.codeTouching && rawEvidence === null) {
    if (!input.config.requireReleaseEvidence) {
      return {
        ok: true,
        validated: { kind: "not_code", notCodeReason: "Release evidence enforcement is disabled by feature flag." },
        githubApiCalled: false,
        degraded: false,
        detail: { codeTouchingReason: codeTouching.reason, enforcementDisabled: true },
        codeTouching: true,
        codeTouchingReason: codeTouching.reason,
      };
    }
    return {
      ...reject("release_evidence_required", "releaseEvidence is required for code-touching issue closure.", {
        codeTouchingReason: codeTouching.reason,
      }),
      codeTouching: codeTouching.codeTouching,
      codeTouchingReason: codeTouching.reason,
    };
  }

  const parsed = releaseEvidenceSchema.safeParse(rawEvidence);
  if (!parsed.success) {
    return {
      ...reject("release_evidence_schema_invalid", "releaseEvidence does not match the closure-gate schema.", {
        issues: parsed.error.issues,
        codeTouchingReason: codeTouching.reason,
      }),
      codeTouching: codeTouching.codeTouching,
      codeTouchingReason: codeTouching.reason,
    };
  }

  const repoMismatch = await detectRepoMismatch(db, input.issue, parsed.data);
  if (repoMismatch) {
    return {
      ...reject("repo_mismatch", "releaseEvidence repo does not match the execution workspace repo.", repoMismatch),
      codeTouching: codeTouching.codeTouching,
      codeTouchingReason: codeTouching.reason,
    };
  }

  let outcome: ClosureGateOutcome;
  switch (parsed.data.kind) {
    case "merge_commit":
      outcome = await validateMergeCommit(input.issue, parsed.data, input.config);
      break;
    case "pr_merged":
      outcome = await validatePrMerged(input.issue, parsed.data, input.config);
      break;
    case "not_code":
      outcome = await validateNotCode(db, input.issue, parsed.data);
      break;
    case "release_owner_signoff":
      outcome = await validateReleaseOwnerSignoff(db, input.issue, parsed.data, input.config);
      break;
    default:
      outcome = reject("release_evidence_schema_invalid", "Unknown releaseEvidence kind.", {});
  }

  return {
    ...outcome,
    detail: {
      ...(outcome.detail ?? {}),
      codeTouchingReason: codeTouching.reason,
    },
    codeTouching: codeTouching.codeTouching,
    codeTouchingReason: codeTouching.reason,
  };
}

export async function recordReleaseEvidenceAudit(
  db: Db,
  input: {
    issueId: string;
    actorAgentId: string | null;
    actorUserId: string | null;
    evidence: ReleaseEvidence;
    outcome: ClosureGateOutcome;
  },
) {
  await db.insert(releaseEvidenceAuditLog).values({
    issueId: input.issueId,
    agentId: input.actorAgentId,
    actorUserId: input.actorUserId,
    kind: input.evidence.kind,
    evidence: input.evidence,
    outcome: input.outcome.ok ? "accepted" : "rejected",
    errorCode: input.outcome.ok ? null : input.outcome.errorCode,
    githubApiCalled: input.outcome.githubApiCalled,
    degraded: input.outcome.degraded,
    detail: input.outcome.detail ?? null,
  });
}

export function closureGateErrorResponse(outcome: Exclude<ClosureGateOutcome, { ok: true }>) {
  return {
    error: outcome.errorCode,
    message: outcome.message,
    hint: CLOSURE_GATE_HINT,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

function reject(
  errorCode: Exclude<ClosureGateOutcome, { ok: true }>["errorCode"],
  message: string,
  detail: Record<string, unknown>,
): Exclude<ClosureGateOutcome, { ok: true }> {
  return {
    ok: false,
    errorCode,
    message,
    githubApiCalled: false,
    degraded: false,
    detail,
  };
}

async function validateMergeCommit(
  issue: IssueForClosureGate,
  evidence: Extract<ReleaseEvidence, { kind: "merge_commit" }>,
  config: ReleaseEvidenceConfig,
): Promise<ClosureGateOutcome> {
  const repo = parseGithubRepo(evidence.repo);
  if (!repo) {
    return reject("release_evidence_schema_invalid", "repo must be a GitHub repository URL.", {});
  }

  const commit = await githubGet<{ commit?: { author?: { date?: string } } }>(
    config,
    `/repos/${repo.owner}/${repo.repo}/commits/${evidence.sha}`,
  );
  if (!commit.ok) return githubUnavailableOrReject(commit, "sha_not_reachable_from_ref", "Could not fetch commit from GitHub.");

  const commitDate = new Date(commit.value.commit?.author?.date ?? "");
  const issueCreatedAt = new Date(issue.createdAt);
  if (
    Number.isFinite(commitDate.getTime()) &&
    Number.isFinite(issueCreatedAt.getTime()) &&
    commitDate.getTime() < issueCreatedAt.getTime() - 60 * 60 * 1000
  ) {
    return {
      ok: false,
      errorCode: "sha_predates_issue",
      message: "Commit predates the issue creation window.",
      githubApiCalled: true,
      degraded: false,
      detail: { commitDate: commitDate.toISOString(), issueCreatedAt: issueCreatedAt.toISOString() },
    };
  }

  return validateShaReachable(config, repo, evidence.sha, evidence.ref, "sha_not_reachable_from_ref");
}

async function validatePrMerged(
  issue: IssueForClosureGate,
  evidence: Extract<ReleaseEvidence, { kind: "pr_merged" }>,
  config: ReleaseEvidenceConfig,
): Promise<ClosureGateOutcome> {
  const pr = parseGithubPrUrl(evidence.prUrl);
  if (!pr) return reject("release_evidence_schema_invalid", "prUrl must be a GitHub pull request URL.", {});
  const repo = parseGithubRepo(evidence.repo);
  if (!repo || repo.owner !== pr.owner || repo.repo !== pr.repo) {
    return reject("repo_mismatch", "releaseEvidence repo does not match prUrl.", { prUrl: evidence.prUrl });
  }

  const result = await githubGet<{
    merged?: boolean;
    merged_at?: string | null;
    base?: { ref?: string };
    title?: string | null;
    body?: string | null;
    merge_commit_sha?: string | null;
  }>(config, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
  if (!result.ok) return githubUnavailableOrReject(result, "pr_not_merged", "Could not fetch pull request from GitHub.");
  if (result.value.merged !== true || !result.value.merged_at) {
    return rejectWithGithub("pr_not_merged", "Pull request is not merged.", { prUrl: evidence.prUrl });
  }
  if (result.value.base?.ref !== evidence.ref) {
    return rejectWithGithub("pr_targets_wrong_ref", "Pull request targets a different base ref.", {
      expected: evidence.ref,
      actual: result.value.base?.ref ?? null,
    });
  }
  if (!prReferencesIssue(result.value.title ?? "", result.value.body ?? "", issue.identifier)) {
    return rejectWithGithub("pr_not_linked_to_issue", "Pull request does not reference this issue.", {
      expectedIssueId: issue.identifier ?? null,
      prUrl: evidence.prUrl,
    });
  }
  const mergeSha = result.value.merge_commit_sha;
  if (!mergeSha) return rejectWithGithub("pr_sha_not_reachable", "Merged pull request has no merge commit SHA.", {});
  return validateShaReachable(config, repo, mergeSha, evidence.ref, "pr_sha_not_reachable");
}

async function validateNotCode(
  db: Db,
  issue: IssueForClosureGate,
  evidence: Extract<ReleaseEvidence, { kind: "not_code" }>,
): Promise<ClosureGateOutcome> {
  if (evidence.notCodeReason.trim().length < 30) {
    return reject("not_code_reason_too_short", "notCodeReason must be at least 30 characters.", {});
  }
  const diffDecision = await detectCodeTouching(db, {
    issueId: issue.id,
    companyId: issue.companyId,
    parentId: null,
    executionWorkspaceId: issue.executionWorkspaceId,
    assigneeAgentId: null,
  });
  if (diffDecision.reason === "workspace_diff_present") {
    return reject("code_evidence_contradicts_not_code", "Workspace diffs exist, so not_code evidence is not valid.", {});
  }
  return {
    ok: true,
    validated: evidence,
    githubApiCalled: false,
    degraded: false,
    detail: { notCodeReasonLength: evidence.notCodeReason.trim().length },
  };
}

async function validateReleaseOwnerSignoff(
  db: Db,
  issue: IssueForClosureGate,
  evidence: Extract<ReleaseEvidence, { kind: "release_owner_signoff" }>,
  config: ReleaseEvidenceConfig,
): Promise<ClosureGateOutcome> {
  if (!config.releaseOwnerAgentId || evidence.signedOffByAgentId !== config.releaseOwnerAgentId) {
    return reject("signer_not_release_owner", "signedOffByAgentId does not match PAPERCLIP_RELEASE_OWNER_AGENT_ID.", {
      configured: Boolean(config.releaseOwnerAgentId),
    });
  }

  const [comment] = await db
    .select()
    .from(issueComments)
    .where(and(eq(issueComments.id, evidence.signoffCommentId), eq(issueComments.companyId, issue.companyId)))
    .limit(1);
  if (!comment) return reject("signoff_comment_not_found", "Signoff comment was not found.", {});
  if (comment.authorAgentId !== evidence.signedOffByAgentId) {
    return reject("signoff_author_mismatch", "Signoff comment author does not match signedOffByAgentId.", {});
  }

  const scopedIssueIds = new Set([issue.id, ...(issue.parentId ? [issue.parentId] : [])]);
  if (!scopedIssueIds.has(comment.issueId)) {
    return reject("signoff_comment_wrong_scope", "Signoff comment is not on this issue or its direct parent.", {
      commentIssueId: comment.issueId,
    });
  }

  const match = comment.body.match(/release:confirmed\s+(https:\/\/github\.com\/[^\s]+|[0-9a-f]{7,40})/i);
  if (!match) return reject("signoff_regex_mismatch", "Signoff comment does not match release confirmation syntax.", {});

  const repo = parseGithubRepo(evidence.repo);
  if (!repo) return reject("release_evidence_schema_invalid", "repo must be a GitHub repository URL.", {});
  const confirmed = match[1];
  if (/^https:\/\/github\.com\//i.test(confirmed)) {
    const pr = parseGithubPrUrl(confirmed);
    if (!pr) return reject("signoff_regex_mismatch", "Confirmed URL is not a GitHub pull request URL.", {});
    return validatePrMerged(issue, { kind: "pr_merged", repo: evidence.repo, ref: evidence.ref, prUrl: confirmed }, config);
  }
  return validateShaReachable(config, repo, confirmed, evidence.ref, "signoff_sha_not_reachable");
}

async function validateShaReachable(
  config: ReleaseEvidenceConfig,
  repo: GithubRepo,
  sha: string,
  ref: string,
  errorCode: "sha_not_reachable_from_ref" | "pr_sha_not_reachable" | "signoff_sha_not_reachable",
): Promise<ClosureGateOutcome> {
  const compare = await githubGet<{ status?: string }>(
    config,
    `/repos/${repo.owner}/${repo.repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(ref)}`,
  );
  if (!compare.ok) return githubUnavailableOrReject(compare, errorCode, "Could not compare SHA reachability on GitHub.");
  if (compare.value.status !== "behind" && compare.value.status !== "identical") {
    return rejectWithGithub(errorCode, "SHA is not reachable from the supplied ref.", {
      sha,
      ref,
      compareStatus: compare.value.status ?? null,
    });
  }
  return {
    ok: true,
    validated: { kind: "merge_commit", repo: repo.normalizedUrl, ref, sha },
    githubApiCalled: true,
    degraded: false,
    detail: { sha, ref, compareStatus: compare.value.status },
  };
}

async function detectRepoMismatch(
  db: Db,
  issue: IssueForClosureGate,
  evidence: ReleaseEvidence,
): Promise<Record<string, unknown> | null> {
  if (evidence.kind === "not_code" || !issue.executionWorkspaceId) return null;
  const [workspace] = await db
    .select({ repoUrl: executionWorkspaces.repoUrl })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, issue.executionWorkspaceId))
    .limit(1);
  if (!workspace?.repoUrl) return null;
  const workspaceRepo = parseGithubRepo(workspace.repoUrl);
  const evidenceRepo = parseGithubRepo(evidence.repo);
  if (!workspaceRepo || !evidenceRepo) return null;
  if (workspaceRepo.owner === evidenceRepo.owner && workspaceRepo.repo === evidenceRepo.repo) return null;
  return {
    workspaceRepo: workspaceRepo.normalizedUrl,
    evidenceRepo: evidenceRepo.normalizedUrl,
  };
}

function githubUnavailableOrReject(
  result: Exclude<GithubClientResult<unknown>, { ok: true }>,
  errorCode: Exclude<ClosureGateOutcome, { ok: true }>["errorCode"],
  message: string,
): ClosureGateOutcome {
  if (result.unavailable) {
    return rejectWithGithub("github_api_unavailable", "GitHub API validation is unavailable.", {
      attemptedErrorCode: errorCode,
      attemptedMessage: message,
      error: result.message,
    });
  }
  return rejectWithGithub(errorCode, message, { status: result.status, error: result.message });
}

function rejectWithGithub(
  errorCode: Exclude<ClosureGateOutcome, { ok: true }>["errorCode"],
  message: string,
  detail: Record<string, unknown>,
): ClosureGateOutcome {
  return {
    ok: false,
    errorCode,
    message,
    githubApiCalled: true,
    degraded: false,
    detail,
  };
}

async function githubGet<T>(config: ReleaseEvidenceConfig, path: string): Promise<GithubClientResult<T>> {
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "paperclip-release-evidence-gate",
        ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        unavailable: response.status >= 500 || response.status === 403 || response.status === 429,
        status: response.status,
        message: text.slice(0, 500) || response.statusText,
      };
    }
    return { ok: true, value: await response.json() as T };
  } catch (err) {
    return {
      ok: false,
      unavailable: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseGithubRepo(value: string): GithubRepo | null {
  const normalized = value.startsWith("http") ? value : `https://${value}`;
  try {
    const url = new URL(normalized);
    if (url.hostname !== "github.com") return null;
    const [owner, repoRaw] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repoRaw) return null;
    const repo = repoRaw.replace(/\.git$/, "");
    return { owner, repo, normalizedUrl: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
}

function parseGithubPrUrl(value: string): { owner: string; repo: string; number: number } | null {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return null;
    const [owner, repo, pull, numberRaw] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    const number = Number(numberRaw);
    if (!owner || !repo || pull !== "pull" || !Number.isInteger(number) || number <= 0) return null;
    return { owner, repo: repo.replace(/\.git$/, ""), number };
  } catch {
    return null;
  }
}

function prReferencesIssue(prTitle: string, prBody: string, issueIdentifier: string | null | undefined): boolean {
  if (!issueIdentifier) return true;
  const escaped = issueIdentifier.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const issuePattern = new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?=$|[^A-Za-z0-9-])`, "i");
  const haystack = `${prTitle}\n${prBody}`;
  return issuePattern.test(haystack);
}
