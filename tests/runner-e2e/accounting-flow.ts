import { expect, type Page } from "@playwright/test";
import { accountingCase, accountingScreenshotFile } from "./accounting-cases.js";
import { gradeAccounting, type AccountingCheckpoint } from "./accounting-scoring.js";
import { prepareLegacyContinuationSkill } from "./continuation-fixtures.js";
import { captureLoadedContinuation } from "./continuation-screenshot.js";
import { chatQuestionPresentation } from "./chat-flow.js";
import { createTaskThroughUi } from "./user-actions.js";
import { pollUntil, type RunnerApi } from "./api.js";
import type { MatrixExecution } from "./types.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
type Row = Record<string, any>;
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
export async function runAccountingFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string; deadlineAt: number;
  restart(): Promise<void>;
  observe(issue: any, runs: any[], checks: ReturnType<typeof gradeAccounting>): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const probe = accountingCase(execution.task.id);
  const checkpoints: AccountingCheckpoint[] = [];
  let issue: Row | undefined;
  let state: AccountingCheckpoint | undefined;
  let checks: ReturnType<typeof gradeAccounting> = [];
  async function load(): Promise<AccountingCheckpoint> {
    if (!issue) throw new Error("Accounting task has not been created");
    const [current, listed, comments, interactions, docs] = await Promise.all([
      api.get<Row>(`/api/issues/${issue.id}`),
      api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`),
      api.get<Row[]>(`/api/issues/${issue.id}/comments?order=asc`),
      api.get<Row[]>(`/api/issues/${issue.id}/interactions`),
      api.get<Row[]>(`/api/issues/${issue.id}/documents`),
    ]);
    const runs = await Promise.all(listed.map(r => api.get<Row>(`/api/heartbeat-runs/${r.id}`)));
    runs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    const documents = await Promise.all(docs.map(d => api.get<Row>(`/api/issues/${issue!.id}/documents/${encodeURIComponent(d.key)}`)));
    issue = current;
    state = { phase: "observation", issue: current, runs, comments, interactions, documents };
    input.observe(current, runs, checks);
    return state;
  }
  async function wait(label: string, accept: (s: AccountingCheckpoint) => boolean) {
    let stable = "";
    return pollUntil({ label, deadlineAt: input.deadlineAt, intervalMs: 500, load,
      accept: s => {
        const key = accept(s) ? JSON.stringify([s.issue.status, s.runs.map(r => [r.id, r.status]), s.interactions.map(i => [i.id, i.status]), s.comments.length]) : "";
        const ready = !!key && key === stable; stable = key; return ready;
      },
      reject: s => s.runs.length > execution.task.expectedRunCount ? "Unexpected additional run exceeds the declared accounting allowance" : s.runs.some(r => ["failed", "timed_out", "cancelled"].includes(r.status)) ? `Unexpected terminated run: ${s.runs.filter(r => ["failed", "timed_out", "cancelled"].includes(r.status)).map(r => `${r.status}:${r.errorCode ?? "no-code"}`).join(", ")}` : undefined,
    });
  }
  async function checkpoint(phase: string, screenshot = false) {
    const s = await load();
    checkpoints.push(structuredClone({ ...s, phase }));
    await input.evidence("continuation.json", { probe, checkpoints, checks });
    await input.evidence("api-state.json", s);
    if (screenshot) {
      await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue!.identifier ?? issue!.id}`, { waitUntil: "domcontentloaded" });
      await captureLoadedContinuation(page, String(issue!.title), () => input.capture(phase, `Accounting: ${phase}`, accountingScreenshotFile(phase)));
    }
  }
  try {
    if (execution.profile.generation === "legacy") await prepareLegacyContinuationSkill(api, fixtures.company.id, fixtures.agent.id);
    await api.patch("/api/instance/settings/experimental", { enableClassicTaskInterface: false });
    await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name,
      title: execution.task.buildTitle(nonce), prompt: execution.task.buildPrompt(nonce), workMode: "standard" });
    issue = await pollUntil({ label: "accounting task creation", deadlineAt: input.deadlineAt,
      load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(i => i.title === execution.task.buildTitle(nonce)), accept: Boolean });
    if (!issue) throw new Error("Missing created accounting task");
    if (probe.kind === "productive") {
      for (let step = 1; step <= 5; step++) {
        await wait(`productive step ${step}`, s => s.runs.length >= step && s.runs.every(r => terminal.has(r.status)) &&
          (step === 5 ? s.issue.status === "done" : s.interactions.some(i => i.kind === "ask_user_questions" && i.status === "pending")));
        await checkpoint(`step-${step}`, true);
        if (step < 5) {
          const pending = state!.interactions.filter(i => i.kind === "ask_user_questions" && i.status === "pending");
          expect(pending).toHaveLength(1);
          const presentation = chatQuestionPresentation(pending[0].payload);
          expect(presentation.questions).toHaveLength(1);
          expect(presentation.questions[0].answerMode).toBe("text");
          await page.getByTestId("question-text-answer-composer").last().locator('[contenteditable="true"],textarea').first().fill(`VALUE${nonce}N${step + 1}`);
          await page.getByRole("button", { name: presentation.submitLabel ?? "Submit answers", exact: true }).last().click();
          await pollUntil({ label: "matching answer committed", deadlineAt: input.deadlineAt, load,
            accept: s => s.interactions.some(i => i.id === pending[0].id && i.status === "answered") });
        }
      }
    } else if (probe.kind === "approval") {
      await wait("repair records approval", s => s.runs.length >= 2 && s.runs.every(r => terminal.has(r.status)) && s.interactions.some(i => i.kind === "request_confirmation" && i.status === "pending"));
      await checkpoint("approval", true);
      // Remain pending longer than immediate post-run scheduling, with no agent wake.
      const until = Date.now() + 5_000;
      await pollUntil({ label: "approval owns wait", deadlineAt: input.deadlineAt, load, accept: () => Date.now() >= until,
        reject: s => s.runs.length !== 2 || !!s.issue.scheduledRetry ? "Repair raced a pending approval" : undefined });
      await page.getByRole("button", { name: "Approve completion", exact: true }).last().click();
      await wait("approved completion", s => s.issue.status === "done" && s.runs.every(r => terminal.has(r.status)));
    } else {
      await wait("second repair is durably scheduled", s => s.runs.length === 3 && s.runs.at(-1)?.status === "scheduled_retry");
      const dueAt = Date.parse(state!.runs.at(-1)!.scheduledRetryAt);
      expect(Number.isFinite(dueAt)).toBe(true);
      await checkpoint("scheduled");
      if (probe.kind === "stop") {
        // This is the same public operator endpoint used by the UI Stop action.
        const response = await api.request.post(`/api/heartbeat-runs/${state!.runs.at(-1)!.id}/cancel`, { data: {} });
        expect(response.ok()).toBe(true);
      }
      await input.restart();
      await checkpoint("restarted");
      if (probe.kind === "stop") {
        await pollUntil({ label: "Stop remains effective after scheduled due time", deadlineAt: input.deadlineAt, intervalMs: 1000, load,
          accept: () => Date.now() >= dueAt + 15_000,
          reject: s => s.runs.length !== 3 || s.runs.at(-1)?.status !== "cancelled" || !!s.runs.at(-1)?.startedAt ? "Stopped repair executed or created a successor" : undefined });
        await checkpoint("after-due");
      } else await wait("bounded repairs exhausted", s => s.issue.status === "blocked" && s.runs.every(r => terminal.has(r.status)) && !!s.issue.activeRecoveryAction);
    }
    await checkpoint("final", true);
  } finally {
    checks = gradeAccounting({ probe, nonce, agentId: fixtures.agent.id, runtime: execution.profile.expectedRuntimeMode, checkpoints });
    if (issue) input.observe(issue, state?.runs ?? [], checks);
    await input.evidence("continuation.json", { probe, checkpoints, checks, lastObserved: state });
  }
  const failed = checks.filter(c => !c.passed);
  if (failed.length) throw new Error(`Accounting assertions failed: ${failed.map(c => c.id).join(", ")}`);
  return { issue: issue!, runs: state!.runs, checks };
}
