import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { createTaskThroughUi, withBrowserEvent } from "../user-actions.js";
import { createObservedReader } from "./observation-read.js";
import { taskLifecycleEvidence, taskLifecycleLabelName, type LifecycleExpectation, type LifecycleLabel, type LifecycleObservation, type LifecycleTask } from "./task-lifecycle-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Stage = "create" | "initial_read" | "rename" | "label" | "in_progress" | "reload" | "complete" | "reopen";
function taskSnapshot(task: LifecycleTask): LifecycleTask {
  return { id: task.id, companyId: task.companyId, identifier: task.identifier, title: task.title,
    description: task.description, status: task.status, priority: task.priority, projectId: task.projectId,
    assigneeUserId: task.assigneeUserId, assigneeAgentId: task.assigneeAgentId, createdByUserId: task.createdByUserId,
    createdByAgentId: task.createdByAgentId, labelIds: task.labelIds, completedAt: task.completedAt };
}
const emptyObservation = (): LifecycleObservation => ({ task: null, runCount: null,
  titleVisible: false, descriptionVisible: false, statusVisible: false, labelVisible: false });

async function properties(context: JourneyContext) {
  const { page } = context;
  // Closed panes keep their rows mounted. Their geometry alone does not make
  // an inert or accessibility-hidden panel available for interaction.
  const row = page.locator('[data-property-row]:not([inert] *):not([aria-hidden="true"] *)')
    .filter({ has: page.locator('[data-property-label="Labels"]') }).filter({ visible: true });
  const toggle = page.getByRole("button", { name: "Toggle side panel", exact: true, pressed: false }).filter({ visible: true });
  const propertiesButton = page.getByRole("button", { name: /^(Show properties|Properties)$/ }).filter({ visible: true });
  await expect.poll(async () => await row.isVisible() || await toggle.isVisible() || await propertiesButton.isVisible()).toBe(true);
  if (!await row.isVisible()) {
    if (await toggle.isVisible()) await toggle.click();
    else await propertiesButton.click();
  }
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport();
  return row;
}

async function setStatus(context: JourneyContext, label: string) {
  const { page } = context;
  await page.getByTestId("issue-detail-header").filter({ visible: true })
    .getByRole("button", { name: /^Change status \(current:/ }).click();
  // The shipped picker includes both a labeled status glyph and visible text.
  // Bind the choice to its exact accessible glyph inside the open popover.
  await page.locator('[data-slot="popover-content"]').filter({ visible: true })
    .getByRole("button").filter({ has: page.getByRole("img", { name: label, exact: true }) }).click();
}

/** All measured edits use the shipped browser. Independent GETs verify saved state. */
export async function taskEditLifecycle(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence,
  options: { deadlineAt: number; directory: string }) {
  const { page, api, company, user } = context;
  const read = createObservedReader(api, options.deadlineAt);
  const journeyId = "task-edit-lifecycle" as const;
  const originalTitle = `Journey QA task lifecycle ${campaignId}`;
  const revisedTitle = `Journey QA task lifecycle revised ${campaignId}`;
  const description = `Keep this task assigned to me. Saved task context ${campaignId} must survive every edit.`;
  const labelName = taskLifecycleLabelName(campaignId);
  const observed = { created: emptyObservation(), edited: emptyObservation(), reloaded: emptyObservation(),
    completed: emptyObservation(), reopened: emptyObservation() };
  let expected: LifecycleExpectation | undefined;
  let label: LifecycleLabel | null = null;
  let stage: Stage = "create";
  const check = (id: string, passed: boolean) => {
    evidence.checks.push({ id, passed });
    if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_"));
  };
  const preserve = async () => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(options.directory, "task-lifecycle-observations.json"),
      JSON.stringify({ schema: "paperclip.task-lifecycle-observations/v1", stage, expected, label, ...observed }, null, 2), { mode: 0o600 });
  };
  const grade = () => taskLifecycleEvidence({ expected: expected!, label, ...observed });
  try {
    for (const capability of ["company", "board-user", "task-write"]) {
      if (!context.capabilities.includes(capability)) throw new JourneyError("unsupported", `missing_${capability}`);
    }
    if (!campaignId) throw new JourneyError("blocked", "task_lifecycle_campaign_required");
    const created = await createTaskThroughUi({ page, origin: api.origin, issuePrefix: company.issuePrefix,
      agentName: "Me", title: originalTitle, prompt: description, workMode: "standard", requireExplicitTitle: true,
      beforeDispatch: () => session.own({ kind: "issue", name: originalTitle, journeyId }) });
    await session.own({ kind: "issue", name: originalTitle, id: created.issueId, journeyId });
    const route = `/api/issues/${created.issueId}`;
    expected = { taskId: created.issueId, companyId: company.id, userId: user.id, originalTitle, revisedTitle, description, labelName };
    const task = await read.get<LifecycleTask>(route);
    await page.goto(`${api.origin}/${company.issuePrefix}/issues/${task.identifier}`);
    const capture = async (title: string, statusLabel: string, withLabel: boolean): Promise<LifecycleObservation> => {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.getByText(description, { exact: true }).first()).toBeVisible();
      const status = page.getByRole("button", { name: `Change status (current: ${statusLabel})`, exact: true }).filter({ visible: true }).first();
      await expect(status).toBeVisible();
      const labelRow = await properties(context);
      if (withLabel) await expect(labelRow.getByText(labelName, { exact: true })).toBeVisible();
      const saved = await read.get<LifecycleTask>(route);
      const runs = await read.get<unknown[]>(`${route}/runs`);
      return { task: structuredClone(taskSnapshot(saved)), runCount: Array.isArray(runs) ? runs.length : null,
        titleVisible: await page.getByRole("heading", { name: title, exact: true }).isVisible(),
        descriptionVisible: await page.getByText(description, { exact: true }).first().isVisible(),
        statusVisible: await status.isVisible(), labelVisible: withLabel && await labelRow.getByText(labelName, { exact: true }).isVisible() };
    };
    stage = "initial_read";
    const initialStatus = task.status === "backlog" ? "Backlog" : "Todo";
    observed.created = await capture(originalTitle, initialStatus, false);
    await preserve();
    check("task-lifecycle-browser-created", grade().created);
    stage = "rename";
    // Keep the creation receipt stable. Cleanup may accept this one exact,
    // predeclared title if the browser save commits but its response is lost.
    await session.own({ kind: "issue", name: originalTitle, id: created.issueId, journeyId, taskEdit: { revisedTitle } });
    await page.getByRole("heading", { name: originalTitle, exact: true }).click();
    const titleEditor = page.getByTestId("issue-detail-header").locator("textarea").first();
    await titleEditor.fill(revisedTitle);
    await titleEditor.press("Enter");
    await expect.poll(async () => (await read.get<LifecycleTask>(route)).title).toBe(revisedTitle);
    stage = "label";
    const labelsRoute = `/api/companies/${company.id}/labels`;
    const beforeLabels = await read.get<LifecycleLabel[]>(labelsRoute);
    if (beforeLabels.some(row => row.name === labelName)) throw new JourneyError("failed", "task_lifecycle_label_not_fresh");
    const labels = await properties(context);
    await labels.locator("[data-property-value]").getByRole("button").first().click();
    await page.getByPlaceholder("New label", { exact: true }).fill(labelName);
    await session.own({ kind: "label", name: labelName, journeyId });
    const response = await withBrowserEvent(() => page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === labelsRoute),
    () => page.getByRole("button", { name: "Create label", exact: true }).click());
    if (response.status() !== 201) throw new JourneyError("failed", "task_lifecycle_label_create_failed");
    const createdLabel = await response.json() as LifecycleLabel;
    if (typeof createdLabel.id !== "string" || !createdLabel.id || createdLabel.name !== labelName || createdLabel.companyId !== company.id) {
      throw new JourneyError("failed", "task_lifecycle_label_receipt_mismatch");
    }
    await session.own({ kind: "label", name: labelName, id: createdLabel.id, journeyId });
    label = { id: createdLabel.id, companyId: createdLabel.companyId, name: createdLabel.name, color: createdLabel.color };
    await page.keyboard.press("Escape");
    const savedLabels = await read.get<LifecycleLabel[]>(labelsRoute);
    if (savedLabels.filter(row => row.name === labelName).length !== 1
      || !savedLabels.some(row => row.id === label!.id && row.name === labelName && row.companyId === company.id && row.color === label!.color)) {
      throw new JourneyError("failed", "task_lifecycle_label_saved_mismatch");
    }
    stage = "in_progress";
    await setStatus(context, "In Progress");
    await expect.poll(async () => (await read.get<LifecycleTask>(route)).status).toBe("in_progress");
    await expect.poll(async () => {
      const task = await read.get<LifecycleTask>(route);
      return Array.isArray(task.labelIds) && task.labelIds.length === 1 && task.labelIds[0] === label!.id;
    }).toBe(true);
    observed.edited = await capture(revisedTitle, "In Progress", true);
    await preserve();
    check("task-lifecycle-visible-edits-persisted", grade().edited);
    stage = "reload";
    await page.reload();
    observed.reloaded = await capture(revisedTitle, "In Progress", true);
    await preserve();
    check("task-lifecycle-edits-reloaded", grade().reloaded);
    stage = "complete";
    await setStatus(context, "Done");
    await expect.poll(async () => (await read.get<LifecycleTask>(route)).status).toBe("done");
    await page.reload();
    observed.completed = await capture(revisedTitle, "Done", true);
    await preserve();
    stage = "reopen";
    await setStatus(context, "Todo");
    await expect.poll(async () => (await read.get<LifecycleTask>(route)).status).toBe("todo");
    await page.reload();
    observed.reopened = await capture(revisedTitle, "Todo", true);
    await preserve();
    const final = grade();
    check("task-lifecycle-completed-and-reopened", final.completedAndReopened);
    check("task-lifecycle-unedited-context-preserved", final.uneditedFieldsPreserved);
    check("no-agent-work", final.noAgentWork);
  } catch (error) {
    if (error instanceof JourneyError) throw error;
    throw new JourneyError("failed", `task_lifecycle_${stage}_failed`);
  } finally { await preserve(); await read.preserve(options.directory); }
}
