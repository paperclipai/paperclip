import { expect, test } from "@playwright/test";
import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

test("a routine delivers a first digest, unread state, source link and replyable history", async ({ page, request }) => {
  const f = await setup(request);
  try {
    await page.goto(`/${f.company.issuePrefix}/chats/${f.agents[1].id}`);
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    const routine = await json(await request.post(`/api/companies/${f.company.id}/routines`, { data: {
      title: "Morning PR review", description: "proactive-digest-fixture", assigneeAgentId: f.agent.id,
    } }));
    await json(await request.post(`/api/routines/${routine.id}/run`, { data: { idempotencyKey: "browser-morning" } }));
    await expect(page.getByRole("img", { name: "Unread messages from Alpha", exact: true })).toBeVisible({ timeout: 45_000 });
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
    await expect(page.getByRole("img", { name: "Unread messages from Alpha", exact: true })).toBeVisible();
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
