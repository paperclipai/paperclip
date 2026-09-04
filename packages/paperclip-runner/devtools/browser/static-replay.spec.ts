import { expect, test } from "@playwright/test";

test("validates and renders the shared Replay fixture", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Live runner diagnostics" })).toBeVisible();
  await page.getByRole("button", { name: "Static replay" }).click();
  await expect(page.getByRole("heading", { name: "Static protocol replay" })).toBeVisible();
  await expect(page.getByTestId("terminal-badge")).toHaveText("Succeeded");
  await expect(page.getByTestId("timeline").getByRole("listitem")).toHaveCount(9);
  await expect(page.getByTestId("timeline")).not.toContainText("workspace_preparing");
  await expect(page.getByTestId("result-summary")).toContainText(
    "The scripted run completed successfully.",
  );
  await page.screenshot({
    path: testInfo.outputPath("replay-static-replay.png"),
    fullPage: true,
  });
});

test("shows duplicate and unsupported-version replay states", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Static replay" }).click();
  await page.getByLabel("Fixture", { exact: true }).selectOption("duplicate-event");
  await expect(page.getByText("1 duplicate events ignored")).toBeVisible();
  await page
    .getByLabel("Fixture", { exact: true })
    .selectOption("unsupported-required-version");
  await expect(page.getByRole("heading", { name: "Fixture cannot be replayed" })).toBeVisible();
  await expect(page.getByText(/protocolVersion 2 is unsupported/)).toBeVisible();
});

test("streams a live run and proves replay parity", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start local run" }).click();
  await expect(page.getByTestId("live-status")).toHaveText("Terminal");
  await expect(page.getByTestId("terminal-badge")).toHaveText("Succeeded");
  await expect(page.getByTestId("process-facts")).toContainText("Harness process exit");
  await expect(page.getByTestId("process-facts")).toContainText("done");
  await expect(page.getByTestId("parity-result")).toContainText("Match");
  await page.screenshot({
    path: testInfo.outputPath("local-runner-live-complete.png"),
    fullPage: true,
  });
});

test("resolves live permission and input requests", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByLabel("Scenario").selectOption("permission-input");
  await page.getByRole("button", { name: "Start local run" }).click();
  await expect(page.getByTestId("runtime-request")).toContainText("permission request");
  await expect(page.getByTestId("terminal-badge")).toHaveText("Executing");
  await expect(
    page.getByTestId("timeline").getByRole("listitem").filter({
      hasText: "runtime_request.created",
    }).first(),
  ).toContainText("permission: Allow the fake driver to write its local fixture?");
  await page.screenshot({
    path: testInfo.outputPath("local-runner-live-permission.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("runtime-request")).toContainText("input request");
  await expect(
    page.getByTestId("timeline").getByRole("listitem").filter({
      hasText: "runtime_request.resolved",
    }).first(),
  ).toContainText("Resolved permission: Allow the fake driver to write its local fixture?");
  await page.waitForTimeout(10_500);
  await page.getByLabel("Response").fill("local-runner-browser-trace");
  await page.getByRole("button", { name: "Send input" }).click();
  await expect(page.getByTestId("live-status")).toHaveText("Terminal");
  await expect(page.getByTestId("parity-result")).toContainText("Match");
});

test("interrupts a live turn without duplicating terminal state", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByLabel("Scenario").selectOption("interrupted");
  await page.getByRole("button", { name: "Start local run" }).click();
  const interrupt = page.getByRole("button", { name: "Interrupt turn" });
  await expect(interrupt).toBeEnabled();
  await interrupt.click();
  await expect(page.getByTestId("live-status")).toHaveText("Terminal");
  await expect(page.getByTestId("terminal-badge")).toHaveText("Cancelled");
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-tone", "neutral");
  await expect(page.getByTestId("terminal-badge")).toHaveAttribute("data-tone", "neutral");
  await expect(page.getByTestId("timeline").getByText("run.terminal")).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath("local-runner-live-interrupted.png"),
    fullPage: true,
  });
});

test("shows failed outcomes as danger and names the duplicate-terminal guard", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Scenario").selectOption("error");
  await page.getByRole("button", { name: "Start local run" }).click();
  await expect(page.getByTestId("live-status")).toHaveText("Terminal");
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-tone", "danger");
  await expect(page.getByTestId("terminal-badge")).toHaveText("Failed");
  await expect(page.getByTestId("terminal-badge")).toHaveAttribute("data-tone", "danger");

  await page.getByLabel("Scenario").selectOption("duplicate-terminal");
  await page.getByRole("button", { name: "Start local run" }).click();
  await expect(page.getByTestId("live-status")).toHaveText("Terminal");
  await expect(
    page.getByTestId("timeline").getByRole("listitem").filter({
      hasText: "harness.diagnostic",
    }),
  ).toContainText(
    "Duplicate terminal event ignored; the first terminal event remains authoritative.",
  );
});
