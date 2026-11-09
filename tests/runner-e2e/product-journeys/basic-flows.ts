import { expect } from "@playwright/test";
import { runnerTasks } from "../catalog.js";
import { createTaskThroughUi } from "../user-actions.js";
import { questionEvidencePasses } from "./basic-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

export async function taskCreate(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence) {
  const title = `Journey QA create ${campaignId}`;
  const prompt = "Keep this task for me to review. No agent work is required.";
  const created = await createTaskThroughUi({ page: context.page, origin: context.api.origin, issuePrefix: context.company.issuePrefix,
    agentName: "Me", title, prompt, workMode: "standard", requireExplicitTitle: true,
    beforeDispatch: () => session.own({ kind: "issue", name: title }) });
  await session.own({ kind: "issue", name: title, id: created.issueId });
  const route = `/api/issues/${created.issueId}`;
  const issue = await context.api.get(route);
  if (issue.companyId !== context.company.id || issue.title !== title || issue.description !== prompt
    || issue.assigneeUserId !== context.user.id || issue.assigneeAgentId !== null) throw new JourneyError("failed", "created_task_mismatch");
  await context.page.goto(`${context.api.origin}/${context.company.issuePrefix}/issues`);
  await context.page.getByRole("link").filter({ hasText: title }).first().click();
  await context.page.reload();
  await expect(context.page.getByText(title, { exact: true }).first()).toBeVisible();
  const saved = await context.api.get(route);
  if (saved.title !== title || saved.description !== prompt || saved.assigneeUserId !== context.user.id
    || (await context.api.get<unknown[]>(`${route}/runs`)).length) throw new JourneyError("failed", "created_task_not_persisted");
  evidence.checks.push({ id: "browser-created-task-persisted", passed: true }, { id: "no-agent-work", passed: true });
}

export async function askQuestion(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence) {
  const agent = context.agent;
  if (!agent) throw new JourneyError("blocked", "configured_agent_required");
  if (agent.runtimeMode !== "native" || !context.environmentId || !agent.model || !agent.provider) throw new JourneyError("unsupported", "question_execution_identity_unavailable");
  // Reuse the exact existing cross-model Ask fixture, including its terminal marker.
  const fixture = runnerTasks.find(task => task.id === "ask-question")!;
  const nonce = campaignId.replace(/-/g, "_");
  const title = `Journey QA ask ${campaignId}`;
  const marker = fixture.buildVisibleMarker(nonce);
  const created = await createTaskThroughUi({ page: context.page, origin: context.api.origin, issuePrefix: context.company.issuePrefix,
    agentName: agent.name, title, prompt: fixture.buildPrompt(nonce), workMode: "ask", requireExplicitTitle: true,
    beforeDispatch: () => session.own({ kind: "issue", name: title }) });
  await session.own({ kind: "issue", name: title, id: created.issueId });
  const route = `/api/issues/${created.issueId}`;
  await expect.poll(async () => {
    const issue = await context.api.get(route);
    const summaries = await context.api.get<Array<{ runId: string }>>(`${route}/runs`);
    const runs = await Promise.all(summaries.map(run => context.api.get<Record<string, any>>(`/api/heartbeat-runs/${run.runId}`)));
    if (runs.length > 1 || runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status))) throw new JourneyError("failed", "question_run_failed");
    const comments = await context.api.get(`${route}/comments`);
    return questionEvidencePasses({ companyId: context.company.id, agentId: agent.id, environmentId: context.environmentId,
      marker, model: agent.model, provider: agent.provider, runtimeMode: agent.runtimeMode, issue, runs, comments });
  }, { timeout: 240_000, intervals: [1000, 2000, 3000] }).toBe(true);
  const issue = await context.api.get(route);
  await context.page.goto(`${context.api.origin}/${context.company.issuePrefix}/issues/${issue.identifier}`);
  await context.page.reload();
  await expect(context.page.getByText(marker, { exact: true }).last()).toBeVisible();
  evidence.checks.push({ id: "question-answer-persisted", passed: true }, { id: "one-bound-successful-run", passed: true }, { id: "configured-model-and-environment", passed: true });
}
