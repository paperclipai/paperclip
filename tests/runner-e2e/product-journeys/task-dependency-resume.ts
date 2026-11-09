import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { HEARTBEAT_RUN_LIST_MAX_LIMIT } from "../../../packages/shared/src/constants.js";
import { createTaskThroughUi } from "../user-actions.js";
import { createObservedReader } from "./observation-read.js";
import { openDocumentAuthoring } from "./task-document-flow.js";
import { DEPENDENCY_IDLE_MS, dependencyNewAgentRuns, gradeTaskDependencyResume, type DependencyEvidence, type DependencyPoint, type DependencyScope } from "./task-dependency-resume-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
const id = "task-dependency-resume" as const;
const taskSnapshot = (task: Row) => ({ id: task.id, companyId: task.companyId, identifier: task.identifier,
  title: task.title, description: task.description, status: task.status, assigneeAgentId: task.assigneeAgentId,
  assigneeUserId: task.assigneeUserId, createdByUserId: task.createdByUserId, createdByAgentId: task.createdByAgentId,
  completedAt: task.completedAt, executionRunId: task.executionRunId, checkoutRunId: task.checkoutRunId,
  blockedByIssueIds: task.blockedByIssueIds ?? task.blockedBy?.map((row: Row) => row.id) ?? [] });
const runSnapshot = (run: Row) => ({ id: run.id, companyId: run.companyId, agentId: run.agentId,
  issueId: run.issueId, nativeIssueId: run.nativeIssueId, status: run.status, runtimeMode: run.runtimeMode,
  nativePhase: run.nativePhase, invocationSource: run.invocationSource, triggerDetail: run.triggerDetail, startedAt: run.startedAt,
  contextSnapshot: { issueId: run.contextSnapshot?.issueId, taskId: run.contextSnapshot?.taskId,
    source: run.contextSnapshot?.source, wakeReason: run.contextSnapshot?.wakeReason,
    resolvedBlockerIssueId: run.contextSnapshot?.resolvedBlockerIssueId, blockerIssueIds: run.contextSnapshot?.blockerIssueIds,
    paperclipEnvironment: { id: run.contextSnapshot?.paperclipEnvironment?.id } },
  runnerProfileJson: { nativeExecutionInput: { provider: { kind: run.runnerProfileJson?.nativeExecutionInput?.provider?.kind,
    model: run.runnerProfileJson?.nativeExecutionInput?.provider?.model } } } });
const documentSnapshot = (row: Row) => Object.fromEntries(["id", "companyId", "issueId", "key", "body", "latestRevisionId",
  "documentId", "createdByAgentId", "createdByUserId", "createdByRunId"].map(key => [key, row[key]]));

async function properties(context: JourneyContext, label: string) {
  const { page } = context;
  const row = page.locator('[data-property-row]:not([inert] *):not([aria-hidden="true"] *)')
    .filter({ has: page.locator(`[data-property-label="${label}"]`) }).filter({ visible: true });
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
  await page.locator('[data-slot="popover-content"]').filter({ visible: true })
    .getByRole("button").filter({ has: page.getByRole("img", { name: label, exact: true }) }).click();
}

export async function taskDependencyResume(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence,
  options: { deadlineAt: number; directory: string }) {
  const { api, page, company, user, agent } = context;
  const read = createObservedReader(api, options.deadlineAt);
  const reference = randomBytes(16).toString("hex");
  let scope: DependencyScope | undefined, stage = "prerequisites", journeyFailed = false;
  let latest: DependencyPoint | undefined;
  const observations: Partial<DependencyEvidence> = { waiting: [] };
  const preserve = async () => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(options.directory, "task-dependency-observations.json"),
      JSON.stringify({ schema: "paperclip.task-dependency-observations/v1", stage, ...observations, latest, scope }, null, 2), { mode: 0o600 });
  };
  const url = (identifier: string) => `${api.origin}/${company.issuePrefix}/issues/${identifier}`;
  try {
    for (const capability of ["company", "board-user", "task-write", "agent"]) {
      if (!context.capabilities.includes(capability)) throw new JourneyError("unsupported", `missing_${capability}`);
    }
    if (!agent || agent.runtimeMode !== "native" || !context.environmentId) throw new JourneyError("unsupported", "native_agent_and_environment_required");
    if ([agent.provider, agent.model].some(value => typeof value !== "string" || !value.trim())) {
      throw new JourneyError("unsupported", "dependency_execution_identity_unavailable");
    }
    const summaries = async (route: string, limit?: number) => {
      const rows = await read.get<Row[]>(route);
      if (!Array.isArray(rows) || limit !== undefined && rows.length >= limit) throw new JourneyError("failed", "dependency_run_coverage_unavailable");
      const ids = rows.map(row => row.runId ?? row.id);
      if (ids.some(value => typeof value !== "string" || !value) || new Set(ids).size !== ids.length) throw new JourneyError("failed", "dependency_run_identity_invalid");
      return rows.map((row, index) => ({ ...row, id: ids[index] }));
    };
    const runDetail = async (runId: string) => {
      const run = await read.get<Row>(`/api/heartbeat-runs/${runId}`);
      if (run.id !== runId) throw new JourneyError("failed", "dependency_run_identity_invalid");
      return runSnapshot(run);
    };
    const snapshots = async (route: string) => Promise.all((await summaries(route)).map(row => runDetail(row.id)));
    const agentRoute = `/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=${HEARTBEAT_RUN_LIST_MAX_LIMIT}`;
    stage = "observe_starting_runs";
    const startingRuns = observations.startingAgentRuns = (await summaries(agentRoute, HEARTBEAT_RUN_LIST_MAX_LIMIT)).map(runSnapshot);
    if (startingRuns.some(run => run.companyId !== company.id || run.agentId !== agent.id
      || !["succeeded", "failed", "cancelled", "timed_out"].includes(run.status))) {
      throw new JourneyError("failed", "dependency_starting_agent_not_idle");
    }
    const startingIds = new Set(startingRuns.map(run => run.id));
    const agentSnapshots = async () => Promise.all((await summaries(agentRoute, HEARTBEAT_RUN_LIST_MAX_LIMIT))
      .map(row => startingIds.has(row.id) ? runSnapshot(row) : runDetail(row.id)));
    stage = "create_blocker";
    const blockerTitle = `Journey QA dependency blocker ${campaignId}`;
    const blockerDescription = `Human review gate. The review reference is ${reference}. Keep this task for my review; no agent work is required.`;
    const blocker = await createTaskThroughUi({ page, origin: api.origin, issuePrefix: company.issuePrefix,
      agentName: "Me", title: blockerTitle, prompt: blockerDescription, workMode: "standard", requireExplicitTitle: true,
      beforeDispatch: () => session.own({ kind: "issue", name: blockerTitle, journeyId: id }) });
    await session.own({ kind: "issue", name: blockerTitle, id: blocker.issueId, journeyId: id });
    const savedBlocker = await read.get<Row>(`/api/issues/${blocker.issueId}`);
    if (typeof savedBlocker.identifier !== "string" || !savedBlocker.identifier) throw new JourneyError("failed", "dependency_blocker_receipt_invalid");
    const dependentTitle = `Journey QA dependency dependent ${campaignId}`, documentKey = "dependency-proof";
    const prompt = `After the blocker ${savedBlocker.identifier} is completed, read its description and save a task document with key ${documentKey}. `
      + `Its body must be JSON with exactly reference (the review reference in the blocker description) and blockerIdentifier ("${savedBlocker.identifier}"). `
      + "Then finish this task. No other tasks, agents or projects are needed.";
    stage = "create_dependent";
    const dependent = await createTaskThroughUi({ page, origin: api.origin, issuePrefix: company.issuePrefix,
      agentName: "Me", title: dependentTitle, prompt, workMode: "standard", requireExplicitTitle: true,
      beforeDispatch: () => session.own({ kind: "issue", name: dependentTitle, journeyId: id }) });
    await session.own({ kind: "issue", name: dependentTitle, id: dependent.issueId, journeyId: id });
    scope = { companyId: company.id, userId: user.id, agentId: agent.id, environmentId: context.environmentId,
      provider: agent.provider, model: agent.model, blockerId: blocker.issueId, blockerIdentifier: savedBlocker.identifier,
      blockerTitle, blockerDescription, dependentId: dependent.issueId, dependentTitle, prompt, reference, documentKey };
    const observe = async (): Promise<DependencyPoint> => {
      const [currentBlocker, currentDependent, blockerRuns, dependentRuns, agentRuns, blockerActivity, dependentActivity, agentActivity] = await Promise.all([
        read.get<Row>(`/api/issues/${blocker.issueId}`), read.get<Row>(`/api/issues/${dependent.issueId}`),
        snapshots(`/api/issues/${blocker.issueId}/runs`), snapshots(`/api/issues/${dependent.issueId}/runs`),
        agentSnapshots(), read.get<Row[]>(`/api/issues/${blocker.issueId}/activity`), read.get<Row[]>(`/api/issues/${dependent.issueId}/activity`),
        read.get<Row[]>(`/api/companies/${company.id}/activity?agentId=${agent.id}&limit=500`),
      ]);
      if ([blockerActivity, dependentActivity, agentActivity].some(rows => !Array.isArray(rows)) || agentActivity.length >= 500) {
        throw new JourneyError("failed", "dependency_activity_coverage_unavailable");
      }
      const newAgentRuns = dependencyNewAgentRuns(agentRuns, startingRuns);
      const activity = [...new Map([...blockerActivity, ...dependentActivity, ...agentActivity].map(row => [row.id, row])).values()];
      if (activity.some(row => typeof row.id !== "string" || !row.id || row.companyId !== company.id)
        || agentActivity.some(row => row.agentId !== agent.id)) throw new JourneyError("failed", "dependency_activity_identity_invalid");
      const point: DependencyPoint = { observedAt: Date.now(), blocker: taskSnapshot(currentBlocker), dependent: taskSnapshot(currentDependent),
        blockerRuns, dependentRuns, agentRuns, activityCoverage: { blocker: true, dependent: true, agent: true },
        activity: activity.filter(row => [blocker.issueId, dependent.issueId].includes(row.entityId)
          || newAgentRuns.some(run => run.id === row.runId)).map(row => ({ id: row.id, companyId: row.companyId, actorType: row.actorType,
          actorId: row.actorId, runId: row.runId, action: row.action, entityType: row.entityType, entityId: row.entityId,
          createdAt: row.createdAt, details: { status: row.details?.status } })) };
      latest = point;
      if (dependentRuns.length > 1 || newAgentRuns.length > 1 || blockerRuns.length
        || [...dependentRuns, ...newAgentRuns].some(run => ["failed", "cancelled", "timed_out"].includes(run.status))) {
        throw new JourneyError("failed", "dependency_unexpected_or_failed_work");
      }
      if (currentDependent.status === "done") {
        const documents = await read.get<Row[]>(`/api/issues/${dependent.issueId}/documents`);
        const candidate = documents.find(row => row.key === documentKey);
        if (candidate) {
          const document = await read.get<Row>(`/api/issues/${dependent.issueId}/documents/${documentKey}`);
          point.document = documentSnapshot(document);
          point.revision = documentSnapshot(await read.get<Row>(`/api/issues/${dependent.issueId}/documents/${documentKey}/revisions/${document.latestRevisionId}`));
        }
      }
      return point;
    };
    observations.created = await observe();
    if ([observations.created.blocker, observations.created.dependent].some(task => task.companyId !== company.id
      || task.assigneeUserId !== user.id || task.assigneeAgentId !== null || task.createdByUserId !== user.id
      || task.createdByAgentId || task.status !== "todo") || observations.created.blocker.id !== blocker.issueId
      || observations.created.dependent.id !== dependent.issueId || observations.created.blockerRuns.length
      || observations.created.dependentRuns.length || dependencyNewAgentRuns(observations.created.agentRuns, startingRuns).length) {
      throw new JourneyError("failed", "dependency_created_task_binding_mismatch");
    }
    stage = "link_blocker";
    const dependentSaved = observations.created.dependent;
    await page.goto(url(dependentSaved.identifier ?? dependent.issueId), { waitUntil: "domcontentloaded" });
    const blockedBy = await properties(context, "Blocked by");
    await blockedBy.locator("[data-property-value]").getByRole("button").first().click();
    await page.getByRole("textbox", { name: "Search tasks to add as blockers", exact: true }).fill(blockerTitle);
    await page.getByRole("button").filter({ hasText: blockerTitle }).last().click();
    await expect.poll(async () => (taskSnapshot(await read.get<Row>(`/api/issues/${dependent.issueId}`)).blockedByIssueIds)).toEqual([blocker.issueId]);
    stage = "set_dependent_blocked";
    await setStatus(context, "Blocked");
    await expect.poll(async () => (await read.get<Row>(`/api/issues/${dependent.issueId}`)).status).toBe("blocked");
    stage = "assign_blocked_task";
    const assignee = await properties(context, "Assignee");
    await assignee.locator("[data-property-value]").getByRole("button").first().click();
    await page.getByPlaceholder("Search assignees...", { exact: true }).fill(agent.name);
    await page.getByRole("button").filter({ hasText: agent.name }).last().click();
    await expect.poll(async () => (await read.get<Row>(`/api/issues/${dependent.issueId}`)).assigneeAgentId).toBe(agent.id);
    await page.reload();
    stage = "observe_blocked_wait";
    const waiting = observations.waiting!;
    waiting.push(await observe());
    if (waiting[0]!.dependentRuns.length || dependencyNewAgentRuns(waiting[0]!.agentRuns, startingRuns).length || waiting[0]!.dependent.status !== "blocked"
      || waiting[0]!.blocker.status !== "todo") throw new JourneyError("failed", "dependency_ran_before_blocker_completed");
    const until = waiting[0]!.observedAt + DEPENDENCY_IDLE_MS;
    while (Date.now() < until) {
      if (Date.now() + 1000 >= options.deadlineAt) throw new JourneyError("failed", "dependency_wait_deadline");
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, until - Date.now())));
      const point = await observe(); waiting.push(point);
      if (point.dependentRuns.length || dependencyNewAgentRuns(point.agentRuns, startingRuns).length || point.dependent.status !== "blocked" || point.blocker.status !== "todo") {
        throw new JourneyError("failed", "dependency_ran_before_blocker_completed");
      }
    }
    if (waiting[waiting.length - 1]!.observedAt < until) waiting.push(await observe());
    stage = "complete_blocker";
    await page.goto(url(savedBlocker.identifier), { waitUntil: "domcontentloaded" });
    observations.releaseRequestedAt = Date.now();
    await setStatus(context, "Done");
    await expect.poll(async () => (await read.get<Row>(`/api/issues/${blocker.issueId}`)).status).toBe("done");
    observations.released = await observe();
    stage = "await_automatic_resume";
    while (Date.now() < options.deadlineAt) {
      const point = await observe(); observations.finished = point;
      if (point.dependent.status === "done" && point.dependentRuns.length === 1 && point.dependentRuns[0]?.status === "succeeded"
        && point.dependentRuns[0]?.nativePhase === "committed" && point.document && point.revision
        && !point.dependent.executionRunId && !point.dependent.checkoutRunId) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!observations.finished || observations.finished.dependent.status !== "done" || observations.finished.dependentRuns[0]?.status !== "succeeded"
      || observations.finished.dependentRuns[0]?.nativePhase !== "committed" || !observations.finished.document || !observations.finished.revision) {
      throw new JourneyError("failed", "dependency_resume_deadline");
    }
    stage = "reopen_result";
    await page.goto(url(dependentSaved.identifier ?? dependent.issueId), { waitUntil: "domcontentloaded" });
    await page.reload(); await openDocumentAuthoring(context);
    const document = page.locator(`#document-${documentKey}`);
    await expect(document).toContainText(reference);
    observations.reopened = await observe();
    observations.reopened.resultVisible = await document.isVisible() && (await document.textContent())?.includes(reference) === true;
    const checks = gradeTaskDependencyResume({ ...observations, scope } as DependencyEvidence);
    evidence.checks.push(...checks);
    const failed = checks.find(check => !check.passed);
    if (failed) throw new JourneyError("failed", failed.id.replaceAll("-", "_"));
    stage = "complete";
  } catch (error) {
    journeyFailed = true;
    throw error;
  } finally {
    const writers = [
      { label: "task-dependency-observations.json", write: preserve },
      { label: "observation-read-failures.json", write: () => read.preserve(options.directory) },
    ];
    const results = await Promise.allSettled(writers.map(writer => Promise.resolve().then(writer.write)));
    const failedWriters = results.flatMap((result, index) => result.status === "rejected" ? [writers[index]!.label] : []);
    if (failedWriters.length) {
      console.error("dependency_evidence_preservation_failed", failedWriters);
      if (!journeyFailed) throw new JourneyError("failed", "dependency_evidence_preservation_failed");
    }
  }
}
