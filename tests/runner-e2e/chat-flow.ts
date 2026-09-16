import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import type {
  AskUserQuestionsPayload,
  PaperclipQuestionSetPayload,
} from "../../packages/shared/src/types/issue.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import { chatMarker } from "./chat-cases.js";

// Public API observations only: this driver never fabricates provider results or writes DB state.
export interface ChatIssue {
  id: string;
  companyId: string;
  title: string;
  status: string;
  identifier?: string;
  conversationState?: string;
  conversationSessionGeneration?: number;
  conversationBoundaryCommentId?: string;
  parentId?: string | null;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  scheduledRetry?: unknown;
  activeRecoveryAction?: unknown;
}
export interface ChatRun {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  error?: string | null;
  errorCode?: string | null;
  runtimeMode?: string;
  contextSnapshot?: Record<string, unknown>;
  resultJson?: Record<string, unknown>;
  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  startedAt?: string;
}
type Comment = {
  id: string;
  body: string;
  authorAgentId?: string;
  createdByRunId?: string;
  conversationSessionGeneration?: number;
};
type Plan = { body: string; latestRevisionId: string; updatedAt: string };
type ChatOutputDocument = Plan & { id: string; issueId: string; key: string };

/** Clarification may request information imperatively rather than end in a question mark. */
export function isChatClarificationReply(body: string): boolean {
  if (body.includes("?")) return true;
  const request = body.match(
    /\b(?:please\s+(?:share|provide|clarify|confirm)|tell me|let me know)\b([\s\S]*)/i,
  ) ?? body.match(
    /\b(?:I|we)(?:'ll|\s+will)?\s+need\s+(?:(?:a|some|the|your|more|following|compact|short|few|additional)\s+){0,4}(?:brief|details|information|context|clarification)\b([\s\S]*)/i,
  );
  return Boolean(request && /[\p{L}\p{N}]/u.test(request[1]));
}

export function assertChatExecutionOutput(
  body: string,
  marker: string,
  supersededMarker?: string,
): void {
  expect(body).toContain(marker);
  if (supersededMarker) expect(body).not.toContain(supersededMarker);
}

/** A requested output document may have a descriptive key; a copied plan is not output. */
export async function readChatOutputDocument(
  api: Pick<RunnerApi, "get">,
  issueId: string,
  marker: string,
): Promise<ChatOutputDocument> {
  const summaries = await api.get<Array<{ key: string }>>(
    `/api/issues/${issueId}/documents`,
  );
  const documents = await Promise.all(
    summaries
      .filter((document) => document.key !== "plan")
      .map((document) =>
        api.get<ChatOutputDocument>(
          `/api/issues/${issueId}/documents/${encodeURIComponent(document.key)}`,
        ),
      ),
  );
  const output = documents.find(
    (document) => document.issueId === issueId && document.body.includes(marker),
  );
  if (!output)
    throw new Error(
      `Execution task ${issueId} has no non-plan output document containing ${marker}; document keys: ${summaries.map((document) => document.key).join(", ") || "none"}`,
    );
  expect(output.id).toBeTruthy();
  expect(output.latestRevisionId).toBeTruthy();
  return output;
}

export const isResetRun = (run: ChatRun) =>
  run.contextSnapshot?.conversationReset === true ||
  run.resultJson?.conversationReset === true;
export function chatRunFailure(
  runs: ChatRun[],
  allowCancelled = false,
): string | undefined {
  const failed = runs.find(
    (run) =>
      ["failed", "timed_out"].includes(run.status) ||
      (!allowCancelled && run.status === "cancelled"),
  );
  return failed
    ? `run ${failed.id} ${failed.status}${failed.errorCode ? ` (${failed.errorCode})` : ""}${failed.error ? `: ${failed.error}` : ""}`
    : undefined;
}

export function chatTaskCompletionFailure(
  task: ChatIssue,
  runs: ChatRun[],
): string | undefined {
  if (
    task.scheduledRetry ||
    task.activeRecoveryAction ||
    runs.some((run) => ["queued", "running"].includes(run.status))
  )
    return undefined;
  return chatRunFailure(runs);
}

/** Require two settled observations so an in-flight finalization is not a failure. */
export function createChatIdleFailureDetector(minimumProviderRuns: number) {
  let priorInconsistentState: string | undefined;
  return (state: {
    resolved: boolean;
    status?: string;
    conversationState?: string;
    providerRunCount: number;
    activeRuns: string[];
  }): string | undefined => {
    const inconsistentState =
      state.resolved &&
      state.providerRunCount >= minimumProviderRuns &&
      state.activeRuns.length === 0 &&
      state.conversationState === "waiting" &&
      ["blocked", "done", "cancelled"].includes(state.status ?? "")
        ? `${state.status}:${state.providerRunCount}`
        : undefined;
    const stable =
      inconsistentState !== undefined &&
      inconsistentState === priorInconsistentState;
    priorInconsistentState = inconsistentState;
    return stable
      ? `chat_idle_state_invariant: conversation is ${state.status} while waiting after ${state.providerRunCount} settled provider runs`
      : undefined;
  };
}

/** Match the shared question form's durable/native presentation, including custom labels. */
export function chatQuestionPresentation(
  payload: AskUserQuestionsPayload,
): PaperclipQuestionSetPayload {
  if (payload.questionSet) return payload.questionSet;
  return {
    schema: "paperclip.question_set.v1",
    ...(payload.submitLabel ? { submitLabel: payload.submitLabel } : {}),
    questions: payload.questions.map((question) => {
      const freeText = question.options.find((option) => option.freeText);
      return {
        id: question.id,
        prompt: question.prompt,
        required: question.required === true,
        answerMode:
          question.selectionMode === "multi" ? "multi_select" : "single_select",
        ...(freeText
          ? { customAnswer: { enabled: true as const, label: freeText.label } }
          : {}),
      };
    }),
  };
}

export function assertChatTaskHandoff(
  task: ChatIssue,
  runs: ChatRun[],
  source: ChatIssue,
) {
  expect(task.parentId).toBeNull();
  expect(task.projectId).toBeTruthy();
  expect(task.assigneeAgentId).toBe(source.assigneeAgentId);
  expect(runs.length).toBeGreaterThan(0);
}

/** A running row can precede creation of its log file. Only that expected 404 is retryable. */
export async function readRunningChatLog(
  api: Pick<RunnerApi, "request">,
  runId: string,
): Promise<string | undefined> {
  const response = await api.request.get(
    `/api/heartbeat-runs/${runId}/log?limitBytes=65536`,
  );
  if (response.status() === 404) return undefined;
  if (!response.ok())
    throw new Error(`Run ${runId} log returned ${response.status()}`);
  return ((await response.json()) as { content?: string }).content;
}

/** Synthetic reset runs have durable events but never start a provider log. */
export async function collectChatRunEvidence(
  api: Pick<RunnerApi, "get">,
  run: ChatRun,
) {
  return {
    runId: run.id,
    log: isResetRun(run)
      ? null
      : await api.get(`/api/heartbeat-runs/${run.id}/log?limitBytes=1048576`),
    events: await api.get(`/api/heartbeat-runs/${run.id}/events?limit=1000`),
  };
}

export function assertChatHandoff(
  task: ChatIssue,
  plan: Plan,
  runs: ChatRun[],
  source: ChatIssue,
) {
  assertChatTaskHandoff(task, runs, source);
  expect(plan.body.trim()).not.toBe("");
  for (const run of runs) {
    expect(Date.parse(plan.updatedAt)).toBeLessThanOrEqual(
      Date.parse(run.startedAt!),
    );
  }
}
export async function sendChatMessage(page: Page, message: string) {
  const composer = page.getByTestId("task-chat-composer-input").last();
  await composer
    .locator('[contenteditable="true"], textarea')
    .first()
    .fill(message);
  await page.getByTestId("task-chat-composer-send").last().click();
}

export async function runChatFlow(input: {
  page: Page;
  api: RunnerApi;
  fixtures: LiveFixtureValues;
  execution: MatrixExecution;
  nonce: string;
  restart: () => Promise<void>;
  observe: (issue: ChatIssue, runs: ChatRun[]) => void;
  capture: (id: string, label: string, file: string) => Promise<void>;
  evidence: (name: string, data: unknown) => Promise<void>;
}) {
  const { page, api, fixtures: f, execution, nonce } = input;
  const chatPath = `/api/companies/${f.company.id}/chats/${f.agent.id}`;
  const route = `/${f.company.issuePrefix}/chats/${f.agent.id}`;
  const marker = execution.task.buildVisibleMarker(nonce);
  const draftMarker = chatMarker("DRAFT", nonce);
  const caseId = execution.task.id;
  let issue: ChatIssue;
  let runs: ChatRun[] = [];
  const settings = await api.get<Record<string, unknown>>(
    "/api/instance/settings/experimental",
  );
  const allRuns = async () => {
    const rows = await api.get<ChatRun[]>(
      `/api/companies/${f.company.id}/heartbeat-runs?limit=100`,
    );
    return Promise.all(
      rows.map((row) => api.get<ChatRun>(`/api/heartbeat-runs/${row.id}`)),
    );
  };
  const tasks = () =>
    api.get<ChatIssue[]>(`/api/companies/${f.company.id}/issues`);
  const comments = async () =>
    (
      await api.get<Array<Comment & { createdAt: string }>>(
        `/api/issues/${issue.id}/comments?order=asc`,
      )
    ).sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const idle = async (minimumProviderRuns: number) => {
    const inconsistentIdle = createChatIdleFailureDetector(minimumProviderRuns);
    await pollUntil({
      label: "chat turn settles to waiting",
      deadlineAt: Date.now() + 240_000,
      intervalMs: 1000,
      load: async () => {
        const resolved = await api.get<ChatIssue | null>(chatPath);
        if (resolved) issue = resolved;
        runs = await allRuns();
        if (resolved) input.observe(resolved, runs);
        return {
          resolved: Boolean(resolved),
          status: resolved?.status,
          conversationState: resolved?.conversationState,
          providerRunCount: runs.filter((run) => !isResetRun(run)).length,
          activeRuns: runs
            .filter((run) => ["queued", "running"].includes(run.status))
            .map((run) => run.id),
          failure: chatRunFailure(runs, caseId === "stop-new-resume"),
        };
      },
      reject: (state) => state.failure ?? inconsistentIdle(state),
      accept: (state) =>
        !state.failure &&
        state.resolved &&
        state.providerRunCount >= minimumProviderRuns &&
        state.activeRuns.length === 0 &&
        state.status === "in_review" &&
        state.conversationState === "waiting",
    });
  };
  const turn = async (text: string, count: number) => {
    await sendChatMessage(page, text);
    await idle(count);
  };
  const noTasks = async () => expect(await tasks()).toHaveLength(0);
  try {
    await api.patch("/api/instance/settings/experimental", {
      enableAgentChat: true,
      enableClassicTaskInterface: false,
    });
    expect(await api.get(chatPath)).toBeNull();
    // Cold Vite startup can keep unrelated assets loading after the chat is
    // interactive. The composer assertion below verifies actual UI readiness.
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    expect(await api.get(chatPath)).toBeNull();
    expect(await allRuns()).toHaveLength(0);

    if (
      ["continuity-restart", "new-session", "stop-new-resume"].includes(caseId)
    ) {
      const secret = chatMarker("OLDCONTEXT", nonce);
      await turn(
        `For this conversation only, remember the phrase ${secret}. Just acknowledge briefly; no project or task is needed.`,
        1,
      );
      const initialId = issue!.id;
      const before = runs.filter((run) => !isResetRun(run))[0]!;
      await noTasks();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      if (caseId === "continuity-restart") {
        await turn(
          "What phrase did I just ask you to remember? Reply with the phrase only.",
          2,
        );
        expect(
          (await comments()).filter((c) => c.authorAgentId).at(-1)?.body,
        ).toContain(secret);
        const count = runs.length;
        await input.restart();
        // Re-enter the canonical route after the server replaces its browser
        // transport; reloading the stale document can target a detached page.
        await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
        await idle(2);
        expect(runs).toHaveLength(count);
        await turn(
          `We are done discussing it. Reply with ${marker} only; no further work.`,
          3,
        );
      } else {
        let cancelledId: string | undefined;
        if (caseId === "stop-new-resume") {
          await sendChatMessage(
            page,
            "Explain the history of gardening at length here, in 100 numbered paragraphs. This is discussion only; do not create work.",
          );
          await expect
            .poll(
              async () => {
                runs = await allRuns();
                const active = runs.find(
                  (run) => run.status === "running" && run.id !== before.id,
                );
                if (!active) return false;
                const events = await api.get<Array<Record<string, unknown>>>(
                  `/api/heartbeat-runs/${active.id}/events?limit=1000`,
                );
                const log = await readRunningChatLog(api, active.id);
                if (!(events.length || log?.length)) return false;
                cancelledId = active.id;
                return true;
              },
              { timeout: 120_000 },
            )
            .toBe(true);
          await page.getByTestId("task-chat-composer-stop").click();
          await expect
            .poll(
              async () =>
                (await api.get<ChatRun>(`/api/heartbeat-runs/${cancelledId}`))
                  .status,
            )
            .toBe("cancelled");
        }
        const oldComments = await comments();
        await sendChatMessage(page, "/new");
        await expect
          .poll(
            async () =>
              (await api.get<ChatIssue>(chatPath))
                .conversationSessionGeneration,
            { timeout: 30_000 },
          )
          .toBe(1);
        await expect
          .poll(async () => (await allRuns()).some(isResetRun))
          .toBe(true);
        await turn(
          `Without reading older history or files, if you have a remembered phrase in your current context return it; otherwise reply exactly ${marker}. Do not look it up.`,
          caseId === "new-session" ? 2 : 3,
        );
        const fresh = runs
          .filter((run) => !isResetRun(run) && run.status === "succeeded")
          .sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))
          .at(-1)!;
        expect(fresh.contextSnapshot?.conversationSessionGeneration).toBe(1);
        expect(fresh.sessionIdBefore).toBeFalsy();
        expect(
          String(fresh.contextSnapshot?.paperclipTaskMarkdown ?? ""),
        ).not.toContain(secret);
        if (before.sessionIdAfter && fresh.sessionIdAfter)
          expect(fresh.sessionIdAfter).not.toBe(before.sessionIdAfter);
        const replies = (await comments()).filter(
          (c) => c.createdByRunId === fresh.id && c.authorAgentId,
        );
        expect(replies.map((c) => c.body).join("\n")).toContain(marker);
        expect(replies.map((c) => c.body).join("\n")).not.toContain(secret);
        const reset = runs.filter(isResetRun);
        expect(reset).toHaveLength(1);
        expect(
          (await comments()).filter(
            (c) => c.authorAgentId && c.createdByRunId === reset[0]!.id,
          ),
        ).toHaveLength(0);
        expect(
          (await comments()).filter((c) =>
            oldComments.some((old) => old.id === c.id),
          ),
        ).toHaveLength(oldComments.length);
        if (cancelledId)
          expect(
            (await comments()).filter((c) => c.createdByRunId === cancelledId),
          ).toEqual(
            oldComments.filter((c) => c.createdByRunId === cancelledId),
          );
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await expect(
          page.getByText("New session", { exact: true }),
        ).toHaveCount(1);
      }
      expect(issue!.id).toBe(initialId);
      await noTasks();
    } else {
      let existingProject: { id: string; name: string } | undefined;
      let acceptedPlan: Plan | undefined;
      let repositoryCatalogBefore:
        { repositories: Array<{ id: string; url: string }> } | undefined;
      const expectedRepositoryUrls = [
        "https://github.com/octocat/Hello-World",
        "https://github.com/octocat/Spoon-Knife",
      ];
      if (caseId === "clarify-reuse") {
        existingProject = await api.post(
          `/api/companies/${f.company.id}/projects`,
          {
            name: `Garden ${nonce}`,
            description: "Garden club welcome notes and event announcements.",
          },
        );
        await turn(
          "I need a welcome note for our club. Help me clarify what information you need before assigning the work.",
          1,
        );
        await noTasks();
        const questions = await api.get<
          Array<{
            status: string;
            kind: string;
            payload: AskUserQuestionsPayload;
          }>
        >(`/api/issues/${issue!.id}/interactions`);
        const pendingInteraction = questions.find(
          (row) =>
            row.status === "pending" && row.kind === "ask_user_questions",
        );
        const questionSet = pendingInteraction
          ? chatQuestionPresentation(pendingInteraction.payload)
          : undefined;
        const pendingQuestions = questionSet?.questions;
        expect(
          Boolean(pendingQuestions?.length) ||
            (await comments()).some(
              (c) => c.authorAgentId && isChatClarificationReply(c.body),
            ),
        ).toBe(true);
        const clarification = `It is the garden club; use the existing Garden ${nonce} project. Make one assigned task for yourself to write a two-sentence welcome note. Include ${marker} in that note, save it as a Paperclip document attached to that execution task, and finish that execution task. Please get it started now.`;
        if (pendingQuestions?.length) {
          for (const [index, question] of pendingQuestions.entries()) {
            const textInput = page
              .getByTestId("question-text-answer-composer")
              .last();
            if (await textInput.isVisible()) {
              await textInput
                .locator('[contenteditable="true"],textarea')
                .first()
                .fill(clarification);
            } else {
              await page
                .getByRole(
                  question.answerMode === "multi_select" ? "checkbox" : "radio",
                  {
                    name: question.customAnswer?.label ?? "Other",
                    exact: true,
                  },
                )
                .last()
                .click();
              await page
                .getByTestId("question-other-answer-composer")
                .last()
                .locator('[contenteditable="true"],textarea')
                .first()
                .fill(clarification);
            }
            await page
              .getByRole("button", {
                name:
                  index === pendingQuestions.length - 1
                    ? (questionSet?.submitLabel ?? "Submit answers")
                    : "Next",
                exact: true,
              })
              .last()
              .click();
          }
          await idle(3);
        } else await turn(clarification, 3);
      } else if (caseId === "plan-handoff") {
        await page.getByTestId("task-chat-composer-mode").click();
        await page
          .getByTestId("task-chat-composer-mode-menu")
          .getByText("Plan mode", { exact: true })
          .click();
        await turn(
          `Let's plan a two-sentence garden club welcome note. The finished welcome note itself must contain the exact phrase ${draftMarker}. Write a plan in the plan panel that includes this requirement, and present it for approval. When I approve the final revision, create a suitable repository-free project and an assigned task for yourself, copy the plan into that task, and have it save the note as a Paperclip document attached to that execution task and finish. Do not create the project or task before approval.`,
          1,
        );
        const draft = await api.get<Plan>(
          `/api/issues/${issue!.id}/documents/plan`,
        );
        expect(draft.body).toContain(draftMarker);
        await noTasks();
        await input.capture(
          "chat-plan-draft",
          "Draft plan in the conversation",
          "chat-plan-draft.png",
        );
        const initialInteractions = await api.get<
          Array<{
            status: string;
            kind: string;
            payload?: {
              target?: { revisionId?: string };
              rejectLabel?: string;
            };
          }>
        >(`/api/issues/${issue!.id}/interactions`);
        const initialApproval = initialInteractions.find(
          (row) =>
            row.status === "pending" &&
            row.kind === "request_confirmation" &&
            row.payload?.target?.revisionId === draft.latestRevisionId,
        );
        expect(
          initialApproval,
          "draft has a revision-bound approval",
        ).toBeTruthy();
        const reviseButton = page
          .getByRole("button", {
            name: initialApproval!.payload?.rejectLabel ?? "Reject",
            exact: true,
          })
          .last();
        await reviseButton.click();
        await page
          .getByTestId("plan-revision-composer")
          .last()
          .locator('[contenteditable="true"],textarea')
          .first()
          .fill(
            `Revise the plan: the finished welcome note itself must contain the exact phrase ${marker} instead of ${draftMarker}. Include that requirement in the revised plan. The execution task should save that welcome note as a Paperclip document attached to that task. Present this revised plan for approval; wait for that approval before handing it off as agreed.`,
          );
        await reviseButton.click();
        await idle(2);
        const revised = await api.get<Plan>(
          `/api/issues/${issue!.id}/documents/plan`,
        );
        expect(revised.body).toContain(marker);
        // A revision-history section may quote the superseded requirement.
        // The executed output below must use only the accepted requirement.
        expect(revised.latestRevisionId).not.toBe(draft.latestRevisionId);
        acceptedPlan = revised;
        await noTasks();
        const interactions = await api.get<
          Array<{
            id: string;
            status: string;
            kind: string;
            payload?: {
              target?: { revisionId?: string };
              acceptLabel?: string;
            };
          }>
        >(`/api/issues/${issue!.id}/interactions`);
        const approval = interactions.find(
          (row) =>
            row.status === "pending" &&
            row.kind === "request_confirmation" &&
            row.payload?.target?.revisionId === revised.latestRevisionId,
        );
        expect(approval, "approval targets the revised plan").toBeTruthy();
        await input.capture(
          "chat-plan-revised",
          "Revised plan before handoff",
          "chat-plan-revised.png",
        );
        await page
          .getByRole("button", {
            name: approval!.payload?.acceptLabel ?? "Approve",
            exact: true,
          })
          .last()
          .click();
        await idle(4);
        await input.evidence("chat-plan-revisions.json", {
          draft,
          revised,
          approval,
          source: await api.get(`/api/issues/${issue!.id}/documents/plan`),
        });
      } else {
        repositoryCatalogBefore = await api.get(
          `/api/companies/${f.company.id}/project-repositories`,
        );
        expect(
          repositoryCatalogBefore!.repositories.filter((repository) =>
            expectedRepositoryUrls.includes(repository.url),
          ),
        ).toHaveLength(0);
        await turn(
          `Create a project called Repository Discussion ${nonce} for work spanning https://github.com/octocat/Hello-World and https://github.com/octocat/Spoon-Knife. These existing public repositories are not in our catalog; register both URLs. Then make one assigned task for yourself to write a two-sentence description of the intended project as a Paperclip document attached to that execution task, containing ${marker}, and complete that task. No code changes or remote repository creation are needed.`,
          2,
        );
      }
      const children = await tasks();
      expect(children).toHaveLength(1);
      const child = children[0]!;
      await pollUntil({
        label: `execution task ${child.id} completes`,
        deadlineAt: Date.now() + 240_000,
        intervalMs: 1000,
        load: async () => ({
          task: await api.get<ChatIssue>(`/api/issues/${child.id}`),
          runs: await api.get<ChatRun[]>(`/api/issues/${child.id}/runs`),
        }),
        accept: (state) => state.task.status === "done",
        reject: (state) => chatTaskCompletionFailure(state.task, state.runs),
      });
      runs = await allRuns();
      input.observe(issue!, runs);
      const plan =
        caseId === "plan-handoff"
          ? await api.get<Plan>(`/api/issues/${child.id}/documents/plan`)
          : null;
      const taskRuns = runs.filter(
        (run) => run.contextSnapshot?.issueId === child.id,
      );
      if (plan) {
        assertChatHandoff(child, plan, taskRuns, issue!);
        expect(plan.body).toContain(marker);
        const sourcePlan = await api.get<Plan>(
          `/api/issues/${issue!.id}/documents/plan`,
        );
        expect(sourcePlan.body).toBe(acceptedPlan!.body);
        expect(sourcePlan.latestRevisionId).toBe(
          acceptedPlan!.latestRevisionId,
        );
      } else assertChatTaskHandoff(child, taskRuns, issue!);
      const output = await readChatOutputDocument(api, child.id, marker);
      assertChatExecutionOutput(
        output.body,
        marker,
        caseId === "plan-handoff" ? draftMarker : undefined,
      );
      await input.evidence("chat-execution-output.json", {
        taskId: child.id,
        document: output,
        revisions: await api.get(
          `/api/issues/${child.id}/documents/${encodeURIComponent(output.key)}/revisions`,
        ),
        executionRunIds: taskRuns.map((run) => run.id),
      });
      expect(
        (await comments())
          .filter((c) => c.authorAgentId)
          .map((c) => c.body)
          .join("\n"),
      ).toMatch(new RegExp(`${child.id}|${child.identifier}`));
      const projects = await api.get<
        Array<{
          id: string;
          name: string;
          workspaces: Array<{ id: string; name: string; repoUrl?: string }>;
        }>
      >(`/api/companies/${f.company.id}/projects`);
      expect(projects).toHaveLength(1);
      if (existingProject) {
        expect(child.projectId).toBe(existingProject.id);
        await expect(
          page.getByRole("article", { name: /Project created:/ }),
        ).toHaveCount(0);
      } else {
        await expect(
          page.getByRole("article", { name: /Project created:/ }),
        ).toHaveCount(1);
        if (caseId === "multi-repository") {
          expect(projects[0]!.workspaces.map((w) => w.repoUrl).sort()).toEqual(
            [...expectedRepositoryUrls].sort(),
          );
          // URL registration is persisted as project workspaces; the discovery
          // catalog continues to reflect authorized GitHub connections only.
          expect(
            projects[0]!.workspaces.every((workspace) => Boolean(workspace.id)),
          ).toBe(true);
          expect(
            new Set(projects[0]!.workspaces.map((workspace) => workspace.id))
              .size,
          ).toBe(2);
          const persistedProject = await api.get<{
            workspaces: Array<{ id: string; repoUrl?: string }>;
          }>(`/api/projects/${projects[0]!.id}`);
          expect(
            persistedProject.workspaces.map(({ id, repoUrl }) => ({
              id,
              repoUrl,
            })),
          ).toEqual(
            projects[0]!.workspaces.map(({ id, repoUrl }) => ({ id, repoUrl })),
          );
          await input.evidence("chat-repository-registration.json", {
            catalogBefore: repositoryCatalogBefore,
            projectId: projects[0]!.id,
            registeredWorkspaces: persistedProject.workspaces,
          });
          const projectCard = page.getByRole("article", {
            name: /Project created:/,
          });
          // Repository labels may be customized; verify the actual destinations.
          for (const repositoryUrl of expectedRepositoryUrls) {
            await expect(
              projectCard.locator(`a[href="${repositoryUrl}"]`),
            ).toBeVisible();
          }
        } else
          expect(projects[0]!.workspaces.filter((w) => w.repoUrl)).toHaveLength(
            0,
          );
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await expect(
          page.getByRole("article", { name: /Project created:/ }),
        ).toHaveCount(1);
      }
      await input.evidence("chat-handoff.json", {
        source: issue!,
        task: child,
        plan,
        output,
        projects,
      });
    }
    await idle(execution.task.expectedRunCount);
    expect(runs.filter((run) => !isResetRun(run))).toHaveLength(
      execution.task.expectedRunCount,
    );
    for (const run of runs.filter((run) => !isResetRun(run))) {
      expect(run.runtimeMode).toBe(execution.profile.expectedRuntimeMode);
      expect(run.status).toBe(
        caseId === "stop-new-resume" && run.status === "cancelled"
          ? "cancelled"
          : "succeeded",
      );
    }
    await input.evidence("api-state.json", {
      issue: issue!,
      runs,
      runGroups: {
        resets: runs.filter(isResetRun).map((run) => run.id),
        cancelled: runs
          .filter((run) => run.status === "cancelled")
          .map((run) => run.id),
        conversation: runs
          .filter(
            (run) =>
              !isResetRun(run) && run.contextSnapshot?.issueId === issue!.id,
          )
          .map((run) => run.id),
        handoff: runs
          .filter((run) => run.contextSnapshot?.issueId !== issue!.id)
          .map((run) => run.id),
      },
      comments: await comments(),
      activity: await api.get(`/api/issues/${issue!.id}/activity`),
      runEvidence: await Promise.all(
        runs.map((run) => collectChatRunEvidence(api, run)),
      ),
    });
    await input.capture(
      "final-state",
      "Chat waiting after its verified workflow",
      "final-state.png",
    );
    return { issue: issue!, runs };
  } finally {
    await api.patch("/api/instance/settings/experimental", {
      enableAgentChat: settings.enableAgentChat,
      enableClassicTaskInterface: settings.enableClassicTaskInterface,
    });
  }
}
