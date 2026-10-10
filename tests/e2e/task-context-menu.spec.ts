import { expect, test } from "@playwright/test";

for (const view of ["List", "Board"] as const) {
  test(`${view}: move and delete tasks through the context menu`, async ({ page, request }, testInfo) => {
    const companyResponse = await request.post("/api/companies", {
      data: { name: `Task menu ${view} ${Date.now()}` },
    });
    expect(companyResponse.ok()).toBe(true);
    const company = await companyResponse.json();
    const taskResponse = await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Review the onboarding flow", status: "todo" },
    });
    expect(taskResponse.ok()).toBe(true);
    const task = await taskResponse.json();
    const taskPath = `/api/issues/${task.id}`;
    await page.goto(`/${company.issuePrefix}/issues`);
    await page.getByRole("button", { name: `${view} view`, exact: true }).click();
    const title = page.getByText(task.title, { exact: true });
    await expect(title).toBeVisible();
    const link = page.locator(`a[href$="/issues/${task.identifier}"]`).first();

    // CM-1: right-click does not navigate; the status is persisted by the real API.
    await link.click({ button: "right" });
    await expect(page.getByRole("menu", { name: `Actions for ${task.identifier}` })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Todo" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`${view.toLowerCase()}-menu.png`) });
    await page.getByRole("menuitem", { name: "Backlog", exact: true }).click();
    await expect.poll(async () => (await (await request.get(taskPath)).json()).status).toBe("backlog");
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/issues$`));
    await expect(title).toBeVisible();

    // CM-4: keyboard invocation and Escape preserve navigation.
    await link.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Backlog", exact: true })).toBeDisabled();
    await page.keyboard.press("Home");
    await expect(page.getByRole("menuitem", { name: "Todo", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await (await request.get(taskPath)).json()).status).toBe("todo");
    await link.focus();
    await page.keyboard.press("Shift+F10");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // CM-2: cancel keeps the task.
    await link.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete task…" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(task.identifier);
    await page.screenshot({ path: testInfo.outputPath(`${view.toLowerCase()}-confirm.png`) });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await request.get(taskPath)).ok()).toBe(true);

    // CM-3: inject only a rejected delete; the retry uses the real API.
    await page.route(`**${taskPath}`, async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Permission denied" }) });
      } else await route.continue();
    });
    await link.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete task…" }).click();
    await page.getByRole("button", { name: "Delete task", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Permission denied");
    expect((await request.get(taskPath)).ok()).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${view.toLowerCase()}-error.png`) });
    await page.unroute(`**${taskPath}`);
    await page.getByRole("button", { name: "Delete task", exact: true }).click();
    await expect.poll(async () => (await request.get(taskPath)).status()).toBe(404);
    await expect(title).toHaveCount(0);
  });
}

test("Board: preserve dragging and normal task navigation", async ({ page, request }) => {
  const company = await (await request.post("/api/companies", {
    data: { name: `Task menu drag ${Date.now()}` },
  })).json();
  const task = await (await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Check existing interactions", status: "todo" },
  })).json();
  await page.goto(`/${company.issuePrefix}/issues`);
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  const link = page.locator(`a[href$="/issues/${task.identifier}"]`).first();
  await expect(link).toBeVisible();
  const source = await link.boundingBox();
  const target = await page.getByText("Backlog", { exact: true }).first().locator("../..").boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(source!.x + source!.width / 2 + 10, source!.y + source!.height / 2, { steps: 4 });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 100, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await (await request.get(`/api/issues/${task.id}`)).json()).status).toBe("backlog");
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/issues/${task.identifier}$`));
});
