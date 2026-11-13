import { createObservedReader } from "./observation-read.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { ConnectionFailure } from "../connection-config.js";
import { fillTaskPrompt, withBrowserEvent } from "../user-actions.js";
import { validateAgentTaskState, waitFor } from "./agent-flows.js";
import { openDocumentAuthoring } from "./task-document-flow.js";
import { scheduledInvocationMatches, schedulePauseMatches, schedulePauseObservationMs, type ScheduledInvocation, type ScheduledTask } from "./routine-schedule-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
const journeyId = "routine-scheduled-run" as const;
type RoutineUiStep = "open_composer" | "select_responsible" | "select_project" | "fill_instructions" | "submit" | "enable_trigger" | "pause_trigger" | "open_history" | "reopen_result";
export async function routineUiStep<T>(step: RoutineUiStep, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof JourneyError) throw error;
    // Browser failures can contain form values and URLs. Retain only this closed step code.
    throw new JourneyError("failed", `routine_${step}_failed`);
  }
}
export async function enableRoutineScheduleTrigger(page: Pick<Page, "getByRole" | "waitForResponse">, triggerRoute: string) {
  const schedule = page.getByRole("region", { name: "Schedule trigger", exact: true });
  // The enable/pause controls are children of the collapsed schedule editor.
  await schedule.getByRole("button", { name: "Edit schedule", exact: true }).click();
  return withBrowserEvent(
    () => page.waitForResponse(response => response.request().method() === "PATCH"
      && new URL(response.url()).pathname === triggerRoute),
    () => schedule.getByRole("button", { name: "Enable trigger", exact: true }).click());
}
export async function withRoutineTriggerCleanup<T>(input: {
  api: Pick<JourneyContext["api"], "patch">; triggerRoute: string; directory: string; run(): Promise<T>;
}): Promise<T> {
  let primary: { error: unknown } | undefined;
  try { return await input.run(); }
  catch (error) { primary = { error }; throw error; }
  finally {
    try { await input.api.patch(input.triggerRoute, { enabled: false }); }
    catch (error) {
      const failure = new JourneyError("failed", "routine_trigger_disable_failed");
      try {
        await mkdir(input.directory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(input.directory, "scheduled-routine-cleanup-failure.json"), JSON.stringify({
          schema: "paperclip.product-journey.routine-cleanup-failure/v1", code: failure.code,
          triggerRoute: input.triggerRoute, primaryFailurePreserved: Boolean(primary),
          transportCode: error instanceof ConnectionFailure && /^(api_request_failed|api_status_[1-5][0-9]{2})$/.test(error.message)
            ? error.message : null,
        }, null, 2), { mode: 0o600 });
      } catch {
        if (primary) throw primary.error;
        throw failure;
      }
      // The outer lifecycle still grades cleanup and reconciles the owned trigger.
      if (!primary) throw failure;
    }
  }
}
export async function runScheduledRoutine(context: JourneyContext, session: TargetSession, campaignId: string,
  evidence: JourneyEvidence, options: { deadlineAt: number; directory: string }) {
  const { api, page, company, user, agent } = context;
  const observations = createObservedReader(api, options.deadlineAt);
  const readObserved = observations.get;
  try {
    if (!agent || agent.runtimeMode !== "native" || !context.environmentId) throw new JourneyError("unsupported", "native_agent_and_environment_required");
    const title = `Journey QA scheduled routine ${campaignId}`, projectName = `Journey QA routine project ${campaignId}`;
    const check = (id: string, passed: boolean) => {
      evidence.checks.push({ id, passed });
      if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_"));
    };
    const bodyReceipt = (body: unknown) => typeof body === "string" ? { byteSize: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"), trimmedSha256: createHash("sha256").update(body.trim()).digest("hex"),
      lineFeedCount: body.split("\n").length - 1, backslashCount: body.split("\\").length - 1 } : null;
    await session.own({ kind: "project", name: projectName, journeyId });
    const project = await api.post<Row>(`/api/companies/${company.id}/projects`, { name: projectName, status: "planned" });
    await session.own({ kind: "project", name: projectName, id: project.id, journeyId });
    const key = "scheduled-summary", marker = `scheduled-${campaignId}`;
    const expectedBody = `${marker}\nSchedule check complete.`;
    const prompt = `Prepare the scheduled status check. Save a task document with key ${key} and title Scheduled check. `
      + "Copy exactly the two lines inside this block, including the final period. Do not include the fences in the document body.\n\n"
      + `\`\`\`text\n${expectedBody}\n\`\`\`\n\n`
      + "Then finish the task. Do not create other tasks or agents.";
    await routineUiStep("open_composer", async () => {
      await page.goto(`${api.origin}/${company.issuePrefix}/routines`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Create routine", exact: true }).first().click();
    });
    const dialog = page.getByRole("dialog");
    await routineUiStep("select_responsible", async () => {
      await dialog.getByPlaceholder("Routine title", { exact: true }).fill(title);
      await dialog.getByRole("button", { name: "Responsible", exact: true }).click();
      await page.getByPlaceholder("Search responsible...", { exact: true }).fill(agent.name);
      await page.getByRole("button", { name: agent.name, exact: true }).click();
    });
    await routineUiStep("select_project", async () => {
      // Selecting Responsible focuses Project and opens its picker. Clicking
      // its trigger again closes the picker before the search field can fill.
      const projectSearch = page.getByPlaceholder("Search projects...", { exact: true });
      await expect(projectSearch).toBeVisible();
      await projectSearch.fill(projectName);
      await page.getByRole("button", { name: projectName, exact: true }).click();
    });
    await routineUiStep("fill_instructions", () => fillTaskPrompt(dialog.locator('[contenteditable="true"]'), prompt));
    await session.own({ kind: "routine", name: title, journeyId });
    const response = await routineUiStep("submit", () => withBrowserEvent(
      () => page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/companies/${company.id}/routines`),
      () => dialog.getByRole("button", { name: "Create routine", exact: true }).click()));
    if (response.status() !== 201) throw new JourneyError("failed", "routine_ui_creation_failed");
    const routine = await response.json();
    if (typeof routine.id !== "string") throw new JourneyError("failed", "routine_creation_receipt_missing");
    await session.own({ kind: "routine", name: title, id: routine.id, journeyId });
    const route = `/api/routines/${routine.id}`;
    // Fixture policy makes duplicate scheduler work observable instead of coalescing it.
    await api.patch(route, { concurrencyPolicy: "always_enqueue" });
    const saved = await readObserved<Row>(route);
    const creationMatches = { company: saved.companyId === company.id, title: saved.title === title,
      project: saved.projectId === project.id, assignee: saved.assigneeAgentId === agent.id,
      userCreator: saved.createdByUserId === user.id, agentCreatorNull: saved.createdByAgentId === null,
      description: saved.description === prompt, concurrency: saved.concurrencyPolicy === "always_enqueue", zeroTriggers: saved.triggers.length === 0 };
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(options.directory, "scheduled-routine-creation.json"), JSON.stringify({
      schema: "paperclip.product-journey.routine-creation/v1", matches: creationMatches,
      expectedDescription: bodyReceipt(prompt), savedDescription: bodyReceipt(saved.description),
      expected: { companyId: company.id, titleSha256: bodyReceipt(title)!.sha256, projectId: project.id, agentId: agent.id, userId: user.id },
      saved: { id: saved.id, companyId: saved.companyId, titleSha256: bodyReceipt(saved.title)?.sha256,
        projectId: saved.projectId, assigneeAgentId: saved.assigneeAgentId, createdByUserId: saved.createdByUserId,
        createdByAgentId: saved.createdByAgentId, concurrencyPolicy: saved.concurrencyPolicy, triggerCount: saved.triggers.length,
        createdAt: saved.createdAt, updatedAt: saved.updatedAt },
    }, null, 2), { mode: 0o600 });
    check("routine-browser-created", Object.values(creationMatches).every(Boolean));
    const createdTrigger = await api.post<Row>(`${route}/triggers`, { kind: "schedule", label: `QA schedule ${campaignId}`,
      cronExpression: "* * * * *", timezone: "America/Chicago", enabled: false });
    const trigger = createdTrigger.trigger;
    if (!trigger?.id || trigger.companyId !== company.id || trigger.routineId !== routine.id || trigger.kind !== "schedule"
      || trigger.cronExpression !== "* * * * *" || trigger.timezone !== "America/Chicago" || trigger.enabled !== false) {
      throw new JourneyError("failed", "routine_schedule_fixture_mismatch");
    }
    const triggerRoute = `/api/routine-triggers/${trigger.id}`;
    const readTrigger = async () => {
      const detail = await readObserved<Row>(route);
      const matching = detail.triggers?.filter((row: Row) => row.id === trigger.id);
      if (!Array.isArray(matching) || matching.length !== 1 || matching[0].companyId !== company.id || matching[0].routineId !== routine.id) {
        throw new JourneyError("failed", "routine_trigger_readback_mismatch");
      }
      return matching[0] as Row;
    };
    const runs = () => readObserved<ScheduledInvocation[]>(`${route}/runs`);
    let pausedAt = 0;
    await withRoutineTriggerCleanup({ api, triggerRoute, directory: options.directory, run: async () => {
      const enabledResponse = await routineUiStep("enable_trigger", async () => {
        await page.goto(`${api.origin}/${company.issuePrefix}/routines/${routine.id}/triggers`, { waitUntil: "domcontentloaded" });
        return enableRoutineScheduleTrigger(page, triggerRoute);
      });
      if (enabledResponse.status() !== 200) throw new JourneyError("failed", "routine_schedule_enable_failed");
      const enabledTrigger = await enabledResponse.json();
      const enabledAt = Date.parse(enabledTrigger?.updatedAt);
      if (enabledTrigger?.id !== trigger.id || enabledTrigger.companyId !== company.id || enabledTrigger.routineId !== routine.id
        || enabledTrigger.enabled !== true || !Number.isFinite(enabledAt)) throw new JourneyError("failed", "routine_schedule_enable_receipt_missing");
      await expect.poll(async () => (await readTrigger()).enabled).toBe(true);
      const first = await waitFor(options.deadlineAt, runs, rows => rows.length > 0 && Boolean(rows[0]?.linkedIssueId), "scheduled_invocation_missing");
      await routineUiStep("pause_trigger", () => page.getByRole("button", { name: "Pause trigger", exact: true }).click());
      await expect.poll(async () => (await readTrigger()).enabled).toBe(false);
      pausedAt = performance.now();
      const task = await readObserved<ScheduledTask & { title: string }>(`/api/issues/${first[0]!.linkedIssueId}`);
      await session.own({ kind: "issue", name: task.title, id: task.id, journeyId });
      const expected = { companyId: company.id, routineId: routine.id, triggerId: trigger.id, projectId: project.id, agentId: agent.id, enabledAt };
      check("routine-scheduler-created-execution", scheduledInvocationMatches(first, task, expected));
      const taskRoute = `/api/issues/${task.id}`;
      const state = await waitFor(options.deadlineAt, async () => {
        const [currentIssue, summaries, comments, interactions] = await Promise.all([
          readObserved<Row & { id: string; status: string }>(taskRoute), readObserved<Row[]>(`${taskRoute}/runs`), readObserved<Row[]>(`${taskRoute}/comments?order=asc`),
          readObserved<Array<Row & { id: string; status: string }>>(`${taskRoute}/interactions`),
        ]);
        const taskRuns = await Promise.all(summaries.map(row => readObserved<Row & { status: string }>(`/api/heartbeat-runs/${row.runId}`)));
        const value = { currentIssue, taskRuns, comments, interactions, attachments: [] };
        validateAgentTaskState(context, task.id, value, 1);
        return value;
      }, value => value.currentIssue.status === "done" && value.taskRuns.length === 1 && value.taskRuns[0]!.status === "succeeded"
        && value.interactions.every(row => row.status !== "pending"), "routine_task_not_completed");
      const completedAt = performance.now();
      const document = await readObserved<Row>(`${taskRoute}/documents/${key}`);
      const revision = await readObserved<Row>(`${taskRoute}/documents/${key}/revisions/${document.latestRevisionId}`);
      const matches = { documentCompany: document.companyId === company.id, documentIssue: document.issueId === task.id,
        documentExactBody: document.body?.trim() === expectedBody, documentAuthor: document.createdByAgentId === agent.id,
        documentUserNull: document.createdByUserId === null, revisionDocument: revision.documentId === document.id,
        revisionExactBody: revision.body?.trim() === expectedBody, revisionAuthor: revision.createdByAgentId === agent.id,
        revisionRun: revision.createdByRunId === state.taskRuns[0]!.id };
      // A failed grade must retain its attribution inputs without the prompt or output body.
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(options.directory, "scheduled-routine-result.json"), JSON.stringify({
        schema: "paperclip.product-journey.routine-result/v1", matches, expectedBody: bodyReceipt(expectedBody),
        documentBody: bodyReceipt(document.body), revisionBody: bodyReceipt(revision.body),
        document: { id: document.id, companyId: document.companyId, issueId: document.issueId,
          latestRevisionId: document.latestRevisionId, createdByAgentId: document.createdByAgentId,
          createdByUserId: document.createdByUserId, createdAt: document.createdAt, updatedAt: document.updatedAt },
        revision: { id: revision.id, documentId: revision.documentId, createdByAgentId: revision.createdByAgentId,
          createdByRunId: revision.createdByRunId, createdAt: revision.createdAt },
        run: { id: state.taskRuns[0]!.id, status: state.taskRuns[0]!.status, nativePhase: state.taskRuns[0]!.nativePhase,
          agentId: state.taskRuns[0]!.agentId, companyId: state.taskRuns[0]!.companyId,
          environmentId: state.taskRuns[0]!.contextSnapshot?.paperclipEnvironment?.id,
          provider: state.taskRuns[0]!.runnerProfileJson?.nativeExecutionInput?.provider?.kind,
          model: state.taskRuns[0]!.runnerProfileJson?.nativeExecutionInput?.provider?.model },
      }, null, 2), { mode: 0o600 });
      check("routine-result-attributed", Object.values(matches).every(Boolean));
      if (typeof state.currentIssue.identifier !== "string" || !state.currentIssue.identifier) throw new JourneyError("failed", "routine_task_identifier_missing");
      await routineUiStep("open_history", async () => {
        await page.goto(`${api.origin}/${company.issuePrefix}/routines/${routine.id}/runs`, { waitUntil: "domcontentloaded" });
        await page.reload();
        await expect(page.getByRole("link", { name: state.currentIssue.identifier, exact: false }).first()).toBeVisible();
      });
      const final = await waitFor(options.deadlineAt, async () => ({ rows: await runs(), now: performance.now() }), value => {
        if (value.rows.length !== 1) throw new JourneyError("failed", "routine_duplicate_invocation");
        return value.rows[0]?.status === "completed" && value.now >= Math.max(pausedAt, completedAt) + schedulePauseObservationMs;
      }, "routine_pause_not_observed");
      check("routine-history-preserved", scheduledInvocationMatches(final.rows, await readObserved(taskRoute), expected));
      check("routine-pause-prevented-next-run", schedulePauseMatches({ enabled: (await readTrigger()).enabled,
        pausedAt, completedAt, observedUntil: final.now, first, final: final.rows }));
      await routineUiStep("reopen_result", async () => {
        await page.goto(`${api.origin}/${company.issuePrefix}/issues/${state.currentIssue.identifier}`, { waitUntil: "domcontentloaded" });
        await page.reload();
        await openDocumentAuthoring(context);
        await expect(page.locator(`#document-${key}`)).toContainText(marker);
      });
      check("routine-result-reopened", (await readObserved<Row>(`${taskRoute}/documents/${key}`)).latestRevisionId === document.latestRevisionId);
      check("configured-model-and-environment", true);
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(options.directory, "scheduled-routine-checks.json"), JSON.stringify({ routineId: routine.id,
        triggerId: trigger.id, invocationId: first[0]!.id, taskId: task.id, runId: state.taskRuns[0]!.id, enabledServerAt: enabledAt, pausedMonotonicAt: pausedAt, completedMonotonicAt: completedAt,
        observedUntilMonotonicAt: final.now, documentId: document.id, revisionId: revision.id }, null, 2), { mode: 0o600 });
    } });
  } finally { await observations.preserve(options.directory); }
}
