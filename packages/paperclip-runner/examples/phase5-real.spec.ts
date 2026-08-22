import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const evidenceRoot = resolve(
  fileURLToPath(new URL("../knowledge/evidence/phase-05", import.meta.url)),
);
mkdirSync(evidenceRoot, { recursive: true });

test("runs the reference console through the real Codex driver", async ({ page }) => {
  await page.goto("/reference-console/");
  await expect(page.getByTestId("manifest-completion")).toBeVisible();
  await page.getByTestId("manifest-completion").click();
  await page.getByTestId("run-manifest").click();
  await expect(page.locator("body")).toContainText("Turn completed", { timeout: 180_000 });
  await expect(page.getByText("Credentials in browser").locator("..")).toContainText("none");
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Bearer ");
  expect(body).not.toContain("auth.json");
  await page.screenshot({
    path: resolve(evidenceRoot, "reference-live-codex-1440x900.png"),
  });
});

test("runs the mini consumer through real session, goal, reconnect, and replay paths", async ({
  page,
}) => {
  await page.goto("/mini-consumer/");
  await expect(page.getByRole("heading", { name: "Runner mini consumer" })).toBeVisible();
  await page.getByLabel("Demo manifest").selectOption("completion");
  await page.getByRole("button", { name: "Start selected flow" }).click();
  await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 180_000 });

  if (await page.getByTestId("mini-goal-set").isEnabled()) {
    await page.getByTestId("mini-goal-set").click();
    await expect(page.getByTestId("mini-goal-state")).toContainText(
      "Exercise the public SDK.",
      { timeout: 30_000 },
    );
    await page.getByTestId("mini-goal-clear").click();
    await expect(page.getByTestId("mini-goal-state")).toContainText("none", {
      timeout: 30_000,
    });
  }

  await page.getByTestId("mini-drop-connection").click();
  await expect(page.getByTestId("reconnect-banner")).toBeVisible();
  await expect(page.getByTestId("reconnect-banner")).toHaveCount(0, { timeout: 30_000 });
  await page.getByTestId("mini-toggle-replay").click();
  await expect(page.getByTestId("replay-controls")).toBeVisible();
  await page.getByTestId("replay-position").press("ArrowRight");
  await expect(page.getByTestId("mini-replay-parity")).toContainText("match");
  await page.screenshot({ path: resolve(evidenceRoot, "mini-live-codex-1440x900.png") });
});
