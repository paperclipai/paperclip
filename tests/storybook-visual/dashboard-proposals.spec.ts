import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  for (const width of [390, 960]) {
    for (const story of ["proposal-hierarchy", "proposal-hierarchy-mobile", "proposal-create", "proposal-new-and-existing-areas", "proposal-edit", "proposal-in-conversation"]) {
      test(`${story} ${theme} ${width}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1100 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`/iframe.html?id=feature-responsibility-dashboard--${story}&viewMode=story&globals=theme:${theme}`);
        const finished = () => page.evaluate(() => (window as unknown as {
          __STORYBOOK_ADDONS_CHANNEL__?: { data: Record<string, Array<{ status?: string }>> };
        }).__STORYBOOK_ADDONS_CHANNEL__?.data.storyFinished?.[0]?.status);
        await expect.poll(finished, { timeout: 30_000 }).not.toBeUndefined();
        expect(await finished()).toBe("success");
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        if (story === "proposal-hierarchy") {
          const area = page.getByRole("region", { name: "Fundraising" });
          const heading = area.getByRole("heading", { name: "Fundraising" });
          const responsibilities = area.getByRole("list", { name: "Responsibilities in Fundraising" });
          await expect(responsibilities.getByText("New responsibility", { exact: true })).toHaveCount(2);
          expect((await responsibilities.getByRole("listitem").first().boundingBox())!.x).toBeGreaterThan((await heading.boundingBox())!.x);
          await expect(responsibilities.getByRole("button", { name: "Drop this change" })).toHaveCount(2);
          await area.getByRole("button", { name: "Drop this change" }).first().click();
          await expect(area.locator("[data-dropped]")).toHaveCount(3);
          await expect(area.getByText("Goes with Fundraising")).toHaveCount(2);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await responsibilities.getByRole("button", { name: "Keep", exact: true }).last().click();
          await expect(area.locator("[data-dropped]")).toHaveCount(1);
          await area.getByRole("button", { name: "Keep", exact: true }).click();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.getByTestId("dashboard-changes").screenshot({ path: testInfo.outputPath(`${story}-${theme}-${width}.png`) });
      });
    }
  }
}

test("nested selections retain the existing apply payload", async ({ page }) => {
  await page.goto("/iframe.html?id=feature-responsibility-dashboard--proposal-hierarchy&viewMode=story");
  const area = page.getByRole("region", { name: "Portfolio", exact: true });
  await area.getByRole("button", { name: "Drop this change" }).first().click();
  await area.getByRole("button", { name: "Keep", exact: true }).last().click();
  await page.evaluate(() => {
    const original = window.fetch;
    (window as unknown as { appliedBody: unknown }).appliedBody = undefined;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/accept")) {
        (window as unknown as { appliedBody: unknown }).appliedBody = JSON.parse(String(init?.body));
      }
      return original(input, init);
    };
  });
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { appliedBody: unknown }).appliedBody))
    .toEqual({ keep: [0, 1, 2, 3, 5, 6, 7, 8, 9] });
});
