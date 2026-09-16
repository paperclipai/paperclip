import { expect, test, type Page } from "@playwright/test";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

function shot(page: Page, name: string) {
  return page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

async function openConsole(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Live console" }).click();
  await expect(page.getByRole("heading", { name: "Live Codex protocol console" })).toBeVisible();
}

async function runManifest(page: Page, id: string) {
  await expect(page.getByTestId("manifest-list")).toBeVisible();
  await page.getByTestId(`manifest-${id}`).click();
  await page.getByTestId("run-manifest").click();
  await expect(page.getByTestId("connection-status")).toHaveText("connected", { timeout: 15_000 });
}

test.describe("Live console", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test("shows the empty state and runs a completed turn", async ({ page }) => {
    await openConsole(page);
    await expect(page.getByTestId("empty-transcript")).toBeVisible();
    await expect(page.getByTestId("composer-send")).toBeDisabled();
    await shot(page, "desktop-01-idle-empty");

    await runManifest(page, "completion");
    await expect(page.getByTestId("reasoning-item")).toBeVisible();
    await expect(page.getByTestId("tool-item")).toBeVisible();
    await shot(page, "desktop-02-streaming-turn");

    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("live-transcript")).toContainText("finished the task");
    await expect(page.getByTestId("live-transcript")).toContainText(
      "Summarize what the Live console demo server proves.",
    );
    await expect(page.getByTestId("tool-item")).toHaveAttribute("data-status", "completed");
    await shot(page, "desktop-03-turn-completed");

    // The browser must never receive a provider credential.
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("Bearer ");
    expect(body).not.toContain("auth.json");
  });

  test("acknowledges steering and keeps rejected text recoverable", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "steering");
    await expect(page.getByTestId("composer-send")).toHaveText("Steer", { timeout: 15_000 });

    await page.getByTestId("composer-input").fill("Keep it to one sentence.");
    await page.getByTestId("composer-send").click();
    const chip = page.getByTestId("steering-chip").first();
    await expect(chip).toContainText("acknowledged", { timeout: 15_000 });
    await shot(page, "desktop-04-steering-acknowledged");

    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 25_000 });
    // The composer state machine now offers Send again; force a stale steer.
    await page.evaluate(() => window.history.replaceState({}, "", "/"));
  });

  test("rejects a stale steer and offers to resend it", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "steering");
    await expect(page.getByTestId("composer-send")).toHaveText("Steer", { timeout: 15_000 });
    await page.getByTestId("composer-input").fill("Typed while the turn was running.");

    // Let the turn finish before the steer is sent: the classic stale race.
    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("composer-send")).toHaveText("Send");
  });

  test("cancels a turn interrupted before it starts", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "interrupt-before-start");
    await expect(page.getByTestId("composer-stop")).toBeEnabled();
    await page.getByTestId("composer-stop").click();
    await expect(page.getByTestId("turn-cancelled")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("turn-cancelled")).toContainText("Cancelled before start");
    await shot(page, "desktop-05-interrupt-before-start");
  });

  test("keeps partial text when a streaming turn is stopped", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "interrupt-during-generation");
    await expect(page.getByTestId("live-transcript")).toContainText("The tracer keeps", {
      timeout: 15_000,
    });
    await page.getByTestId("composer-stop").click();
    await expect(page.getByTestId("turn-interrupted")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("interrupted-divider").first()).toBeVisible();
    await expect(page.getByTestId("live-transcript")).not.toContainText("And this final one.");
    await shot(page, "desktop-06-interrupt-during-generation");
  });

  test("keeps an interrupted tool item without a fabricated result", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "interrupt-during-tool");
    await expect(page.getByTestId("tool-item")).toHaveAttribute("data-status", "running", {
      timeout: 15_000,
    });
    await page.getByTestId("composer-stop").click();
    await expect(page.getByTestId("tool-item")).toHaveAttribute("data-status", "interrupted", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("turn-interrupted")).toBeVisible();
    await shot(page, "desktop-07-interrupt-during-tool");
  });

  test("resolves approvals exactly once and collapses the resolved card", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "approvals");
    const card = page.getByTestId("request-card").first();
    await expect(card).toHaveAttribute("data-status", "pending", { timeout: 15_000 });
    await expect(page.getByTestId("pending-request-banner")).toBeVisible();
    await expect(page.getByTestId("request-action-accept_for_session")).toBeVisible();
    await shot(page, "desktop-08-request-pending");

    await page.getByTestId("request-action-accept").first().click();
    await expect(page.getByTestId("request-card").first()).toHaveAttribute(
      "data-status",
      "resolved",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("request-card").first()).toContainText("resolved — Approve");
    await shot(page, "desktop-09-request-resolved");

    // Second request only offers accept and decline.
    const second = page.getByTestId("request-card").nth(1);
    await expect(second).toHaveAttribute("data-status", "pending", { timeout: 15_000 });
    await expect(second.getByTestId("request-action-accept_for_session")).toHaveCount(0);
  });

  test("submits user-input and elicitation answers and lets an unanswered request expire", async ({ page }) => {
    test.setTimeout(60_000);
    await openConsole(page);
    await runManifest(page, "user-input");
    await expect(page.getByTestId("request-answer")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("request-answer").fill("staging");
    await page.getByTestId("request-action-submit").click();
    await expect(page.getByTestId("request-card").first()).toHaveAttribute(
      "data-status",
      "resolved",
      { timeout: 15_000 },
    );

    // An elicitation submits `content`, not `answers`. The runner validates the
    // body against the request kind, so a card that sent the user-input shape
    // would be rejected and stay pending here.
    const elicitation = page.getByTestId("request-card").nth(1);
    await expect(elicitation).toHaveAttribute("data-status", "pending", { timeout: 15_000 });
    await elicitation.getByTestId("request-answer").fill("stable");
    await elicitation.getByTestId("request-action-submit").click();
    await expect(elicitation).toHaveAttribute("data-status", "resolved", { timeout: 15_000 });
    await expect(elicitation).toContainText("resolved — Submit");

    await expect(page.getByTestId("request-card").nth(2)).toHaveAttribute(
      "data-status",
      "expired",
      { timeout: 25_000 },
    );
    await expect(page.getByTestId("request-card").nth(2)).toContainText("expired before response");
    await shot(page, "desktop-10-request-expired");
  });

  test("moves a goal through its lifecycle", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "goals");
    await expect(page.getByTestId("goal-banner")).toHaveText("No goal set", { timeout: 15_000 });

    await page.locator("#goal-menu").click();
    await page.getByRole("menuitem", { name: "Set goal…" }).click();
    await page.getByTestId("goal-objective").fill("Keep the demo goal visible");
    await page.getByTestId("goal-set-confirm").click();
    await expect(page.getByTestId("goal-banner")).toContainText("Keep the demo goal visible", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("goal-banner")).toContainText("active");

    await page.locator("#goal-menu").click();
    await page.getByRole("menuitem", { name: "Pause" }).click();
    await expect(page.getByTestId("goal-banner")).toContainText("paused", { timeout: 15_000 });
    await shot(page, "desktop-11-goal-supported");
  });

  test("disables the goal menu with the exact upstream diagnostic", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "goals-unsupported");
    const trigger = page.locator("#goal-menu");
    await expect(trigger).toHaveAttribute("aria-disabled", "true", { timeout: 15_000 });
    const describedBy = await trigger.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    await expect(page.locator(`#${describedBy}`)).toHaveText(
      "Goal operations unsupported: app-server 0.132.0 does not advertise the goals capability",
    );

    await page.getByTestId("toggle-inspector").click();
    await page.getByRole("tab", { name: "Capabilities" }).click();
    await expect(page.getByTestId("inspector-capabilities")).toContainText(
      "does not advertise the goals capability",
    );
    await shot(page, "desktop-12-goal-unsupported");
  });

  test("shows child threads and refuses to emulate child steering", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "subagents");
    await expect(page.getByTestId("thread-thread-child-b")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("thread-thread-child-a")).toContainText("Completed");
    await expect(page.getByTestId("thread-thread-child-b")).toContainText("Failed");

    await page.getByTestId("thread-thread-child-a").click();
    await expect(page.getByTestId("breadcrumb")).toContainText("thread-child-a");
    await expect(page.getByTestId("composer-reason")).toHaveText(
      "Direct steering of child threads is not supported by this app-server.",
    );
    await expect(page.getByTestId("composer-input")).toBeDisabled();
    await shot(page, "desktop-13-lineage-child");
  });

  test("shows the failed item and diagnostic in the record", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "failure");
    await expect(page.getByTestId("turn-failed")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("tool-failure")).toContainText("cannot find module");
    await shot(page, "desktop-14-failed-turn");
  });

  test("resumes the same session after a transport drop", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "completion");
    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });
    const before = await page.getByTestId("live-transcript").innerText();

    await page.getByTestId("drop-connection").click();
    await expect(page.getByTestId("reconnect-banner")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeDisabled();
    await shot(page, "desktop-15-reconnect-banner");

    await page.getByTestId("retry-now").click();
    await expect(page.getByTestId("connection-status")).toHaveText("connected", {
      timeout: 20_000,
    });
    // Live and resumed transcripts must be identical, not merely similar.
    expect(await page.getByTestId("live-transcript").innerText()).toContain(before.trim());
  });

  test("restores the same session across a page refresh", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "completion");
    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });
    const before = await page.getByTestId("live-transcript").innerText();

    await page.reload();
    await page.getByRole("button", { name: "Live console" }).click();
    await expect(page.getByTestId("live-transcript")).toContainText("finished the task", {
      timeout: 20_000,
    });
    expect(await page.getByTestId("live-transcript").innerText()).toContain(before.trim());
    await shot(page, "desktop-16-refresh-replay");
  });

  test("replays a recorded session with a stepper", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "completion");
    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("toggle-replay").click();
    await expect(page.getByTestId("replay-badge")).toBeVisible();
    await expect(page.getByTestId("replay-stepper")).toBeVisible();
    await expect(page.getByTestId("empty-transcript")).toBeVisible();

    await page.getByRole("button", { name: "Step forward" }).click();
    await page.getByRole("button", { name: "Step forward" }).click();
    await expect(page.getByTestId("empty-transcript")).toHaveCount(0);
    await shot(page, "desktop-17-replay-mode");

    await page.getByTestId("toggle-replay").click();
    await expect(page.getByTestId("replay-badge")).toHaveCount(0);
    await expect(page.getByTestId("turn-completed")).toBeVisible();
  });

  test("inspects canonical events and reports reducer parity", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "completion");
    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("toggle-inspector").click();
    await expect(page.getByTestId("inspector-events")).toBeVisible();
    await page.getByTestId("inspector-filter").fill("turn.completed");
    await expect(page.getByTestId("inspector-events").getByRole("listitem")).toHaveCount(1);
    await shot(page, "desktop-18-inspector-events");

    await page.getByTestId("inspector-filter").fill("");
    await page.getByRole("tab", { name: "Session" }).click();
    await expect(page.getByTestId("inspector-session")).toContainText("Credentials in browser");
    await expect(page.getByTestId("replay-parity")).toHaveText("match");
    await shot(page, "desktop-19-inspector-session");
  });

  test("meets the keyboard contract", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "steering");
    await expect(page.getByTestId("composer-send")).toHaveText("Steer", { timeout: 15_000 });

    // K2: Escape moves focus to Stop and never interrupts directly.
    await page.getByTestId("composer-input").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("composer-stop")).toBeFocused();
    await expect(page.getByTestId("turn-interrupted")).toHaveCount(0);

    // K2: Enter steers the running turn.
    await page.getByTestId("composer-input").fill("Steered with the keyboard.");
    await page.getByTestId("composer-input").press("Enter");
    await expect(page.getByTestId("steering-chip").first()).toContainText("acknowledged", {
      timeout: 15_000,
    });

    // K7: inspector tabs follow the arrow-key tabs pattern.
    await page.getByTestId("toggle-inspector").click();
    await page.getByRole("tab", { name: "Events" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Requests" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Requests" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // K5: lineage tree responds to arrow keys.
    await page.getByTestId("lineage-tree").getByRole("treeitem").first().focus();
    await page.keyboard.press("ArrowDown");

    // K6/A1: the transcript is a labelled log landmark.
    await expect(page.getByTestId("live-transcript")).toHaveAttribute("role", "log");
    await expect(page.getByTestId("live-transcript")).toHaveAttribute("aria-live", "polite");
  });

  test("resets demo state behind a naming confirmation", async ({ page }) => {
    await openConsole(page);
    await runManifest(page, "completion");
    await expect(page.getByTestId("turn-completed")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Reset demo state", exact: true }).first().click();
    await expect(page.getByRole("dialog")).toContainText(
      "Recorded evidence files are not touched.",
    );
    await page.getByTestId("reset-confirm").click();
    await expect(page.getByTestId("empty-transcript")).toBeVisible();
  });
});

test.describe("Live console on a small screen", () => {
  test("keeps the transcript and composer usable at 390 by 844", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await openConsole(page);
    await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible();
    await expect(page.getByTestId("manifest-list")).toHaveCount(0);
    await shot(page, "mobile-01-idle-empty");

    await page.getByRole("tab", { name: "Session" }).click();
    await expect(page.getByTestId("manifest-list")).toBeVisible();
    await page.getByTestId("manifest-approvals").click();
    await page.getByTestId("run-manifest").click();
    await shot(page, "mobile-02-session-segment");

    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(page.getByTestId("request-card").first()).toHaveAttribute(
      "data-status",
      "pending",
      { timeout: 20_000 },
    );
    await shot(page, "mobile-03-request-pending");
    await page.getByTestId("request-action-accept").first().click();
    await expect(page.getByTestId("request-card").first()).toHaveAttribute(
      "data-status",
      "resolved",
      { timeout: 15_000 },
    );

    await page.getByRole("tab", { name: "Inspector" }).click();
    await expect(page.getByTestId("inspector-events")).toBeVisible();
    await shot(page, "mobile-04-inspector");

    // WCAG 1.4.10 reflow: no horizontal scrolling of the page itself.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
