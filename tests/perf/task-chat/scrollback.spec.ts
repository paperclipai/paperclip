import { expect, test } from "@playwright/test";

for (const reproject of [false, true]) {
test(`long scrollback stays responsive (${reproject ? "reprojected history" : "tail only"})`, async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/task-chat-perf.html");
  await expect(page.getByTestId("task-chat-scroller")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-thread-anchor^="history-"]')).toHaveCount(200);
  if (reproject) await page.getByLabel("Recreate history objects").check();
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const read = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  await page.getByRole("button", { name: "Start streaming" }).click();
  const before = await read();
  await page.waitForTimeout(3000);
  const after = await read();
  const metrics = {
    mainThreadBusyPercent: 100 * (after.TaskDuration - before.TaskDuration) / (after.Timestamp - before.Timestamp),
    scriptMs: 1000 * (after.ScriptDuration - before.ScriptDuration),
    layoutMs: 1000 * (after.LayoutDuration - before.LayoutDuration),
    domNodes: await page.locator("*").count(),
    ticks: Number(await page.getByTestId("stream-tick").textContent()),
  };
  console.log(JSON.stringify(metrics));
  await testInfo.attach("performance.json", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
  // Read scrollback without getting pulled down by ongoing live updates.
  const scroller = page.getByTestId("task-chat-scroller");
  await scroller.hover();
  await page.mouse.wheel(0, -700);
  await expect(page.getByRole("button", { name: "Scroll to latest" })).toBeVisible();
  const top = await scroller.evaluate((element) => element.scrollTop);
  await page.getByRole("textbox", { name: "Reply" }).fill("Reply remains usable during streaming.");
  await page.waitForTimeout(300);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
  await expect(page.getByRole("textbox", { name: "Reply" })).toHaveValue("Reply remains usable during streaming.");
  await page.getByRole("button", { name: "Scroll to latest" }).click();
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await page.getByRole("button", { name: "Stop streaming" }).click();
  await expect(page.getByTestId("task-chat-tool-card")).toHaveCount(0);
  const summary = page.getByTestId("task-chat-turn-summary").last();
  await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("task-chat-tool-card")).toHaveCount(20);
  const tool = page.getByTestId("task-chat-tool-card").first();
  await tool.getByRole("button").click();
  await expect(tool).toContainText("File inspected successfully.");
  await summary.click();
  await summary.click();
  await expect(tool).toContainText("File inspected successfully.");
  expect(errors).toEqual([]);
  // A broad regression ceiling, not a machine-specific benchmark target.
  expect(metrics.mainThreadBusyPercent).toBeLessThan(50);
  expect(metrics.ticks).toBeGreaterThanOrEqual(20);
});
}
