import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { chatActions, chatEndpointLeases, chatGitHubReviews, type Db } from "@paperclipai/db";
import type { GitHubReviewEventContext } from "@paperclipai/shared";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";
import { githubReviewCheckState } from "./review-check-state.js";

type Scope = { companyId: string; endpointId?: string; repositoryId?: string; number?: number; issueId?: string };
type Entry = Scope & { id: string; dueAt: number; stateRead: boolean };

export const GITHUB_REVIEW_CHECK_COMPANY_RECONSTRUCTION_MS = 30_000;

export function githubReviewCheckReconstructionIntervalMs(scope: Scope | undefined) {
  return scope && !scope.endpointId && !scope.repositoryId && !scope.number && !scope.issueId
    ? GITHUB_REVIEW_CHECK_COMPANY_RECONSTRUCTION_MS : 0;
}

export async function notifyGitHubReviewChecks(tx: object, scope: Scope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatGitHubReviewChecks, JSON.stringify(scope));
}

export function registerGitHubReviewCheckWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  dispatch: (id: string, canContinue: () => boolean) => Promise<unknown>,
  canRun: () => boolean,
) {
  const reviewIssueId = sql<string | null>`(select r.issue_id from ${chatGitHubReviews} r
    where r.endpoint_id = ${chatActions.endpointId}
      and r.repository_id = ${chatActions.payload}->'event'->>'repositoryId'
      and r.pull_number = (${chatActions.payload}->'event'->>'pullNumber')::integer
      and r.head_sha = ${chatActions.payload}->'event'->>'headSha'
    order by r.created_at desc limit 1)`;
  async function page(scope?: Scope, cursor?: string, actionId?: string) {
    return db.select({ action: chatActions, reviewIssueId,
      leaseExpiresAt: sql<string | null>`(select max(l.expires_at) from ${chatEndpointLeases} l
        where l.company_id = ${chatActions.companyId} and l.endpoint_id = ${chatActions.endpointId}
          and l.lease_key = 'github-publication:' || (${chatActions.payload}->'event'->>'repositoryId')
            || ':' || (${chatActions.payload}->'event'->>'pullNumber'))`,
    }).from(chatActions).where(and(eq(chatActions.kind, "github_review_check"),
      or(eq(chatActions.status, "received"), and(eq(chatActions.status, "failed"), sql`${chatActions.result}->>'retryable' = 'true'`)),
      scope ? eq(chatActions.companyId, scope.companyId) : undefined,
      scope?.endpointId ? eq(chatActions.endpointId, scope.endpointId) : undefined,
      scope?.repositoryId ? sql`${chatActions.payload}->'event'->>'repositoryId' = ${scope.repositoryId}` : undefined,
      scope?.number ? sql`${chatActions.payload}->'event'->>'pullNumber' = ${String(scope.number)}` : undefined,
      scope?.issueId ? sql`${reviewIssueId} = ${scope.issueId}` : undefined,
      cursor ? gt(chatActions.id, cursor) : undefined, actionId ? eq(chatActions.id, actionId) : undefined,
    )).orderBy(asc(chatActions.id)).limit(100);
  }
  /** `readState` compares the current check status with the published one, so
   * a change is published before the saved poll deadline. */
  async function entry(row: Awaited<ReturnType<typeof page>>[number], readState = true): Promise<Entry> {
    const { action } = row;
    const event = action.payload.event as GitHubReviewEventContext;
    let dueAt = action.result?.retryAt ? Date.parse(String(action.result.retryAt)) : 0;
    if (!Number.isFinite(dueAt)) throw new Error("GitHub review check has an invalid retry deadline");
    if (action.status === "received" && readState) {
      const current = await githubReviewCheckState(db, action);
      if (current.disposition !== "publish" || current.state !== action.result?.state) dueAt = 0;
    }
    if (row.leaseExpiresAt) dueAt = Math.max(dueAt, Date.parse(row.leaseExpiresAt));
    return { id: action.id, companyId: action.companyId, endpointId: action.endpointId,
      repositoryId: event.repositoryId, number: event.pullNumber, issueId: row.reviewIssueId ?? undefined, dueAt,
      stateRead: readState || action.status !== "received" };
  }
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.chatGitHubReviewChecks,
    decodeScope: (hint: string): Scope | undefined => hint === "*" ? undefined : JSON.parse(hint),
    matches: (value: Entry, scope?: Scope) => !scope || (value.companyId === scope.companyId &&
      (!scope.endpointId || value.endpointId === scope.endpointId) &&
      (!scope.repositoryId || value.repositoryId === scope.repositoryId) && (!scope.number || value.number === scope.number) &&
      (!scope.issueId || value.issueId === scope.issueId)),
    reconstructionIntervalMs: githubReviewCheckReconstructionIntervalMs,
    // A rebuild that did not read the status must not postpone a change that
    // an earlier read found due. check() reads the status again.
    mergeEntry: (pending: Entry, loaded: Entry) => loaded.stateRead ? loaded
      : { ...loaded, dueAt: Math.min(pending.dueAt, loaded.dueAt) },
    load: async (scope?: Scope, signal?: AbortSignal) => {
      const entries: Entry[] = [];
      let cursor: string | undefined;
      // A company-wide hint says only that something in the company changed.
      // Its rebuild keeps each check's saved poll deadline, where dispatch reads
      // the current status anyway. A change to a check's run or pull request
      // sends a hint for its task or pull request, and startup (no scope) reads
      // every status, so both still publish a change at once.
      const readState = !scope || !!(scope.endpointId || scope.repositoryId || scope.number || scope.issueId);
      while (canRun() && !signal?.aborted) {
        const rows = await page(scope, cursor);
        for (const row of rows) {
          if (!canRun() || signal?.aborted) throw signal?.reason ?? new Error("GitHub review check recovery stopped");
          entries.push(await entry(row, readState));
        }
        if (rows.length < 100) return entries;
        cursor = rows[rows.length - 1].action.id;
      }
      throw signal?.reason ?? new Error("GitHub review check recovery stopped");
    },
    check: async (value: Entry, signal?: AbortSignal) => {
      const [row] = await page(undefined, undefined, value.id);
      const current = row ? await entry(row) : null;
      if (!current || current.dueAt > Date.now() || !canRun() || signal?.aborted) return current;
      await dispatch(current.id, () => canRun() && !signal?.aborted);
      const [remaining] = await page(undefined, undefined, value.id);
      return remaining ? entry(remaining) : null;
    },
  }, canRun);
}
