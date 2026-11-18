import { expect, test } from "@playwright/test";
import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

test("answering questions in chat and inbox updates both open surfaces", async ({ page, request, context }) => {
  const f = await setup(request);
  const inbox = await context.newPage();
  try {
    await page.goto(f.route);
    for (const answerIn of ["chat", "inbox"] as const) {
      await send(page, { action: "question" });
      await expect(page.getByRole("radio", { name: "Garden club", exact: true }).last()).toBeVisible({ timeout: 45_000 });
      if (answerIn === "chat") await inbox.goto(`/${f.company.issuePrefix}/decisions`);
      const inboxQuestion = inbox.getByRole("radio", { name: "Garden club", exact: true });
      await expect(inboxQuestion).toBeVisible({ timeout: 20_000 });
      const answeringPage = answerIn === "chat" ? page : inbox;
      await answeringPage.getByRole("radio", { name: "Garden club", exact: true }).last().click();
      await answeringPage.getByRole("button", { name: "Submit answers", exact: true }).last().click();
      await expect(inboxQuestion).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByRole("radio", { name: "Garden club", exact: true })).toHaveCount(0, { timeout: 20_000 });
      const chat = await json(await request.get(f.chatPath));
      await expect.poll(async () => {
        const feed = await json(await request.get(`/api/companies/${f.company.id}/attention?all=true&view=mine`));
        return feed.items.filter((item: any) => item.sourceKind === "issue_thread_interaction" && item.relatedIssue?.id === chat.id).length;
      }).toBe(0);
      await idle(request, f.chatPath, answerIn === "chat" ? 2 : 4);
    }
  } finally { await inbox.close(); await f.restore(); }
});

test("a routine delivers a first digest, unread state, source link and replyable history", async ({ page, request }) => {
  const f = await setup(request);
  try {
    await page.goto(`/${f.company.issuePrefix}/chats/${f.agents[1].id}`);
    await expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    const routine = await json(await request.post(`/api/companies/${f.company.id}/routines`, { data: {
      title: "Morning PR review", description: "proactive-digest-fixture", assigneeAgentId: f.agent.id,
    } }));
    await json(await request.post(`/api/routines/${routine.id}/run`, { data: { idempotencyKey: "browser-morning" } }));
    await expect(page.getByLabel(/unread chats/)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByLabel(/unread chats/)).toBeVisible();
    let chat: any;
    await expect.poll(async () => {
      chat = await json(await request.get(f.chatPath));
      return chat?.isUnreadForMe;
    }).toBe(true);
    const comments = await json(await request.get(`/api/issues/${chat.id}/comments`));
    const digest = comments.find((c: any) => c.metadata?.chatMessage);
    expect(digest.authorAgentId).toBe(f.agent.id);
    const sourceId = digest.metadata.chatMessage.sourceTaskId;
    const source = await json(await request.get(`/api/issues/${sourceId}`));
    expect(source.originKind).toBe("routine_execution");
    expect(await json(await request.get(`/api/issues/${chat.id}/runs`))).toEqual([]);
    await page.reload();
    await expect(page.getByLabel(/unread chats/)).toBeVisible();
    await page.goto(f.route);
    await expect(page.getByText("Morning PR digest", { exact: true })).toBeVisible();
    const sourceLink = page.getByRole("link", { name: `From ${source.identifier}`, exact: true });
    await expect(sourceLink).toBeVisible();
    await expect.poll(async () => (await json(await request.get(f.chatPath))).isUnreadForMe).toBe(false);
    await sourceLink.click();
    await expect(page).toHaveURL(new RegExp(`/issues/${source.identifier}`));
    await page.goto(f.route);
    await send(page, { action: "digest-followup", text: "Which was the first PR?" });
    await idle(request, f.chatPath, 2);
    await expect(page.getByText("The first PR in your morning digest is PR 123.", { exact: true })).toBeVisible({ timeout: 45_000 });
  } finally { await f.restore(); }
});
