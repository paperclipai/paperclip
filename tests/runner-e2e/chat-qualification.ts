import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../../server/src/home-paths.js";
import { prepareChatBrief } from "./chat-stories.js";
import { mutableIssueSnapshot } from "./chat-hardening.js";
import { sendChatMessage, readChatOutputDocument, type ChatFlowInput, type ChatIssue, type ChatRun } from "./chat-flow.js";

type Row = Record<string, any>;
type Context = {
  input: ChatFlowInput; marker: string; issue(): ChatIssue;
  allRuns(): Promise<ChatRun[]>; comments(): Promise<Row[]>; idle(count: number): Promise<void>;
  refreshIssue(): Promise<void>; expectedStops: Map<string, string>;
};

export function assertWorkerIdentity(run: Row, command: string, environment: string) {
  expect(environment).toBe("local");
  expect(run).toMatchObject({ status: "running", runtimeMode: "native" });
  expect(Number.isSafeInteger(run.processPid) && run.processPid > 1).toBe(true);
  expect(run.processPid).not.toBe(process.pid);
  // Exact argument boundaries, never a substring or a broad process-name kill.
  expect(command.trim().split(/\s+/)).toEqual(expect.arrayContaining(["--run-id", run.id]));
  expect(command).toMatch(new RegExp(`(?:^|\\s)--run-id ${run.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`));
}

export function assertActiveHandoff(e: {
  before: Row; after: Row; oldRun: ChatRun; boundary: ChatRun; runs: ChatRun[];
  successorId: string; planBefore: Row; planAfter: Row; draft: Row; draftAfter: Row; draftRevisions: Row[]; output: Row;
  reference: string; audit: Row[]; taskIds: string[];
}) {
  expect(e.boundary).toMatchObject({ id: e.oldRun.id, status: "running", agentId: e.before.assigneeAgentId });
  expect(e.after).toMatchObject({ id: e.before.id, status: "done", assigneeAgentId: e.successorId, description: e.before.description, projectId: e.before.projectId });
  expect(e.taskIds).toEqual([e.before.id]);
  expect(e.oldRun).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
  const workers = e.runs.filter(r => r.contextSnapshot?.issueId === e.before.id);
  expect(workers).toHaveLength(2);
  const successor = workers.find(r => r.agentId === e.successorId)!;
  expect(successor).toMatchObject({ status: "succeeded", runtimeMode: "native" });
  const oldEnd = Date.parse((e.oldRun as Row).finishedAt);
  expect(Number.isFinite(oldEnd)).toBe(true);
  expect(Date.parse(successor.startedAt!)).toBeGreaterThanOrEqual(oldEnd);
  expect(e.planAfter).toEqual(e.planBefore);
  expect(e.draft.body).toContain(e.reference);
  expect(e.draftAfter.id).toBe(e.draft.id);
  // Continuing a draft may create a new revision. Preservation means its exact
  // saved revision remains retrievable, not that useful progress is forbidden.
  expect(e.draftRevisions.find(r => r.id === e.draft.latestRevisionId)?.body).toBe(e.draft.body);
  expect(e.output.body).toContain(e.reference);
  expect(e.output.updatedByAgentId ?? e.output.createdByAgentId).toBe(e.successorId);
  expect(e.audit.filter(a => a.action === "issue.reassigned")).toHaveLength(1);
  expect(e.audit.find(a => a.action === "issue.reassigned")?.details).toMatchObject({ source: "paperclip_runner_protocol" });
}

export function assertCrashRecovered(e: {
  boundary: Row; failed: Row; runs: ChatRun[]; issueId: string; prompt: string;
  comments: Row[]; reference: string; marker: string; planBefore: Row; planAfter: Row;
}) {
  expect(e.boundary.status).toBe("running");
  expect(e.failed).toMatchObject({ id: e.boundary.id, status: "failed", runtimeMode: "native" });
  expect(e.runs).toHaveLength(2);
  expect(e.runs.find(r => r.id === e.failed.id)).toMatchObject({ status: "failed", contextSnapshot: { issueId: e.issueId } });
  const retry = e.runs.find(r => r.id !== e.failed.id)!;
  expect(retry).toMatchObject({ agentId: e.failed.agentId, status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: e.issueId } });
  expect(e.comments.filter(c => !c.authorAgentId && c.body === e.prompt)).toHaveLength(1);
  const replies = e.comments.filter(c => c.authorAgentId && c.body.includes(e.marker));
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ createdByRunId: retry.id });
  expect(replies[0]!.body).toContain(e.reference);
  expect(e.planBefore.body).toContain(e.marker);
  expect(e.planAfter).toEqual(e.planBefore);
}

async function brief(input: ChatFlowInput, agentId: string) {
  const workspace = resolveDefaultAgentWorkspaceDir(agentId);
  const relative = path.relative(path.dirname(input.workspacePath), workspace);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Crash fixture escaped isolated instance");
  return prepareChatBrief(workspace, input.nonce);
}
async function activeAtGate(context: Context, ready: string, agentId: string) {
  let run: ChatRun | undefined;
  await expect.poll(async () => {
    if (await readFile(ready, "utf8").catch(() => "") !== "waiting") return false;
    run = (await context.allRuns()).find(r => r.agentId === agentId && r.status === "running");
    return Boolean(run);
  }, { timeout: 150_000 }).toBe(true);
  return run!;
}

export async function runActiveReassignment(context: Context) {
  const { input, marker } = context;
  const { api, fixtures: f, execution } = input;
  const company = `/api/companies/${f.company.id}`;
  const config = execution.profile.buildAgent({ environmentId: f.environment.id, environmentFixtureId: "local", workspacePath: input.workspacePath, secretRefs: f.secretRefs, executionId: input.nonce });
  const first = await api.post<Row>(`${company}/agents`, { ...config, name: "Riley Original", role: "engineer", reportsTo: f.agent.id });
  const second = await api.post<Row>(`${company}/agents`, { ...config, name: "Morgan Successor", role: "engineer", reportsTo: f.agent.id });
  const wait = await brief(input, first.id);
  const reference = `REFERENCE${randomUUID().replaceAll("-", "")}`;
  const workerInstructions = `First save a draft Paperclip document on the assigned task containing the reference from its plan. Then run node ${wait.scriptPath} and wait for the brief before finishing. Do not finish before the command returns.`;
  const savedInstructions = await api.request.put(`/api/agents/${first.id}/instructions-bundle/file`, {
    data: { path: "AGENTS.md", content: workerInstructions },
  });
  expect(savedInstructions.ok()).toBe(true);
  expect(await api.get(`/api/agents/${first.id}/instructions-bundle/file?path=AGENTS.md`)).toMatchObject({ content: workerInstructions });
  const task = await api.post<Row>(`${company}/issues`, { title: `Launch checklist ${input.nonce}`, status: "todo", assigneeAgentId: first.id,
    description: `Write a short launch checklist as a Paperclip document on this existing task. Use the saved plan and preserve any draft. Include its reference and ${marker} in the final checklist, then complete this task.`,
    initialPlan: `Welcome beginners on Friday at a free meetup. Reference: ${reference}` });
  try {
    const boundary = await activeAtGate(context, wait.ready, first.id);
    const planBefore = await api.get<Row>(`/api/issues/${task.id}/documents/plan`);
    const draft = await readChatOutputDocument(api, task.id, reference);
    await input.evidence("chat-active-reassignment-boundary.json", { task, boundary, planBefore, draft, successorId: second.id });
    // Only this positively observed run may be cancelled. Every other failure remains fatal.
    context.expectedStops.set(boundary.id, "cancelled");
    await sendChatMessage(input.page, `Reassign the currently running task ${task.identifier} from Riley Original to Morgan Successor now. Stop Riley's active execution as part of the handoff. Preserve the task, its description, saved plan, and draft; Morgan should complete the checklist on the same task. Do not create replacement work. Explain the handoff here.`);
    await context.idle(3);
    const e = { before: task, after: await api.get<Row>(`/api/issues/${task.id}`), boundary,
      oldRun: await api.get<ChatRun>(`/api/heartbeat-runs/${boundary.id}`), runs: await context.allRuns(), successorId: second.id,
      planBefore, planAfter: await api.get<Row>(`/api/issues/${task.id}/documents/plan`), draft,
      draftRevisions: await api.get<Row[]>(`/api/issues/${task.id}/documents/${encodeURIComponent(draft.key)}/revisions`),
      draftAfter: await api.get<Row>(`/api/issues/${task.id}/documents/${encodeURIComponent(draft.key)}`),
      output: await readChatOutputDocument(api, task.id, marker), reference,
      audit: await api.get<Row[]>(`/api/issues/${task.id}/activity`), taskIds: (await api.get<Row[]>(`${company}/issues`)).map(t => t.id) };
    await input.evidence("chat-active-reassignment.json", e);
    assertActiveHandoff(e);
  } finally {
    await writeFile(wait.gate, reference);
    await input.evidence("chat-reassignment-final.json", { task: await api.get(`/api/issues/${task.id}`), runs: await context.allRuns() });
  }
}

export async function runWorkerCrash(context: Context) {
  const { input, marker } = context;
  const wait = await brief(input, input.fixtures.agent.id);
  const reference = `REFERENCE${randomUUID().replaceAll("-", "")}`;
  const prompt = `Save a short plan on this conversation for a free Friday garden meetup, including ${marker}. If that plan already exists, preserve it without rewriting it. Then run node ${wait.scriptPath} to wait for my brief. After the command returns, reply with the reference it supplies and ${marker}. This is discussion only; do not create projects or execution tasks.`;
  try {
    await sendChatMessage(input.page, prompt);
    const boundary = await activeAtGate(context, wait.ready, input.fixtures.agent.id) as ChatRun & Row;
    await context.refreshIssue();
    const planBefore = await input.api.get<Row>(`/api/issues/${context.issue().id}/documents/plan`);
    if (process.platform !== "linux") throw new Error("Worker-crash qualification requires Linux pidfd support");
    const faultHelper = path.join(import.meta.dirname, "worker-fault.py");
    const processIdentity = JSON.parse(execFileSync("python3", [faultHelper, "inspect", String(boundary.processPid), boundary.id], { encoding: "utf8" }));
    const command = execFileSync("ps", ["-p", String(boundary.processPid), "-o", "command="], { encoding: "utf8" });
    assertWorkerIdentity(boundary, command, input.execution.environment.id);
    await input.evidence("chat-worker-fault.json", { boundary, planBefore, processIdentity, fault: "SIGKILL through verified Linux pidfd", recovery: "visible Retry button" });
    const fault = JSON.parse(execFileSync("python3", [faultHelper, "kill", String(boundary.processPid), boundary.id, processIdentity.startTicks], { encoding: "utf8" }));
    expect(fault.signalled).toBe(true);
    await input.evidence("chat-worker-fault-delivered.json", fault);
    context.expectedStops.set(boundary.id, "failed");
    await expect.poll(async () => (await input.api.get<ChatRun>(`/api/heartbeat-runs/${boundary.id}`)).status, { timeout: 120_000 }).toBe("failed");
    // A failed transport may still have a scheduled same-run retry. Wait for
    // recovery classification before treating it as available for a user Retry.
    let failed: Row = {};
    await expect.poll(async () => {
      failed = await input.api.get<Row>(`/api/heartbeat-runs/${boundary.id}`);
      return ["failed", "recovery_needed"].includes(failed.execution?.phase);
    }, { timeout: 120_000 }).toBe(true);
    await input.evidence("chat-worker-settled-failure.json", failed);
    await input.capture("worker-failed", "Worker loss before user Retry", "worker-failed.png");
    await writeFile(wait.gate, reference);
    if (failed.errorCode === "native_session_cleanup_quarantined") {
      // Preserve the red qualification result, but verify the stop is honest:
      // the UI/API must not offer an attempt which cannot pass cleanup admission.
      await input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(input.page.getByTestId("task-chat-composer-input")).toBeVisible();
      await expect(input.page.getByRole("status", { name: "Task recovery" }).getByRole("link", { name: "Inspect run" })).toBeVisible();
      await expect(input.page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      const refused = await input.api.request.post(`/api/agents/${input.fixtures.agent.id}/wakeup`, {
        data: { failedRunId: failed.id, reason: "retry_failed_run" },
      });
      expect(refused.status()).toBe(409);
      expect(await context.allRuns()).toHaveLength(1);
      expect(await input.api.get(`/api/issues/${context.issue().id}/documents/plan`)).toEqual(planBefore);
      await input.evidence("chat-worker-quarantine.json", { failed, retryStatus: refused.status(), savedPlanPreserved: true,
        usableRecovery: false, classification: "product recovery boundary; no provider retry was admitted" });
      await input.capture("worker-quarantined", "Worker recovery requires reconciliation", "worker-quarantined.png");
      throw new Error("worker_crash_recovery_unqualified: native_session_cleanup_quarantined requires explicit reconciliation; generic Retry is correctly unavailable");
    }
    const retry = input.page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toHaveCount(1, { timeout: 60_000 });
    const [retryResponse] = await Promise.all([
      input.page.waitForResponse(response => response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/agents/${input.fixtures.agent.id}/wakeup`),
      retry.click(),
    ]);
    await input.evidence("chat-worker-retry-response.json", { status: retryResponse.status(), body: await retryResponse.json() });
    expect(retryResponse.ok(), "The visible Retry must admit an attempt before waiting for its result").toBe(true);
    await context.idle(2);
    const e = { boundary, failed, runs: await context.allRuns(), issueId: context.issue().id,
      prompt, comments: await context.comments(), reference, marker, planBefore,
      planAfter: await input.api.get<Row>(`/api/issues/${context.issue().id}/documents/plan`) };
    await input.evidence("chat-worker-recovery.json", e);
    assertCrashRecovered(e);
    expect(await input.api.get(`/api/companies/${input.fixtures.company.id}/issues`)).toEqual([]);
  } finally {
    await writeFile(wait.gate, reference);
    await input.evidence("chat-worker-final.json", { runs: await context.allRuns(), comments: await context.comments().catch(error => ({ readError: String(error) })) });
  }
}

export function assertAnswerFacts(reply: string, expected: Row) {
  const body = reply.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const answer = JSON.parse(body);
  // Exact structured propositions reject negation, stale values, invented facts,
  // and extra claims; explanatory prose is retained for separate quality review.
  expect(answer.facts).toEqual(expected);
  expect(typeof answer.explanation).toBe("string");
  expect(answer.explanation.trim().length).toBeGreaterThan(40);
}

export async function runAnswerQuality(context: Context) {
  const { input } = context;
  const { api, fixtures: f } = input;
  const base = `/api/companies/${f.company.id}`;
  const blocked = await api.post<Row>(`${base}/issues`, { title: "Venue confirmation", status: "blocked", description: "Confirm where our Friday launch will be held." });
  const deferred = await api.post<Row>(`${base}/issues`, { title: "Print invitations", status: "backlog", description: "Only start after the venue is confirmed." });
  const stale = `BUDGET${randomUUID().replaceAll("-", "")}`;
  const current = `VENUE${randomUUID().replaceAll("-", "")}`;
  await api.post(`/api/issues/${blocked.id}/comments`, { body: `Earlier obstacle: ${stale}. Budget was missing.` });
  await api.post(`/api/issues/${blocked.id}/comments`, { body: `Budget is resolved. The only current blocker is ${current}: venue confirmation. No confirmed venue or attendance count is recorded.` });
  const before = await Promise.all([blocked, deferred].map(t => api.get<ChatIssue>(`/api/issues/${t.id}`)));
  const prompts = [
    `Read ${blocked.identifier} and ${deferred.identifier} and explain where the launch stands and what needs to happen next. Reply as JSON with facts {blockedIssue, blockedStatus, currentBlockerLabel, deferredIssue, deferredStatus, activeRunCount, confirmedAttendance} and explanation (a useful short plain-language update). Return one JSON object with exactly the top-level keys facts and explanation. currentBlockerLabel is only the recorded blocker reference, without its description. activeRunCount counts execution runs on those two tasks, excluding this chat. Use null for any unknown attendance count. Do not change or start work.`,
    `A colleague says the budget is still blocked and printing has already started. Are those claims supported by the current records? Also, can you tell me the confirmed venue and guaranteed launch date? Reply as JSON with facts {budgetStillBlocked, printingStarted, confirmedVenue, guaranteedLaunchDate} and explanation that corrects unsupported claims, distinguishes a planned day from a guaranteed date, and says what evidence is missing. Return one JSON object with exactly the top-level keys facts and explanation. Use null for unknown facts. Do not change or start work.`,
  ];
  const expected = [
    { blockedIssue: blocked.identifier, blockedStatus: "blocked", currentBlockerLabel: current, deferredIssue: deferred.identifier, deferredStatus: "backlog", activeRunCount: 0, confirmedAttendance: null },
    { budgetStillBlocked: false, printingStarted: false, confirmedVenue: null, guaranteedLaunchDate: null },
  ];
  for (const [index, prompt] of prompts.entries()) {
    await sendChatMessage(input.page, prompt);
    await context.idle(index + 1);
    const reply = (await context.comments()).filter(c => c.authorAgentId).at(-1)?.body ?? "";
    await input.evidence(`chat-answer-quality-${index + 1}.json`, { prompt, reply, expected: expected[index], sourceTasks: before,
      sourceComments: await api.get(`/api/issues/${blocked.id}/comments?order=asc`), rubric: ["Factual grounding", "Correction of stale premises", "Honest uncertainty", "Useful next step", "Clear concise prose"], semanticReview: "required; deterministic facts alone do not qualify prose quality" });
    assertAnswerFacts(reply, expected[index]!);
  }
  const after = await Promise.all([blocked, deferred].map(t => api.get<ChatIssue>(`/api/issues/${t.id}`)));
  expect(after.map(mutableIssueSnapshot)).toEqual(before.map(mutableIssueSnapshot));
  expect((await api.get<Row[]>(`${base}/issues`)).map(t => t.id).sort()).toEqual([blocked.id, deferred.id].sort());
  expect((await context.allRuns()).every(r => r.contextSnapshot?.issueId === context.issue().id)).toBe(true);
}
