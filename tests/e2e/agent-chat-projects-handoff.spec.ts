import { expect, test } from "@playwright/test";

import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

/**
 * Agent chat repository selection, plan-approval handoff, shared questions,
 * history pagination, and retired opt-out coverage. Split from
 * agent-chat-projects.spec.ts to keep every serial E2E spec under 100s.
 */
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
    await page.getByTestId("task-chat-composer-add").click();
    await page.getByTestId("composer-add-plan").click();
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
    // Task completion is delivered back to the chat as another real turn.
    await idle(request, f.chatPath, 3);
    const task = (
      await json(await request.get(`/api/companies/${f.company.id}/issues`))
    )[0];
    expect(task.parentId).toBeNull();
    expect(task.projectId).toBeTruthy();
    expect(task.assigneeAgentId).toBe(f.agent.id);
    const completion = page.getByText("Delegated work completed:", { exact: false });
    await expect(completion.getByRole("link").and(page.locator(
      `a[href="/${f.company.issuePrefix}/issues/${task.identifier}"]`,
    ))).toBeVisible();
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
    await idle(request, f.chatPath);
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
    // The delegated task finishes on its own and wakes the conversation with
    // a completion reporting turn. Wait for that turn to post its reply and
    // settle before reading status, or this read can catch the conversation
    // mid-turn.
    await idle(request, f.chatPath, 4);
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

test("retired Chat opt-outs do not interrupt active turns or hide existing history", async ({
  page,
  request,
}) => {
  const original = await json(
    await request.get("/api/instance/settings/experimental"),
  );
  expect(original.enableAgentChat).toBe(true);
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    await send(page, { action: "delayed" });
    await expect(
      page.getByText("Turn started before feature disable.", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
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
    const before = (
      await json(
        await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
      )
    ).length;
    await page.reload();
    await expect(page.getByText("Active turn settled after feature disable.", { exact: true })).toBeVisible();
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
