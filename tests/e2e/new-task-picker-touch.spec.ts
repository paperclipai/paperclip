import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Locator, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function swipeToLastOption(page: Page, picker: Locator) {
  const list = picker.locator("[data-mobile-entity-picker-list]");
  const last = list.getByRole("button").last();
  // visualViewport resize updates React state after the browser viewport changes.
  await expect.poll(async () => {
    const bounds = (await picker.boundingBox())!;
    return bounds.y + bounds.height;
  }).toBeLessThanOrEqual(page.viewportSize()!.height);
  const session = await page.context().newCDPSession(page);
  try {
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bounds = (await list.boundingBox())!;
      const target = (await last.boundingBox())!;
      if (target.y >= bounds.y && target.y + target.height <= bounds.y + bounds.height) break;
      const before = await list.evaluate((element) => element.scrollTop);
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height - 20;
      const distance = Math.min(180, bounds.height - 40);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 12; step += 1) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove", touchPoints: [{ x, y: y - distance * step / 12 }],
        });
        // Pace native finger movement across compositor frames.
        await page.waitForTimeout(20);
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
      // A drag must not choose a row or dismiss the picker.
      await expect(picker).toBeVisible();
    }
    const bounds = (await list.boundingBox())!;
    const target = (await last.boundingBox())!;
    expect(target.y).toBeGreaterThanOrEqual(bounds.y);
    expect(target.y + target.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  } finally {
    await session.detach();
  }
  return last;
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("new-task assignee and model sheets scroll by touch and retain the selected values", async ({ page, request, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "Native touch drags use Chromium's input protocol.");
  const company = await json(await request.post("/api/companies", {
    data: { name: `Touch pickers ${randomUUID()}` },
  }));
  for (let index = 1; index <= 22; index += 1) {
    await json(await request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: `Touch Agent ${String(index).padStart(2, "0")}`, role: "engineer",
        adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol" },
        runtimeConfig: { heartbeat: { enabled: false } },
      },
    }));
  }
  // Keep the provider catalog deterministic; task UI, agents, and drafts are real.
  await page.route(`**/api/companies/${company.id}/adapters/codex_local/models*`, (route) => route.fulfill({
    json: Array.from({ length: 24 }, (_, index) => ({
      id: `touch-model-${String(index + 1).padStart(2, "0")}`,
      label: `Touch Model ${String(index + 1).padStart(2, "0")}`,
    })),
  }));
  await page.goto(`/${company.issuePrefix}/dashboard`);
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "New Task", exact: true }).tap();
  await page.getByPlaceholder("Task title").fill("Keep this touch selection draft");
  await page.getByRole("button", { name: "Assignee", exact: true }).tap();
  const assignees = page.getByRole("dialog", { name: "Select assignee", exact: true });
  const lastAssignee = await swipeToLastOption(page, assignees);
  await expect(lastAssignee).toHaveText("Touch Agent 22");
  await lastAssignee.tap();
  // Assignee confirmation advances to the project picker.
  await page.getByRole("dialog", { name: "Select project", exact: true }).getByRole("button", { name: "No project", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Touch Agent 22", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Codex options", exact: true }).tap();
  await page.getByRole("radio", { name: "Custom", exact: true }).tap();
  await page.getByRole("button", { name: "Default model", exact: true }).tap();
  // A reduced viewport exercises the space available when a phone keyboard opens.
  await page.setViewportSize({ width: 390, height: 430 });
  const models = page.getByRole("dialog", { name: "Default model", exact: true });
  const lastModel = await swipeToLastOption(page, models);
  await expect(lastModel).toHaveText("Touch Model 24");
  await lastModel.tap();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Touch Model 24", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Task title")).toHaveValue("Keep this touch selection draft");

  // Reopening and closing the nested modal must preserve the outer task draft.
  await page.getByRole("button", { name: "Touch Model 24", exact: true }).tap();
  await page.getByRole("button", { name: "Close selector", exact: true }).tap();
  await expect(models).toBeHidden();
  await expect(page.getByRole("button", { name: "Touch Model 24", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Touch Agent 22", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Task", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Touch Model 24", exact: true }).tap();
  await page.getByPlaceholder("Search models...").press("Escape");
  await expect(models).toBeHidden();
  await expect(page.getByRole("button", { name: "Touch Model 24", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Touch Model 24", exact: true }).tap();
  await page.touchscreen.tap(4, 4);
  await expect(models).toBeHidden();
  await expect(page.getByPlaceholder("Task title")).toHaveValue("Keep this touch selection draft");
  await page.screenshot({ path: testInfo.outputPath("selected-mobile-assignee-and-model.png") });

  // The desktop popover keeps mouse opening and keyboard selection.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Touch Model 24", exact: true }).click();
  await page.getByPlaceholder("Search models...").fill("Touch Model 01");
  await page.getByPlaceholder("Search models...").press("Enter");
  await expect(page.getByRole("button", { name: "Touch Model 01", exact: true })).toBeVisible();
});
