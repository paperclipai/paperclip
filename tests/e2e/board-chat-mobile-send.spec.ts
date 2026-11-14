import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/**
 * NEXA-261: "on my phone I cannot click the send message button."
 *
 * Two separate things covered the send button on a phone viewport, and both
 * are asserted here:
 *
 *  1. The Conference Room's root used a percent height (`h-[calc(100%+3rem)]`).
 *     The mobile shell is block flow (root `min-h-dvh`, `main` `overflow-visible`
 *     with auto height), so the percentage has nothing to resolve against and
 *     degenerates to auto. The pane then collapsed to its 60px header, the
 *     message viewport measured 0px, and the docked composer rendered ABOVE
 *     the viewport — under the sticky breadcrumb bar, which swallowed its taps.
 *  2. The "Open agent feed" floating action button was `fixed bottom-20 z-20`,
 *     exactly on top of the send button.
 *
 * The hit-chain assertion below fails if either overlay comes back.
 */
test("board chat send message button is tappable on a phone viewport", async ({ page, request }) => {
  const flagRes = await page.request.patch("/api/instance/settings/experimental", {
    data: { enableConferenceRoomChat: true },
  });
  expect(flagRes.ok()).toBe(true);

  const company = await json(await request.post("/api/companies", {
    data: { name: `Mobile Send ${randomUUID()}` },
  }));

  await page.goto(`/${company.issuePrefix}/board-chat`);
  const textarea = page.getByTestId("chat-composer-input");
  await expect(textarea).toBeVisible();

  const sendButton = page.getByRole("button", { name: "Send message" });
  await expect(sendButton).toBeVisible();

  // Type a draft so the button enables, exactly like a user would.
  await textarea.tap();
  await textarea.fill("Hello from a phone");

  // The center of the send button must be the send button itself — not the
  // mobile nav, not the floating agent-feed button, not the sticky top bar.
  const hit = await sendButton.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const center = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      rect: { top: rect.top, bottom: rect.bottom },
      hitIsButton: center === button || button.contains(center),
      hitAriaLabel: center?.getAttribute("aria-label"),
    };
  });

  expect(hit.hitIsButton, `send button center hits ${hit.hitAriaLabel ?? "nothing"}`).toBe(true);

  // The composer must also sit inside the viewport, clear of the sticky top bar
  // (0..60) and the mobile bottom nav (780..844 here).
  expect(hit.rect.bottom).toBeLessThanOrEqual(780);

  // And an actual tap must send the message (optimistic bubble appears).
  await sendButton.tap();
  await expect(page.getByText("Hello from a phone").first()).toBeVisible();
});

/**
 * The fix is mobile-only (`h-(--boardchat-mobile-fill) md:h-(--sz-calc-29)`), so
 * pin the desktop surface down too: the pane still fills its column, the message
 * viewport still has real height, the send button stays tappable, and the agent
 * feed is the always-visible side pane rather than a floating button.
 */
test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test("board chat composer stays docked on a desktop viewport", async ({ page, request }) => {
    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    const company = await json(await request.post("/api/companies", {
      data: { name: `Desktop Send ${randomUUID()}` },
    }));

    await page.goto(`/${company.issuePrefix}/board-chat`);
    await expect(page.getByTestId("chat-composer-input")).toBeVisible();

    const messageViewportHeight = await page
      .locator("main .scrollbar-auto-hide")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(messageViewportHeight).toBeGreaterThan(300);

    const sendButton = page.getByRole("button", { name: "Send message" });
    await page.getByTestId("chat-composer-input").fill("Hello from a desk");

    const hit = await sendButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const center = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        hitIsButton: center === button || button.contains(center),
        bottom: rect.bottom,
      };
    });
    expect(hit.hitIsButton).toBe(true);
    // Docked at the bottom of its pane, not stranded mid-screen.
    expect(hit.bottom).toBeGreaterThan(600);

    // Desktop keeps the agent feed as an always-visible side pane, with no
    // floating toggle. The pane's box is asserted rather than its heading
    // text: this environment ships no fonts, so Chromium reports a 0px box
    // for every text run and a text-visibility assertion would be meaningless.
    const feedBox = await page.getByTestId("board-chat-agent-feed").boundingBox();
    expect(feedBox, "agent feed pane is not rendered").not.toBeNull();
    expect(feedBox!.width).toBeGreaterThan(200);
    expect(feedBox!.height).toBeGreaterThan(600);
    await expect(
      page.getByRole("separator", { name: "Resize board chat and agent feed" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Open agent feed" })).toHaveCount(0);

    await sendButton.click();
    await expect(page.getByText("Hello from a desk").first()).toBeVisible();
  });
});
