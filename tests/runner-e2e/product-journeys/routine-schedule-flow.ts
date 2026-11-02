import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { validateAgentTaskState, waitFor } from "./agent-flows.js";
import { openDocumentAuthoring } from "./task-document-flow.js";
import { scheduledInvocationMatches, schedulePauseMatches, type ScheduledInvocation, type ScheduledTask } from "./routine-schedule-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
const journeyId = "routine-scheduled-run" as const;
export async function runScheduledRoutine(context: JourneyContext, session: TargetSession, campaignId: string,
  evidence: JourneyEvidence, options: { deadlineAt: number; directory: string }) {
  const { api, page, company, user, agent } = context;
  if (!agent || agent.runtimeMode !== "native" || !context.environmentId) throw new JourneyError("unsupported", "native_agent_and_environment_required");
  const title = `Journey QA scheduled routine ${campaignId}`, projectName = `Journey QA routine project ${campaignId}`;
  const check = (id: string, passed: boolean) => {
    evidence.checks.push({ id, passed });
    if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_"));
  };
  await session.own({ kind: "project", name: projectName, journeyId });
  const project = await api.post<Row>(`/api/companies/${company.id}/projects`, { name: projectName, status: "planned" });
  await session.own({ kind: "project", name: projectName, id: project.id, journeyId });
  const key = "scheduled-summary", marker = `scheduled-${campaignId}`;
  const prompt = `Prepare the scheduled status check. Save a task document with key ${key} and title Scheduled check. `
    + `Its body must contain exactly these two lines: ${marker} followed by Schedule check complete. `
    + "Then finish the task. Do not create other tasks or agents.";
  await page.goto(`${api.origin}/${company.issuePrefix}/routines`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Create routine", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Routine title", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Responsible", exact: true }).click();
  await page.getByPlaceholder("Search responsible...", { exact: true }).fill(agent.name);
  await page.getByRole("button", { name: agent.name, exact: true }).click();
  await dialog.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByPlaceholder("Search projects...", { exact: true }).fill(projectName);
  await page.getByRole("button", { name: projectName, exact: true }).click();
  await dialog.locator('[contenteditable="true"]').fill(prompt);
  await session.own({ kind: "routine", name: title, journeyId });
  const responsePromise = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/companies/${company.id}/routines`);
  await dialog.getByRole("button", { name: "Create routine", exact: true }).click();
  const response = await responsePromise;
  if (response.status() !== 201) throw new JourneyError("failed", "routine_ui_creation_failed");
  const routine = await response.json();
  if (typeof routine.id !== "string") throw new JourneyError("failed", "routine_creation_receipt_missing");
  await session.own({ kind: "routine", name: title, id: routine.id, journeyId });
  const route = `/api/routines/${routine.id}`;
  // Fixture policy makes duplicate scheduler work observable instead of coalescing it.
  await api.patch(route, { concurrencyPolicy: "always_enqueue" });
  const saved = await api.get<Row>(route);
  check("routine-browser-created", saved.companyId === company.id && saved.title === title && saved.projectId === project.id
    && saved.assigneeAgentId === agent.id && saved.createdByUserId === user.id && saved.createdByAgentId === null
    && saved.description === prompt && saved.concurrencyPolicy === "always_enqueue" && saved.triggers.length === 0);
  const trigger = await api.post<Row>(`${route}/triggers`, { kind: "schedule", label: `QA schedule ${campaignId}`,
    cronExpression: "* * * * *", timezone: "America/Chicago", enabled: false });
  const triggerRoute = `/api/routine-triggers/${trigger.id}`;
  const runs = () => api.get<ScheduledInvocation[]>(`${route}/runs`);
  let pausedAt = 0;
  try {
    await page.goto(`${api.origin}/${company.issuePrefix}/routines/${routine.id}/triggers`, { waitUntil: "domcontentloaded" });
    const enabledAt = Date.now();
    await page.getByRole("button", { name: "Enable trigger", exact: true }).click();
    await expect.poll(async () => (await api.get<Row>(triggerRoute)).enabled).toBe(true);
    const first = await waitFor(options.deadlineAt, runs, rows => rows.length > 0 && Boolean(rows[0]?.linkedIssueId), "scheduled_invocation_missing");
    await page.getByRole("button", { name: "Pause trigger", exact: true }).click();
    await expect.poll(async () => (await api.get<Row>(triggerRoute)).enabled).toBe(false);
    pausedAt = Date.now();
    const task = await api.get<ScheduledTask & { title: string }>(`/api/issues/${first[0]!.linkedIssueId}`);
    await session.own({ kind: "issue", name: task.title, id: task.id, journeyId });
    const expected = { companyId: company.id, routineId: routine.id, triggerId: trigger.id, projectId: project.id, agentId: agent.id, enabledAt };
    check("routine-scheduler-created-execution", scheduledInvocationMatches(first, task, expected));
    const taskRoute = `/api/issues/${task.id}`;
    const state = await waitFor(options.deadlineAt, async () => {
      const [currentIssue, summaries, comments, interactions] = await Promise.all([
        api.get<Row & { id: string; status: string }>(taskRoute), api.get<Row[]>(`${taskRoute}/runs`), api.get<Row[]>(`${taskRoute}/comments?order=asc`),
        api.get<Array<Row & { id: string; status: string }>>(`${taskRoute}/interactions`),
      ]);
      const taskRuns = await Promise.all(summaries.map(row => api.get<Row & { status: string }>(`/api/heartbeat-runs/${row.runId}`)));
      const value = { currentIssue, taskRuns, comments, interactions, attachments: [] };
      validateAgentTaskState(context, task.id, value, 1);
      return value;
    }, value => value.currentIssue.status === "done" && value.taskRuns.length === 1 && value.taskRuns[0]!.status === "succeeded"
      && value.interactions.every(row => row.status !== "pending"), "routine_task_not_completed");
    const completedAt = Date.now();
    const document = await api.get<Row>(`${taskRoute}/documents/${key}`);
    const revision = await api.get<Row>(`${taskRoute}/documents/${key}/revisions/${document.latestRevisionId}`);
    const expectedBody = `${marker}\nSchedule check complete.`;
    check("routine-result-attributed", document.companyId === company.id && document.issueId === task.id
      && document.body?.trim() === expectedBody && document.createdByAgentId === agent.id && document.createdByUserId === null
      && revision.documentId === document.id && revision.body?.trim() === expectedBody && revision.createdByAgentId === agent.id
      && revision.createdByRunId === state.taskRuns[0]!.id);
    await page.goto(`${api.origin}/${company.issuePrefix}/routines/${routine.id}/runs`, { waitUntil: "domcontentloaded" });
    await page.reload();
    await expect(page.getByRole("link", { name: state.currentIssue.identifier, exact: false }).first()).toBeVisible();
    const final = await waitFor(options.deadlineAt, async () => ({ rows: await runs(), now: Date.now() }), value => {
      if (value.rows.length !== 1) throw new JourneyError("failed", "routine_duplicate_invocation");
      return value.rows[0]?.status === "completed" && value.now >= Math.floor(Math.max(pausedAt, completedAt) / 60_000) * 60_000 + 65_000;
    }, "routine_pause_not_observed");
    check("routine-history-preserved", scheduledInvocationMatches(final.rows, await api.get(taskRoute), expected));
    check("routine-pause-prevented-next-run", schedulePauseMatches({ enabled: (await api.get<Row>(triggerRoute)).enabled,
      pausedAt, completedAt, observedUntil: final.now, first, final: final.rows }));
    await page.goto(`${api.origin}/${company.issuePrefix}/issues/${state.currentIssue.identifier}`, { waitUntil: "domcontentloaded" });
    await page.reload();
    await openDocumentAuthoring(context);
    await expect(page.locator(`#document-${key}`)).toContainText(marker);
    check("routine-result-reopened", (await api.get<Row>(`${taskRoute}/documents/${key}`)).latestRevisionId === document.latestRevisionId);
    check("configured-model-and-environment", true);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(options.directory, "scheduled-routine-checks.json"), JSON.stringify({ routineId: routine.id,
      triggerId: trigger.id, invocationId: first[0]!.id, taskId: task.id, runId: state.taskRuns[0]!.id, enabledAt, pausedAt, completedAt,
      observedUntil: final.now, documentId: document.id, revisionId: revision.id }, null, 2), { mode: 0o600 });
  } finally {
    // The private provider independently reconciles and stops this exact routine
    // if this request fails or the page closes before its receipt arrives.
    await api.patch(triggerRoute, { enabled: false });
  }
}
