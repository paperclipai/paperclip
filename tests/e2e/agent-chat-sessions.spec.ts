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

test("sidebar discovery, stars, recent agents, configuration links, and drafts survive switching", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(`/${f.company.issuePrefix}/dashboard`);
    const nav = page.getByRole("navigation");
    const chatLinks = nav.locator('a[href*="/chats/"]');
    await expect(chatLinks).toHaveText(["Alpha"]);
    const compose = nav.getByRole("button", { name: "Chat with an agent", exact: true });
    await compose.click();
    const picker = page.getByRole("dialog", { name: "Chat with an agent", exact: true });
    await expect(picker.getByRole("option")).toHaveCount(6);
    await picker.getByRole("combobox").fill("Beta");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Configure Beta", exact: true })).toBeVisible();
    expect(await json(await request.get(`/api/companies/${f.company.id}/chats/${f.agents[1].id}`))).toBeNull();
    for (const agent of f.agents) {
      await page.goto(`/${f.company.issuePrefix}/chats/${agent.id}`);
      await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    }
    await expect(chatLinks).toHaveText(["Alpha", "Zeta", "Epsilon", "Delta", "Gamma"]);
    const star = page.getByRole("button", { name: "Star Zeta", exact: true });
    await page.getByTestId("task-chat-composer-input").hover();
    await expect(star).toHaveCSS("opacity", "0");
    // Enter from the preceding link. Clicking the rich editor first can leave
    // a pending selection update that restores editor focus; Shift+Tab there
    // also cycles work modes instead of moving backwards through the sidebar.
    await nav.getByRole("link", { name: "Zeta", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(star).toBeFocused();
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
    await compose.click();
    await expect(picker.getByRole("combobox")).toHaveValue("");
    await picker.getByRole("combobox").fill("Beta");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Configure Beta", exact: true })).toBeVisible();
    await expect(page.getByText("Background activity", { exact: true })).toBeVisible();
  } finally {
    await f.restore();
  }
});
