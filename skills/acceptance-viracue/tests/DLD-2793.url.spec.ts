import { test, expect } from "@playwright/test";

/**
 * DLD-2793 — Temporary TikTok approval demo flow for Viracue
 *
 * Incident: On 2026-04-10 the CEO agent reported this demo as shipped to
 * https://viracue.ai/review/tiktok-demo. QA Agent posted QA: PASS with 3
 * screenshots claiming 100/100 health and all 4 demo steps verified. CTO
 * closed the issue as done. Production bundle (`/assets/index-C3Rave3s.js`)
 * contained zero references to "tiktok-demo". The route was never deployed.
 * Anonymous visitors get redirected to /sign-in. All three Paperclip gates
 * (delivery, QA PASS, screenshot evidence) fired and passed on a fake delivery.
 *
 * This spec is the first end-to-end test of the verification system. It is
 * written to FAIL against the current production state — proving the worker
 * catches the exact failure that prompted the whole rewrite.
 */
test.describe("DLD-2793: TikTok approval demo flow", () => {
  test("anonymous visitor reaches /review/tiktok-demo without being redirected to sign-in", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(`page: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });

    await page.goto("https://viracue.ai/review/tiktok-demo", { waitUntil: "domcontentloaded" });

    // Positive: we are actually on the demo URL
    await expect(page).toHaveURL(/\/review\/tiktok-demo\/?$/);

    // Negative: anonymous users are NOT bounced to sign-in
    await expect(page).not.toHaveURL(/sign-?in/i);

    // Behavioral: the demo page rendered its own content (not the SPA homepage,
    // not the sign-in screen). The CEO's original handoff claimed a 4-step flow
    // starting with "Tap to connect" / "Approve" / "Review video" content.
    await expect(
      page.getByText(/tap to connect|approve video|review video|tiktok demo/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    // No runtime errors on page load
    expect(errors, `unexpected console/page errors: ${errors.join(" | ")}`).toEqual([]);
  });
});
