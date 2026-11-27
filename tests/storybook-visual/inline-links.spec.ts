import { expect, test } from "@playwright/test";

for (const theme of ["dark", "light"]) {
  for (const mobile of [false, true]) {
    for (const streaming of [false, true]) {
      test(`GitHub inline links [${theme}, ${mobile ? "mobile" : "desktop"}, ${streaming ? "streaming" : "ordinary"}]`, async ({ page }, testInfo) => {
        if (mobile) await page.setViewportSize({ width: 390, height: 844 });
        const errors: string[] = [];
        const providerRequests: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (new URL(request.url()).hostname === "github.com") providerRequests.push(request.url());
        });
        const id = `tasks-inline-links--${streaming ? "streaming" : mobile ? "narrow" : "playground"}`;
        await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
        await expect.poll(() => page.evaluate(() => {
          const channel = (window as unknown as {
            __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> };
          }).__STORYBOOK_ADDONS_CHANNEL__;
          return channel?.data.storyFinished?.[0]?.status;
        })).toBe("success");
        const main = page.getByRole("main");
        const pr = main.getByRole("link", { name: "GitHub pull request: acme/web#241", exact: true });
        await expect(pr).toHaveAttribute("rel", "noopener noreferrer");
        if (streaming) {
          await expect(pr.locator(".conversation-stream-word")).toHaveText("acme/web#241");
        }
        const comment = main.getByRole("link", { name: "GitHub pull request: Jump to the review comment" });
        await expect(comment).toHaveAttribute("href", "https://github.com/acme/web/pull/241/files?diff=split#discussion_r123");
        await expect(comment).toHaveAttribute("title", "Review comment on the exact diff");
        await pr.focus();
        await expect(pr).toBeFocused();
        await pr.blur();
        const settings = main.getByRole("link", { name: "company settings" });
        await expect(settings).not.toHaveAttribute("target");
        await expect(main.locator("a[data-github-link] .lucide-external-link")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        expect(providerRequests).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`inline-links-${theme}-${mobile ? "mobile" : "desktop"}-${streaming ? "streaming" : "ordinary"}.png`), fullPage: true });
      });
    }
  }
}
