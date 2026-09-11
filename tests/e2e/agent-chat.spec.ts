import path from "node:path";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);
async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return response.json();
}
async function setup(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", {
      data: { name: `Agent Chat ${Date.now()}` },
    }),
  );
  const original = await json(
    await request.get("/api/instance/settings/experimental"),
  );
  await json(
    await request.patch("/api/instance/settings/experimental", {
      data: { enableAgentChat: true, enableClassicTaskInterface: false },
    }),
  );
  const agents = [];
  for (const name of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"])
    agents.push(
      await json(
        await request.post(`/api/companies/${company.id}/agents`, {
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
        }),
      ),
    );
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
        const chat = await request.get(chatPath);
        const history = chat.ok() ? await chat.json() : null;
        const tasks = await json(
          await request.get(`/api/companies/${company.id}/issues`),
        );
        const projects = await json(
          await request.get(`/api/companies/${company.id}/projects`),
        );
        const ledger = await json(
          await request.get(`/api/companies/${company.id}/heartbeat-runs`),
        );
        const documents = await Promise.all(
          [...(history ? [history] : []), ...tasks].map(async (task: any) => ({
            taskId: task.id,
            documents: await json(
              await request.get(`/api/issues/${task.id}/documents`),
            ),
          })),
        );
        await test.info().attach("chat-persisted-state", {
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
      } finally {
        const runs = await json(
          await request.get(`/api/companies/${company.id}/live-runs`),
        );
        for (const run of runs)
          await json(
            await request.post(`/api/heartbeat-runs/${run.id}/cancel`),
          );
        await json(
          await request.patch("/api/instance/settings/experimental", {
            data: {
              enableAgentChat: original.enableAgentChat,
              enableClassicTaskInterface: original.enableClassicTaskInterface,
            },
          }),
        );
      }
    },
  };
}
async function send(page: Page, value: unknown) {
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
async function idle(
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

test("chat first open is read-only; concurrent first sends and retries share one task", async ({
  page,
  context,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    expect(await json(await request.get(f.chatPath))).toBeNull();
    expect(
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      ),
    ).toHaveLength(0);
    const other = await context.newPage();
    await other.goto(f.route);
    await Promise.all([send(page, "Same first message"), send(other, "Same first message")]);
    const issue = await idle(request, f.chatPath, 2);
    const initialComments = await json(await request.get(`/api/issues/${issue.id}/comments`));
    expect(initialComments.filter((comment: any) => !comment.authorAgentId && comment.body === "Same first message")).toHaveLength(2);
    const resolved = await Promise.all(
      Array.from({ length: 4 }, () =>
        request.post(f.chatPath, { data: {} }).then(json),
      ),
    );
    expect(new Set(resolved.map((row) => row.id))).toEqual(new Set([issue.id]));
    const body = {
      body: "Retry once",
      clientRequestId: "00000000-0000-4000-8000-000000000001",
    };
    const replies = await Promise.all([
      request
        .post(`/api/issues/${issue.id}/comments`, { data: body })
        .then(json),
      request
        .post(`/api/issues/${issue.id}/comments`, { data: body })
        .then(json),
    ]);
    expect(replies[0].id).toBe(replies[1].id);
    await idle(request, f.chatPath, 3);
    await page.reload();
    await expect(
      page.getByText("Reply generation 0: Retry once", { exact: true }),
    ).toBeVisible();
    expect(
      await json(await request.get(`/api/companies/${f.company.id}/issues`)),
    ).toHaveLength(0);
    const dashboard = await json(
      await request.get(`/api/companies/${f.company.id}/dashboard`),
    );
    expect(dashboard.tasks).toEqual({
      open: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
    });
    const count = (
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      )
    ).length;
    await page.goto(`/${f.company.issuePrefix}/issues/${issue.identifier}`);
    await page.goto(f.route);
    expect(
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      ),
    ).toHaveLength(count);
    await other.close();
  } finally {
    await f.restore();
  }
});

test("feature flag blocks new sends and resets while preserving existing history", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await send(page, "Visible history");
    const issue = await idle(request, f.chatPath);
    await json(
      await request.patch("/api/instance/settings/experimental", {
        data: { enableAgentChat: false },
      }),
    );
    for (const body of ["blocked message", "/new"])
      expect(
        (
          await request.post(`/api/issues/${issue.id}/comments`, {
            data: { body },
          })
        ).status(),
      ).toBe(404);
    await page.reload();
    await expect(page.getByText(/Agent Chat is disabled/)).toBeVisible();
    expect(
      (await json(await request.get(`/api/issues/${issue.id}/comments`))).some(
        (c: any) => c.body.includes("Visible history"),
      ),
    ).toBe(true);
    expect((await request.post(f.chatPath, { data: {} })).status()).toBe(404);
  } finally {
    await f.restore();
  }
});

test("Stop then queued /new resets unpause the conversation without losing history", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await send(page, { action: "hold" });
    await expect
      .poll(async () => {
        const chat = await json(await request.get(f.chatPath));
        return (
          chat &&
          (
            await json(await request.get(`/api/issues/${chat.id}/comments`))
          ).some(
            (c: any) => c.body === "Provider is streaming and ready to stop.",
          )
        );
      })
      .toBe(true);
    const issue = await json(await request.get(f.chatPath));
    const active = (
      await json(await request.get(`/api/issues/${issue.id}/live-runs`))
    )[0];
    await page.getByTestId("task-chat-composer-stop").click();
    await expect
      .poll(
        async () =>
          (await json(await request.get(`/api/heartbeat-runs/${active.id}`)))
            .status,
      )
      .toBe("cancelled");
    const staleToken = createLocalAgentJwt(
      f.agent.id,
      f.company.id,
      "process",
      active.id,
    );
    expect(staleToken).toBeTruthy();
    const late = await request.post(`/api/issues/${issue.id}/comments`, {
      headers: { Authorization: `Bearer ${staleToken}` },
      data: { body: "Forbidden late response" },
    });
    expect([403, 409]).toContain(late.status());
    const mutation = await request.post(
      `/api/companies/${f.company.id}/projects`,
      {
        headers: { Authorization: `Bearer ${staleToken}` },
        data: { name: "Cancelled project" },
      },
    );
    expect([403, 409]).toContain(mutation.status());
    expect(
      await json(await request.get(`/api/companies/${f.company.id}/projects`)),
    ).toHaveLength(0);
    await send(page, "/new");
    await send(page, "/new");
    await send(page, "Fresh followup");
    await idle(request, f.chatPath, 2);
    const fresh = await json(await request.get(f.chatPath));
    expect(fresh.id).toBe(issue.id);
    expect(fresh.conversationSessionGeneration).toBe(2);
    await expect(
      page.getByText("Reply generation 2: Fresh followup", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText("New session", { exact: true })).toHaveCount(2);
    await expect(
      page.getByRole("separator", { name: "Run completed", exact: true }),
    ).toHaveCount(0);
    const runs = await json(
      await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
    );
    const detailed = await Promise.all(
      runs.map((run: any) =>
        request.get(`/api/heartbeat-runs/${run.id}`).then(json),
      ),
    );
    expect(
      detailed.filter((run) => run.contextSnapshot?.conversationReset),
    ).toHaveLength(2);
    expect(
      detailed
        .filter((run) => run.contextSnapshot?.conversationReset)
        .every((run) => !run.sessionIdAfter),
    ).toBe(true);
  } finally {
    await f.restore();
  }
});

for (const direct of [false, true])
  test(`project card through ${direct ? "direct API" : "dedicated tool"} persists and deduplicates retries`, async ({
    page,
    request,
  }) => {
    const f = await setup(request);
    try {
      await page.goto(f.route);
      await send(page, {
        action: "project",
        name: "Browser repositories",
        direct,
        urls: [
          "https://github.com/octocat/Hello-World.git",
          "https://github.com/octocat/Spoon-Knife",
          "https://github.com/octocat/Hello-World",
        ],
      });
      await idle(request, f.chatPath);
      const card = page.getByRole("article", {
        name: "Project created: Browser repositories",
      });
      await expect(card).toHaveCount(1);
      await expect(
        card.getByRole("link", { name: "octocat/Hello-World" }),
      ).toHaveAttribute("href", "https://github.com/octocat/Hello-World");
      await expect(
        card.getByRole("link", { name: "octocat/Spoon-Knife" }),
      ).toBeVisible();
      const projects = await json(
        await request.get(`/api/companies/${f.company.id}/projects`),
      );
      expect(projects).toHaveLength(1);
      expect(projects[0].workspaces).toHaveLength(2);
      if (direct) {
        await json(await request.post(`/api/projects/${projects[0].id}/workspaces`, {
          data: { name: "Additional repository", repoUrl: "https://github.com/octocat/git-consortium" },
        }));
        await expect(card.getByRole("link", { name: "Additional repository" }))
          .toHaveAttribute("href", "https://github.com/octocat/git-consortium");
        await expect(card).toHaveCount(1);
      }
      await send(page, "/new");
      await expect
        .poll(
          async () =>
            (await json(await request.get(f.chatPath)))
              .conversationSessionGeneration,
        )
        .toBe(1);
      await page.reload();
      await expect(card).toHaveCount(1);
      if (direct) await expect(card.getByRole("link", { name: "Additional repository" })).toBeVisible();
      await card
        .getByRole("link", { name: "Browser repositories", exact: true })
        .click();
      await expect(page).toHaveURL(/\/projects\/.*\/issues/);
      await page
        .getByRole("tab", { name: "Configuration", exact: true })
        .click();
      await expect(
        page.getByRole("region", { name: "Repositories" }),
      ).toContainText("octocat/Hello-World");
    } finally {
      await f.restore();
    }
  });

test("split handoff commits relevant plans before execution and never creates chat children", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await send(page, {
      action: "handoff",
      name: "Welcome project",
      split: true,
      plan: "# Welcome plan\nWrite a friendly welcome.",
    });
    const chat = await idle(request, f.chatPath);
    await expect
      .poll(
        async () => {
          const tasks = await json(
            await request.get(`/api/companies/${f.company.id}/issues`),
          );
          return (
            tasks.length === 2 &&
            tasks.every((task: any) => task.status === "done")
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const tasks = await json(
      await request.get(`/api/companies/${f.company.id}/issues`),
    );
    for (const task of tasks) {
      expect(task.parentId).toBeNull();
      expect(task.projectId).toBeTruthy();
      expect(task.assigneeAgentId).toBe(f.agent.id);
      const plan = await json(
        await request.get(`/api/issues/${task.id}/documents/plan`),
      );
      const output = await json(
        await request.get(`/api/issues/${task.id}/documents/output`),
      );
      expect(output.body).toContain(plan.body);
      const runs = await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      );
      const run = runs.find(
        (run: any) => run.contextSnapshot?.issueId === task.id,
      );
      expect(run).toBeTruthy();
      expect(Date.parse(plan.updatedAt)).toBeLessThanOrEqual(
        Date.parse(run.startedAt),
      );
    }
    expect(
      (await json(await request.get(`/api/issues/${chat.id}/documents/plan`)))
        .body,
    ).toContain("Welcome plan");
    expect(
      (
        await request.post(`/api/companies/${f.company.id}/issues`, {
          data: { title: "Invalid child", parentId: chat.id },
        })
      ).status(),
    ).toBe(422);
    expect(
      (
        await request.patch(`/api/issues/${tasks[0].id}`, {
          data: { parentId: chat.id },
        })
      ).status(),
    ).toBe(422);
  } finally {
    await f.restore();
  }
});

for (const bad of [
  { ids: ["987654321"] },
  { urls: ["https://user:password@github.com/org/repo"] },
  {
    urls: ["https://github.com/org/repo"],
    workspace: { name: "Conflicting", repoUrl: "https://github.com/org/repo" },
  },
])
  test(`failed project creation has no success card or partial state: ${JSON.stringify(bad)}`, async ({
    page,
    request,
  }) => {
    const f = await setup(request);
    try {
      await page.goto(f.route);
      await send(page, { action: "project", ...bad });
      await idle(request, f.chatPath);
      await expect(page.getByText(/Expected tool result:/)).toBeVisible();
      await expect(
        page.getByRole("article", { name: /Project created:/ }),
      ).toHaveCount(0);
      expect(
        await json(
          await request.get(`/api/companies/${f.company.id}/projects`),
        ),
      ).toHaveLength(0);
      expect(
        await json(await request.get(`/api/companies/${f.company.id}/issues`)),
      ).toHaveLength(0);
    } finally {
      await f.restore();
    }
  });

test("sidebar stars, recent agents, configuration links, and drafts survive switching", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    for (const agent of f.agents) {
      await page.goto(`/${f.company.issuePrefix}/chats/${agent.id}`);
      await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    }
    const nav = page.getByRole("navigation");
    await expect(nav.locator('a[href*="/chats/"]')).toHaveCount(4);
    await expect(nav.locator('a[href*="/chats/"]').first()).toHaveText("Zeta");
    const star = page.getByRole("button", { name: "Star Zeta", exact: true });
    await page.getByTestId("task-chat-composer-input").click();
    await expect(star).toHaveCSS("opacity", "0");
    await star.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(star).toHaveCSS("opacity", "1");
    await star.click();
    await page.goto(f.route);
    await page.getByRole("button", { name: "Star Alpha", exact: true }).click();
    await expect(nav.locator('a[href*="/chats/"]').first()).toHaveText("Alpha");
    await expect(nav.locator('a[href*="/chats/"]').nth(1)).toHaveText("Zeta");
    const editor = page
      .getByTestId("task-chat-composer-input")
      .locator('[contenteditable="true"]');
    await editor.fill("Unsent draft for Alpha");
    await nav.getByRole("link", { name: "Zeta", exact: true }).click();
    await expect(editor).toHaveText("");
    await nav.getByRole("link", { name: "Alpha", exact: true }).click();
    await expect(editor).toContainText("Unsent draft for Alpha");
    const recent = await page.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([key]) =>
          key.startsWith("paperclip.recentAgentChats:"),
        ),
      ),
    );
    await page.getByRole("link", { name: /Configure Alpha/ }).click();
    await expect(page).toHaveURL(/\/agents\/.*\/runtime/);
    const backgroundPath = `/api/companies/${f.company.id}/chats/${f.agents[1].id}`;
    const background = await json(
      await request.post(backgroundPath, { data: {} }),
    );
    await json(
      await request.post(`/api/issues/${background.id}/comments`, {
        data: {
          body: "Background activity",
          clientRequestId: "00000000-0000-4000-8000-000000000099",
        },
      }),
    );
    await idle(request, backgroundPath);
    expect(
      await page.evaluate(() =>
        Object.fromEntries(
          Object.entries(localStorage).filter(([key]) =>
            key.startsWith("paperclip.recentAgentChats:"),
          ),
        ),
      ),
    ).toEqual(recent);
    await page
      .getByRole("link", { name: "See all agents", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/${f.company.issuePrefix}/agents/all$`),
    );
  } finally {
    await f.restore();
  }
});

test("first upload creates the chat without invoking its agent; shared attachments persist", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await page
      .locator('input[type="file"]')
      .last()
      .setInputFiles({
        name: "chat-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Attachment acceptance content"),
      });
    await expect(
      page.getByTestId("task-chat-composer-attachments"),
    ).toContainText("chat-notes.txt");
    await expect
      .poll(async () => Boolean(await json(await request.get(f.chatPath))))
      .toBe(true);
    const chat = await json(await request.get(f.chatPath));
    expect(chat.id).toBeTruthy();
    expect(
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      ),
    ).toHaveLength(0);
    await expect
      .poll(
        async () =>
          (await json(await request.get(`/api/issues/${chat.id}/attachments`)))
            .length,
      )
      .toBe(1);
    await send(page, "Read these notes later; just acknowledge.");
    await idle(request, f.chatPath);
    await page.reload();
    await expect(
      page.getByRole("tab", { name: "Properties", exact: true }),
    ).toHaveCount(0);
    expect(
      await json(await request.get(`/api/issues/${chat.id}/attachments`)),
    ).toHaveLength(1);
  } finally {
    await f.restore();
  }
});

for (const mode of ["Ask", "Plan"])
  test(`${mode} denies project mutations; Plan can draft and revise without execution`, async ({
    page,
    request,
  }) => {
    const f = await setup(request);
    try {
      await page.goto(f.route);
      await page.getByTestId("task-chat-composer-mode").click();
      await page
        .getByTestId("task-chat-composer-mode-menu")
        .getByText(`${mode} mode`, { exact: true })
        .click();
      await send(page, { action: "project", name: "Forbidden mutation" });
      await idle(request, f.chatPath);
      expect(
        await json(
          await request.get(`/api/companies/${f.company.id}/projects`),
        ),
      ).toHaveLength(0);
      await expect(
        page.getByRole("article", { name: /Project created:/ }),
      ).toHaveCount(0);
      if (mode === "Plan") {
        await send(page, {
          action: "plan",
          text: "# Draft plan\nDiscuss the goal.",
        });
        const chat = await idle(request, f.chatPath, 2);
        const first = await json(
          await request.get(`/api/issues/${chat.id}/documents/plan`),
        );
        await send(page, {
          action: "plan",
          text: "# Revised plan\nDiscuss the revised goal.",
        });
        await idle(request, f.chatPath, 3);
        const revised = await json(
          await request.get(`/api/issues/${chat.id}/documents/plan`),
        );
        expect(revised.latestRevisionId).not.toBe(first.latestRevisionId);
        expect(revised.body).toContain("Revised plan");
        await expect(
          page.getByRole("tab", { name: "Plan", exact: true }),
        ).toBeVisible();
      }
      expect(
        await json(await request.get(`/api/companies/${f.company.id}/issues`)),
      ).toHaveLength(0);
    } finally {
      await f.restore();
    }
  });

for (const selection of [
  { ids: ["101"] },
  { ids: ["101", "102"] },
  {
    ids: ["101"],
    urls: [
      "https://github.com/chat-fixture/frontend",
      "https://github.com/octocat/Hello-World",
    ],
  },
])
  test(`authorized repository discovery and selection: ${JSON.stringify(selection)}`, async ({
    page,
    request,
  }) => {
    const f = await setup(request);
    try {
      const secret = await json(
        await request.post(`/api/companies/${f.company.id}/secrets`, {
          data: {
            name: "Deterministic GitHub credential",
            value: "paperclip-e2e-repository-fixture",
          },
        }),
      );
      await json(
        await request.post(`/api/companies/${f.company.id}/tools/connections`, {
          data: {
            name: "Fixture GitHub",
            applicationName: "Fixture GitHub",
            transport: "rest_api",
            authKind: "api_key",
            credentialPolicy: "shared",
            status: "active",
            enabled: true,
            config: {
              sourceTemplateKey: "github",
              baseUrl: "https://api.github.com",
            },
            credentialSecretRefs: [
              {
                configPath: "headers.Authorization",
                secretId: secret.id,
                versionSelector: "latest",
              },
            ],
          },
        }),
      );
      const repos = await json(
        await request.get(
          `/api/companies/${f.company.id}/project-repositories`,
        ),
      );
      expect(repos.repositories.map((repo: any) => repo.id).sort()).toEqual([
        "101",
        "102",
      ]);
      await page.goto(f.route);
      await send(page, {
        action: "project",
        name: "Selected repositories",
        ...selection,
      });
      await idle(request, f.chatPath);
      const project = (
        await json(await request.get(`/api/companies/${f.company.id}/projects`))
      )[0];
      expect(project).toBeTruthy();
      expect(
        project.workspaces
          .map((w: any) => w.metadata?.githubRepositoryId)
          .filter(Boolean)
          .sort(),
      ).toEqual(selection.ids);
      expect(new Set(project.workspaces.map((w: any) => w.repoUrl)).size).toBe(
        project.workspaces.length,
      );
      await expect(
        page.getByRole("article", {
          name: "Project created: Selected repositories",
        }),
      ).toHaveCount(1);
    } finally {
      await f.restore();
    }
  });

test("plan approval hands the preserved revision to an assigned project task", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await page.getByTestId("task-chat-composer-mode").click();
    await page
      .getByTestId("task-chat-composer-mode-menu")
      .getByText("Plan mode", { exact: true })
      .click();
    await send(page, {
      action: "plan",
      text: "# Approved welcome\nWrite two friendly sentences.",
      approval: true,
    });
    const chat = await idle(request, f.chatPath);
    const original = await json(
      await request.get(`/api/issues/${chat.id}/documents/plan`),
    );
    expect(
      await json(await request.get(`/api/companies/${f.company.id}/issues`)),
    ).toHaveLength(0);
    await page
      .getByRole("button", { name: "Approve handoff", exact: true })
      .last()
      .click();
    await idle(request, f.chatPath, 2);
    await expect
      .poll(
        async () =>
          (
            await json(
              await request.get(`/api/companies/${f.company.id}/issues`),
            )
          ).filter((task: any) => task.status === "done").length,
        { timeout: 60_000 },
      )
      .toBe(1);
    const task = (
      await json(await request.get(`/api/companies/${f.company.id}/issues`))
    )[0];
    expect(task.parentId).toBeNull();
    expect(task.projectId).toBeTruthy();
    expect(task.assigneeAgentId).toBe(f.agent.id);
    const plan = await json(
      await request.get(`/api/issues/${task.id}/documents/plan`),
    );
    const output = await json(
      await request.get(`/api/issues/${task.id}/documents/output`),
    );
    expect(plan.body).toContain(original.body);
    expect(output.body).toContain(plan.body);
    expect(
      (await json(await request.get(`/api/issues/${chat.id}/documents/plan`)))
        .latestRevisionId,
    ).toBe(original.latestRevisionId);
    await expect(
      page.getByRole("article", {
        name: "Project created: Approved plan project",
      }),
    ).toHaveCount(1);
  } finally {
    await f.restore();
  }
});

test("shared questions resume and existing project reuse creates no project card", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    const project = await json(
      await request.post(`/api/companies/${f.company.id}/projects`, {
        data: { name: "Garden club" },
      }),
    );
    await page.goto(f.route);
    await send(page, { action: "question" });
    await expect(
      page.getByRole("radio", { name: "Garden club", exact: true }).last(),
    ).toBeVisible();
    await page
      .getByRole("radio", { name: "Garden club", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Submit answers", exact: true })
      .last()
      .click();
    const chat = await idle(request, f.chatPath, 2);
    await expect(
      page.getByText("Reply generation 0: Clarification received.", {
        exact: true,
      }),
    ).toBeVisible();
    await send(page, { action: "handoff", projectId: project.id });
    await idle(request, f.chatPath, 3);
    await expect
      .poll(
        async () =>
          (
            await json(
              await request.get(`/api/companies/${f.company.id}/issues`),
            )
          ).length,
      )
      .toBe(1);
    const task = (
      await json(await request.get(`/api/companies/${f.company.id}/issues`))
    )[0];
    expect(task.projectId).toBe(project.id);
    expect(task.parentId).toBeNull();
    expect(
      await json(await request.get(`/api/companies/${f.company.id}/projects`)),
    ).toHaveLength(1);
    await expect(
      page.getByRole("article", { name: /Project created:/ }),
    ).toHaveCount(0);
    const ordinaryChild = await json(
      await request.post(`/api/companies/${f.company.id}/issues`, {
        data: { title: "Ordinary delegation still works", parentId: task.id },
      }),
    );
    expect(ordinaryChild.parentId).toBe(task.id);
    expect(
      (await json(await request.get(`/api/issues/${chat.id}`))).status,
    ).toBe("in_review");
  } finally {
    await f.restore();
  }
});

test("shared history loads older messages without replacing the latest turn", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await send(page, { action: "history" });
    await idle(request, f.chatPath, 65);
    await page.reload();
    await expect(
      page.getByText("History message 64", { exact: true }),
    ).toBeVisible();
    // Scroll the shared transcript, including its older-page sentinel.
    await page.getByText("History message 64", { exact: true }).hover();
    for (
      let attempt = 0;
      attempt < 5 &&
      !(await page.getByText("History message 00", { exact: true }).count());
      attempt++
    ) {
      await page.mouse.wheel(0, -12000);
      await expect
        .poll(async () => page.getByText(/History message/).count())
        .toBeGreaterThan(40);
    }
    await expect(
      page.getByText("History message 00", { exact: true }),
    ).toBeAttached();
    await expect(
      page.getByText("History message 64", { exact: true }),
    ).toBeAttached();
  } finally {
    await f.restore();
  }
});

test("disabling the experiment lets an active turn settle and keeps idle history", async ({
  page,
  request,
}) => {
  const original = await json(
    await request.get("/api/instance/settings/experimental"),
  );
  expect(original.enableAgentChat).toBe(false);
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await send(page, { action: "delayed" });
    await expect(
      page.getByText("Turn started before feature disable.", { exact: true }),
    ).toBeVisible();
    const chat = await json(await request.get(f.chatPath));
    await json(
      await request.patch("/api/instance/settings/experimental", {
        data: { enableAgentChat: false },
      }),
    );
    await expect
      .poll(async () =>
        (await json(await request.get(`/api/issues/${chat.id}/comments`))).some(
          (c: any) => c.body === "Active turn settled after feature disable.",
        ),
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await json(await request.get(`/api/issues/${chat.id}`)))
            .conversationState,
      )
      .toBe("waiting");
    expect(
      (
        await request.post(`/api/issues/${chat.id}/comments`, {
          data: { body: "/new" },
        })
      ).status(),
    ).toBe(404);
    const before = (
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      )
    ).length;
    await page.reload();
    await expect(page.getByText(/Agent Chat is disabled/)).toBeVisible();
    expect(
      (
        await json(
          await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
        )
      ).length,
    ).toBe(before);
  } finally {
    await f.restore();
  }
});
