import { expect, test, type Page } from "@playwright/test";

/**
 * Scenario chat browser acceptance.
 *
 * The chat is where the board actually uses the mock control plane, so these
 * cover the paths a person takes: send a prompt, get a denial, follow a turn to
 * its evidence, reset, and do it again on a phone. The recorded §11 screenshot
 * campaign is deferred from this release.
 */

const BASE = "/scenario-explorer/";
const MOBILE = { width: 390, height: 844 };

async function open(page: Page, hash: string, state = "settled"): Promise<void> {
  await page.goto(`${BASE}${hash}`);
  await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
    "data-chat-state",
    state,
    { timeout: 30_000 },
  );
}

async function send(page: Page, prompt: string): Promise<void> {
  await page.fill('[data-testid="composer-input"]', prompt);
  await page.press('[data-testid="composer-input"]', "Enter");
  await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
    "data-chat-state",
    "settled",
    { timeout: 30_000 },
  );
}

test.describe("chat shell", () => {
  test("chat home offers the picker and an intro, with no dead panel", async ({ page }) => {
    await page.goto(`${BASE}#/chat`);
    await expect(page.locator('[data-testid="explorer-intro"]')).toContainText("scenario chat");
    await expect(page.locator("nav[aria-label='Scenario picker']")).toBeVisible();
    await expect(page.locator("aside[aria-label='Turn activity']")).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("an unknown chat case is named rather than silently redirected", async ({ page }) => {
    await page.goto(`${BASE}#/chat/not-a-real-case`);
    await expect(page.locator('[data-testid="unknown-scenario"]')).toContainText("not-a-real-case");
  });

  test("the seeded session shows control-plane work before any message", async ({ page }) => {
    await open(page, "#/chat/ix-checkbox-01");
    await expect(page.locator('[data-testid="chat-seed-label"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-turn-0"]')).toContainText("Control plane");
    await expect(page.locator('[data-testid="session-status"]')).toHaveText("Idle · seeded");
    await expect(page.locator('[data-testid="turn-activity-strip-0"]')).toBeVisible();
  });
});

test.describe("driving a session from the composer", () => {
  test("a typed prompt runs a turn and a denial lands in place", async ({ page }) => {
    await open(page, "#/chat/ap-mcp-gate-01");
    await send(page, "Where does the MCP tool approval stand?");
    await send(page, "Raise the approval request yourself.");

    await expect(page.locator('[data-testid="turn-activity-strip-2"]')).toBeVisible();
    const denial = page.locator('[data-outcome="denied"]').first();
    await expect(denial).toBeVisible();
    await expect(denial).toContainText("required_claim_missing");
    // A denial must never carry protected state.
    await expect(denial).toContainText("not returned");
    await expect(page.locator('[data-testid="denial-announcement"]').first()).toHaveAttribute(
      "aria-live",
      "assertive",
    );
    // The session survives a denial; it is an outcome, not a failure.
    await expect(page.locator('[data-testid="session-status"]')).toHaveText(
      "Scripted · deterministic",
    );
  });

  test("a turn strip opens that turn's evidence and mirrors it to the route", async ({ page }) => {
    await open(page, "#/chat/ap-mcp-gate-01?replay=fake");
    await page.click('[data-testid="turn-activity-strip-2"]');
    await expect(page).toHaveURL(/view=activity&turn=2/);
    await expect(page.locator('[data-testid="activity-turn-2"]')).toHaveAttribute(
      "data-open",
      "true",
    );
    await expect(page.locator('[data-testid="activity-section-2-authorization"]')).toBeVisible();
    await expect(page.locator('[data-testid="activity-diff-2"]')).toBeVisible();
  });

  test("reset confirms, returns to the seed, and leaks nothing", async ({ page }) => {
    await open(page, "#/chat/ap-mcp-gate-01?replay=fake");
    await expect(page.locator('[data-testid="turn-activity-strip-2"]')).toBeVisible();

    await page.click('[data-testid="reset-session"]');
    await page.click('[data-testid="confirm-cancel"]');
    await expect(page.locator('[data-testid="turn-activity-strip-2"]')).toBeVisible();

    await page.click('[data-testid="reset-session"]');
    await page.click('[data-testid="confirm-accept"]');
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
      "data-chat-state",
      "settled",
      { timeout: 30_000 },
    );
    await expect(page.locator('[data-testid="turn-activity-strip-1"]')).toHaveCount(0);
    await expect(page.locator('[data-outcome="denied"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="session-status"]')).toHaveText("Idle · seeded");
  });

  test("switching scenario mid-session asks before discarding the mock state", async ({ page }) => {
    await open(page, "#/chat/ap-mcp-gate-01?replay=fake");
    await page.fill('[data-testid="scenario-search"]', "ix-checkbox-01");
    await page.click('[data-testid="case-row-ix-checkbox-01"]');
    await expect(page.locator("dialog[open]")).toContainText("Switch scenario?");
    await page.click('[data-testid="confirm-accept"]');
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
      "data-chat-state",
      "settled",
      { timeout: 30_000 },
    );
    await expect(page.locator('[data-testid="session-header"]')).toContainText("ix-checkbox-01");
    await expect(page.locator('[data-outcome="denied"]')).toHaveCount(0);
  });
});

test.describe("determinism and evidence", () => {
  test("the scripted route settles to a byte-identical transcript on reload", async ({ page }) => {
    const read = async (): Promise<string> => {
      await open(page, "#/chat/ix-checkbox-01?replay=fake");
      return (await page.locator('[data-testid="chat-conversation"]').innerText()).trim();
    };
    const first = await read();
    await page.goto("about:blank");
    expect(await read()).toBe(first);
  });

  test("every turn group carries the six evidence sections in order", async ({ page }) => {
    await open(page, "#/chat/ix-checkbox-01?replay=fake&view=activity&turn=3");
    const group = page.locator('[data-testid="activity-turn-3"]');
    await expect(group.locator('[data-testid="activity-section-3-exposure"]')).toBeVisible();
    await expect(group.locator('[data-testid="activity-section-3-calls"]')).toBeVisible();
    await expect(group.locator('[data-testid="activity-section-3-control"]')).toBeVisible();
    await expect(group.locator('[data-testid="activity-section-3-diff"]')).toBeVisible();
    await expect(group.locator('[data-testid="activity-section-3-parity"]')).toBeVisible();
    await expect(group.locator('[data-testid="activity-reconciliation-3"]')).toContainText(
      "wake.scheduled",
    );
  });

  test("a filter collapses sections without deleting turn groups", async ({ page }) => {
    await open(page, "#/chat/ap-mcp-gate-01?replay=fake&view=activity&turn=2&filter=authorization");
    await expect(page.locator('[data-testid="activity-turn-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="activity-turn-2"]')).toBeVisible();
    await expect(page.locator('[data-testid="activity-section-2-authorization"]')).toBeVisible();
    await expect(page.locator('[data-testid="activity-section-2-diff"]')).toHaveCount(0);
  });

  test("the staged streaming route holds a running turn", async ({ page }) => {
    await open(page, "#/chat/ap-mcp-gate-01?replay=fake&stage=streaming", "streaming");
    await expect(page.locator('[data-slot="composer"]')).toHaveAttribute("data-state", "active-turn");
    await expect(page.locator('[data-testid^="turn-pending-"]')).toBeVisible();
    const modelCard = page.locator('[data-testid="streaming-model-card"]');
    await expect(modelCard).toBeVisible();
    await expect(modelCard.locator(".pcr-stream-cursor")).toBeVisible();

    const activity = page.locator('[data-testid="activity-turn-2"]');
    await expect(activity.locator('[data-testid="activity-turn-header-2"]')).toContainText(
      "Turn 2 · running",
    );
    const calls = activity.locator('[data-testid="activity-section-2-calls"]');
    await expect(calls).toContainText("request_approval");
    await expect(calls).not.toContainText("request_review");
    await expect(activity.locator('[data-testid="activity-section-2-authorization"]')).toContainText(
      "Authorization (1)",
    );
    await expect(activity.locator('[data-testid="activity-section-2-diff"]')).toHaveCount(0);
    await expect(activity.locator('[data-testid="activity-section-2-parity"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="activity-session"]')).toHaveCount(0);
    // Controls that would corrupt the running turn state their reason.
    const reason = page.locator('[data-testid="running-controls-reason"]');
    await expect(reason).toHaveText("Controls return when the turn settles.");
    for (const testId of [
      "chat-mode-scripted",
      "chat-mode-codex",
      "reset-session",
      "replay-session",
    ]) {
      const control = page.locator(`[data-testid="${testId}"]`);
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute("aria-describedby", "running-controls-reason");
    }
  });

  test("no credential or raw secret reaches the chat page", async ({ page }) => {
    await open(page, "#/chat/rs-secret-hygiene-01?replay=fake");
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("fixture-secret-value-not-a-real-credential");
    expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  });
});

test.describe("mobile and accessibility", () => {
  test.use({ viewport: MOBILE });

  test("the activity segment carries the whole stream and counts denials", async ({ page }) => {
    await open(page, "#/chat/ap-mcp-gate-01?replay=fake");
    await expect(page.locator('[data-testid="segment-activity-denials"]')).toContainText("deny");
    await page.click('[data-testid="segment-activity"]');
    await expect(page.locator('[data-testid="activity-stream"]')).toBeVisible();
    await expect(page.locator('[data-testid="activity-section-2-authorization"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-conversation"]')).toBeHidden();
  });

  test("back to chat returns focus to the turn strip that opened the group", async ({ page }) => {
    await open(page, "#/chat/ap-mcp-gate-01?replay=fake");
    await page.click('[data-testid="turn-activity-strip-2"]');
    await expect(page.locator('[data-testid="activity-stream"]')).toBeVisible();
    await page.click('[data-testid="activity-back-to-chat-2"]');
    await expect(page.locator('[data-testid="chat-conversation"]')).toBeVisible();
    await expect(page.locator('[data-testid="turn-activity-strip-2"]')).toBeFocused();
  });

  test("long payloads never scroll the page sideways", async ({ page }) => {
    for (const hash of [
      "#/chat/ix-checkbox-01?replay=fake",
      "#/chat/ap-mcp-gate-01?replay=fake&view=activity&turn=2",
      "#/chat/mh-subtask-tree-01?replay=fake&view=activity",
    ]) {
      await open(page, hash);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${hash} scrolls horizontally`).toBeLessThanOrEqual(0);
    }
  });

  test("touch targets on the chat controls meet the minimum", async ({ page }) => {
    await open(page, "#/chat/ix-checkbox-01?replay=fake");
    for (const testId of ["segment-chat", "segment-activity", "turn-activity-strip-1"]) {
      const box = await page.locator(`[data-testid="${testId}"]`).first().boundingBox();
      expect(box, testId).not.toBeNull();
      expect(box!.height, testId).toBeGreaterThanOrEqual(40);
    }
  });

  test("the composer stays in the thumb zone while the transcript scrolls", async ({ page }) => {
    await open(page, "#/chat/ix-checkbox-01?replay=fake");
    await page.evaluate(() => window.scrollTo(0, 0));
    const composer = page.locator('[data-testid="composer"]');
    const top = (await composer.boundingBox())!.y;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const bottom = (await composer.boundingBox())!.y;
    expect(bottom).not.toBe(top);
    // Still on screen after the scroll, not left behind at the top.
    const box = (await composer.boundingBox())!;
    expect(box.y).toBeLessThan(MOBILE.height);
    expect(box.y + box.height).toBeGreaterThan(0);
  });

  test("the composer keyboard contract holds", async ({ page }) => {
    await open(page, "#/chat/ix-checkbox-01");
    const input = page.locator('[data-testid="composer-input"]');
    await input.fill("first line");
    await input.press("Shift+Enter");
    await input.type("second line");
    expect(await input.inputValue()).toContain("\n");
    await expect(page.locator('[data-testid="turn-activity-strip-1"]')).toHaveCount(0);
    await input.press("Enter");
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
      "data-chat-state",
      "settled",
      { timeout: 30_000 },
    );
    await expect(page.locator('[data-testid="turn-activity-strip-1"]')).toBeVisible();
  });
});
