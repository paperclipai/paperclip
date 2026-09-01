import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { formalQaPolicies, formalQaSchedulerStates } from "@paperclipai/db";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { resolveFormalQaGitHubToken } from "./formal-qa-github-issuer.js";
import { formalQaPreparationService } from "./formal-qa-preparations.js";
import { FORMAL_QA_STAGE, formalQaSchedulerStateService } from "./formal-qa-scheduler-state.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type TokenProvider = (input: { companyId: string; responsibleUserId: string }) => Promise<string | null>;
type PullCandidate = { number: number; headSha: string; draft: boolean };

const SHA40_RE = /^[0-9a-f]{40}$/;
const MAX_POLICIES_PER_TICK = 100;
const MAX_PAGES_PER_POLICY = 10;
const DEFAULT_DISCOVERY_INTERVAL_MS = 2 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsePullCandidate(value: unknown): PullCandidate | null {
  const row = asRecord(value);
  const head = row ? asRecord(row.head) : null;
  const number = row?.number;
  const headSha = typeof head?.sha === "string" ? head.sha.toLowerCase() : "";
  if (
    row?.state !== "open"
    || typeof row.draft !== "boolean"
    || typeof number !== "number"
    || !Number.isSafeInteger(number)
    || number <= 0
    || !SHA40_RE.test(headSha)
  ) {
    return null;
  }
  return { number, headSha, draft: row.draft };
}

function hasNextPage(link: string | null): boolean {
  return Boolean(link && /(?:^|,)\s*<[^>]+>;\s*rel="?next"?(?:,|$)/i.test(link));
}

function discoveryKey(input: { policyId: string; policyVersion: number; prNumber: number; headSha: string }) {
  return `github-discovery:${input.policyId}:v${input.policyVersion}:pr:${input.prNumber}:head:${input.headSha}`;
}

/**
 * Discover ready open pull requests for enabled Formal-QA policies.
 *
 * Discovery is only an inert request producer. The issuer still performs the
 * authoritative double-read of the pull request, check run, workflow run, and
 * exact commit/tree before it can create a checkout or review run.
 */
export function formalQaGitHubDiscoveryService(db: Db, options?: {
  fetch?: FetchLike;
  tokenProvider?: TokenProvider;
  discoveryIntervalMs?: number;
}) {
  const fetchImpl = options?.fetch ?? ghFetch;
  const resolveToken = options?.tokenProvider
    ?? ((input: { companyId: string; responsibleUserId: string }) => resolveFormalQaGitHubToken(db, input));
  const preparations = formalQaPreparationService(db);
  const discoveryIntervalMs = Math.max(0, options?.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS);
  const schedulerState = formalQaSchedulerStateService(db);

  const reconcileOpenPulls = async (input: {
    companyId?: string;
    policyLimit?: number;
    maxPagesPerPolicy?: number;
  } = {}) => {
    const now = new Date();
    const policyRows = await db.select({ policy: formalQaPolicies, state: formalQaSchedulerStates })
      .from(formalQaPolicies)
      .leftJoin(formalQaSchedulerStates, and(
        eq(formalQaSchedulerStates.stage, FORMAL_QA_STAGE.discovery),
        eq(formalQaSchedulerStates.subjectId, formalQaPolicies.id),
      )).where(and(
        eq(formalQaPolicies.enabled, true),
        or(isNull(formalQaSchedulerStates.subjectId), lte(formalQaSchedulerStates.nextEligibleAt, now)),
        input.companyId ? eq(formalQaPolicies.companyId, input.companyId) : undefined,
      )).orderBy(
        asc(sql`coalesce(${formalQaSchedulerStates.nextEligibleAt}, 'epoch'::timestamptz)`),
        asc(formalQaPolicies.createdAt),
      ).limit(
      Math.max(1, Math.min(input.policyLimit ?? 25, MAX_POLICIES_PER_TICK)),
    );
    const policies = policyRows.map((row) => ({ ...row.policy, discoveryState: row.state }));
    const result = {
      policiesMatched: policies.length,
      policiesScanned: 0,
      policiesThrottled: 0,
      pullsScanned: 0,
      created: 0,
      replayed: 0,
      draftsSkipped: 0,
      deferred: 0,
    };

    for (const policy of policies) {
      result.policiesScanned += 1;
      let cursor = Math.max(1, policy.discoveryState?.cursor ?? 1);
      try {
        const token = await resolveToken({
          companyId: policy.companyId,
          responsibleUserId: policy.updatedByUserId,
        });
        if (!token?.trim()) throw new Error("formal_qa_github_token_unavailable");
        const [owner, repo] = policy.repository.split("/");
        if (!owner || !repo) throw new Error("formal_qa_policy_repository_invalid");
        const apiBase = gitHubApiBase("github.com");
        const maxPages = Math.max(1, Math.min(input.maxPagesPerPolicy ?? MAX_PAGES_PER_POLICY, MAX_PAGES_PER_POLICY));

        for (let scannedPages = 0; scannedPages < maxPages; scannedPages += 1) {
          const page = cursor;
          const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`;
          const response = await fetchImpl(url, {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "user-agent": "paperclip-formal-qa-discovery",
              "x-github-api-version": "2022-11-28",
            },
          });
          if (!response.ok || response.redirected) throw new Error("formal_qa_github_discovery_read_failed");
          const body = await response.json().catch(() => null);
          if (!Array.isArray(body) || body.length > 100) throw new Error("formal_qa_github_discovery_invalid_response");
          result.pullsScanned += body.length;

          for (const value of body) {
            const pull = parsePullCandidate(value);
            if (!pull) throw new Error("formal_qa_github_discovery_invalid_response");
            // Drafts are observed on every tick but remain inert. The same
            // exact head becomes eligible automatically when GitHub reports
            // the pull request as ready for review.
            if (pull.draft) {
              result.draftsSkipped += 1;
              continue;
            }
            const created = await preparations.create({
              companyId: policy.companyId,
              projectId: policy.projectId,
              projectWorkspaceId: policy.projectWorkspaceId,
              prNumber: pull.number,
              idempotencyKey: discoveryKey({
                policyId: policy.id,
                policyVersion: policy.version,
                prNumber: pull.number,
                headSha: pull.headSha,
              }),
              issuedByUserId: policy.updatedByUserId,
            });
            if (created.replayed) result.replayed += 1;
            else result.created += 1;
          }

          const next = hasNextPage(response.headers.get("link"));
          cursor = next ? page + 1 : 1;
          if (!Number.isSafeInteger(cursor) || cursor > 10_000) throw new Error("formal_qa_github_discovery_page_bound");
          await schedulerState.record({
            companyId: policy.companyId,
            stage: FORMAL_QA_STAGE.discovery,
            subjectId: policy.id,
            cursor,
            delayMs: next && scannedPages + 1 === maxPages ? 0 : discoveryIntervalMs,
            failed: false,
          });
          if (!next) break;
        }
      } catch {
        await schedulerState.record({
          companyId: policy.companyId,
          stage: FORMAL_QA_STAGE.discovery,
          subjectId: policy.id,
          cursor,
          delayMs: discoveryIntervalMs,
          failed: true,
        });
        result.deferred += 1;
      }
    }
    return result;
  };

  return { reconcileOpenPulls };
}

export const formalQaGitHubDiscoveryTestOnly = { discoveryKey, hasNextPage, parsePullCandidate };
