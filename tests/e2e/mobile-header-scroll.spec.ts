import { expect, test, type Page } from "@playwright/test";

async function createCompany(page: Page): Promise<{ id: string; prefix: string }> {
  const response = await page.request.post("/api/companies", {
    data: { name: `Mobile header scroll ${Date.now()}` },
  });
  expect(response.ok(), `create company failed ${response.status()}: ${await response.text()}`).toBe(true);
  const company = await response.json();
  return {
    id: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

async function addScrollableContent(page: Page) {
  await page.locator("#main-content").evaluate((main) => {
    const spacer = document.createElement("div");
    spacer.dataset.mobileHeaderScrollSpacer = "true";
    spacer.style.height = "2400px";
    main.append(spacer);
  });
}

async function scrollBy(page: Page, browserName: string, deltaY: number) {
  if (browserName === "webkit") {
    await page.evaluate((amount) => window.scrollBy(0, amount), deltaY);
    return;
  }
  await page.mouse.wheel(0, deltaY);
}

test("mobile header hides and restores deterministically under real browser scroll", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const company = await createCompany(page);
  const header = page.locator("[data-mobile-header='true']");

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.goto(`/${company.prefix}/dashboard`);
    await expect(header).toBeVisible();
    await addScrollableContent(page);

    await scrollBy(page, browserName, 160);
    await expect(header).toHaveAttribute("aria-hidden", "true");
    await expect(header).toHaveAttribute("inert", "");

    await page.waitForTimeout(300);
    await scrollBy(page, browserName, -20);
    await expect(header).not.toHaveAttribute("aria-hidden", "true");
    await expect(header).not.toHaveAttribute("inert", "");

    await page.waitForTimeout(300);
    await scrollBy(page, browserName, 160);
    await expect(header).toHaveAttribute("aria-hidden", "true");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(header).not.toHaveAttribute("aria-hidden", "true");
  }
});
