import { expect, test } from "@playwright/test";

for (const width of [640, 1200]) {
  for (const theme of ["light", "dark"]) {
    test(`task identities fit their columns at ${width}px in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/iframe.html?id=task-column-identities--long-names&viewMode=story&globals=theme:${theme}`);
      await expect(page.getByTestId("agent-spaces").locator('[data-slot="agent-avatar"]')).toHaveCount(2);
      await page.evaluate(() => document.fonts.ready);

      for (const id of ["agent-spaces", "agent-unbroken", "human", "short"]) {
        const row = page.getByTestId(id);
        const cells = row.locator(":scope > span > span");
        await expect(cells).toHaveCount(4);
        for (const index of [0, 1]) {
          const cell = cells.nth(index);
          const identity = cell.locator("[title]");
          const name = await identity.getAttribute("title");
          const metrics = await identity.evaluate(element => {
            const cell = element.parentElement!.getBoundingClientRect();
            const identity = element.getBoundingClientRect();
            const avatar = element.firstElementChild!.getBoundingClientRect();
            const text = element.lastElementChild as HTMLElement;
            return {
              right: identity.right, cellRight: cell.right,
              avatarWidth: avatar.width, avatarLeft: avatar.left, cellLeft: cell.left,
              textWidth: text.clientWidth, textContentWidth: text.scrollWidth,
              overflow: getComputedStyle(text).textOverflow,
            };
          });
          expect(metrics.right, `${id} identity escapes column ${index}`).toBeLessThanOrEqual(metrics.cellRight + 1);
          expect(metrics.avatarLeft).toBeGreaterThanOrEqual(metrics.cellLeft);
          expect(metrics.avatarWidth).toBe(24);
          expect(metrics.textWidth).toBeGreaterThan(0);
          expect(metrics.textContentWidth > metrics.textWidth).toBe(id !== "short");
          expect(metrics.overflow).toBe("ellipsis");
          await expect(identity.locator(":scope > span").last()).toHaveText(name!);
        }
        await expect(cells.nth(2)).toHaveText("Paperclip");
        expect((await row.boundingBox())!.height).toBeLessThanOrEqual((await page.getByTestId("short").boundingBox())!.height);
      }
    });
  }
}
