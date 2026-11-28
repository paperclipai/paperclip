import { expect, test } from "@playwright/test";

import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt";

import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

/**
 * Agent chat session reset and sidebar navigation coverage split out of
 * agent-chat-sessions.spec.ts so serial E2E shards stay under 75s.
 */
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
      }, { timeout: 30_000 })
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

test("Coordinator agent switching preserves drafts and opens one conversation only on send", async ({ page, request }) => {
  const f = await setup(request, { agentCount: 2 });
  try {
    await page.goto(f.route);
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    const editor = page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]');
    const contacts = page.getByRole("complementary", { name: "Chat contacts", exact: true });
    const switchTo = async (name: string) => {
      const contact = contacts.getByRole("link", { name: new RegExp(`^${name}`) });
      await contact.click();
      await expect(contact).toHaveAttribute("aria-current", "page");
    };
    await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
    await expect(contacts.getByRole("button", { name: "Add chat", exact: true })).toHaveCount(0);
    await editor.fill("Unsent Coordinator draft for Alpha");
    await switchTo("Beta");
    await expect(editor).toHaveText("");
    expect(await json(await request.get(`/api/companies/${f.company.id}/chats/${f.agents[1].id}`))).toBeNull();
    await switchTo("Alpha");
    await expect(editor).toContainText("Unsent Coordinator draft for Alpha");
    await page.reload();
    await expect(editor).toContainText("Unsent Coordinator draft for Alpha");
    expect(await json(await request.get(f.chatPath))).toBeNull();
    await editor.fill("");
    await send(page, "Coordinator conversation acceptance");
    await idle(request, f.chatPath);
    const chat = await json(await request.get(f.chatPath));
    await switchTo("Beta");
    await switchTo("Alpha");
    await expect(page.getByText("Coordinator conversation acceptance", { exact: true })).toBeVisible();
    expect((await json(await request.get(f.chatPath))).id).toBe(chat.id);
    expect(await json(await request.get(`/api/companies/${f.company.id}/chats`))).toHaveLength(1);
  } finally {
    await f.restore();
  }
});

test("secondary chat navigation preserves layout, unique conversations, history, and drafts", async ({
  page,
  request,
}) => {
  const originalExperimental = await json(await request.get("/api/instance/settings/experimental"));
  const f = await setup(request, { agentCount: 6 });
  const originalWorkspace = await json(await request.get("/api/workspace-preferences/me"));
  try {
    await page.route("**/api/workspace-preferences/me", (route) =>
      route.fulfill({
        json: { ...originalWorkspace, coordinatorWorkspaceEnabled: false },
      }),
    );
    await page.route("**/api/instance/settings/experimental", (route) =>
      route.fulfill({
        json: { ...originalExperimental, enableStreamlinedUi: true },
      }),
    );
    await page.goto(`/${f.company.issuePrefix}/dashboard`);
    await page.getByRole("link", { name: /^Chat(?:\s|$)/ }).click();
    expect(await json(await request.get(`/api/companies/${f.company.id}/primary-agent/me`))).toMatchObject({
      primaryAgentId: f.agents[0].id, initialized: true,
    });
    const sidebar = page.getByRole("complementary", { name: "Chat contacts", exact: true });
    const nav = sidebar.getByRole("navigation", { name: "Agent conversations" });
    const alphaLink = nav.getByRole("link", { name: /^Alpha/ });
    const betaLink = nav.getByRole("link", { name: /^Beta/ });
    await expect(alphaLink).toHaveAttribute("aria-current", "page");
    expect(await json(await request.get(f.chatPath))).toBeNull();
    expect(await json(await request.get(`/api/companies/${f.company.id}/heartbeat-runs`))).toHaveLength(0);
    await expect(nav.getByRole("link")).toHaveText([/^Alpha/, /^Beta/, /^Delta/, /^Epsilon/, /^Gamma/, /^Zeta/]);
    const landingBounds = await sidebar.boundingBox();
    const chatListPath = `/api/companies/${f.company.id}/chats`;
    const betaPath = `${chatListPath}/${f.agents[1].id}`;
    await betaLink.click();
    await expect(betaLink).toHaveAttribute("aria-current", "page");
    expect(await sidebar.boundingBox()).toEqual(landingBounds);
    expect(await json(await request.get(betaPath))).toBeNull();
    expect(await json(await request.get(chatListPath))).toHaveLength(0);
    expect(await json(await request.get(`/api/companies/${f.company.id}/heartbeat-runs`))).toHaveLength(0);
    await betaLink.click();
    expect(await json(await request.get(betaPath))).toBeNull();
    await send(page, "Beta conversation acceptance");
    const beta = await idle(request, betaPath);
    expect(beta.conversationAgentId).toBe(f.agents[1].id);
    expect(await json(await request.get(chatListPath))).toHaveLength(1);
    await alphaLink.click();
    await expect(alphaLink).toHaveAttribute("aria-current", "page");
    await betaLink.click();
    await expect(betaLink).toHaveAttribute("aria-current", "page");
    expect((await json(await request.get(betaPath))).id).toBe(beta.id);
    expect(await json(await request.get(chatListPath))).toHaveLength(1);
    await alphaLink.click();
    await expect(alphaLink).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link")).toHaveText([/^Alpha/, /^Beta/, /^Delta/, /^Epsilon/, /^Gamma/, /^Zeta/]);
    const editor = page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]');
    await editor.fill("Unsent draft for Alpha");
    await betaLink.click();
    await expect(editor).toHaveText("");
    await alphaLink.click();
    await expect(editor).toContainText("Unsent draft for Alpha");

    const search = sidebar.getByRole("textbox", { name: "Search chats", exact: true });
    await search.fill("No matching agent");
    await expect(sidebar.getByText("No agents found", { exact: true })).toBeVisible();
    await search.fill("Beta");
    await expect(nav.getByRole("link")).toHaveCount(1);
    await expect(betaLink).toBeVisible();
    await search.press("Escape");
    await expect(nav.getByRole("link")).toHaveCount(6);
    await page.reload();
    await expect(editor).toContainText("Unsent draft for Alpha");
    await expect(nav.getByRole("link")).toHaveCount(6);

    await page.getByRole("link", { name: /^Chat(?:\s|$)/ }).click();
    await expect(alphaLink).toHaveAttribute("aria-current", "page");
    await expect(editor).toContainText("Unsent draft for Alpha");
    expect(await sidebar.boundingBox()).toEqual(landingBounds);
    await page.goto(`/${f.company.issuePrefix}/dashboard`);
    await expect(page).toHaveURL(/\/dashboard$/);
    await json(await request.post(`/api/issues/${beta.id}/comments`, {
      data: {
        body: "Background activity",
        clientRequestId: "00000000-0000-4000-8000-000000000099",
      },
    }));
    await idle(request, betaPath);
    await page.getByRole("link", { name: /^Chat(?:\s|$)/ }).click();
    await expect(alphaLink).toHaveAttribute("aria-current", "page");
    await betaLink.click();
    await expect(betaLink).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Background activity", { exact: true })).toBeVisible();
    expect((await json(await request.get(betaPath))).id).toBe(beta.id);
    expect(await json(await request.get(chatListPath))).toHaveLength(1);
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
  }
});
