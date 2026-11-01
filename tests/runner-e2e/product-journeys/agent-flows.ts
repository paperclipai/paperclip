import { hireDelegateReuse } from "./hire-delegate-flow.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { nativeCancellationHasNoLaterWork, nativeStopAcknowledged, nativeWorkEvents, stopAndRedirectThroughUi } from "../stop-redirect-flow.js";
import { activeStopWorkBoundary, stoppedRunAccountingFinalized, STOP_REVISION_WAIT, type StopWorkBoundary } from "./stop-redirect-evidence.js";
import { runnerTasks } from "../catalog.js";
import { everydayTasks, SLUGIFY_REQUIREMENTS, SLUGIFY_REVISION } from "../everyday-cases.js";
import { latestStoryDelivery, type StoryDelivery } from "../everyday-delivery.js";
import { gradeConnectionGuidanceDecline } from "../connection-guidance-evidence.js";
import { runPlanRevisionAcceptance } from "../plan-revision-flow.js";
import { decideProtectedActionThroughUi, readServiceBriefing, serviceBriefingChecks } from "../protected-action-flow.js";
import { editCreatedSkillThroughStudio } from "../skill-studio-flow.js";
import { downloadStoryArtifact, runArtifactOracle } from "../story-artifact.js";
import { collectRunEvents } from "../run-observations.js";
import { readBoundTaskFinalReply } from "../native-task-reply.js";
import { createTaskThroughUi, submitTaskReply } from "../user-actions.js";
import { agentJourneyRuns } from "./catalog.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
type AgentJourney = Exclude<keyof typeof agentJourneyRuns, "ask-question" | "question-answer-resume" | "followup-while-running">;
interface TaskState { currentIssue: Row & { id: string; status: string }; taskRuns: Array<Row & { status: string }>; comments: Row[]; interactions: Array<Row & { id: string; status: string }>; attachments: StoryDelivery[] }
interface Options { deadlineAt: number; directory: string; capture(id: string, label: string, file: string): Promise<void> }
const active = (run: Row) => ["queued", "running"].includes(run.status);

/** These fixture replies are plain text. The rich editor escapes underscores in
 * its persisted Markdown; compare the intended text while retaining exact count
 * and author checks. Do not strip arbitrary markup or accept partial messages. */
export function fixtureReplyStoredOnce(before: Row[], after: Row[], userId: string, message: string) {
  const added = after.filter(row => row.authorUserId === userId && !before.some(old => old.id === row.id));
  return added.length === 1 && typeof added[0].body === "string" && added[0].body.replaceAll("\\_", "_") === message;
}

/** Owned-task observations only: other work in a persistent QA company cannot affect this grade. */
export function validateAgentTaskState(context: JourneyContext, issueId: string, state: TaskState, maxRuns: number, allowedCancelled: string[] = []) {
  const agent = context.agent!;
  if (state.currentIssue.id !== issueId || state.currentIssue.companyId !== context.company.id
    || state.currentIssue.assigneeAgentId !== agent.id || state.taskRuns.length > maxRuns) throw new JourneyError("failed", "agent_task_binding_mismatch");
  for (const run of state.taskRuns) {
    const provider = run.runnerProfileJson?.nativeExecutionInput?.provider;
    const boundIssueId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
    if (run.companyId !== context.company.id || run.agentId !== agent.id || boundIssueId !== issueId) throw new JourneyError("failed", "agent_run_binding_mismatch");
    if (!active(run) && (run.runtimeMode !== "native" || run.contextSnapshot?.paperclipEnvironment?.id !== context.environmentId
      || provider?.kind !== agent.provider || provider?.model !== agent.model)) throw new JourneyError("failed", "agent_run_binding_mismatch");
    if (!["queued", "running", "succeeded"].includes(run.status) && !(run.status === "cancelled" && allowedCancelled.includes(run.id))) throw new JourneyError("failed", "agent_run_failed");
  }
}

export async function waitFor<T>(deadlineAt: number, load: () => Promise<T>, accept: (value: T) => boolean, code: string): Promise<T> {
  while (Date.now() < deadlineAt) {
    const value = await load();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new JourneyError("failed", code);
}

export async function runAgentJourney(id: AgentJourney, context: JourneyContext, session: TargetSession,
  campaignId: string, evidence: JourneyEvidence, options: Options) {
  if (id === "hire-delegate-reuse") return hireDelegateReuse(context, session, campaignId, evidence, options);
  const agent = context.agent;
  if (!agent || agent.runtimeMode !== "native" || !context.environmentId) throw new JourneyError("unsupported", "native_agent_and_environment_required");
  const nonce = campaignId.replaceAll("-", "_");
  const maxRuns = agentJourneyRuns[id];
  const cancelled: string[] = [];
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const check = (id: string, passed = true) => {
    evidence.checks.push({ id, passed });
    if (!passed) throw new JourneyError("failed", id.replaceAll("-", "_"));
  };
  const retain = async (name: string, value: unknown) => writeFile(path.join(options.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  const open = async (issue: Row) => context.page.goto(`${context.api.origin}/${context.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`, { waitUntil: "domcontentloaded" });
  const create = async (suffix: string, prompt: string, workMode: "standard" | "planning" = "standard") => {
    const title = `Journey QA ${id}${suffix} ${campaignId}`;
    const created = await createTaskThroughUi({ page: context.page, origin: context.api.origin, issuePrefix: context.company.issuePrefix,
      agentName: agent.name, title, prompt, workMode, requireExplicitTitle: true,
      beforeDispatch: () => session.own({ kind: "issue", name: title, journeyId: id }) });
    await session.own({ kind: "issue", name: title, id: created.issueId, journeyId: id });
    return context.api.get<Row>(`/api/issues/${created.issueId}`);
  };
  const read = async (issue: Row): Promise<TaskState> => {
    const route = `/api/issues/${issue.id}`;
    const [currentIssue, summaries, comments, interactions, attachments] = await Promise.all([
      context.api.get<TaskState["currentIssue"]>(route), context.api.get<Row[]>(`${route}/runs`), context.api.get<Row[]>(`${route}/comments?order=asc`),
      context.api.get<TaskState["interactions"]>(`${route}/interactions`), context.api.get<TaskState["attachments"]>(`${route}/attachments`),
    ]);
    if (!Array.isArray(summaries) || summaries.length > maxRuns) throw new JourneyError("failed", "agent_run_limit_exceeded");
    const taskRuns = await Promise.all(summaries.map(summary => context.api.get<TaskState["taskRuns"][number]>(`/api/heartbeat-runs/${summary.runId}`)));
    const state = { currentIssue, taskRuns, comments, interactions, attachments };
    await retain(`${issue.id}-latest.json`, state);
    validateAgentTaskState(context, issue.id, state, maxRuns, cancelled);
    return state;
  };
  const settled = (issue: Row, count: number) => waitFor(options.deadlineAt, () => read(issue), state =>
    state.currentIssue.status === "done" && state.taskRuns.length === count && state.taskRuns.every(run => !active(run))
    && state.interactions.every(row => row.status !== "pending"), "agent_task_not_completed");
  const finalReply = async (issue: Row, state: TaskState, marker?: string) => {
    const runs = state.taskRuns.filter(run => run.status === "succeeded");
    if (!runs.length || runs.some(run => !Number.isFinite(Date.parse(run.finishedAt)))) throw new JourneyError("failed", "final_run_time_missing");
    const run = [...runs].sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt)).at(-1)!;
    const companies = await context.api.get<Row[]>("/api/companies?scope=accessible");
    if (!Array.isArray(companies) || !companies.some(row => row.id === context.company.id)
      || companies.some(row => typeof row.issuePrefix !== "string" || !row.issuePrefix)) throw new JourneyError("failed", "reply_company_context_missing");
    await open(issue);
    const receipt = await readBoundTaskFinalReply({ page: context.page, runId: run.id, agentId: agent.id,
      load: async () => {
        const [latest, events] = await Promise.all([read(issue), collectRunEvents<Row>((afterSeq, limit) =>
          context.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`))]);
        return { run: latest.taskRuns.find(row => row.id === run.id)!, comments: latest.comments, events };
      },
      expectedText: marker, deadlineAt: options.deadlineAt, knownCompanyPrefixes: companies.map(row => row.issuePrefix) });
    await retain(`${issue.id}-final-reply.json`, receipt);
    return receipt;
  };
  const reply = async (issue: Row, message: string) => {
    const before = (await read(issue)).comments;
    await open(issue);
    await submitTaskReply(context.page, message);
    const after = await waitFor(Math.min(options.deadlineAt, Date.now() + 30_000), () => read(issue), state =>
      state.comments.some(row => row.authorUserId === context.user.id && !before.some(old => old.id === row.id)), "reply_not_persisted");
    const added = after.comments.filter(row => row.authorUserId === context.user.id && !before.some(old => old.id === row.id));
    check("user-reply-stored-once", fixtureReplyStoredOnce(before, after.comments, context.user.id, message));
    return added[0];
  };
  const download = async (issue: Row, state: TaskState, phase: string, mode: "base" | "separator", preserved: string[] = []) => {
    const delivery = latestStoryDelivery(state.attachments, [issue.id], undefined, preserved);
    if (!delivery) throw new JourneyError("failed", "artifact_delivery_missing");
    await open(issue);
    const receipt = await downloadStoryArtifact({ page: context.page, attachmentId: delivery.id, directory: options.directory,
      phase, mode, deadlineAt: options.deadlineAt });
    await retain(`${phase}-download.json`, receipt);
    check(`${phase}-artifact-verified`, receipt.checks.length > 0 && receipt.checks.every(row => row.passed));
    return receipt;
  };

  if (id === "plan-revise-accept") {
    const fixture = runnerTasks.find(task => task.id === id)!;
    const issue = await create("", fixture.buildPrompt(nonce), "planning");
    const receipt = await runPlanRevisionAcceptance({ page: context.page, api: context.api, origin: context.api.origin,
      issue: { id: issue.id, identifier: issue.identifier }, issuePrefix: context.company.issuePrefix, native: true,
      planMarkers: fixture.buildPlanMarkers!(nonce), revisionRequest: fixture.buildRevisionRequest!(nonce), deadlineAt: options.deadlineAt,
      load: () => read(issue), retryOnError: error => !(error instanceof JourneyError), reject: () => undefined, capture: options.capture });
    await retain("plan-revision.json", receipt);
    const final = await settled(issue, 3);
    const marker = fixture.buildVisibleMarker(nonce);
    check("plan-revision-and-approval", receipt.draftInteraction.id !== receipt.revisedInteraction.id);
    await finalReply(issue, final, marker);
    check("plan-final-answer");
  } else if (id === "build-revise") {
    await runArtifactOracle(null, "base", options.deadlineAt);
    const issue = await create("", SLUGIFY_REQUIREMENTS);
    const initial = await download(issue, await settled(issue, 1), "initial", "base");
    await reply(issue, SLUGIFY_REVISION);
    const revised = await download(issue, await settled(issue, 2), "revised", "separator", [initial.sha256]);
    check("artifact-versions-differ", revised.attachmentId !== initial.attachmentId && revised.sha256 !== initial.sha256);
    check("original-artifact-preserved", createHash("sha256").update(await context.api.bytes(`/api/attachments/${initial.attachmentId}/content`)).digest("hex") === initial.sha256);
  } else if (id === "create-skill-studio") {
    const skillName = `qa-skill-${campaignId}`;
    const fixture = everydayTasks.find(task => task.id === id)!;
    const prompt = fixture.buildPrompt(nonce).replaceAll("release-readiness-checklist", skillName).replaceAll("create-skill-e2e-001", campaignId);
    await session.own({ kind: "skill", name: skillName });
    const issue = await create("", prompt);
    const completed = await settled(issue, 1);
    const skills = await context.api.get<Row[]>(`/api/companies/${context.company.id}/skills`);
    const owned = skills.filter(skill => skill.slug === skillName && skill.name === skillName);
    check("created-skill-persisted", owned.length === 1);
    const skill = owned[0];
    await session.own({ kind: "skill", name: skillName, id: skill.id });
    const activity = await context.api.get<Row[]>(`/api/issues/${issue.id}/activity`);
    check("skill-creation-attributed", activity.filter(row => row.action === "company.skill_created" && row.entityId === skill.id
      && row.runId === completed.taskRuns[0]!.id && row.agentId === agent.id && row.details?.sourceIssueId === issue.id).length === 1);
    await open(issue);
    await editCreatedSkillThroughStudio({ page: context.page, skillId: skill.id, skillName,
      marker: `Studio edit marker: ${campaignId}`, deadlineAt: options.deadlineAt,
      read: () => context.api.get(`/api/companies/${context.company.id}/skills/${skill.id}`) });
    check("skill-studio-edit-persisted");
  } else if (id === "protected-actions") {
    const service = context.fixtures?.reviewService;
    if (!service) throw new JourneyError("unsupported", "review_service_required");
    for (const decline of [false, true]) {
      const phase = decline ? "decline" : "approve";
      const callsBefore = service.invocationCount();
      const connectionBefore = await context.api.get<Row>(`/api/tool-connections/${service.connectionId}`);
      const fixture = everydayTasks.find(task => task.id === `service-${phase}`)!;
      const issue = await create(`-${phase}`, `${fixture.buildPrompt(nonce)}\nUse only the connected service named "${service.name}". Do not use any other service.`);
      const pending = await waitFor(options.deadlineAt, () => read(issue), state =>
        state.taskRuns.length === 1 && !state.taskRuns.some(active) && state.interactions.some(row => row.status === "pending"), "protected_action_not_requested");
      check(`${phase}-waited-for-decision`, pending.currentIssue.status !== "done" && service.invocationCount() === callsBefore);
      await open(issue); await context.page.reload();
      const decision = await decideProtectedActionThroughUi({ page: context.page, rows: pending.interactions as any,
        connectionId: service.connectionId, decline, invocationCount: service.invocationCount, expectedCallsBefore: callsBefore });
      const final = await settled(issue, 2);
      check(`${phase}-decision-persisted`, final.interactions.some(row => row.id === decision.id && row.status === (decline ? "rejected" : "accepted")));
      check(`${phase}-service-call-count`, service.invocationCount() === callsBefore + (decline ? 0 : 1));
      if (decline) {
        const nativeFinalReply = await finalReply(issue, final);
        const refreshed = await read(issue);
        const connectionAfter = await context.api.get<Row>(`/api/tool-connections/${service.connectionId}`);
        const unchanged = (row: Row) => JSON.stringify({ id: row.id, companyId: row.companyId, status: row.status, enabled: row.enabled,
          installs: row.installs?.filter((install: Row) => install.targetType === "agent" && install.targetId === agent.id) });
        const checks = gradeConnectionGuidanceDecline({ caseId: "service-decline", decisionId: decision.id,
          decisions: refreshed.interactions as any, leadAgentId: agent.id, issueId: issue.id, replies: refreshed.comments, nativeFinalReply,
          runs: refreshed.taskRuns as any, marker: service.marker, calls: service.invocationCount() - callsBefore, sameConnections: unchanged(connectionBefore) === unchanged(connectionAfter) });
        await retain("service-decline-grade.json", checks);
        check("decline-truthful-explanation", checks.every(row => row.passed));
      } else {
        await open(issue);
        const bodies = await readServiceBriefing({ page: context.page, api: context.api, issueId: issue.id });
        await retain("service-briefing.json", bodies);
        check("approved-service-data-used", serviceBriefingChecks(bodies, service.marker).every(row => row.passed));
      }
      await open(issue);
    }
  } else {
    await runArtifactOracle(null, "base", options.deadlineAt);
    const issue = await create("", SLUGIFY_REQUIREMENTS);
    const initial = await download(issue, await settled(issue, 1), "checkpoint", "base");
    await reply(issue, `${SLUGIFY_REVISION}\n${STOP_REVISION_WAIT}`);
    const state = await waitFor(options.deadlineAt, () => read(issue), value => value.taskRuns.some(run => run.status === "running"), "stop_boundary_not_active");
    const original = state.taskRuns.find(run => run.status === "running")!;
    await open(issue);
    const originalEvents = () => collectRunEvents<Row>((afterSeq, limit) =>
      context.api.get(`/api/heartbeat-runs/${original.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    cancelled.push(original.id);
    let beforeEvents: Row[];
    let boundary: StopWorkBoundary;
    const runActivity = async () => nativeWorkEvents(await originalEvents(), boundary);
    const redirected = await stopAndRedirectThroughUi({ page: context.page, nonce,
      beforeStop: async () => {
        const observed = await waitFor(options.deadlineAt, async () => {
          const events = await originalEvents();
          await retain("stop-startup-events.json", events);
          const current = await read(issue);
          const run = current.taskRuns.find(row => row.id === original.id);
          if (!run || !active(run)) throw new JourneyError("failed", "stop_boundary_already_settled");
          return { state: current, boundary: activeStopWorkBoundary(run, events) };
        }, value => Boolean(value.boundary), "stop_native_command_and_usage_not_observed");
        boundary = observed.boundary!;
        await retain("stop-boundary.json", boundary);
        await retain("stop-before.json", observed.state);
      },
      awaitRetirement: async () => {
        const stopped = await waitFor(options.deadlineAt, () => read(issue), value => {
          const run = value.taskRuns.find(row => row.id === original.id);
          return run?.status === "cancelled" && nativeStopAcknowledged(run, context.company.id, issue.id, context.user.id);
        }, "stop_not_acknowledged");
        await retain("stop-after.json", stopped);
        beforeEvents = await waitFor(options.deadlineAt, async () => {
          const events = await runActivity();
          await retain("stop-cancellation-events.json", events);
          return events;
        }, events => events.some(row => row.payload?.prpEvent?.eventType === "turn.cancelled"), "stop_native_terminal_not_retained");
        check("stop-native-terminal-retained", beforeEvents.some(row => row.payload?.prpEvent?.eventType === "turn.cancelled"));
        if (!nativeCancellationHasNoLaterWork(beforeEvents, boundary)) check("stopped-run-no-later-events", false);
      },
      beforeRedirect: async () => {
        const leases = await waitFor(options.deadlineAt, () => context.api.get<Row[]>(`/api/environments/${context.environmentId}/leases`), rows => {
          const owned = rows.filter(row => row.companyId === context.company.id && row.issueId === issue.id && row.heartbeatRunId === original.id);
          return owned.length > 0 && owned.every(row => ["released", "retained", "expired"].includes(row.status) && row.cleanupStatus === "success");
        }, "stopped_run_resources_not_released");
        await retain("stop-leases.json", leases.filter(row => row.issueId === issue.id && row.heartbeatRunId === original.id));
        const accounted = await waitFor(options.deadlineAt, async () =>
          (await read(issue)).taskRuns.find(row => row.id === original.id),
        run => Boolean(run && stoppedRunAccountingFinalized(run, boundary)), "stopped_run_accounting_not_finalized");
        await retain("stop-accounting.json", { runId: accounted!.id, costAccountingPending: accounted!.costAccountingPending,
          costAccountedAt: accounted!.costAccountedAt, receiptId: accounted!.usageJson.accountingReceiptId,
          sourceId: accounted!.usageJson.accountingReceiptSourceId, sequence: accounted!.usageJson.accountingReceiptSequence,
          ready: accounted!.usageJson.accountingReceiptReady });
        check("active-work-stopped");
      },
      reply: message => reply(issue, message),
    });
    const marker = redirected.marker;
    const userReply = redirected.reply as Row;
    const final = await settled(issue, 3);
    const completion = await finalReply(issue, final, marker);
    check("new-direction-completed", completion.runId !== original.id);
    check("stopped-run-remained-terminal", final.taskRuns.find(run => run.id === original.id)?.status === "cancelled");
    const afterEvents = await runActivity();
    check("stopped-run-no-later-events", nativeCancellationHasNoLaterWork(afterEvents, boundary!)
      && JSON.stringify(beforeEvents!) === JSON.stringify(afterEvents));
    check("stop-preserved-download", createHash("sha256").update(await context.api.bytes(`/api/attachments/${initial.attachmentId}/content`)).digest("hex") === initial.sha256);
    const queue = await context.api.get<Row>(`/api/issues/${issue.id}/queued-comments`);
    check("redirect-consumed-once", queue.entries.length === 0 && final.comments.filter(row => row.id === userReply.id).length === 1);
    await open(issue); await context.page.reload();
    await expect(context.page.getByText(marker, { exact: true }).last()).toBeVisible();
  }
  check("configured-model-and-environment");
}
