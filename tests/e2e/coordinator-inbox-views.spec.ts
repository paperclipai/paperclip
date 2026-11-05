import path from "node:path";
import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test.use({ hasTouch: true });
for (const mobile of [false, true]) test(`Mine retains Inbox behavior inside Tasks (${mobile ? "mobile" : "desktop"})`, async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("paperclip:inbox:issue-columns")) localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "project", "updated"]));
  });
  const company = await json(await request.post("/api/companies", { data: { name: "Personal Tasks verification" } }));
  const preferences = await json(await request.get("/api/workspace-preferences/me"));
  const preferencePath = `/api/companies/${company.id}/workspace-preferences/me`;
  try {
    await json(await request.put(preferencePath, { data: { coordinatorWorkspaceEnabled: true } }));
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Inbox activity fixture", adapterType: "process", adapterConfig: {
        command: process.execPath, args: [path.resolve("tests/e2e/fixtures/inbox-activity.mjs")],
      }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    } }));
    const unread = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Unread personal task", status: "todo", assigneeAgentId: agent.id,
    } }));
    const read = await json(await request.post(`/api/companies/${company.id}/issues`, { data: { title: "Read personal task", status: "todo" } }));
    await expect.poll(async () => {
      const comments = await json(await request.get(`/api/issues/${unread.id}/comments`));
      return comments.some((comment: { authorAgentId: string | null }) => comment.authorAgentId === agent.id);
    }, { timeout: 30_000 }).toBe(true);
    await json(await request.delete(`/api/issues/${unread.id}/read`));
    await json(await request.post(`/api/issues/${read.id}/read`, { data: {} }));
    await page.goto(`/${company.issuePrefix}/inbox/mine`);
    await expect(page).toHaveURL(/\/issues\?view=mine$/);
    const mine = page.getByRole("region", { name: "Tasks", exact: true });
    const unreadRow = mine.locator(`[data-issue-id="${unread.id}"]`);
    const readRow = mine.locator(`[data-issue-id="${read.id}"]`);
    await expect(unreadRow).toHaveAttribute("data-unread", "true");
    await expect(unreadRow.locator('[data-slot="task-row-title"]')).toHaveClass(/font-semibold/);
    await expect(readRow.locator('[data-slot="task-row-title"]')).not.toHaveClass(/font-semibold/);
    await expect(page.getByRole("link", { name: /^Inbox(?:,|$)/ }).first()).toHaveAttribute("href", `/${company.issuePrefix}/decisions`);

    await page.getByRole("button", { name: "Columns", exact: true }).click();
    const creatorColumn = page.getByRole("menuitemcheckbox", { name: /^Kicked off by/ });
    await creatorColumn.click();
    await expect(creatorColumn).toBeChecked();
    await page.keyboard.press("Escape");
    await page.locator('button[title="Group"]').click();
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(unreadRow).toBeVisible();
    await expect(mine.getByText("No project", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await expect(creatorColumn).toBeChecked();
    await page.keyboard.press("Escape");
    await page.locator('button[title="Group"]').click();
    await page.getByRole("button", { name: "None", exact: true }).click();
    await page.keyboard.press("Escape");

    if (mobile) {
      await unreadRow.scrollIntoViewIfNeeded();
      const bounds = await unreadRow.boundingBox();
      expect(bounds).not.toBeNull();
      const session = await page.context().newCDPSession(page);
      const x = bounds!.x + bounds!.width * 0.85;
      const y = bounds!.y + bounds!.height / 2;
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) await session.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: x - bounds!.width * 0.1 * step, y }],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await session.detach();
      await expect(unreadRow).toHaveCount(0);
    } else {
      await unreadRow.hover();
      await page.keyboard.press("r");
      await expect(unreadRow).not.toHaveAttribute("data-unread", "true");
      await page.keyboard.press("U");
      await expect(unreadRow).toHaveAttribute("data-unread", "true");
      const archiveSaved = page.waitForResponse(response => response.url().endsWith(`/api/issues/${unread.id}/inbox-archive`) && response.request().method() === "POST");
      await page.keyboard.press("a");
      expect((await archiveSaved).ok()).toBe(true);
      await expect(unreadRow).toHaveCount(0);
      await page.keyboard.press("u");
      await expect(unreadRow).toBeVisible();
      await page.getByRole("link", { name: "Inbox", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
    }
  } finally {
    await request.put(preferencePath, { data: { coordinatorWorkspaceEnabled: preferences.coordinatorWorkspaceEnabled } });
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
  }
});
