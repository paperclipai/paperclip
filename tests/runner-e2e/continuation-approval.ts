import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { isContinuationPlan, type ContinuationCheckpoint } from "./continuation-scoring.js";

type Target = { type: string; issueId?: string; key?: string; revisionId?: string };
export interface ContinuationApproval {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  resolverPolicy?: string;
  effectiveResolverPolicy?: string;
  continuationPolicy?: string;
  payload: { acceptLabel?: string; target?: Target };
  resolvedByUserId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedAt?: string | null;
  result?: { outcome?: string } | null;
}

/** Select the exact current saved proposal before using its UI. */
export function currentContinuationApproval(checkpoint: ContinuationCheckpoint): ContinuationApproval {
  const pending = (checkpoint.interactions as ContinuationApproval[])
    .filter(i => i.kind === "request_confirmation" && i.status === "pending");
  expect(pending, "one current plan confirmation must await the user's decision").toHaveLength(1);
  const card = pending[0]!;
  const target = card.payload.target;
  expect(card.issueId).toBe(checkpoint.issue.id);
  expect(target).toMatchObject({ type: "issue_document", issueId: checkpoint.issue.id });
  const document = checkpoint.documents.find(d => d.key === target?.key);
  expect(document && isContinuationPlan(document, checkpoint), "approval must target the recorded plan").toBeTruthy();
  expect(document?.latestRevisionId, "the plan must have an immutable current revision").toBeTruthy();
  expect(target?.revisionId, "approval must target the current plan revision").toBe(document!.latestRevisionId);
  return card;
}

function sameTarget(left: Target | undefined, right: Target | undefined) {
  return Boolean(left && right && left.type === right.type && left.issueId === right.issueId
    && left.key === right.key && left.revisionId === right.revisionId);
}

export function continuationApprovalAccepted(expected: ContinuationApproval, saved: ContinuationApproval | undefined) {
  return Boolean(saved && saved.id === expected.id && saved.issueId === expected.issueId
    && saved.kind === "request_confirmation" && saved.status === "accepted"
    && saved.result?.outcome === "accepted" && sameTarget(expected.payload.target, saved.payload.target)
    && saved.resolvedByUserId?.trim() && !saved.resolvedByAgentId
    && saved.resolvedAt && Number.isFinite(Date.parse(saved.resolvedAt)));
}

/** A chat comment/dismissal is not a human-only card response. Use its real UI. */
export async function confirmContinuationPlan(input: {
  page: Page;
  api: Pick<RunnerApi, "get">;
  checkpoint: ContinuationCheckpoint;
  deadlineAt: number;
}) {
  const expected = currentContinuationApproval(input.checkpoint);
  const path = `/api/issues/${input.checkpoint.issue.id}`;
  const [interactions, documents] = await Promise.all([
    input.api.get<ContinuationApproval[]>(`${path}/interactions`),
    input.api.get<ContinuationCheckpoint["documents"]>(`${path}/documents`),
  ]);
  const current = currentContinuationApproval({ ...input.checkpoint, interactions, documents });
  expect(current.id, "the reviewed confirmation must still be current").toBe(expected.id);
  expect(sameTarget(current.payload.target, expected.payload.target), "the reviewed plan must not change before approval").toBe(true);
  const card = input.page.getByTestId("task-chat-composer-takeover")
    .locator(`[id=${JSON.stringify(`interaction-${current.id}`)}]`);
  await expect(card, "the exact current confirmation must be visible").toBeVisible();
  await card.getByRole("button", { name: current.payload.acceptLabel ?? "Approve", exact: true }).click();
  const saved = await pollUntil({
    label: "continuation plan human acceptance",
    deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000),
    intervalMs: 250,
    load: async () => (await input.api.get<ContinuationApproval[]>(`${path}/interactions`)).find(i => i.id === current.id),
    accept: result => continuationApprovalAccepted(current, result),
    reject: result => result && (!sameTarget(current.payload.target, result.payload.target)
      || !["pending", "accepted"].includes(result.status)
      || result.status === "accepted" && !continuationApprovalAccepted(current, result))
      ? "the reviewed confirmation changed or did not record human acceptance" : undefined,
  });
  return saved!;
}
