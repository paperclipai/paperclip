import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Locator, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function swipeToLastOption(page: Page, picker: Locator, list = picker.getByRole("listbox"), last = list.getByRole("option").last()) {
  // The shared picker animates its height between views. Native touch
  // coordinates must use the settled sheet rather than its clipped first frame.
  await expect.poll(() => picker.evaluate((element) => {
    const body = element.querySelector(".composer-run-settings-height");
    return [...element.getAnimations(), ...(body?.getAnimations() ?? [])]
      .every((animation) => animation.playState !== "running");
  })).toBe(true);
  // visualViewport resize updates React state after the browser viewport changes.
  await expect.poll(async () => {
    const bounds = (await picker.boundingBox())!;
    return bounds.y + bounds.height;
  }).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect((await picker.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  const session = await page.context().newCDPSession(page);
  try {
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    let touchScrolled = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bounds = (await list.boundingBox())!;
      const target = (await last.boundingBox())!;
      if (target.y >= bounds.y && target.y + target.height <= bounds.y + bounds.height + 1) break;
      const { scrollTop: before, maxScrollTop } = await list.evaluate((element) => ({
        scrollTop: element.scrollTop,
        maxScrollTop: element.scrollHeight - element.clientHeight,
      }));
      // At the native scroll limit, another gesture cannot increase scrollTop.
      // Let the visibility assertion below report any genuinely clipped row.
      if (before >= maxScrollTop) break;
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
      touchScrolled = true;
      // A drag must not choose a row or dismiss the picker.
      await expect(picker).toBeVisible();
    }
    expect(touchScrolled).toBe(true);
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

test("new-task assignee, model, and project sheets scroll by touch and retain the selected values", async ({ page, request, browserName }, testInfo) => {
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
    await json(await request.post(`/api/companies/${company.id}/projects`, {
      data: { name: `Touch Project ${String(index).padStart(2, "0")}` },
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
  const draft = page.getByRole("textbox", { name: "editable markdown" });
  await draft.fill("Keep this touch selection draft");
  const assigneeTrigger = page.getByRole("button", { name: "Select assignee", exact: true });
  const modelTrigger = page.getByRole("button", { name: "Select model and effort", exact: true });
  await assigneeTrigger.tap();
  const assigneePicker = page.getByRole("dialog", { name: "Select assignee", exact: true });
  const lastAssignee = await swipeToLastOption(page, assigneePicker);
  await expect(lastAssignee).toContainText("Touch Agent 22");
  await lastAssignee.tap();
  await expect(assigneePicker).toBeHidden();
  await expect(assigneeTrigger).toBeFocused();
  await modelTrigger.tap();
  const picker = page.getByRole("dialog", { name: "Select model and effort", exact: true });
  // The settings view must keep its controls stretched across the mobile sheet.
  await expect.poll(async () => {
    const sheet = (await picker.boundingBox())!;
    const control = (await picker.getByRole("button", { name: "Choose exact model" }).boundingBox())!;
    return control.width / sheet.width;
  }).toBeGreaterThan(0.8);
  // Short screens must also let a finger reach the settings below the fold.
  const effort = picker.getByRole("slider", { name: "Effort" });
  const effortBeforeScroll = await effort.inputValue();
  await page.setViewportSize({ width: 390, height: 200 });
  await swipeToLastOption(page, picker, picker.getByTestId("composer-run-settings-view"), effort);
  await expect(effort).toHaveValue(effortBeforeScroll);
  await page.screenshot({ path: testInfo.outputPath("settings-after-touch-scroll.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Choose exact model" }).tap();
  await page.screenshot({ path: testInfo.outputPath("model-before-keyboard.png") });
  // A reduced viewport exercises the space available when a phone keyboard opens.
  await page.setViewportSize({ width: 390, height: 430 });
  const lastModel = await swipeToLastOption(page, picker);
  await expect(lastModel).toContainText("Touch Model 24");
  await page.screenshot({ path: testInfo.outputPath("model-after-touch-scroll.png") });
  await lastModel.tap();
  await page.getByRole("button", { name: "Close picker" }).tap();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(assigneeTrigger).toContainText("Touch Agent 22");
  await expect(modelTrigger).toContainText("Touch Model 24");
  await expect(draft).toHaveText("Keep this touch selection draft");

  const projectTrigger = page.getByRole("button", { name: "Project", exact: true });
  await projectTrigger.tap();
  const projectPicker = page.getByRole("dialog", { name: "Select project", exact: true });
  await page.setViewportSize({ width: 390, height: 430 });
  const projectList = projectPicker.locator("[data-mobile-entity-picker-list]");
  const lastProject = await swipeToLastOption(page, projectPicker, projectList, projectList.getByRole("button").filter({ hasText: "Touch Project 22" }));
  await page.screenshot({ path: testInfo.outputPath("project-after-touch-scroll.png") });
  await lastProject.tap();
  await expect(projectPicker).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-slot="new-issue-compact-control"]').filter({ hasText: "Touch Project 22" })).toBeVisible();
  await expect(draft).toHaveText("Keep this touch selection draft");

  // Closing the nested picker preserves the outer composer draft and choices.
  await modelTrigger.tap();
  await page.getByRole("button", { name: "Choose exact model" }).tap();
  await page.getByRole("searchbox", { name: "Search or paste a model ID" }).press("Escape");
  await expect(picker).toBeHidden();
  await expect(assigneeTrigger).toBeFocused();
  await expect(page.getByRole("button", { name: "Create task", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("selected-mobile-picker-values.png") });

  // The desktop picker uses the same selected values and supports model search.
  await page.setViewportSize({ width: 1280, height: 900 });
  await modelTrigger.click();
  await page.getByRole("button", { name: "Choose exact model" }).click();
  await page.getByRole("searchbox", { name: "Search or paste a model ID" }).fill("Touch Model 01");
  await page.getByRole("option", { name: "Touch Model 01 touch-model-01", exact: true }).click();
  await page.getByRole("button", { name: "Choose exact model" }).press("Escape");
  await expect(modelTrigger).toContainText("Touch Model 01");
});

test.describe("desktop picker scrolling", () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });

  test("mouse wheels scroll nested model, assignee, and project lists without losing the draft", async ({ page, request }) => {
    const company = await json(await request.post("/api/companies", {
      data: { name: `Wheel pickers ${randomUUID()}` },
    }));
    for (let index = 1; index <= 22; index += 1) {
      await json(await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: `Wheel Agent ${String(index).padStart(2, "0")}`, role: "engineer",
          adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol" },
          runtimeConfig: { heartbeat: { enabled: false } },
        },
      }));
      await json(await request.post(`/api/companies/${company.id}/projects`, {
        data: { name: `Wheel Project ${String(index).padStart(2, "0")}` },
      }));
    }
    await page.route(`**/api/companies/${company.id}/adapters/codex_local/models*`, (route) => route.fulfill({
      json: Array.from({ length: 24 }, (_, index) => ({
        id: `wheel-model-${String(index + 1).padStart(2, "0")}`,
        label: `Wheel Model ${String(index + 1).padStart(2, "0")}`,
      })),
    }));
    await page.goto(`/${company.issuePrefix}/dashboard`);
    await page.getByRole("button", { name: "New Task", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "editable markdown" });
    await draft.fill("Keep this mouse wheel selection draft");

    const wheelToBottom = async (list: Locator) => {
      await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      const before = await list.evaluate((element) => element.scrollTop);
      await list.hover();
      await page.mouse.wheel(0, 2000);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
    };
    const assigneeTrigger = page.getByRole("button", { name: "Select assignee", exact: true });
    const modelTrigger = page.getByRole("button", { name: "Select model and effort", exact: true });
    await assigneeTrigger.click();
    await wheelToBottom(page.getByRole("listbox", { name: "Assignees", exact: true }));
    await page.getByRole("option").filter({ hasText: "Wheel Agent 22" }).click();
    await expect(assigneeTrigger).toContainText("Wheel Agent 22");

    await modelTrigger.click();
    await page.getByRole("button", { name: "Choose exact model" }).click();
    await wheelToBottom(page.getByRole("listbox", { name: "Models", exact: true }));
    await page.getByRole("option").filter({ hasText: "Wheel Model 24" }).click();
    await page.getByRole("button", { name: "Choose exact model" }).press("Escape");
    await expect(modelTrigger).toContainText("Wheel Model 24");

    await page.getByRole("button", { name: "Project", exact: true }).click();
    const projectPicker = page.getByRole("dialog", { name: "Select project", exact: true });
    await wheelToBottom(projectPicker.locator("[data-mobile-entity-picker-list]"));
    await projectPicker.getByRole("button").filter({ hasText: "Wheel Project 22" }).click();
    await expect(projectPicker).toBeHidden();
    await expect(page.locator('[data-slot="new-issue-compact-control"]').filter({ hasText: "Wheel Project 22" })).toBeVisible();
    await expect(draft).toHaveText("Keep this mouse wheel selection draft");
  });
});
