import { expect, test } from "@playwright/test";
import { assertNativeBlockerReply } from "./native-blocker-visible.js";

test("accepts a visible blocker explanation rather than requiring a marker-only reply", async ({ page }) => {
  await page.setContent('<div data-testid="reply">Deployment is <strong>blocked</strong>.<br>Release Owner must Grant deployment access. BLOCKED_probe</div>');
  await assertNativeBlockerReply(page.getByTestId("reply"), "BLOCKED_probe", 100);
});

test("accepts a future access condition while the task remains blocked", async ({ page }) => {
  await page.setContent('<div data-testid="reply">Deployment remains blocked until access is granted. Release Owner must Grant deployment access. BLOCKED_probe</div>');
  await assertNativeBlockerReply(page.getByTestId("reply"), "BLOCKED_probe", 100);
});

for (const [name, body] of [
  ["marker only", "BLOCKED_probe"],
  ["missing owner", "Blocked. Someone must Grant deployment access. BLOCKED_probe"],
  ["missing action", "Blocked. Release Owner must take action. BLOCKED_probe"],
  ["missing reason", "Release Owner: Grant deployment access. BLOCKED_probe"],
  ["contradictory disposition", "Deployment is not blocked. Release Owner completed Grant deployment access. BLOCKED_probe"],
  ["resolved blocker", "Deployment is no longer blocked. Release Owner must Grant deployment access. BLOCKED_probe"],
  ["granted access", "Blocked. Access already granted. Release Owner must Grant deployment access. BLOCKED_probe"],
  ["duplicate replies", "Blocked. Release Owner must Grant deployment access. BLOCKED_probe</div><div data-testid=reply>BLOCKED_probe"],
]) {
  test(`rejects ${name}`, async ({ page }) => {
    await page.setContent(`<div data-testid="reply">${body}</div>`);
    await expect(assertNativeBlockerReply(page.getByTestId("reply"), "BLOCKED_probe", 100)).rejects.toThrow();
  });
}
