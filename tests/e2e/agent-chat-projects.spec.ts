import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

test("cleanup restores agent chat experiments when cancellation fails", async ({ request }) => {
  const original = await json(await request.get("/api/instance/settings/experimental"));
  const response = (status: number, body: unknown) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as APIResponse;
  const failingRequest = new Proxy(request, {
    get(target, property) {
      if (property === "get") return async (...args: Parameters<APIRequestContext["get"]>) =>
        args[0].endsWith("/live-runs")
          ? response(200, [{ id: "cleanup-cancellation-fixture" }])
          : target.get(...args);
      if (property === "post") return async (...args: Parameters<APIRequestContext["post"]>) =>
        args[0].endsWith("/heartbeat-runs/cleanup-cancellation-fixture/cancel")
          ? response(500, { error: "simulated cancellation failure" })
          : target.post(...args);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const f = await setup(failingRequest);
    await expect(f.restore()).rejects.toThrow("500");
    const restored = await json(await request.get("/api/instance/settings/experimental"));
    expect(restored).toMatchObject({
      enableAgentChat: original.enableAgentChat,
      enableClassicTaskInterface: original.enableClassicTaskInterface,
    });
  } finally {
    const current = await json(await request.get("/api/instance/settings/experimental"));
    if (
      current.enableAgentChat !== original.enableAgentChat ||
      current.enableClassicTaskInterface !== original.enableClassicTaskInterface
    ) {
      await json(await request.patch("/api/instance/settings/experimental", { data: {
        enableAgentChat: original.enableAgentChat,
        enableClassicTaskInterface: original.enableClassicTaskInterface,
      } }));
    }
  }
});

/**
 * Agent chat project and content coverage: project cards, split handoff,
 * uploads, Ask/Plan modes, repository selection, plan approval, and shared
 * history. Shared fixtures live in ./agent-chat.shared.ts; session lifecycle
 * flows run in agent-chat-sessions.spec.ts.
 */
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
      const taskRuns = runs.filter(
        (run: any) => run.contextSnapshot?.issueId === task.id,
      );
      expect(taskRuns.length).toBeGreaterThan(0);
      const startedAt = taskRuns
        .filter((run: any) => run.startedAt != null)
        .map((run: any) => Date.parse(run.startedAt));
      // A newer queued/cancelled run need not have started. Preserve the
      // invariant against the first actual execution, not list ordering.
      expect(startedAt.length).toBeGreaterThan(0);
      expect(startedAt.every(Number.isFinite)).toBe(true);
      expect(Date.parse(plan.updatedAt)).toBeLessThanOrEqual(
        Math.min(...startedAt),
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
    await expect.poll(async () => {
      const comments = await json(await request.get(`/api/issues/${chat.id}/comments`));
      const completed = comments.filter((comment: any) => comment.authorAgentId === f.agent.id &&
        comment.body.startsWith("Delegated work completed:"));
      return tasks.every((task: any) => completed.some((comment: any) => comment.body.includes(task.identifier)));
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => await json(await request.get(`/api/companies/${f.company.id}/live-runs`)),
      { timeout: 30_000 }).toEqual([]);
    const settledTasks = await json(await request.get(`/api/companies/${f.company.id}/issues`));
    expect(settledTasks.map((task: any) => ({ id: task.id, status: task.status, parentId: task.parentId }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual(tasks.map((task: any) => ({
        id: task.id, status: "done", parentId: null,
      })).sort((a: any, b: any) => a.id.localeCompare(b.id)));
  } finally {
    await f.restore();
  }
});

test("failed project creation has no success card or partial state", async ({
  page,
  request,
}) => {
  const invalidPayloads = [
    { ids: ["987654321"] },
    { urls: ["https://user:password@github.com/org/repo"] },
    {
      urls: ["https://github.com/org/repo"],
      workspace: { name: "Conflicting", repoUrl: "https://github.com/org/repo" },
    },
  ];
  const f = await setup(request);
  try {
    await page.goto(f.route);
    for (const [index, bad] of invalidPayloads.entries()) {
      await send(page, { action: "project", ...bad });
      await idle(request, f.chatPath, index + 1);
      await expect(page.getByText(/Expected tool result:/)).toHaveCount(index + 1);
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
    }
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
      await page.getByTestId("task-chat-composer-add").click();
      await page.getByTestId(mode === "Plan" ? "composer-add-plan" : "composer-add-ask").click();
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
        await page.getByRole("link", { name: /Open Revised plan revision 2 in task sidebar/ }).click();
        await expect(page.getByRole("tab", { name: "Plan", exact: true })).toBeVisible();
      }
      expect(
        await json(await request.get(`/api/companies/${f.company.id}/issues`)),
      ).toHaveLength(0);
    } finally {
      await f.restore();
    }
  });
