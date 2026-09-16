import { expect, test } from "@playwright/test";

import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

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
