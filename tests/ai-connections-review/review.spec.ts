import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const index = JSON.parse(
  readFileSync(
    new URL("../../ui/storybook-static/index.json", import.meta.url),
    "utf8",
  ),
);
const stories = Object.keys(index.entries).filter((id) =>
  id.startsWith("ai-connections-review--"),
);

for (const id of stories) {
  test(id, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().startsWith("Failed to load resource")
      )
        errors.push(message.text());
    });
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "localhost"
        ? route.continue()
        : route.abort(),
    );
    await page.goto(`/iframe.html?id=${id}&viewMode=story`);
    // Completing follows the awaited play function, including its assertions.
    await page.waitForFunction(() => {
      const preview = (
        window as unknown as {
          __STORYBOOK_PREVIEW__?: { currentRender?: { phase: string } };
        }
      ).__STORYBOOK_PREVIEW__;
      return ["completing", "completed", "finished", "errored"].includes(
        preview?.currentRender?.phase ?? "",
      );
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            document.querySelector("#storybook-root")?.textContent ||
            document.querySelector('[role="dialog"]')?.textContent,
          ),
        ),
      )
      .toBe(true);
    expect(errors, `Story/play errors for ${id}`).toEqual([]);
    await expect(page.getByTestId("ai-review-frame")).toContainText("Already in the app");
    await expect(page.getByTestId("ai-review-frame")).toContainText("Storybook simulation");
    if (id.endsWith("responsible-user")) {
      await expect(page.getByTestId("ai-review-preview")).toContainText("Example page context · Storybook only");
      await expect(page.getByTestId("ai-component-boundary")).toContainText("App component: AiConnectionPicker");
      await expect(page.getByText("Your personal accounts", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Make default|Authorize for/ })).toHaveCount(0);
      await expect(page.getByText("For you: My Claude subscription", { exact: true })).toBeVisible();
    }
    if (id.endsWith("review-index")) {
      const links = await page
        .locator("#storybook-root a")
        .evaluateAll((anchors) =>
          anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
        );
      for (const href of links) {
        const url = new URL(href);
        expect(url.pathname).toBe("/");
        expect(
          index.entries[url.searchParams.get("path")!.replace("/story/", "")],
        ).toBeTruthy();
      }
    }
  });
}

for (const theme of ["light", "dark"]) {
  for (const width of [390, 1200]) {
    test(`layout ${theme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 960 });
      for (const story of [
        "responsible-user",
        "claude-subscription",
        "identity-matrix",
        "management",
      ]) {
        await page.goto(
          `/iframe.html?id=ai-connections-review--${story}&viewMode=story&globals=theme:${theme}`,
        );
        await expect
          .poll(() =>
            page.evaluate(() =>
              Boolean(
                document.querySelector("#storybook-root")?.textContent ||
                document.querySelector('[role="dialog"]')?.textContent,
              ),
            ),
          )
          .toBe(true);
        if (story === "management") await expect(page.getByLabel("AI account settings")).toBeVisible();
        if (story === "identity-matrix") await expect(page.getByRole("button", { name: "Add account Anthropic" })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          )
          .toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`${story}-${theme}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    });
  }
}

test("shared connection chooser keyboard navigation preserves runtime", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=ai-connections-review--responsible-user&viewMode=story",
  );
  const first = page.getByRole("button", { name: "Responsible user’s connection", exact: true });
  await first.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Engineering Claude", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Engineering Claude", exact: true }),
  ).toBeFocused();
  await expect(page.getByTestId("ai-harness")).toHaveText("Claude Code");
  await expect(page.getByTestId("ai-model")).toHaveText(
    "Configured Claude model",
  );
});

// Keep upstream's real saved-account and login workflow in this integration's
// review gate as well as the AI-specific component stories above.
for (const id of Object.keys(index.entries).filter((entry) => entry.startsWith("onboarding-saved-connections--"))) {
  test(`upstream ${id}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/iframe.html?id=${id}&viewMode=story`);
    await page.waitForFunction(() => {
      const preview = (window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase: string } } }).__STORYBOOK_PREVIEW__;
      return ["completed", "finished", "errored"].includes(preview?.currentRender?.phase ?? "");
    });
    await expect(page.locator("#storybook-root")).not.toBeEmpty();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase: string } } }).__STORYBOOK_PREVIEW__?.currentRender?.phase)).not.toBe("errored");
  });
}
