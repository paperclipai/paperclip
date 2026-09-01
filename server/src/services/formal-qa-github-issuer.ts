import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  formalQaIssuances,
  projectWorkspaces,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { formalQaCheckoutService } from "./formal-qa-checkouts.js";
import { formalQaPreparationService } from "./formal-qa-preparations.js";
import { secretService } from "./secrets.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;

export type FormalQaGitHubIssuerPolicy = {
  repository: string;
  requiredCheckName: string;
  requiredCheckAppSlug: string;
};

export type FormalQaGitHubIssuerInput = {
  companyId: string;
  projectId: string;
  projectWorkspaceId: string;
  prNumber: number;
  idempotencyKey: string;
  issuedByUserId: string;
  /** Short-lived authority supplied by the caller; must be no more than six hours. */
  expiresAt: Date;
  policy: FormalQaGitHubIssuerPolicy;
};

type GitHubTokenInput = {
  companyId: string;
  projectId: string;
  projectWorkspaceId: string;
  issuedByUserId: string;
};

type GitHubTokenProvider = (input: GitHubTokenInput) => Promise<string | null>;

type PullSnapshot = {
  state: string;
  draft: boolean;
  merged: boolean;
  updatedAt: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
};

type CheckSnapshot = {
  id: string;
  name: string;
  appSlug: string;
  status: string;
  conclusion: string;
  completedAt: string;
};

const SHA40_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const MAX_EXPIRY_MS = 6 * 60 * 60 * 1000;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nestedString(record: RecordValue, first: string, second: string): string | null {
  const nested = asRecord(record[first]);
  return nested ? asString(nested[second]) : null;
}

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
  } catch {
    return null;
  }
}

function issuerFailure(message: string, code: string): never {
  throw conflict(message, { code });
}

async function readJson(fetchImpl: FetchLike, url: string, token: string, failureCode: string) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "paperclip-formal-qa-issuer",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    issuerFailure("GitHub could not be reached while issuing Formal-QA", failureCode);
  }
  if (!response!.ok || response!.redirected) {
    issuerFailure("GitHub did not authorize the Formal-QA issuance read", failureCode);
  }
  const body = asRecord(await response!.json().catch(() => null));
  if (!body) issuerFailure("GitHub returned invalid Formal-QA issuance data", failureCode);
  return {
    body,
    etag: response!.headers.get("etag") ?? "",
    link: response!.headers.get("link") ?? "",
  };
}

function parsePull(body: RecordValue): PullSnapshot {
  const state = asString(body.state);
  const draft = asBoolean(body.draft);
  const merged = asBoolean(body.merged) ?? Boolean(asString(body.merged_at));
  const updatedAt = asString(body.updated_at);
  const headSha = nestedString(body, "head", "sha")?.toLowerCase() ?? null;
  const baseRef = nestedString(body, "base", "ref");
  const baseSha = nestedString(body, "base", "sha")?.toLowerCase() ?? null;
  if (!state || draft === null || !updatedAt || !headSha || !baseRef || !baseSha ||
    !SHA40_RE.test(headSha) || !SHA40_RE.test(baseSha)) {
    issuerFailure("GitHub pull request snapshot is incomplete", "formal_qa_github_invalid_response");
  }
  if (state !== "open" || draft || merged) {
    issuerFailure("GitHub pull request is not an open, ready Formal-QA candidate", "formal_qa_pull_not_eligible");
  }
  return { state, draft, merged, updatedAt, headSha, baseRef, baseSha };
}

function parseTree(body: RecordValue, expectedHeadSha: string): string {
  const commitSha = asString(body.sha)?.toLowerCase() ?? null;
  const tree = asRecord(body.tree);
  const treeSha = tree ? asString(tree.sha)?.toLowerCase() ?? null : null;
  if (commitSha !== expectedHeadSha || !treeSha || !SHA40_RE.test(treeSha)) {
    issuerFailure("GitHub exact commit/tree snapshot is incomplete", "formal_qa_github_invalid_response");
  }
  return treeSha;
}

function parseRequiredCheck(input: {
  body: RecordValue;
  hasNextPage: boolean;
  policy: FormalQaGitHubIssuerPolicy;
  headSha: string;
}): CheckSnapshot {
  const { body, hasNextPage, policy, headSha } = input;
  const totalCount = body.total_count;
  if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0 || hasNextPage) {
    issuerFailure("GitHub required Formal-QA trigger checks are incomplete", "formal_qa_required_check_incomplete");
  }
  const runs = Array.isArray(body.check_runs) ? body.check_runs.map(asRecord).filter((row): row is RecordValue => Boolean(row)) : [];
  if (runs.length !== totalCount) {
    issuerFailure("GitHub required Formal-QA trigger checks are incomplete", "formal_qa_required_check_incomplete");
  }
  const candidates = runs.map((run) => {
    const app = asRecord(run.app);
    return {
      id: asString(run.id) ?? (typeof run.id === "number" ? String(run.id) : null),
      name: asString(run.name),
      appSlug: app ? asString(app.slug) : null,
      headSha: asString(run.head_sha)?.toLowerCase() ?? null,
      status: asString(run.status),
      conclusion: asString(run.conclusion),
      completedAt: asString(run.completed_at),
    };
  }).filter((run) => run.id && run.name === policy.requiredCheckName && run.appSlug === policy.requiredCheckAppSlug);
  if (candidates.length === 0 || candidates.some((run) => !run.completedAt || !run.status || !run.conclusion || run.headSha !== headSha)) {
    issuerFailure("GitHub required Formal-QA trigger check is missing or ambiguous", "formal_qa_required_check_missing");
  }
  candidates.sort((left, right) => Date.parse(right.completedAt!) - Date.parse(left.completedAt!));
  const latest = candidates[0]!;
  if (!Number.isFinite(Date.parse(latest.completedAt!)) ||
    (candidates[1] && Date.parse(candidates[1].completedAt!) === Date.parse(latest.completedAt!)) ||
    latest.status !== "completed" || latest.conclusion !== "success") {
    issuerFailure("GitHub required Formal-QA trigger check is not an exact successful result", "formal_qa_required_check_missing");
  }
  return {
    id: latest.id!,
    name: latest.name!,
    appSlug: latest.appSlug!,
    status: latest.status!,
    conclusion: latest.conclusion!,
    completedAt: latest.completedAt!,
  };
}

async function defaultTokenProvider(db: Db, input: GitHubTokenInput) {
  const secrets = secretService(db);
  for (const secretName of DEFAULT_GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await secrets.getByName(input.companyId, secretName).catch(() => null);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(input.companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: "formal-qa-github-issuer",
        actorType: "system",
        responsibleUserId: input.issuedByUserId,
      },
    }).then((value) => value.trim()).catch(() => "");
    if (token) return token;
  }
  return null;
}

/**
 * Server-only issuer. It has no HTTP route: the later lifecycle controller is
 * the sole caller and supplies only the tenant/workspace/PR identity and a
 * preconfigured trigger policy. GitHub supplies the head/base/tree/evidence.
 */
export function formalQaGitHubIssuerService(db: Db, options?: {
  fetch?: FetchLike;
  tokenProvider?: GitHubTokenProvider;
  checkoutInstanceRoot?: string;
}) {
  const fetchImpl = options?.fetch ?? ghFetch;
  const preparations = formalQaPreparationService(db);
  const checkouts = formalQaCheckoutService(db, { instanceRoot: options?.checkoutInstanceRoot });
  const resolveToken = options?.tokenProvider ?? ((input: GitHubTokenInput) => defaultTokenProvider(db, input));

  return {
    issue: async (input: FormalQaGitHubIssuerInput) => {
      const repository = canonicalRepository(input.policy.repository);
      if (!repository || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 ||
        !input.idempotencyKey.trim() || input.expiresAt.getTime() <= Date.now() ||
        input.expiresAt.getTime() > Date.now() + MAX_EXPIRY_MS || !input.policy.requiredCheckName.trim() || !input.policy.requiredCheckAppSlug.trim()) {
        issuerFailure("Formal-QA issuer input is invalid", "formal_qa_issuer_input_invalid");
      }
      const [workspace] = await db.select({ repoUrl: projectWorkspaces.repoUrl })
        .from(projectWorkspaces)
        .where(and(
          eq(projectWorkspaces.id, input.projectWorkspaceId),
          eq(projectWorkspaces.companyId, input.companyId),
          eq(projectWorkspaces.projectId, input.projectId),
        )).limit(1);
      if (!workspace) throw notFound("Project workspace not found for this company and project");
      if (!workspace.repoUrl || canonicalRepository(workspace.repoUrl) !== repository) {
        issuerFailure("Formal-QA issuer policy does not match the configured project repository", "formal_qa_repository_mismatch");
      }
      const token = await resolveToken({
        companyId: input.companyId,
        projectId: input.projectId,
        projectWorkspaceId: input.projectWorkspaceId,
        issuedByUserId: input.issuedByUserId,
      });
      if (!token?.trim()) issuerFailure("No scoped GitHub credential is available for Formal-QA issuance", "formal_qa_github_token_unavailable");

      const [owner, repo] = repository.split("/") as [string, string];
      const apiBase = gitHubApiBase("github.com");
      const pullUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.prNumber}`;
      const firstPullResponse = await readJson(fetchImpl, pullUrl, token, "formal_qa_github_read_failed");
      const firstPull = parsePull(firstPullResponse.body);
      const commitResponse = await readJson(fetchImpl,
        `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${firstPull.headSha}`,
        token,
        "formal_qa_github_read_failed",
      );
      const treeSha = parseTree(commitResponse.body, firstPull.headSha);
      const checksResponse = await readJson(fetchImpl,
        `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${firstPull.headSha}/check-runs?per_page=100`,
        token,
        "formal_qa_github_read_failed",
      );
      const requiredCheck = parseRequiredCheck({
        body: checksResponse.body,
        hasNextPage: /(?:^|,)\s*<[^>]+>;\s*rel="?next"?/i.test(checksResponse.link),
        policy: input.policy,
        headSha: firstPull.headSha,
      });
      const secondPullResponse = await readJson(fetchImpl, pullUrl, token, "formal_qa_github_read_failed");
      const secondPull = parsePull(secondPullResponse.body);
      if (JSON.stringify(secondPull) !== JSON.stringify(firstPull)) {
        issuerFailure("GitHub pull request changed during Formal-QA issuance", "formal_qa_pull_changed_during_issue");
      }

      const snapshot = {
        repository,
        prNumber: input.prNumber,
        pull: firstPull,
        treeSha,
        requiredCheck,
        etags: {
          firstPull: firstPullResponse.etag,
          commit: commitResponse.etag,
          checks: checksResponse.etag,
          secondPull: secondPullResponse.etag,
        },
      };
      const snapshotSha256 = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      const issued = await preparations.create({
        companyId: input.companyId,
        projectId: input.projectId,
        projectWorkspaceId: input.projectWorkspaceId,
        repository,
        prNumber: input.prNumber,
        headSha: firstPull.headSha,
        baseRef: firstPull.baseRef,
        baseSha: firstPull.baseSha,
        treeSha,
        evidenceSha256: snapshotSha256,
        issuerReceiptSha256: snapshotSha256,
        issuerOperationId: `github-pr:${repository}#${input.prNumber}@${firstPull.headSha}`,
        issuedByUserId: input.issuedByUserId,
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt,
        status: "issued",
      });

      const issuance = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(formalQaIssuances)
          .where(eq(formalQaIssuances.preparationId, issued.preparation.id)).limit(1);
        const values = {
          companyId: input.companyId,
          projectId: input.projectId,
          projectWorkspaceId: input.projectWorkspaceId,
          repository,
          prNumber: String(input.prNumber),
          headSha: firstPull.headSha,
          baseRef: firstPull.baseRef,
          baseSha: firstPull.baseSha,
          treeSha,
          requiredCheckName: input.policy.requiredCheckName,
          requiredCheckAppSlug: input.policy.requiredCheckAppSlug,
          checkRunId: requiredCheck.id,
          snapshotSha256,
        };
        if (existing) {
          if (Object.entries(values).some(([key, value]) => existing[key as keyof typeof values] !== value)) {
            issuerFailure("Formal-QA issuance replay differs from its immutable GitHub snapshot", "formal_qa_issuance_replay_mismatch");
          }
          return existing;
        }
        const [created] = await tx.insert(formalQaIssuances).values({ preparationId: issued.preparation.id, ...values }).returning();
        return created!;
      });
      const checkout = await checkouts.materialize({ preparationId: issued.preparation.id });
      return { preparation: issued.preparation, issuance, checkout: checkout.checkout, replayed: issued.replayed && checkout.replayed };
    },
  };
}
