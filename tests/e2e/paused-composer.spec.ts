import { test, expect, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

for (const classic of [false, true]) {
  test(`paused composer: ${classic ? "classic" : "task chat"} preserves drafts and requires resume`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const company = await json(await request.post("/api/companies", { data: { name: `Paused composer ${Date.now()}` } }));
    const settings = await json(await request.get("/api/instance/settings/experimental"));
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: classic } }));
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "Paused composer fixture", role: "engineer", adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      } }));
      const task = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "Review the paused composer", status: "backlog", assigneeAgentId: agent.id,
      } }));
      await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
      const editor = (classic ? page.getByTestId("issue-chat-composer") : page).getByRole("textbox", { name: "editable markdown" });
      await editor.fill("Keep this draft until I resume.");
      await page.getByRole("button", { name: "More task actions", exact: true }).click();
      await page.getByRole("button", { name: "Pause work", exact: true }).click();
      const takeover = page.getByTestId("paused-composer-takeover");
      await expect(takeover).toBeVisible();
      await expect(takeover).toContainText("Your draft is saved.");
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
      await page.keyboard.press("Meta+Enter");
      const rejected = await request.post(`/api/issues/${task.id}/comments`, { data: { body: "Cannot send yet", reopen: true } });
      expect(rejected.status()).toBe(409);
      const rejectedUpdate = await request.patch(`/api/issues/${task.id}`, { data: { comment: "Cannot reassign and send", assigneeAgentId: null } });
      expect(rejectedUpdate.status()).toBe(409);
      expect((await json(await request.get(`/api/issues/${task.id}`))).assigneeAgentId).toBe(agent.id);
      expect(await json(await request.get(`/api/issues/${task.id}/comments`))).toHaveLength(0);
      await page.reload();
      await expect(takeover).toBeVisible();
      await expect(takeover).toContainText("Your draft is saved.");
      await takeover.getByRole("button", { name: "Resume task" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Resume work", exact: true }).click();
      await expect(takeover).toHaveCount(0);
      await expect(editor).toHaveText("Keep this draft until I resume.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}/comments`))).map((comment: { body: string }) => comment.body)).toEqual(["Keep this draft until I resume."]);

      // Ancestor pause is effective even when this child was created after it.
      await page.getByRole("button", { name: "More task actions", exact: true }).click();
      await page.getByRole("button", { name: "Pause work", exact: true }).click();
      await expect(takeover).toBeVisible();
      const child = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "Child held by parent", parentId: task.id, status: "backlog", assigneeAgentId: agent.id,
      } }));
      await page.goto(`/${company.issuePrefix}/issues/${child.identifier}`);
      await expect(takeover).toContainText("Subtree is paused.");
      await expect(editor).toHaveCount(0);
      expect((await request.post(`/api/issues/${child.id}/comments`, { data: { body: "Still paused" } })).status()).toBe(409);
      await takeover.getByRole("link", { name: "Resume subtree" }).click();
      await expect(page).toHaveURL(new RegExp(task.identifier));
      await takeover.getByRole("button", { name: "Resume subtree" }).click();
      await page.getByRole("dialog").getByRole("checkbox").uncheck();
      await page.getByRole("dialog").getByRole("button", { name: "Resume subtree", exact: true }).click();
      await page.goto(`/${company.issuePrefix}/issues/${child.identifier}`);
      await expect(takeover).toHaveCount(0);
      await expect(editor).toBeVisible();
    } finally {
      await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
      await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: settings.enableClassicTaskInterface } });
    }
  });
}
