import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator } from "@playwright/test";
import { continuationScenario } from "../continuation-cases.js";
import { continuationAnswerCommitted, continuationCheckpointReady } from "../continuation-readiness.js";
import type { ContinuationCheckpoint } from "../continuation-scoring.js";
import { answerResumeQuestionThroughUi } from "../question-resume-ui.js";
import { createTaskThroughUi } from "../user-actions.js";
import { validateAgentTaskState } from "./agent-flows.js";
import { clarificationQuestionFailure, gradeClarificationEvidence, type ClarificationReadback } from "./clarification-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

type Row = Record<string, any>;
interface Options { deadlineAt: number; directory: string; capture(id: string, label: string, file: string): Promise<void> }

export async function waitForClarificationDocument(visible: Locator, answer: string, deadlineAt: number) {
  const remaining = () => {
    const timeout = deadlineAt - Date.now();
    if (!Number.isFinite(timeout) || timeout <= 0) throw new JourneyError("failed", "clarification_document_not_ready");
    return timeout;
  };
  await expect(visible).toHaveCount(1, { timeout: remaining() });
  await expect(visible).toBeVisible({ timeout: remaining() });
  await expect(visible).toContainText(answer, { timeout: remaining() });
  await expect(visible).toContainText(/afternoon/i, { timeout: remaining() });
  remaining();
}

export async function readClarificationState(context: JourneyContext, issueId: string) {
  const route = `/api/issues/${issueId}`;
  const [currentIssue, summaries, interactions, documents, attachments, children] = await Promise.all([
    context.api.get<Row>(route), context.api.get<Row[]>(`${route}/runs`), context.api.get<Row[]>(`${route}/interactions`),
    context.api.get<Row[]>(`${route}/documents`), context.api.get<Row[]>(`${route}/attachments`),
    context.api.get<Row[]>(`/api/companies/${context.company.id}/issues?view=index&parentIds=${encodeURIComponent(issueId)}&limit=2`),
  ]);
  if (!Array.isArray(summaries) || summaries.length > 3) throw new JourneyError("failed", "clarification_run_limit_exceeded");
  const runs = await Promise.all(summaries.map(summary => context.api.get<Row>(`/api/heartbeat-runs/${summary.runId}`)));
  validateAgentTaskState(context, issueId, { currentIssue: currentIssue as Row & { id: string; status: string },
    taskRuns: runs as Array<Row & { status: string }>, interactions: interactions as Array<Row & { id: string; status: string }>, comments: [], attachments: [] }, 3);
  if (!Array.isArray(children) || children.some(child => child.parentId !== issueId || child.companyId !== context.company.id)) {
    throw new JourneyError("failed", "clarification_child_query_mismatch");
  }
  return { currentIssue, runs, interactions, documents, attachments, children };
}

export async function runClarificationJourney(context: JourneyContext, session: TargetSession,
  campaignId: string, evidence: JourneyEvidence, options: Options) {
  if (!context.agent || context.agent.runtimeMode !== "native" || !context.environmentId) {
    throw new JourneyError("unsupported", "native_agent_and_environment_required");
  }
  const agent = context.agent, scenario = continuationScenario("question-answer-resume", campaignId.replaceAll("-", "_"));
  const checkpoints: ContinuationCheckpoint[] = [];
  let issue: Row | undefined, readback: ClarificationReadback | undefined;
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const retain = (name: string, value: unknown) => writeFile(path.join(options.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  const read = () => readClarificationState(context, issue!.id);
  const settle = async (answeredId?: string, final = false) => {
    let stable = "";
    while (Date.now() < options.deadlineAt) {
      const state = await read();
      const pending = state.interactions.filter(i => i.kind === "ask_user_questions" && i.status === "pending");
      const ready = continuationAnswerCommitted(state.interactions, answeredId)
        && continuationCheckpointReady({ issue: state.currentIssue as { status: string; executionRunId?: string }, runs: state.runs as Array<Row & { id: string; status: string }>, interactions: state.interactions })
        && (final ? state.currentIssue.status === "done" && !pending.length : pending.length === 1)
        && !state.currentIssue.scheduledRetry && !state.currentIssue.activeRecoveryAction;
      const key = ready ? JSON.stringify([state.currentIssue.status, state.currentIssue.executionRunId,
        state.runs.map(run => [run.id, run.status]), state.interactions.map(i => [i.id, i.status])]) : "";
      if (key && key === stable) return state;
      stable = key;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new JourneyError("failed", final ? "clarification_not_completed" : "clarification_question_not_ready");
  };
  const open = () => context.page.goto(`${context.api.origin}/${encodeURIComponent(context.company.issuePrefix)}/issues/${encodeURIComponent(issue!.identifier ?? issue!.id)}`, { waitUntil: "domcontentloaded" });
  const snapshot = async (phase: "initial" | "answered" | "final", state: Awaited<ReturnType<typeof read>>) => {
    const documents = await Promise.all(state.documents.map(document => context.api.get<Row>(`/api/issues/${issue!.id}/documents/${encodeURIComponent(document.key)}`)));
    const point = { phase, issue: state.currentIssue, runs: structuredClone(state.runs), interactions: structuredClone(state.interactions),
      documents, attachments: state.attachments, children: state.children, comments: [] } as unknown as ContinuationCheckpoint;
    checkpoints.push(point);
    await retain("clarification.json", { checkpoints });
    await open();
    await options.capture(phase, `Clarification ${phase}`, `clarification-${phase}.png`);
    return point;
  };
  try {
    const title = `Journey QA question-answer-resume ${campaignId}`;
    const created = await createTaskThroughUi({ page: context.page, origin: context.api.origin,
      issuePrefix: context.company.issuePrefix, agentName: agent.name, title, prompt: scenario.prompt,
      workMode: "standard", requireExplicitTitle: true,
      beforeDispatch: () => session.own({ kind: "issue", name: title, journeyId: "question-answer-resume" }) });
    await session.own({ kind: "issue", name: title, id: created.issueId, journeyId: "question-answer-resume" });
    issue = await context.api.get<Row>(`/api/issues/${created.issueId}`);
    let state = await settle();
    for (const [index, input] of [{ choice: "Afternoon" }, { text: scenario.answer, allowProviderCustomAnswer: true }].entries()) {
      const point = await snapshot(index === 0 ? "initial" : "answered", state);
      const question = state.interactions.find(i => i.kind === "ask_user_questions" && i.status === "pending")!;
      const questionFailure = clarificationQuestionFailure(point, question, index === 0);
      if (questionFailure) throw new JourneyError("failed", questionFailure);
      if (point.documents.length || point.attachments.length || point.children.length || point.issue.status === "done") {
        throw new JourneyError("failed", "clarification_premature_output");
      }
      await answerResumeQuestionThroughUi(context.page, question, input);
      state = await settle(question.id, index === 1);
    }
    const final = await snapshot("final", state);
    if (final.documents.length !== 1) throw new JourneyError("failed", "clarification_document_missing");
    const document = final.documents[0]!;
    const href = `/${encodeURIComponent(context.company.issuePrefix)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}#document-${encodeURIComponent(document.key)}`;
    await context.page.goto(new URL(href, context.api.origin).href, { waitUntil: "domcontentloaded" });
    await context.page.reload({ waitUntil: "domcontentloaded" });
    const visible = context.page.locator(`[id=${JSON.stringify(`document-${document.key}`)}]:visible, [id=${JSON.stringify(`side-panel-content-document:${document.key}`)}]:visible`);
    await waitForClarificationDocument(visible, scenario.answer, options.deadlineAt);
    const persisted = await context.api.get<Row>(`/api/issues/${issue.id}/documents/${encodeURIComponent(document.key)}`);
    readback = { issueId: persisted.issueId, key: persisted.key, revisionId: persisted.latestRevisionId, body: persisted.body, visibleBody: await visible.innerText() };
    await options.capture("reloaded", "Saved answers after reload", "clarification-reloaded.png");
  } finally {
    const checks = gradeClarificationEvidence(context, issue?.id ?? "", scenario.marker, checkpoints, readback);
    evidence.checks.push(...checks.map(({ id, passed }) => ({ id, passed })));
    await retain("clarification.json", { checkpoints, readback, checks });
  }
  if (evidence.checks.some(check => !check.passed)) throw new JourneyError("failed", "clarification_evidence_failed");
}
