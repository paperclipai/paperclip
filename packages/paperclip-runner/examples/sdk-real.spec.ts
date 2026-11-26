import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const evidenceRoot = resolve(
  fileURLToPath(new URL("../.paperclip-local/evidence/sdk", import.meta.url)),
);
mkdirSync(evidenceRoot, { recursive: true });

test("runs a direct multi-turn chat through the real Codex driver", async ({ page }) => {
  await page.goto("/reference-console/");
  await expect(page.getByTestId("console-version")).toHaveText("🖇️ v0.1.2");
  await page.getByTestId("composer-input").fill("Reply with exactly: direct chat works");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("runner-transcript")).toContainText("direct chat works", {
    timeout: 180_000,
  });
  await expect(page.getByTestId("composer-send")).toHaveText("Send", { timeout: 30_000 });
  await page.getByTestId("composer-input").fill("Reply with exactly: follow-up works");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("runner-transcript")).toContainText("follow-up works", {
    timeout: 180_000,
  });
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Live console boundary: operate only");
  expect(body).not.toContain("Do not discover or invoke skills");
  await page.getByTestId("toggle-inspector").click();
  await expect(page.getByRole("complementary", { name: "Protocol inspector" })).toBeVisible();
  await page.screenshot({
    path: resolve(evidenceRoot, "reference-direct-chat-codex-1440x900.png"),
  });
});

test("runs the reference console through the real Codex driver", async ({ page }) => {
  await page.goto("/reference-console/");
  await expect(page.getByTestId("manifest-completion")).toBeVisible();
  await page.getByTestId("manifest-completion").click();
  await page.getByTestId("run-manifest").click();
  await expect(page.locator("body")).toContainText("Turn completed", { timeout: 180_000 });
  await expect(page.getByTestId("structured-response")).toBeVisible();
  await expect(page.getByTestId("structured-response")).toContainText("Agent response");
  await expect(page.getByText("Completion details", { exact: true })).toBeVisible();
  const responseVisibility = await page.getByTestId("structured-response").evaluate((response) => {
    const viewport = response.closest('[data-testid="runner-transcript"]');
    if (!(viewport instanceof HTMLElement)) return false;
    const responseBox = response.getBoundingClientRect();
    const viewportBox = viewport.getBoundingClientRect();
    return responseBox.top >= viewportBox.top && responseBox.top < viewportBox.bottom;
  });
  expect(responseVisibility).toBe(true);
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
