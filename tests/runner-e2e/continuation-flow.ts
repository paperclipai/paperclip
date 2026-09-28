import { gradeLifecycleBaseline, type LifecycleCheckpoint } from "./lifecycle-baseline.js";
import { lifecycleLiveCase, lifecycleLiveContinuation, gradeLifecycleNarrative } from "./lifecycle-live-cases.js";
import { prepareLegacyContinuationSkill } from "./continuation-fixtures.js";
import { captureFirstTaskAttachments } from "./first-task-attachments.js";
import { answerableRuntimeRunIds, isSingleClaudeQuestion } from "./runtime-question-readiness.js";
import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { continuationAnswerCommitted, continuationInitialReady } from "./continuation-readiness.js";
import { captureLoadedContinuation } from "./continuation-screenshot.js";
import { seedContinuationContext } from "./continuation-workspace.js";
import { pollUntil, type RunnerApi } from "./api.js";
import {
  chatQuestionPresentation,
  sendChatMessage,
  collectChatRunEvidence,
  type ChatRun,
} from "./chat-flow.js";
import {
  continuationScenario,
  continuationScreenshotFile,
} from "./continuation-cases.js";
import {
  gradeContinuation,
  isContinuationPlan,
  type ContinuationCheckpoint,
} from "./continuation-scoring.js";
import { createTaskThroughUi } from "./user-actions.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
type Row = Record<string, any>;

export async function runContinuationFlow(input: {
  page: Page;
  api: RunnerApi;
  fixtures: LiveFixtureValues;
  execution: MatrixExecution;
  nonce: string;
  secrets: readonly string[];
  workspacePath: string;
  deadlineAt: number;
  restart(): Promise<void>;
  observe(
    issue: any,
    runs: any[],
    checks: ReturnType<typeof gradeContinuation>,
  ): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution } = input;
  const lifecycleProbe = lifecycleLiveCase(execution.task.id);
  const scenario = lifecycleProbe
    ? lifecycleLiveContinuation(execution.task.id, input.nonce)
    : continuationScenario(execution.task.id, input.nonce);
  const checkpoints: LifecycleCheckpoint[] = [];
  let issue: Row | undefined;
  let runs: Row[] = [];
  let checks: ReturnType<typeof gradeContinuation> = [];
  const tasksPath = `/api/companies/${fixtures.company.id}/issues?limit=100`;
  async function refresh() {
    issue = await api.get<Row>(`/api/issues/${issue!.id}`);
    const listed = await api.get<Row[]>(
      `/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`,
    );
    runs = await Promise.all(
      listed.map((r) => api.get<Row>(`/api/heartbeat-runs/${r.id}`)),
    );
    input.observe(issue, runs, checks);
    return { issue, runs };
  }
  let pausedRuntimeRunIds = new Set<string>();
  async function settle(prior: Set<string>, requireQuestion = false, answeredInteractionId?: string) {
    let stable = "";
    const previousPaused = pausedRuntimeRunIds;
    await pollUntil({
      label: `continuation ${scenario.id} settled`,
      deadlineAt: input.deadlineAt,
      intervalMs: 1000,
      load: async () => ({
        ...await refresh(),
        interactions: await api.get<Row[]>(`/api/issues/${issue!.id}/interactions`),
      }),
      accept: (state) => {
        const paused = answerableRuntimeRunIds(state.interactions);
        const idle =
          continuationAnswerCommitted(state.interactions, answeredInteractionId) &&
          state.runs.some((r) => !prior.has(r.id) || previousPaused.has(r.id)) &&
          state.runs.every((r) => ["succeeded", "failed", "timed_out", "cancelled"].includes(r.status) ||
            (r.status === "running" && paused.has(r.id))) &&
          !state.issue.scheduledRetry &&
          !state.issue.activeRecoveryAction &&
          (!requireQuestion || continuationInitialReady(state.interactions));
        const key = idle
          ? state.runs.map((r) => `${r.id}:${r.status}`).join()
          : "";
        const ready = !!key && key === stable;
        stable = key;
        if (ready) pausedRuntimeRunIds = paused;
        return ready;
      },
      reject: (state) =>
        state.runs.length > 12
          ? "Bounded continuation run count exceeded"
          : state.runs.some((r) =>
                ["failed", "timed_out", "cancelled"].includes(r.status),
              )
            ? `Provider execution failed: ${state.runs
                .filter((r) => r.status !== "succeeded")
                .map(
                  (r) => `${r.id} ${r.errorCode ?? r.status}: ${r.error ?? ""}`,
                )
                .join("; ")}`
            : undefined,
    });
  }
  async function open() {
    await page.goto(
      `/${fixtures.company.issuePrefix}/issues/${issue!.identifier ?? issue!.id}`,
      { waitUntil: "domcontentloaded" },
    );
  }
  async function snapshot(phase: ContinuationCheckpoint["phase"]) {
    const [tasks, summaries, comments, interactions, attachments] =
      await Promise.all([
        api.get<Row[]>(tasksPath),
        api.get<Row[]>(`/api/issues/${issue!.id}/documents`),
        api.get<Row[]>(`/api/issues/${issue!.id}/comments?order=asc`),
        api.get<Row[]>(`/api/issues/${issue!.id}/interactions`),
        captureFirstTaskAttachments(api, [{ id: issue!.id }], input.secrets),
      ]);
    const documents = await Promise.all(
      summaries.map((d) =>
        api.get<Row>(
          `/api/issues/${issue!.id}/documents/${encodeURIComponent(d.key)}`,
        ),
      ),
    );
    checkpoints.push({
      phase,
      lifecycle: {
        executionRunId: issue!.executionRunId ?? null,
        scheduledRetry: issue!.scheduledRetry ?? null,
        activeRecoveryAction: issue!.activeRecoveryAction ?? null,
        monitorNextCheckAt: issue!.monitorNextCheckAt ?? null,
      },
      issue: issue as ContinuationCheckpoint["issue"],
      children: tasks.filter(
        (t) => t.parentId === issue!.id,
      ) as ContinuationCheckpoint["children"],
      documents: documents as ContinuationCheckpoint["documents"],
      comments,
      interactions,
      attachments,
      runs: [...runs] as ContinuationCheckpoint["runs"],
    });
    await input.evidence("continuation.json", {
      ...scenario,
      checkpoints,
      checks,
    });
    await input.evidence("api-state.json", checkpoints.at(-1));
    await open();
    await captureLoadedContinuation(page, String(issue!.title), () => input.capture(
      phase,
      `Continuation: ${phase}`,
      continuationScreenshotFile(phase),
    ));
  }
  async function answer(choice?: string) {
    const interactions = await api.get<Row[]>(
      `/api/issues/${issue!.id}/interactions`,
    );
    const questions = interactions.filter(
      (i) => i.kind === "ask_user_questions" && i.status === "pending",
    );
    expect(questions, "one real question must be shown").toHaveLength(1);
    const set = chatQuestionPresentation(questions[0].payload);
    if (scenario.id === "provider-question-bridge") {
      expect(isSingleClaudeQuestion(set.questions), "one choice question with only the optional provider Other field").toBe(true);
    } else expect(set.questions, "ask only the requested next question").toHaveLength(1);
    const before = new Set(runs.map((r) => r.id));
    if (choice) {
      expect(set.questions[0].answerMode, "choices must use radio controls").toBe("single_select");
      const options = questions[0].payload.questionSet?.questions[0]?.options
        ?? questions[0].payload.questions[0]?.options ?? [];
      expect(new Set(options.map((o: Row) => String(o.label).trim().toLowerCase())).size).toBeGreaterThanOrEqual(2);
      await page.getByRole("radio", { name: new RegExp(`^${choice}\\b`, "i") }).last().click();
    } else {
      expect(set.questions[0].answerMode, "open answers must render a text field, not a choice question").toBe("text");
      await page.getByTestId("question-text-answer-composer").last()
        .locator('[contenteditable="true"],textarea').first().fill(scenario.answer);
    }
    // Claude may add a separate optional Other field after its choice page.
    // Navigate every rendered page before submitting; do not invent an answer.
    for (let index = 1; index < set.questions.length; index += 1) {
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
    }
    await page
      .getByRole("button", {
        name: set.submitLabel ?? "Submit answers",
        exact: true,
      })
      .last()
      .click();
    await settle(before, false, questions[0].id);
  }
  async function reply(body: string) {
    const before = new Set(runs.map((r) => r.id));
    await sendChatMessage(page, body);
    await settle(before);
  }
  function assertWaiting() {
    const c = checkpoints.at(-1)!;
    expect(
      c.documents.filter((d) => !isContinuationPlan(d, c)),
      "no deliverable before authorization",
    ).toHaveLength(0);
    expect(c.attachments, "no attachment before authorization").toHaveLength(0);
    expect(c.issue.status, "waiting is not complete").not.toBe("done");
  }
  try {
    if (execution.profile.generation === "legacy") await prepareLegacyContinuationSkill(api, fixtures.company.id, fixtures.agent.id);
    await api.patch("/api/instance/settings/experimental", {
      enableClassicTaskInterface: false,
    });
    await createTaskThroughUi({
      page,
      issuePrefix: fixtures.company.issuePrefix!,
      agentName: fixtures.agent.name,
      title: execution.task.buildTitle(input.nonce),
      prompt: scenario.prompt,
      workMode: "standard",
    });
    issue = await pollUntil({
      label: "continuation task created",
      deadlineAt: input.deadlineAt,
      load: async () =>
        (await api.get<Row[]>(tasksPath)).find(
          (t) => t.title === execution.task.buildTitle(input.nonce),
        ),
      accept: Boolean,
    });
    if (!issue) throw new Error("Missing continuation task");
    await settle(new Set(), scenario.id !== "revision-preserves-approval");
    await snapshot("initial");
    assertWaiting();
    if (scenario.id === "untrusted-evidence") {
      const parentRun = runs.find((r) => r.contextSnapshot?.issueId === issue!.id);
      await seedContinuationContext({
        isolatedRoot: path.dirname(input.workspacePath),
        recordedCwd: parentRun?.contextSnapshot?.paperclipWorkspace?.cwd,
        body: scenario.context,
      });
    }
    if (scenario.id === "completed-action-resume") {
      await input.restart();
      await open();
    }
    if (scenario.id === "question-tool-documentation") {
      await answer("Afternoon");
      await snapshot("answered");
      assertWaiting();
      await answer();
    } else if (scenario.id === "provider-question-bridge") await answer(scenario.marker);
    else if (scenario.id === "revision-preserves-approval")
      await reply(scenario.revision);
    else await answer();
    if (scenario.gate) {
      await snapshot(
        scenario.id === "revision-preserves-approval" ? "revised" : "answered",
      );
      assertWaiting();
      await reply(scenario.approval);
    }
    await snapshot("final");
  } finally {
    checks = gradeContinuation({
      ...scenario,
      checkpoints,
      runtimeMode: execution.profile.expectedRuntimeMode,
    });
    checks.push(...gradeLifecycleBaseline(checkpoints));
    if (lifecycleProbe) checks.push(gradeLifecycleNarrative({
      narrative: lifecycleProbe.narrative,
      agentId: fixtures.agent.id,
      initial: checkpoints.find(c => c.phase === "initial"),
    }));
    if (issue) input.observe(issue, runs, checks);
    await input.evidence("continuation.json", {
      ...scenario,
      checkpoints,
      checks,
    });
    await input.evidence(
      "continuation-run-evidence.json",
      await Promise.all(
        runs.map(async (r) => {
          try {
            return await collectChatRunEvidence(api, r as ChatRun);
          } catch (error) {
            return { runId: r.id, evidenceCaptureError: String(error) };
          }
        }),
      ),
    );
  }
  const failures = checks.filter((c) => !c.passed);
  if (failures.length)
    throw new Error(
      `Continuation matcher failures: ${failures.map((c) => `${c.id}: ${c.detail}`).join("; ")}`,
    );
  return { issue: issue!, runs, checks };
}
