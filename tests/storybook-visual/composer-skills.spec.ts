import { expect, test } from "@playwright/test";

for (const surface of ["composer-new-task", "composer-skills"]) {
  for (const theme of ["dark", "light"]) {
    for (const mobile of [false, true]) {
      for (const state of ["slash-commands", "inline-skill"]) {
        test(`${surface} ${state} ${theme} ${mobile ? "mobile" : "desktop"}`, async ({ page }, testInfo) => {
          await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1200, height: 800 });
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const id = `${surface}--${mobile ? "mobile-" : ""}${state}`;
          await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
          await expect.poll(() => page.evaluate(() => {
            const channel = (window as unknown as {
              __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> };
            }).__STORYBOOK_ADDONS_CHANNEL__;
            return channel?.data.storyFinished?.[0]?.status;
          }), { timeout: 30_000 }).toBe("success");
          expect(await page.evaluate(() => (window as unknown as {
            __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, unknown> };
          }).__STORYBOOK_ADDONS_CHANNEL__?.data.playFunctionThrewException)).toBeUndefined();
          expect(errors).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

          if (state === "slash-commands") {
            const menu = page.getByTestId("mention-autocomplete-menu");
            await expect(menu).toBeVisible();
            const bounds = await menu.boundingBox();
            expect(bounds!.width).toBeGreaterThan(mobile ? 350 : 420);
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
            const description = menu.getByText(/^Walk through the feature/);
            const layout = await description.evaluate((element) => {
              const style = getComputedStyle(element);
              return { clipped: element.scrollWidth > element.clientWidth, whiteSpace: style.whiteSpace, overflow: style.textOverflow };
            });
            expect(layout).toEqual({ clipped: true, whiteSpace: "nowrap", overflow: "ellipsis" });
            await expect(menu.getByRole("button", { name: /\/release-notes/ })).toBeVisible();
          } else {
            const skill = page.getByRole("textbox", { name: "editable markdown" }).locator('[data-mention-kind="skill"]');
            await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveText("Use /test-it-for-real to verify the sign-in redirect.");
            await expect(skill).toBeVisible();
            const appearance = await skill.evaluate((element) => {
              const style = getComputedStyle(element);
              const icon = getComputedStyle(element, "::before");
              return {
                border: style.borderTopWidth, padding: style.padding, radius: style.borderRadius,
                color: style.color, parentColor: getComputedStyle(element.parentElement!).color,
                mask: icon.maskImage, iconWidth: Number.parseFloat(icon.width),
              };
            });
            expect(appearance.border).toBe("0px");
            expect(appearance.padding).toBe("0px");
            expect(appearance.radius).toBe("0px");
            expect(appearance.color).not.toBe(appearance.parentColor);
            expect(appearance.mask).toContain("data:image/svg+xml");
            expect(appearance.iconWidth).toBeGreaterThan(0);
          }
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({ path: testInfo.outputPath(`${surface}-${state}-${theme}-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
        });
      }
    }
  }
}

for (const id of ["composer-skills--send-inline-skill", "composer-new-task--create-with-rich-chips"]) {
  test(`${id} preserves submitted skill references`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${id}&viewMode=story`);
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> };
    }).__STORYBOOK_ADDONS_CHANNEL__?.data.storyFinished?.[0]?.status), { timeout: 30_000 }).toBe("success");
  });
}
