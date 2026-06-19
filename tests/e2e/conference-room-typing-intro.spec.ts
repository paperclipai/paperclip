import { test, expect } from "@playwright/test";

/**
 * E2E: post-wizard Conference Room typing intro (PAP-134, plan PAP-133).
 *
 * Completing the onboarding wizard must land the user in the Conference Room
 * with a staged intro: three-dot typing bubble first (~2s), then the CEO
 * welcome message, then the suggestion chips. This is the regression spec
 * from the PAP-133 investigation, checked in so the intro can't silently
 * vanish again (it already did once — PAP-54 dropped the dots CSS during a
 * theme migration).
 *
 * The wizard is driven end-to-end against real endpoints with two
 * deterministic intercepts so no live LLM/CLI is needed:
 *  - the adapter env-test returns an instant pass, and
 *  - the team-lead hire is re-issued server-side as a REAL hire with an
 *    inert `http` adapter (dead URL, heartbeat disabled), so a real CEO
 *    agent exists for the welcome bubble but no agent process ever runs.
 */

const COMPANY_NAME = `E2E-TypingIntro-${Date.now()}`;
const MISSION = "Verify the typing-dots intro survives the wizard handoff.";

test.describe("Conference Room typing intro after onboarding wizard", () => {
  test("shows typing dots first, then welcome, then chips", async ({
    page,
    baseURL,
  }) => {
    // The dots animation is intentionally disabled under reduced motion —
    // pin the e2e run to full motion so the animation guard is deterministic.
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // Intercept env-test → instant pass (avoid running a real CLI check).
    await page.route("**/test-environment", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "pass", checks: [] }),
      }),
    );

    // Intercept hire → perform a REAL hire server-side with an inert http
    // adapter so no real agent process spawns.
    await page.route("**/agent-hires", async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() || "{}");
      const auth = req.headers().authorization;
      const real = await fetch(new URL(req.url(), baseURL).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({
          name: body.name,
          role: body.role,
          adapterType: "http",
          adapterConfig: { url: "http://127.0.0.1:1/dead" },
          runtimeConfig: { heartbeat: { enabled: false } },
        }),
      });
      await route.fulfill({
        status: real.status,
        contentType: "application/json",
        body: await real.text(),
      });
    });

    // New-NUX surfaces are flag-gated default-OFF (PAP-136/137/138): turn the
    // experimental flag on for this throwaway instance before driving them.
    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    await page.goto("/onboarding");

    // Launcher card path (existing companies) — enter the wizard if the
    // route shows a launcher instead of opening the wizard directly.
    const startBtn = page.getByRole("button", { name: /Start Onboarding/i });
    if (await startBtn.count()) await startBtn.first().click();

    // Step 0: front door (skipped when the wizard opens on the create path).
    const frontDoor = page.getByText("Build a new team");
    if (await frontDoor.count()) await frontDoor.first().click();

    // Step 1: team name.
    await page.getByPlaceholder("Acme Corp").fill(COMPANY_NAME);
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 2: mission (direct path default).
    await page
      .getByPlaceholder("What is your team trying to achieve?")
      .fill(MISSION);
    await page.getByRole("button", { name: /Confirm mission/ }).click();

    // Step 3: lead name (prefilled) → Next.
    await page.waitForSelector('input[placeholder="Chief of staff"]', {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 4: adapter (claude_local default); heartbeat is intercepted.
    await page.getByRole("button", { name: /Give it a heartbeat/ }).click();

    // Step 5: review → Get started hands off to the Conference Room.
    const getStarted = page.getByRole("button", { name: /Get started/ });
    await getStarted.waitFor({ timeout: 20_000 });
    await getStarted.click();

    // Dots-first: the typing bubble must be on screen before the welcome.
    const dots = page.locator(".typing-dots");
    await expect(dots).toBeVisible({ timeout: 5_000 });

    // Atomic snapshot — dots and welcome state read in one evaluation so a
    // slow assertion can't race the 2s reveal timer.
    const snapshot = await page.evaluate(() => ({
      dots: document.querySelectorAll(".typing-dots").length,
      welcomeVisible: document.body.textContent?.includes("Welcome to") ?? false,
    }));
    expect(snapshot.dots).toBeGreaterThan(0);
    expect(snapshot.welcomeVisible).toBe(false);

    // Animation-presence guard (PAP-54 failure mode): the dots must carry a
    // real computed animation, not silently render as static circles after
    // the CSS block gets dropped in a refactor.
    const animationName = await dots
      .locator("span")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(animationName).not.toBe("none");
    expect(animationName).toBeTruthy();

    // Staged reveal completes: welcome bubble (~2s) then chips (~+700ms).
    await expect(page.getByText(/Welcome to/).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: "Draft a Company Brief" }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(dots).toHaveCount(0);
  });
});
