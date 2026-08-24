import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const evidenceRoot = resolve(fileURLToPath(new URL("../knowledge/evidence/phase-05", import.meta.url)));
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
mkdirSync(evidenceRoot, { recursive: true });

async function screenshotPair(page: Page, name: string, mobileSegment = "chat") {
  await page.setViewportSize(DESKTOP);
  await page.screenshot({ path: resolve(evidenceRoot, `reference-${name}-1440x900.png`) });
  await page.setViewportSize(MOBILE);
  await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
  const segment = page.getByRole("tab", { name: new RegExp(`^${mobileSegment}$`, "i") });
  await segment.click();
  await expect(page.locator('[data-slot="runner-console-app"]')).toBeVisible();
  await page.screenshot({ path: resolve(evidenceRoot, `reference-${name}-390x844.png`) });
  await page.setViewportSize(DESKTOP);
}

async function miniScreenshotPair(page: Page, name: string) {
  await page.setViewportSize(DESKTOP);
  await page.screenshot({ path: resolve(evidenceRoot, `mini-${name}-1440x900.png`) });
  await page.setViewportSize(MOBILE);
  await page.screenshot({ path: resolve(evidenceRoot, `mini-${name}-390x844.png`) });
  await page.setViewportSize(DESKTOP);
}

async function openReference(page: Page) {
  await page.setViewportSize(DESKTOP);
  await page.goto("/reference-console/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("manifest-list")).toBeVisible();
}

async function runManifest(page: Page, id: string) {
  await page.getByTestId(`manifest-${id}`).click();
  await page.getByTestId("run-manifest").click();
  await expect(page.getByTestId("connection-status")).toHaveText("connected", { timeout: 15_000 });
}

test.describe("Phase 5 reference console evidence", () => {
  test("captures idle and streaming states at both canonical viewports", async ({ page }) => {
    await openReference(page);
    await expect(page.getByTestId("empty-transcript")).toBeVisible();
    await screenshotPair(page, "idle-empty");

    await runManifest(page, "completion");
    await expect(page.getByTestId("reasoning-item")).toBeVisible();
    await expect(page.getByTestId("composer-send")).toHaveText("Steer");
    await screenshotPair(page, "streaming-turn");
    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });
    expect(await page.locator("body").innerText()).not.toContain("Bearer ");
    expect(await page.locator("body").innerText()).not.toContain("auth.json");
  });

  test("captures steering and interrupt states", async ({ page }) => {
    await openReference(page);
    await runManifest(page, "steering");
    await expect(page.getByTestId("composer-send")).toHaveText("Steer");
    await page.getByTestId("composer-input").fill("Keep it short.");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("steering-chip")).toContainText("acknowledged", { timeout: 15_000 });
    await screenshotPair(page, "steering-acknowledged");

    await page.getByRole("button", { name: "Reset demo state", exact: true }).click();
    await page.getByTestId("reset-confirm").click();
    await runManifest(page, "interrupt-during-generation");
    await expect(page.getByTestId("runner-transcript")).toContainText("The tracer keeps", { timeout: 15_000 });
    await page.getByTestId("composer-stop").click();
    await expect(page.getByTestId("turn-interrupted")).toBeVisible({ timeout: 15_000 });
    await screenshotPair(page, "interrupt");
  });

  test("captures request, goal, reconnect, replay, and failure states", async ({ page }) => {
    await openReference(page);
    await runManifest(page, "approvals");
    await expect(page.getByTestId("request-card").first()).toHaveAttribute("data-status", "pending", { timeout: 15_000 });
    await screenshotPair(page, "request-pending");
    await page.getByTestId("request-action-accept").first().click();
    await expect(page.getByTestId("request-card").first()).toHaveAttribute("data-status", "resolved", { timeout: 15_000 });
    await screenshotPair(page, "request-resolved");

    await page.getByRole("button", { name: "Reset demo state", exact: true }).click();
    await page.getByTestId("reset-confirm").click();
    await runManifest(page, "goals");
    await page.getByRole("button", { name: "Goal", exact: true }).click();
    await page.getByRole("menuitem", { name: "Set goal…" }).click();
    await page.getByTestId("goal-objective").fill("Prove the SDK lifecycle.");
    await page.getByTestId("goal-set-confirm").click();
    await expect(page.getByTestId("goal-banner")).toContainText("Prove the SDK lifecycle.");
    await screenshotPair(page, "goal-set", "session");

    await page.setViewportSize(DESKTOP);
    await page.getByTestId("drop-connection").click();
    await expect(page.getByTestId("reconnect-banner")).toBeVisible();
    await screenshotPair(page, "reconnect-banner");
    await expect(page.getByTestId("connection-status")).toHaveText("connected", { timeout: 10_000 });

    await page.getByTestId("toggle-replay").click();
    await expect(page.getByTestId("replay-controls")).toBeVisible();
    await page.getByRole("button", { name: "Step forward" }).click();
    await screenshotPair(page, "replay-mode");

    await page.setViewportSize(DESKTOP);
    await page.getByTestId("toggle-replay").click();
    await page.getByRole("button", { name: "Reset demo state", exact: true }).click();
    await page.getByTestId("reset-confirm").click();
    await runManifest(page, "failure");
    await expect(page.getByTestId("turn-failed")).toBeVisible({ timeout: 20_000 });
    await screenshotPair(page, "failed-turn");
  });
});

test.describe("Phase 5 mini consumer evidence", () => {
  test("uses public render, token, request, reconnect, and replay extension points", async ({ page }) => {
    await page.goto("/mini-consumer/");
    await expect(page.getByRole("heading", { name: "Runner mini consumer" })).toBeVisible();
    await miniScreenshotPair(page, "idle");

    await page.getByRole("button", { name: "Start selected flow" }).click();
    await expect(page.getByText("Mini renderer:").first()).toBeVisible({ timeout: 15_000 });
    await miniScreenshotPair(page, "streaming-custom-renderer-token");

    await page.getByTestId("composer-input").fill("Keep the mini answer short.");
    await expect(page.getByTestId("composer-send")).toHaveText("Steer");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("mini-steering-chip")).toContainText("acknowledged", { timeout: 15_000 });

    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Demo manifest").selectOption("interrupt-during-generation");
    await page.getByRole("button", { name: "Start selected flow" }).click();
    await expect(page.getByTestId("composer-send")).toHaveText("Steer", { timeout: 15_000 });
    await page.getByTestId("composer-stop").click();
    await expect(page.getByTestId("turn-interrupted")).toBeVisible({ timeout: 15_000 });

    await page.getByLabel("Demo manifest").selectOption("approvals");
    await page.getByRole("button", { name: "Start selected flow" }).click();
    await expect(page.getByTestId("request-card").first()).toHaveAttribute("data-status", "pending", { timeout: 15_000 });
    await miniScreenshotPair(page, "request-pending");
    await page.getByTestId("request-action-accept").first().click();
    await expect(page.getByTestId("request-card").first()).toHaveAttribute("data-status", "resolved", { timeout: 15_000 });

    await page.getByTestId("mini-goal-set").click();
    await expect(page.getByTestId("mini-goal-state")).toContainText("Exercise the public SDK.", { timeout: 15_000 });
    await page.getByTestId("mini-goal-clear").click();
    await expect(page.getByTestId("mini-goal-state")).toContainText("none", { timeout: 15_000 });

    await page.getByRole("button", { name: "Drop connection" }).click();
    await expect(page.getByTestId("reconnect-banner")).toBeVisible();
    await miniScreenshotPair(page, "reconnect");
    await expect(page.getByTestId("reconnect-banner")).toHaveCount(0, { timeout: 10_000 });

    await page.getByRole("button", { name: "Enter replay" }).click();
    await expect(page.getByTestId("replay-controls")).toBeVisible();
    await page.getByTestId("replay-position").press("ArrowRight");
    await expect(page.getByTestId("mini-replay-parity")).toContainText("match");
    await miniScreenshotPair(page, "replay");
  });
});

test("meets keyboard, accessibility, responsive, and grid contracts", async ({ page }) => {
  await openReference(page);
  await runManifest(page, "completion");
  await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("composer-input").fill("first");
  await page.getByTestId("composer-input").press("Shift+Enter");
  await expect(page.getByTestId("composer-input")).toHaveValue("first\n");

  await page.getByTestId("toggle-inspector").click();
  await page.getByRole("tab", { name: "Events" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Requests" })).toBeFocused();

  const goalMenu = page.getByRole("button", { name: "Goal", exact: true });
  await goalMenu.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(goalMenu).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);

  await goalMenu.press("ArrowDown");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.getByRole("menuitem", { name: "Set goal…" }).click();
  await expect(page.getByRole("dialog", { name: "Set goal" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Set goal" })).not.toBeVisible();

  await page.getByTestId("toggle-replay").click();
  await page.getByTestId("replay-position").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("replay-position")).toHaveValue("1");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("replay-controls").getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  expect(await page.getByRole("log").count()).toBe(1);
  expect(await page.locator('[aria-live="polite"]').count()).toBe(1);
  const unnamed = await page.locator("button").evaluateAll((buttons) => buttons.filter((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim().length === 0).length);
  expect(unnamed).toBe(0);

  const boxes = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-slot="runner-console-app"]')!;
    const rail = document.querySelector<HTMLElement>(".pcr-console-rail")!;
    const center = document.querySelector<HTMLElement>(".pcr-console-center")!;
    return { root: root.getBoundingClientRect(), rail: rail.getBoundingClientRect(), center: center.getBoundingClientRect() };
  });
  expect(boxes.rail.right).toBeLessThanOrEqual(boxes.center.left);
  expect(boxes.center.right).toBeLessThanOrEqual(boxes.root.right);

  await page.setViewportSize(MOBILE);
  await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
  expect(await page.getByRole("log").count()).toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
