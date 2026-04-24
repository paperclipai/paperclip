import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { resolveReleaseGateQaAgent, selectPooledQaReviewer, type QaReviewerCandidate } from "@paperclipai/shared";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

export const QA_OPEN_LOAD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

export type QaReviewerPoolCandidate = QaReviewerCandidate & {
  name?: string | null;
  title?: string | null;
};

export type QaReviewerPoolSelection = ReturnType<typeof selectPooledQaReviewer> & {
  orderedReviewers: QaReviewerPoolCandidate[];
  selectedReviewer: QaReviewerPoolCandidate | null;
  preferredReviewerAgentId: string | null;
  openIssueCountByAgentId: ReadonlyMap<string, number>;
};

function reviewerOrder(input: {
  reviewer: QaReviewerPoolCandidate;
  selectedReviewerAgentId: string | null;
  preferredReviewerAgentId: string | null;
  openIssueCountByAgentId: ReadonlyMap<string, number>;
}) {
  return [
    input.reviewer.id === input.selectedReviewerAgentId ? 0 : 1,
    input.openIssueCountByAgentId.get(input.reviewer.id) ?? 0,
    input.reviewer.id === input.preferredReviewerAgentId ? 0 : 1,
    input.reviewer.status === "idle" ? 0 : input.reviewer.status === "active" ? 1 : input.reviewer.status === "running" ? 2 : 3,
    input.reviewer.id,
  ] as const;
}

export function buildQaOpenIssueCountByAgentId(
  openIssues: Array<{ assigneeAgentId?: string | null }>,
  reviewerIds: string[],
) {
  const reviewerIdSet = new Set(reviewerIds);
  const counts = new Map<string, number>();
  for (const reviewerId of reviewerIds) {
    counts.set(reviewerId, 0);
  }
  for (const issue of openIssues) {
    const assigneeAgentId = issue.assigneeAgentId ?? null;
    if (!assigneeAgentId || !reviewerIdSet.has(assigneeAgentId)) continue;
    counts.set(assigneeAgentId, (counts.get(assigneeAgentId) ?? 0) + 1);
  }
  return counts;
}

export function resolvePreferredQaReviewerAgentId(
  reviewers: QaReviewerPoolCandidate[],
  configuredReviewerAgentId?: string | null,
) {
  return resolveReleaseGateQaAgent(reviewers, {
    configuredAgentId: configuredReviewerAgentId ?? null,
  }).releaseGateQaAgent?.id ?? null;
}

export function orderPooledQaReviewers(input: {
  reviewers: QaReviewerPoolCandidate[];
  stickyReviewerAgentId?: string | null;
  preferredReviewerAgentId?: string | null;
  openIssueCountByAgentId?: ReadonlyMap<string, number>;
}): QaReviewerPoolSelection {
  const openIssueCountByAgentId = input.openIssueCountByAgentId ?? new Map<string, number>();
  const selection = selectPooledQaReviewer({
    reviewers: input.reviewers,
    stickyReviewerAgentId: input.stickyReviewerAgentId ?? null,
    preferredReviewerAgentId: input.preferredReviewerAgentId ?? null,
    openIssueCountByAgentId,
  });
  const eligibleReviewerIds = new Set(selection.eligibleAgentIds);
  const orderedReviewers = input.reviewers
    .filter((reviewer) => eligibleReviewerIds.has(reviewer.id))
    .sort((left, right) => {
    const leftOrder = reviewerOrder({
      reviewer: left,
      selectedReviewerAgentId: selection.reviewerAgentId,
      preferredReviewerAgentId: input.preferredReviewerAgentId ?? null,
      openIssueCountByAgentId,
    });
    const rightOrder = reviewerOrder({
      reviewer: right,
      selectedReviewerAgentId: selection.reviewerAgentId,
      preferredReviewerAgentId: input.preferredReviewerAgentId ?? null,
      openIssueCountByAgentId,
    });
    for (let index = 0; index < leftOrder.length; index += 1) {
      if (leftOrder[index] === rightOrder[index]) continue;
      return leftOrder[index] < rightOrder[index] ? -1 : 1;
    }
    return 0;
    });
  return {
    ...selection,
    orderedReviewers,
    selectedReviewer: orderedReviewers.find((reviewer) => reviewer.id === selection.reviewerAgentId) ?? null,
    preferredReviewerAgentId: input.preferredReviewerAgentId ?? null,
    openIssueCountByAgentId,
  };
}

export function buildDeliveryQaExecutionPolicy(reviewers: QaReviewerPoolCandidate[]): IssueExecutionPolicy | null {
  if (reviewers.length === 0) return null;
  return normalizeIssueExecutionPolicy({
    stages: [{
      type: "review",
      participants: reviewers.map((reviewer) => ({
        type: "agent" as const,
        agentId: reviewer.id,
      })),
    }],
  });
}

type LoadableDb = Pick<Db, "select">;

export async function loadCompanyQaReviewerPool(db: LoadableDb, companyId: string) {
  const [companyRow, reviewerRows, openIssueRows] = await Promise.all([
    db
      .select({
        releaseGateQaAgentId: companies.releaseGateQaAgentId,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: agents.id,
        role: agents.role,
        status: agents.status,
        name: agents.name,
        title: agents.title,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "qa"))),
    db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.status, [...QA_OPEN_LOAD_STATUSES]),
          isNull(issues.hiddenAt),
        ),
      ),
  ]);

  const openIssueCountByAgentId = buildQaOpenIssueCountByAgentId(
    openIssueRows,
    reviewerRows.map((reviewer) => reviewer.id),
  );
  const preferredReviewerAgentId = resolvePreferredQaReviewerAgentId(
    reviewerRows,
    companyRow?.releaseGateQaAgentId ?? null,
  );

  return {
    configuredReviewerAgentId: companyRow?.releaseGateQaAgentId ?? null,
    reviewers: reviewerRows,
    openIssueCountByAgentId,
    preferredReviewerAgentId,
  };
}

export async function selectCompanyPooledQaReviewers(
  db: LoadableDb,
  companyId: string,
  opts?: {
    stickyReviewerAgentId?: string | null;
  },
) {
  const pool = await loadCompanyQaReviewerPool(db, companyId);
  return orderPooledQaReviewers({
    reviewers: pool.reviewers,
    stickyReviewerAgentId: opts?.stickyReviewerAgentId ?? null,
    preferredReviewerAgentId: pool.preferredReviewerAgentId,
    openIssueCountByAgentId: pool.openIssueCountByAgentId,
  });
}

export function authorizedStandaloneQaReviewerAgentId(issue: {
  assigneeAgentId?: string | null;
  qaReviewerAgentId?: string | null;
  executionState?: unknown;
}) {
  const currentParticipant =
    issue.executionState && typeof issue.executionState === "object"
      ? (issue.executionState as {
          currentParticipant?: {
            type?: "agent" | "user";
            agentId?: string | null;
          } | null;
        }).currentParticipant ?? null
      : null;
  if (currentParticipant?.type === "agent" && currentParticipant.agentId) {
    return currentParticipant.agentId;
  }
  if (issue.qaReviewerAgentId) {
    return issue.qaReviewerAgentId;
  }
  return issue.assigneeAgentId ?? null;
}
