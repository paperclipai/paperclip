import path from "node:path";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// Per-file Playwright configuration (test.use, test.setTimeout) must stay in
// the spec files themselves: calling test.use() from a shared helper makes
// Playwright fail the whole worker with "inconsistent test.use() options".
export async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return response.json();
}
const DEFAULT_AGENT_NAMES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"] as const;

export async function setup(
  request: APIRequestContext,
  options: { agentCount?: number } = {},
) {
  const company = await json(
    await request.post("/api/companies", {
      data: { name: `Agent Chat ${Date.now()}` },
    }),
  );
  const original = await json(
    await request.get("/api/instance/settings/experimental"),
  );
  const needsExperimentalPatch =
    original.enableAgentChat !== true ||
    original.enableClassicTaskInterface !== false;
  if (needsExperimentalPatch) {
    await json(
      await request.patch("/api/instance/settings/experimental", {
        data: { enableAgentChat: true, enableClassicTaskInterface: false },
      }),
    );
  }
  const agentNames = DEFAULT_AGENT_NAMES.slice(0, options.agentCount ?? 1);
  const createAgent = (name: string) =>
    request
      .post(`/api/companies/${company.id}/agents`, {
        data: {
          name,
          adapterType: "process",
          adapterConfig: {
            command: process.execPath,
            args: [path.resolve("tests/e2e/fixtures/agent-chat.mjs")],
            graceSec: 1,
          },
          runtimeConfig: {
            heartbeat: { enabled: false, wakeOnDemand: true },
          },
        },
      })
      .then(json);
  // Create the primary agent first so DB creation order and default primary-agent
  // selection stay deterministic (`agents[0]`), then parallelize any extra agents.
  const firstAgent = await createAgent(agentNames[0]!);
  const remainingAgents = await Promise.all(agentNames.slice(1).map(createAgent));
  const agents = [firstAgent, ...remainingAgents];
  const agent = agents[0];
  const chatPath = `/api/companies/${company.id}/chats/${agent.id}`;
  const route = `/${company.issuePrefix}/chats/${agent.id}`;
  return {
    company,
    agents,
    agent,
    chatPath,
    route,
    restore: async () => {
      try {
        const info = test.info();
        if (info.status !== info.expectedStatus) {
          const chat = await request.get(chatPath);
          const history = chat.ok() ? await chat.json() : null;
          const [tasks, projects, ledger] = await Promise.all([
            request.get(`/api/companies/${company.id}/issues`).then(json),
            request.get(`/api/companies/${company.id}/projects`).then(json),
            request.get(`/api/companies/${company.id}/heartbeat-runs`).then(json),
          ]);
          const documents = await Promise.all(
            [...(history ? [history] : []), ...tasks].map(async (task: any) => ({
              taskId: task.id,
              documents: await json(
                await request.get(`/api/issues/${task.id}/documents`),
              ),
            })),
          );
          await info.attach("chat-persisted-state", {
            contentType: "application/json",
            body: Buffer.from(
              JSON.stringify(
                {
                  chat: history,
                  tasks,
                  projects,
                  documents,
                  comments: history
                    ? await json(
                        await request.get(`/api/issues/${history.id}/comments`),
                      )
                    : [],
                  runs: ledger.map((run: any) => ({
                    id: run.id,
                    status: run.status,
                    startedAt: run.startedAt,
                    finishedAt: run.finishedAt,
                    sessionIdBefore: run.sessionIdBefore,
                    sessionIdAfter: run.sessionIdAfter,
                    issueId: run.contextSnapshot?.issueId,
                    generation:
                      run.contextSnapshot?.conversationSessionGeneration,
                    reset: run.contextSnapshot?.conversationReset,
                  })),
                },
                null,
                2,
              ),
            ),
          });
        }
      } finally {
        try {
          const runs = await json(
            await request.get(`/api/companies/${company.id}/live-runs`),
          );
          for (const run of runs)
            await json(
              await request.post(`/api/heartbeat-runs/${run.id}/cancel`),
            );
        } finally {
          if (needsExperimentalPatch) {
            await json(
              await request.patch("/api/instance/settings/experimental", {
                data: {
                  enableAgentChat: original.enableAgentChat,
                  enableClassicTaskInterface: original.enableClassicTaskInterface,
                },
              }),
            );
          }
        }
      }
    },
  };
}
export async function send(page: Page, value: unknown) {
  await page
    .getByTestId("task-chat-composer-input")
    .last()
    .locator('[contenteditable="true"],textarea')
    .first()
    .fill(
      typeof value === "string"
        ? value
        : `fixture:${Buffer.from(JSON.stringify(value)).toString("base64url")}`,
    );
  await page.getByTestId("task-chat-composer-send").last().click();
}
export async function idle(
  request: APIRequestContext,
  chatPath: string,
  minimumReplies = 1,
) {
  let issue: any;
  await expect
    .poll(
      async () => {
        issue = await json(await request.get(chatPath));
        if (!issue) return false;
        const replies = await json(
          await request.get(`/api/issues/${issue.id}/comments`),
        );
        const live = await json(
          await request.get(`/api/issues/${issue.id}/live-runs`),
        );
        return (
          live.length === 0 &&
          issue.conversationState === "waiting" &&
          issue.status === "in_review" &&
          replies.filter((c: any) => c.authorAgentId).length >= minimumReplies
        );
      },
      { timeout: 60_000, intervals: [100, 250, 500] },
    )
    .toBe(true);
  return issue;
}
