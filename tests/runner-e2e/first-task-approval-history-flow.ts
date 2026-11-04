import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { DRAFT_OPTION, PUBLISH_OPTION, approvalHistoryWriter } from "./first-task-approval-history.js";
import type { FirstTaskCheckpoint, Row } from "./first-task-scoring.js";

/** The model produces every proposal and hire; the harness only operates ordinary approval controls. */
export async function runApprovalHistoryDecisions(input: {
  page: Page; api: Pick<RunnerApi, "get">; issueId: string; marker: string; deadlineAt: number;
  allRuns: () => Promise<Row[]>;
  snapshot: (phase: FirstTaskCheckpoint["phase"], at?: string) => Promise<FirstTaskCheckpoint>;
  settle: (prior: Set<string>, completion?: boolean) => Promise<void>;
  capture: (id: string, label: string, file: string) => Promise<void>;
}) {
  const cards = () => input.api.get<Row[]>(`/api/issues/${input.issueId}/interactions`);
  const approve = async (card: Row, phase: FirstTaskCheckpoint["phase"]) => {
    const before = new Set((await input.allRuns()).map(run => run.id));
    await input.page.getByRole("button", { name: card.payload.acceptLabel
      ?? (card.kind === "request_confirmation" ? "Approve" : "Confirm selection"), exact: true }).last().click();
    await pollUntil({ label: `saved ${phase} decision`, deadlineAt: Math.min(input.deadlineAt, Date.now() + 30_000), intervalMs: 250,
      load: cards, accept: rows => rows.some(row => row.id === card.id && row.status === "accepted" && row.resolvedByUserId),
    });
    await input.snapshot(phase);
    await input.settle(before, phase === "accepted");
  };
  const pending = async (predicate: (row: Row) => boolean) => {
    const found = (await cards()).filter(row => row.status === "pending" && predicate(row));
    expect(found, "One saved approval for this stage must exist").toHaveLength(1);
    return found[0]!;
  };
  const plan = await pending(row => row.kind === "request_checkbox_confirmation" && row.payload?.target?.key === "plan");
  expect(plan.payload.options.map((option: Row) => option.label).sort()).toEqual([DRAFT_OPTION, PUBLISH_OPTION].sort());
  await input.page.getByRole("checkbox", { name: DRAFT_OPTION, exact: true }).last().check();
  await input.page.getByRole("checkbox", { name: PUBLISH_OPTION, exact: true }).last().uncheck();
  await approve(plan, "plan-accepted");
  await input.snapshot("hiring-proposed");
  await input.capture("hiring-proposed", "Hiring waits for approval", "hiring-proposed.png");
  const writer = approvalHistoryWriter(input.marker);
  const hiring = await pending(row => row.kind === "request_checkbox_confirmation" && !row.payload?.target
    && row.payload?.options?.length === 1 && row.payload.options[0].label.includes(writer));
  await input.page.getByRole("checkbox", { name: hiring.payload.options[0].label, exact: true }).last().check();
  await approve(hiring, "hiring-accepted");
  await input.snapshot("execution-proposed");
  await input.capture("execution-proposed", "Execution waits for Start drafting", "execution-proposed.png");
  const execution = await pending(row => row.kind === "request_confirmation" && !row.payload?.target
    && /start drafting/i.test(row.payload?.prompt ?? ""));
  await approve(execution, "accepted");
  await input.snapshot("finished");
  await input.page.reload({ waitUntil: "domcontentloaded" });
  await input.snapshot("finished");
}
