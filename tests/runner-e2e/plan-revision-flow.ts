import { expect, type Page } from "@playwright/test";
import { pollUntil } from "./api.js";
import { numberedPlanStepCount } from "./run-observations.js";

export interface PlanInteraction {
  id: string; kind?: string; status: string;
  payload?: { acceptLabel?: string; rejectLabel?: string; target?: { type?: string; key?: string; revisionId?: string } };
}
export interface PlanDocument { id: string; key: string; body?: string | null; latestRevisionId?: string | null; latestRevisionNumber?: number }
interface PlanState {
  currentIssue: { status: string };
  taskRuns: Array<{ status: string }>;
  interactions: PlanInteraction[];
}
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
export function isPendingPlanConfirmation(interaction: PlanInteraction) {
  return interaction.kind === "request_confirmation" && interaction.status === "pending"
    && interaction.payload?.target?.type === "issue_document" && interaction.payload.target.key === "plan"
    && typeof interaction.payload.target.revisionId === "string";
}
export function normalizePlanMarkdown(body: string | null | undefined) { return (body ?? "").replaceAll("\\_", "_"); }
export async function expectPlanStageVisible(page: Page, options: { native: boolean; revision: number | null }) {
  const root = options.native ? page.locator('[data-testid="task-chat-turn"][data-settled="true"]') : page.locator("body");
  const preview = root.getByTestId("task-chat-plan-preview").last();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  if (options.revision !== null) await expect(preview).toHaveAttribute("aria-label", `Open Plan revision ${options.revision}`);
}

/** The classic matrix and deployment-targeted journeys share this exact user story. */
export async function runPlanRevisionAcceptance<S extends PlanState>(input: {
  page: Page; api: { get<T>(route: string): Promise<T> }; origin: string;
  issue: { id: string; identifier?: string | null }; issuePrefix: string; native: boolean;
  planMarkers: { draft: string; revised: string }; revisionRequest: string; deadlineAt: number;
  load(): Promise<S>;
  retryOnError?: (error: unknown) => boolean;
  reject(state: { taskRuns: S["taskRuns"]; interactions: S["interactions"]; minimumRunCount: number }): string | undefined;
  capture(id: string, label: string, file: string): Promise<void>;
}) {
  const { page, api, origin, issue, issuePrefix, native, planMarkers, revisionRequest, deadlineAt, load, reject, capture } = input;
  const draftState = await pollUntil({
    label: `initial plan confirmation for issue ${issue.id}`,
    deadlineAt,
    load,
    retryOnError: input.retryOnError,
    accept: ({ currentIssue, taskRuns, interactions }) =>
      currentIssue.status !== "done" &&
      taskRuns.length >= 1 &&
      taskRuns.every((run) => TERMINAL_RUN_STATUSES.has(run.status)) &&
      interactions.some(isPendingPlanConfirmation),
    reject: ({ currentIssue, taskRuns, interactions }) =>
      currentIssue.status === "done" ? "Plan completed before approval" : reject({
        taskRuns,
        interactions,
        minimumRunCount: 1,
      }),
  });
  const draftInteraction = draftState.interactions.find(
    isPendingPlanConfirmation,
  )!;
  const draftPlan = await api.get<PlanDocument>(
    `/api/issues/${issue.id}/documents/plan`,
  );
  if (
    !normalizePlanMarkdown(draftPlan.body).includes(planMarkers.draft)
  ) {
    throw new Error(
      `Initial Plan document did not contain ${planMarkers.draft}`,
    );
  }
  if (numberedPlanStepCount(draftPlan.body) !== 2) {
    throw new Error(
      "Initial Plan must contain exactly two numbered steps",
    );
  }
  if (
    draftInteraction.payload?.target?.revisionId !==
    draftPlan.latestRevisionId
  ) {
    throw new Error(
      "Initial plan confirmation did not target the latest Plan revision",
    );
  }
  await page.goto(
    `${origin}/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
    { waitUntil: "domcontentloaded" },
  );
  await expectPlanStageVisible(page, {
    native,
    revision: draftPlan.latestRevisionNumber ?? null,
  });
  await capture(
    "plan-draft",
    "Initial plan awaiting revision",
    "plan-draft.png",
  );
  await page
    .getByRole("button", {
      name: draftInteraction.payload?.rejectLabel ?? "Reject",
      exact: true,
    })
    .last()
    .click();
  const revisionComposer = page
    .getByTestId("plan-revision-composer")
    .last();
  await expect(revisionComposer).toBeVisible({ timeout: 10_000 });
  await revisionComposer
    .locator('[contenteditable="true"], textarea')
    .first()
    .fill(revisionRequest);
  await page
    .getByRole("button", {
      name: draftInteraction.payload?.rejectLabel ?? "Reject",
      exact: true,
    })
    .last()
    .click();

  const revisedState = await pollUntil({
    label: `revised plan confirmation for issue ${issue.id}`,
    deadlineAt,
    load,
    retryOnError: input.retryOnError,
    accept: ({ currentIssue, taskRuns, interactions }) =>
      currentIssue.status !== "done" &&
      taskRuns.length >= 2 &&
      taskRuns.every((run) => TERMINAL_RUN_STATUSES.has(run.status)) &&
      interactions.some(
        (interaction) =>
          isPendingPlanConfirmation(interaction) &&
          interaction.id !== draftInteraction.id,
      ),
    reject: ({ currentIssue, taskRuns, interactions }) =>
      currentIssue.status === "done" ? "Plan completed before approval" : reject({
        taskRuns,
        interactions,
        minimumRunCount: 2,
      }),
  });
  const revisedInteraction = revisedState.interactions.find(
    (interaction) =>
      isPendingPlanConfirmation(interaction) &&
      interaction.id !== draftInteraction.id,
  )!;
  const revisedPlan = await api.get<PlanDocument>(
    `/api/issues/${issue.id}/documents/plan`,
  );
  const normalizedRevisedPlan = normalizePlanMarkdown(revisedPlan.body);
  if (
    !normalizedRevisedPlan.includes(planMarkers.revised) ||
    normalizedRevisedPlan.includes(planMarkers.draft)
  ) {
    throw new Error(
      `Revised Plan must replace ${planMarkers.draft} with ${planMarkers.revised}`,
    );
  }
  if (numberedPlanStepCount(revisedPlan.body) !== 3) {
    throw new Error(
      "Revised Plan must contain exactly three numbered steps",
    );
  }
  if (
    revisedInteraction.payload?.target?.revisionId !==
      revisedPlan.latestRevisionId ||
    revisedPlan.latestRevisionId === draftPlan.latestRevisionId
  ) {
    throw new Error(
      "Revised confirmation did not target a new latest Plan revision",
    );
  }
  await page.goto(
    `${origin}/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`,
    { waitUntil: "domcontentloaded" },
  );
  await expectPlanStageVisible(page, {
    native,
    revision: revisedPlan.latestRevisionNumber ?? null,
  });
  await capture(
    "plan-revised",
    "Revised plan awaiting acceptance",
    "plan-revised.png",
  );
  await page
    .getByRole("button", {
      name: revisedInteraction.payload?.acceptLabel ?? "Approve",
      exact: true,
    })
    .last()
    .click();
  return {
    draftInteraction,
    draftPlan,
    revisedInteraction,
    revisedPlan,
    revisionRequest,
  };
}
