import { expect, test } from "@playwright/test";

test("validates and renders the shared Phase 1 fixture", async ({ page }, testInfo) => {
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
    path: testInfo.outputPath("phase-01-static-replay.png"),
    fullPage: true,
  });
});

test("shows Phase 3 recovery diagnostics without secrets", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Recovery", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Durable recovery diagnostics" })).toBeVisible();
  const fault = page.getByLabel("Fault", { exact: true });
  await expect(fault).toHaveValue("lost-ack");
  expect(await fault.locator("option").allTextContents()).toEqual([
    "Normal connection",
    "Socket drop",
    "Lost ACK",
    "Duplicate command",
    "Runner restart",
    "Harness restart",
    "Malformed input",
    "Lease expiry",
    "Storage pressure",
    "Drain",
    "Revoke",
  ]);
  await fault.selectOption("none");
  await page.getByRole("button", { name: "Run Phase 3 recovery" }).click();
  await expect(fault).toBeDisabled();
  await expect(page.getByText("complete", { exact: true })).toBeVisible();
  await expect(fault).toBeEnabled();
  await expect(page.getByTestId("phase3-connection-state")).toHaveText("Stopped");
  await expect(page.getByTestId("phase3-connections")).toHaveText("1");
  await expect(page.getByTestId("phase3-reconnects")).toHaveText("0");
  await expect(page.getByTestId("phase3-runner-restarts")).toHaveText("0");
  await expect(page.getByTestId("phase3-fresh-bootstraps")).toHaveText("1");
  await expect(page.getByTestId("phase3-diagnostics")).toContainText("At-least-once redeliveries");
  await expect(page.getByTestId("phase3-diagnostics")).toContainText("Duplicate commands");
  await expect(page.getByTestId("phase3-storage")).toContainText("0 bytes of 65536 max");
  await expect(page.getByTestId("phase3-outcome")).toHaveText("Recovered");
  await expect(page.getByTestId("phase3-outcome")).toHaveAttribute("data-tone", "success");
  await expect(page.getByTestId("recovery-history").getByRole("listitem")).toHaveCount(9);
  const firstRecoveryEvent = page.getByTestId("recovery-history").getByRole("listitem").first();
  await expect(firstRecoveryEvent).toContainText("workspace.ready");
  await expect(firstRecoveryEvent.getByText("delivered 2×")).toBeVisible();
  await expect(page.getByText("Preserved", { exact: true })).toBeVisible();
  await expect(page.getByText("Yes", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("leaseToken");
  await expect(page.locator("body")).not.toContainText("bootstrapTicket");
  await page.screenshot({ path: testInfo.outputPath("phase-03-recovery-diagnostics.png"), fullPage: true });
});

test("tones failure outcomes and storage backpressure", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Recovery", exact: true }).click();
  const fault = page.getByLabel("Fault", { exact: true });
  const run = page.getByRole("button", { name: "Run Phase 3 recovery" });

  await fault.selectOption("revoke");
  await run.click();
  await expect(page.getByTestId("phase3-outcome")).toHaveText("Revoked");
  await expect(page.getByTestId("phase3-outcome")).toHaveAttribute("data-tone", "warning");
  await expect(page.getByText("Revoke completed", { exact: true })).toBeVisible();

  await fault.selectOption("storage-pressure");
  await run.click();
  await expect(page.getByTestId("phase3-storage")).toContainText("0 bytes of 16384 max");
  await expect(page.getByTestId("phase3-storage").getByText("Backpressure")).toHaveAttribute(
    "data-tone",
    "warning",
  );
});

test("keeps recovery diagnostics within the narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Recovery", exact: true }).click();
  await page.getByLabel("Fault", { exact: true }).selectOption("none");
  await page.getByRole("button", { name: "Run Phase 3 recovery" }).click();
  await expect(page.getByTestId("recovery-history")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("phase-03-recovery-diagnostics-mobile.png"),
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
    path: testInfo.outputPath("phase-02-live-complete.png"),
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
    path: testInfo.outputPath("phase-02-live-permission.png"),
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
  await page.getByLabel("Response").fill("phase-02-browser-trace");
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
    path: testInfo.outputPath("phase-02-live-interrupted.png"),
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
