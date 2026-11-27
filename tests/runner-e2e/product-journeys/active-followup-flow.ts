import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { createTaskThroughUi, submitTaskReply } from "../user-actions.js";
import { collectRunEvents } from "../run-observations.js";
import { nativeFinalReplyEvents, readBoundTaskFinalReply } from "../native-task-reply.js";
import { fixtureReplyStoredOnce, validateAgentTaskState, waitFor } from "./agent-flows.js";
import { activeFollowupBoundary, activeFollowupOutcome, sameActiveFollowupBoundary } from "./active-followup-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
const id = "followup-while-running";

export function activeFollowupStory(campaignId: string) {
  const nonce = campaignId.replace(/[^a-z0-9]/gi, "");
  const reference = `BRIEF${nonce}`, marker = `UPDATED${nonce}`;
  const expectedReply = `Launch Friday. Reference ${reference}. Update ${marker}.`;
  return {
    first: `Our launch is planned for Monday. Run the bounded command sleep 90 exactly once before answering, so I can send additional context while you work. After the command finishes, briefly acknowledge the launch day and reference ${reference}, then finish this task. No files, projects or child tasks are needed.`,
    followup: `Change the launch day to Friday. When ready, reply with exactly this one line and finish: ${expectedReply}`,
    reference, marker, expectedReply,
  };
}

/** Once owned work has settled, an unobserved live boundary cannot arrive. */
export async function observeActiveFollowupCommand(taskRuns: Row[], loadEvents: (runId: string) => Promise<Row[]>) {
  if (taskRuns.length > 0 && taskRuns.every(run => run.status === "succeeded"))
    throw new JourneyError("failed", "followup_native_command_not_active");
  const run = taskRuns.find(run => run.status === "running");
  return { run, boundary: run ? activeFollowupBoundary(run, await loadEvents(run.id)) : null };
}

/** The same browser/API/native story runs against managed and attached targets. */
export async function runActiveFollowup(context: JourneyContext, session: TargetSession, campaignId: string,
  evidence: JourneyEvidence, options: { deadlineAt: number; directory: string }) {
  const agent = context.agent;
  if (!agent || agent.runtimeMode !== "native" || !context.environmentId) throw new JourneyError("unsupported", "native_agent_and_environment_required");
  const story = activeFollowupStory(campaignId), title = `Journey QA active followup ${campaignId}`;
  const check = (name: string, passed: boolean) => {
    evidence.checks.push({ id: name, passed });
    if (!passed) throw new JourneyError("failed", name.replaceAll("-", "_"));
  };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const retain = (name: string, value: unknown) => writeFile(path.join(options.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  const created = await createTaskThroughUi({ page: context.page, origin: context.api.origin, issuePrefix: context.company.issuePrefix,
    agentName: agent.name, title, prompt: story.first, workMode: "standard", requireExplicitTitle: true,
    beforeDispatch: () => session.own({ kind: "issue", name: title, journeyId: id }) });
  await session.own({ kind: "issue", name: title, id: created.issueId, journeyId: id });
  const route = `/api/issues/${created.issueId}`;
  const read = async () => {
    const [currentIssue, summaries, comments, queue] = await Promise.all([
      context.api.get<Row & { id: string; status: string }>(route), context.api.get<Row[]>(`${route}/runs`), context.api.get<Row[]>(`${route}/comments?order=asc`),
      context.api.get<Row>(`${route}/queued-comments`),
    ]);
    if (!Array.isArray(summaries) || summaries.length > 2) throw new JourneyError("failed", "followup_run_limit_exceeded");
    const taskRuns = await Promise.all(summaries.map(summary => context.api.get<Row & { status: string }>(`/api/heartbeat-runs/${summary.runId}`)));
    validateAgentTaskState(context, created.issueId, { currentIssue, taskRuns, comments, interactions: [], attachments: [] }, 2);
    if (currentIssue.description !== story.first) throw new JourneyError("failed", "followup_initial_prompt_changed");
    return { currentIssue, taskRuns, comments, queue };
  };
  const events = (runId: string) => collectRunEvents<Row>((afterSeq, limit) =>
    context.api.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const issue = (await read()).currentIssue;
  await context.page.goto(`${context.api.origin}/${context.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`, { waitUntil: "domcontentloaded" });
  await expect(context.page.getByTestId("task-chat-composer-input").last()).toBeVisible({ timeout: 30_000 });
  const beforeComments = (await read()).comments;
  const active = await waitFor(options.deadlineAt, async () => {
    const state = await read();
    return observeActiveFollowupCommand(state.taskRuns, events);
  }, value => Boolean(value.boundary), "followup_native_command_not_active");
  const before = active.boundary!;
  await submitTaskReply(context.page, story.followup);
  const persisted = await waitFor(Math.min(options.deadlineAt, Date.now() + 30_000), read, state => state.comments.some(comment => comment.authorUserId === context.user.id
    && !beforeComments.some(old => old.id === comment.id)), "followup_not_persisted");
  const afterRun = persisted.taskRuns.find(run => run.id === before.runId)!;
  const after = activeFollowupBoundary(afterRun, await events(before.runId));
  await retain("followup-boundary.json", { before, after });
  check("followup-native-command-active", sameActiveFollowupBoundary(before, after));
  check("followup-stored-once", fixtureReplyStoredOnce(beforeComments, persisted.comments, context.user.id, story.followup));

  const final = await waitFor(options.deadlineAt, async () => {
    const state = await read();
    const replies = [] as Array<{ runId: string; body: string }>;
    for (const run of state.taskRuns.filter(run => run.status === "succeeded")) {
      const stream = await events(run.id);
      const decision = run.resultJson?.presentationDecision?.commentId;
      const posted = state.comments.filter(comment => comment.id === decision && comment.authorAgentId === agent.id && comment.createdByRunId === run.id);
      if (posted.length) replies.push(...posted.map(comment => ({ runId: run.id, body: comment.body })));
      else replies.push(...nativeFinalReplyEvents(stream, run).map(reply => ({ runId: run.id, body: reply.body })));
    }
    return { state, replies };
  }, value => activeFollowupOutcome({ issueId: created.issueId, agentId: agent.id, before, after,
    runs: value.state.taskRuns, expectedReply: story.expectedReply, marker: story.marker, replies: value.replies,
    storedFollowupCount: value.state.comments.filter(comment => comment.authorUserId === context.user.id
      && comment.body?.replaceAll("\\_", "_") === story.followup).length,
    queuedCommentCount: Array.isArray(value.state.queue.entries) ? value.state.queue.entries.length : -1,
    finalIssueStatus: value.state.currentIssue.status }), "followup_final_outcome_missing");
  check("followup-consumed-once", true);
  const finalRunId = final.replies.find(reply => reply.body === story.expectedReply)!.runId;
  const companies = await context.api.get<Array<{ id: string; issuePrefix: string }>>("/api/companies?scope=accessible");
  if (!Array.isArray(companies) || !companies.some(company => company.id === context.company.id) || companies.some(company => !company.issuePrefix)) throw new JourneyError("failed", "reply_company_context_missing");
  const reply = await readBoundTaskFinalReply({ page: context.page, runId: finalRunId, agentId: agent.id,
    expectedText: story.expectedReply, deadlineAt: options.deadlineAt, knownCompanyPrefixes: companies.map(company => company.issuePrefix),
    load: async () => { const latest = await read(); return { run: latest.taskRuns.find(run => run.id === finalRunId)!, comments: latest.comments, events: await events(finalRunId) }; } });
  await retain("followup-final.json", { before, after, runIds: final.state.taskRuns.map(run => run.id), reply });
  check("followup-final-answer-persisted", reply.observedAfterReload === true);
  check("followup-one-or-two-native-runs", final.state.taskRuns.length >= 1 && final.state.taskRuns.length <= 2);
  await expect(context.page.getByText(story.expectedReply, { exact: true }).last()).toBeVisible();
  check("configured-model-and-environment", true);
}
