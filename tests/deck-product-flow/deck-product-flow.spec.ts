import { expect, test, type Page } from "@playwright/test";

async function expectNoViewportClip(page: Page) {
  const report = await page.evaluate(() => ({
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientWidth: window.innerWidth,
      clientHeight: window.innerHeight,
    },
    panels: Array.from(
      document.querySelectorAll<HTMLElement>("[data-deck-product-flow-panel]"),
      (element) => ({
        id: element.dataset.deckProductFlowPanel,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      }),
    ),
  }));
  expect(report.document.scrollWidth, JSON.stringify(report)).toBeLessThanOrEqual(report.document.clientWidth);
  expect(report.document.scrollHeight, JSON.stringify(report)).toBeLessThanOrEqual(report.document.clientHeight);
  for (const panel of report.panels) {
    expect(panel.scrollWidth, JSON.stringify(panel)).toBeLessThanOrEqual(panel.clientWidth);
    expect(panel.scrollHeight, JSON.stringify(panel)).toBeLessThanOrEqual(panel.clientHeight);
  }
}

test("renders a captured frame as product-register, chrome-free static UI", async ({ page }) => {
  await page.goto("/deck-product-flow.html?mode=capture&frame=2&theme=dark");
  const harness = page.locator("[data-deck-product-flow-ready='true']");

  await expect(harness).toBeVisible();
  await expect(harness).toHaveAttribute("data-register", "product");
  await expect(harness).toHaveAttribute("data-app-chrome", "none");
  await expect(page.getByText("Seeded fixture")).toBeVisible();
  await expect(page.getByText("live", { exact: true })).toHaveCount(0);
  await expect(page.locator(".agent-cap-liquid")).toHaveAttribute("data-agent-capsule", "Rook");
  await expectNoViewportClip(page);
});

test("keeps the sandboxed iframe mode keyboard-safe", async ({ page }) => {
  await page.goto("/deck-product-flow.html?mode=embed&frame=0&theme=light");
  const harness = page.locator("[data-deck-product-flow-ready='true']");

  await harness.focus();
  await expect(page.getByText("01 Seed")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("02 Story")).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByText("04 Embed")).toBeVisible();
  await expectNoViewportClip(page);
});
