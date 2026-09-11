import { expect, type Page } from "@playwright/test";
import type { RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

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
}
export interface ChatRun {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
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
export const isResetRun = (run: ChatRun) =>
  run.contextSnapshot?.conversationReset === true ||
  run.resultJson?.conversationReset === true;
export function assertChatHandoff(
  task: ChatIssue,
  plan: Plan,
  runs: ChatRun[],
  source: ChatIssue,
) {
  expect(task.parentId).toBeNull();
  expect(task.projectId).toBeTruthy();
  expect(task.assigneeAgentId).toBe(source.assigneeAgentId);
  expect(plan.body.trim()).not.toBe("");
  expect(runs.length).toBeGreaterThan(0);
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
    await expect
      .poll(
        async () => {
          const resolved = await api.get<ChatIssue | null>(chatPath);
          if (!resolved) return false;
          issue = resolved;
          runs = await allRuns();
          input.observe(issue, runs);
          return (
            runs.filter((run) => !isResetRun(run)).length >=
              minimumProviderRuns &&
            runs.every((run) => !["queued", "running"].includes(run.status)) &&
            issue.status === "in_review" &&
            issue.conversationState === "waiting"
          );
        },
        {
          timeout: 240_000,
          intervals: [500, 1000, 2000],
          message: "chat turn settles to waiting",
        },
      )
      .toBe(true);
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
    await page.goto(route);
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    expect(await api.get(chatPath)).toBeNull();
    expect(await allRuns()).toHaveLength(0);

    if (
      ["continuity-restart", "new-session", "stop-new-resume"].includes(caseId)
    ) {
      const secret = `OLD_CONTEXT_${nonce}`;
      await turn(
        `For this conversation only, remember the phrase ${secret}. Just acknowledge briefly; no project or task is needed.`,
        1,
      );
      const initialId = issue!.id;
      const before = runs.filter((run) => !isResetRun(run))[0]!;
      await noTasks();
      await page.reload();
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
        await page.reload();
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
                const log = await api.get<{ content?: string }>(
                  `/api/heartbeat-runs/${active.id}/log?limitBytes=65536`,
                );
                if (!(events.length || log.content?.length)) return false;
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
        await page.reload();
        await expect(
          page.getByText("New session", { exact: true }),
        ).toHaveCount(1);
      }
      expect(issue!.id).toBe(initialId);
      await noTasks();
    } else {
      let existingProject: { id: string; name: string } | undefined;
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
            payload?: {
              questions?: Array<{
                selectionMode?: string;
                answerMode?: string;
                customAnswer?: { label?: string };
              }>;
            };
          }>
        >(`/api/issues/${issue!.id}/interactions`);
        const pendingQuestions = questions.find(
          (row) =>
            row.status === "pending" && row.kind === "ask_user_questions",
        )?.payload?.questions;
        expect(
          Boolean(pendingQuestions?.length) ||
            (await comments()).some(
              (c) => c.authorAgentId && c.body.includes("?"),
            ),
        ).toBe(true);
        const clarification = `It is the garden club; use the existing Garden ${nonce} project. Make one assigned task for yourself to write a two-sentence welcome note. Include ${marker} in that note, save it as the output document, and finish that execution task. Please get it started now.`;
        if (pendingQuestions?.length) {
          expect(pendingQuestions.length).toBeLessThanOrEqual(3);
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
                  question.selectionMode === "multiple" ? "checkbox" : "radio",
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
                    ? "Submit answers"
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
          `Let's plan a two-sentence garden club welcome note. Write a plan in the plan panel, with the required phrase DRAFT_${nonce}. Do not create a project or task yet.`,
          1,
        );
        const draft = await api.get<Plan>(
          `/api/issues/${issue!.id}/documents/plan`,
        );
        expect(draft.body).toContain(`DRAFT_${nonce}`);
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
            `Revise the plan: replace DRAFT_${nonce} with ${marker}. The execution task should save the welcome note in its output document. Present this revised plan for approval; do not hand it off yet.`,
          );
        await reviseButton.click();
        await idle(2);
        const revised = await api.get<Plan>(
          `/api/issues/${issue!.id}/documents/plan`,
        );
        expect(revised.body).toContain(marker);
        expect(revised.body).not.toContain(`DRAFT_${nonce}`);
        expect(revised.latestRevisionId).not.toBe(draft.latestRevisionId);
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
        await turn(
          `Create a project called Repository Discussion ${nonce} for work spanning https://github.com/octocat/Hello-World and https://github.com/octocat/Spoon-Knife. These existing public repositories are not in our catalog; register both URLs. Then make one assigned task for yourself to write a two-sentence description of the intended project in an output document, containing ${marker}, and complete that task. No code changes or remote repository creation are needed.`,
          2,
        );
      }
      const children = await tasks();
      expect(children).toHaveLength(1);
      const child = children[0]!;
      await expect
        .poll(
          async () =>
            (await api.get<ChatIssue>(`/api/issues/${child.id}`)).status,
          { timeout: 240_000 },
        )
        .toBe("done");
      runs = await allRuns();
      input.observe(issue!, runs);
      const plan = await api.get<Plan>(
        `/api/issues/${child.id}/documents/plan`,
      );
      const taskRuns = runs.filter(
        (run) => run.contextSnapshot?.issueId === child.id,
      );
      assertChatHandoff(child, plan, taskRuns, issue!);
      const output = await api.get<Plan>(
        `/api/issues/${child.id}/documents/output`,
      );
      expect(output.body).toContain(marker);
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
          workspaces: Array<{ repoUrl?: string }>;
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
            [
              "https://github.com/octocat/Hello-World",
              "https://github.com/octocat/Spoon-Knife",
            ].sort(),
          );
          await expect(
            page
              .getByRole("article")
              .getByRole("link", { name: "octocat/Hello-World" }),
          ).toBeVisible();
          await expect(
            page
              .getByRole("article")
              .getByRole("link", { name: "octocat/Spoon-Knife" }),
          ).toBeVisible();
        } else
          expect(projects[0]!.workspaces.filter((w) => w.repoUrl)).toHaveLength(
            0,
          );
        await page.reload();
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
        runs.map(async (run) => ({
          runId: run.id,
          log: await api.get(
            `/api/heartbeat-runs/${run.id}/log?limitBytes=1048576`,
          ),
          events: await api.get(
            `/api/heartbeat-runs/${run.id}/events?limit=1000`,
          ),
        })),
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
