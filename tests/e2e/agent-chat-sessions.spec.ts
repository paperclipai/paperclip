import { expect, test } from "@playwright/test";

import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt";

import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

/**
 * Agent chat session lifecycle coverage: first-open semantics, the feature
 * flag, Stop + queued /new resets, and sidebar discovery. Shared fixtures
 * live in ./agent-chat.shared.ts; project, attachment, and history flows run
 * in agent-chat-projects.spec.ts.
 */
test("built chat initializes after service worker takeover and reload with a slow CPU", async ({
  page,
  context,
  request,
}) => {
  const f = await setup(request);
  try {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.goto(f.route);
      await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
      // The failed CI traces stopped before React evaluated, while a service
      // worker forwarded the Vite module graph. Keep this test on shipped assets
      // and cover both first takeover and subsequent controlled navigations.
      const scripts = await page.locator('script[type="module"][src]').evaluateAll(
        (elements) => elements.map((element) => element.getAttribute("src")),
      );
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.every((src) => src?.startsWith("/assets/"))).toBe(true);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      for (let reload = 0; reload < 3; reload += 1) {
        await page.reload();
        await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
        expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      }
      expect(await json(await request.get(f.chatPath))).toBeNull();
    } finally {
      await cdp.detach();
    }
  } finally {
    await f.restore();
  }
});

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

test("secondary chat navigation preserves layout, unique conversations, history, and drafts", async ({
  page,
  request,
}) => {
  const originalExperimental = await json(await request.get("/api/instance/settings/experimental"));
  const f = await setup(request);
  try {
    await json(await request.patch("/api/instance/settings/experimental", {
      data: { enableStreamlinedUi: true },
    }));
    await page.goto(`/${f.company.issuePrefix}/dashboard`);
    await page.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Who would you like to talk to?" })).toBeVisible();
    const sidebar = page.getByRole("complementary", { name: "Chat", exact: true });
    await expect(sidebar.getByText("No chats yet", { exact: true })).toBeVisible();
    const landingBounds = await sidebar.boundingBox();
    const compose = sidebar.getByRole("button", { name: "Add chat", exact: true });
    const picker = page.getByRole("dialog", { name: "Chat with an agent", exact: true });
    const chatListPath = `/api/companies/${f.company.id}/chats`;
    const betaPath = `${chatListPath}/${f.agents[1].id}`;
    await compose.click();
    await expect(picker.getByRole("option")).toHaveCount(6);
    await picker.getByRole("combobox").fill("Beta");
    await expect(picker.getByRole("option", { name: /^Beta / })).toContainText("New chat");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Configure Beta", exact: true })).toBeVisible();
    expect(await sidebar.boundingBox()).toEqual(landingBounds);
    const beta = await json(await request.get(betaPath));
    expect(beta.conversationAgentId).toBe(f.agents[1].id);
    expect(await json(await request.get(chatListPath))).toHaveLength(1);
    expect(await json(await request.get(`/api/companies/${f.company.id}/heartbeat-runs`))).toHaveLength(0);

    // Explicitly adding an existing agent must reopen the same conversation.
    await compose.click();
    await expect(picker.getByRole("combobox")).toHaveValue("");
    await picker.getByRole("combobox").fill("Beta");
    await expect(picker.getByRole("option", { name: /^Beta / })).toContainText("Open chat");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker).not.toBeVisible();
    expect((await json(await request.get(betaPath))).id).toBe(beta.id);
    expect(await json(await request.get(chatListPath))).toHaveLength(1);

    await compose.click();
    await picker.getByRole("combobox").fill("Alpha");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Configure Alpha", exact: true })).toBeVisible();
    const nav = sidebar.getByRole("navigation", { name: "Agent conversations" });
    const alphaLink = nav.getByRole("link", { name: /^Alpha / });
    const betaLink = nav.getByRole("link", { name: /^Beta / });
    await expect(nav.getByRole("link")).toHaveCount(2);
    const editor = page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]');
    await editor.fill("Unsent draft for Alpha");
    await betaLink.click();
    await expect(editor).toHaveText("");
    await alphaLink.click();
    await expect(editor).toContainText("Unsent draft for Alpha");

    const search = sidebar.getByRole("textbox", { name: "Search agents", exact: true });
    await search.fill("No matching agent");
    await expect(sidebar.getByText("No agents found", { exact: true })).toBeVisible();
    await search.fill("Beta");
    await expect(nav.getByRole("link")).toHaveCount(1);
    await expect(betaLink).toBeVisible();
    await search.press("Escape");
    await expect(nav.getByRole("link")).toHaveCount(2);
    await page.reload();
    await expect(editor).toContainText("Unsent draft for Alpha");
    await expect(nav.getByRole("link")).toHaveCount(2);

    await page.getByRole("link", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Who would you like to talk to?" })).toBeVisible();
    expect(await sidebar.boundingBox()).toEqual(landingBounds);
    await alphaLink.click();
    await page.getByRole("link", { name: "Configure Alpha", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/.*\/runtime/);
    await json(await request.post(`/api/issues/${beta.id}/comments`, {
      data: {
        body: "Background activity",
        clientRequestId: "00000000-0000-4000-8000-000000000099",
      },
    }));
    await idle(request, betaPath);
    await page.getByRole("link", { name: "Chat", exact: true }).click();
    await compose.click();
    await picker.getByRole("combobox").fill("Beta");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Configure Beta", exact: true })).toBeVisible();
    await expect(page.getByText("Background activity", { exact: true })).toBeVisible();
    expect((await json(await request.get(betaPath))).id).toBe(beta.id);
    expect(await json(await request.get(chatListPath))).toHaveLength(2);
    await json(await request.post(`/api/agents/${f.agents[1].id}/terminate`));
    await page.goto(`/${f.company.issuePrefix}/chats`);
    await expect(betaLink).toContainText("Terminated");
    await betaLink.click();
    await expect(page).toHaveURL(new RegExp(`/chats/${f.agents[1].id}$`));
    await expect(page.getByText("Background activity", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Background activity", { exact: true })).toBeVisible();
  } finally {
    await f.restore();
    await json(await request.patch("/api/instance/settings/experimental", {
      data: { enableStreamlinedUi: originalExperimental.enableStreamlinedUi },
    }));
  }
});
