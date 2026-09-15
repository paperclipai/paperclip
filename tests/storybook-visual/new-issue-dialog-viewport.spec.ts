import { expect, test, type Locator, type Page } from "@playwright/test";

const STORY_ID = "product-dialogs-modals--new-issue-prefilled";

type ViewportCase = {
  name: string;
  width: number;
  layoutHeight: number;
  visualHeight: number;
  offsetTop: number;
};

const VIEWPORT_CASES: ViewportCase[] = [
  { name: "mobile", width: 390, layoutHeight: 844, visualHeight: 408, offsetTop: 120 },
  { name: "tablet", width: 820, layoutHeight: 1180, visualHeight: 780, offsetTop: 120 },
  { name: "desktop with an on-screen keyboard", width: 1440, layoutHeight: 900, visualHeight: 600, offsetTop: 80 },
];

async function installVisualViewport(page: Page, layoutHeight: number) {
  await page.addInitScript(({ initialHeight }) => {
    class TestVisualViewport extends EventTarget {
      width = window.innerWidth;
      height = initialHeight;
      offsetLeft = 0;
      offsetTop = 0;
      pageLeft = 0;
      pageTop = 0;
      scale = 1;
    }

    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: new TestVisualViewport(),
    });
  }, { initialHeight: layoutHeight });
}

async function renderDialog(page: Page, viewport: ViewportCase) {
  await page.setViewportSize({ width: viewport.width, height: viewport.layoutHeight });
  await installVisualViewport(page, viewport.layoutHeight);
  await page.goto(`/iframe.html?id=${STORY_ID}&viewMode=story`, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const body = document.body;
    return body.classList.contains("sb-show-main") || body.classList.contains("sb-show-errordisplay");
  });
  expect(
    await page.locator(".sb-show-errordisplay").count(),
    `story ${STORY_ID} threw during render`,
  ).toBe(0);

  const dialog = page.locator('[data-slot="dialog-content"]');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Create Task" })).toBeEnabled();
  return dialog;
}

async function constrainVisualViewport(page: Page, viewport: ViewportCase) {
  await page.evaluate(({ height, offsetTop }) => {
    const visualViewport = window.visualViewport as VisualViewport & {
      height: number;
      offsetTop: number;
    };
    visualViewport.height = height;
    visualViewport.offsetTop = offsetTop;
    visualViewport.dispatchEvent(new Event("resize"));
  }, { height: viewport.visualHeight, offsetTop: viewport.offsetTop });
}

async function expectHitTarget(locator: Locator, visibleTop: number, visibleBottom: number) {
  const result = await locator.evaluate((element, band) => {
    const rect = element.getBoundingClientRect();
    const pointTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      top: rect.top,
      bottom: rect.bottom,
      hit: pointTarget === element || element.contains(pointTarget),
      visibleTop: band.visibleTop,
      visibleBottom: band.visibleBottom,
    };
  }, { visibleTop, visibleBottom });

  expect(result.top).toBeGreaterThanOrEqual(result.visibleTop);
  expect(result.bottom).toBeLessThanOrEqual(result.visibleBottom);
  expect(result.hit).toBe(true);
}

for (const viewport of VIEWPORT_CASES) {
  test(`keeps the new-task dialog inside the constrained visual viewport at ${viewport.name} width`, async ({ page }) => {
    const dialog = await renderDialog(page, viewport);
    const descriptionEditor = dialog.locator('.paperclip-mdxeditor-content[contenteditable="true"]');
    await expect(descriptionEditor).toBeVisible();
    await descriptionEditor.focus();

    await constrainVisualViewport(page, viewport);

    const visibleTop = viewport.offsetTop;
    const visibleBottom = viewport.offsetTop + viewport.visualHeight;
    await expect.poll(async () => dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    })).toEqual({
      top: viewport.offsetTop + 16,
      bottom: viewport.offsetTop + viewport.visualHeight - 16,
    });

    const dialogGeometry = await dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        heightVariable: style.getPropertyValue("--new-issue-dialog-height").trim(),
        rootHeightVariable: getComputedStyle(document.documentElement)
          .getPropertyValue("--new-issue-dialog-height")
          .trim(),
        translate: style.translate,
      };
    });
    expect(dialogGeometry.heightVariable).toContain(`${viewport.visualHeight}px`);
    expect(dialogGeometry.heightVariable).not.toContain("100dvh");
    expect(dialogGeometry.heightVariable).not.toBe(dialogGeometry.rootHeightVariable);
    expect(dialogGeometry.rootHeightVariable).toBe("");
    expect(dialogGeometry.translate).toBe("-50%");

    const closeButton = dialog.locator("button").filter({ hasText: "×" });
    const createButton = page.getByRole("button", { name: "Create Task" });
    await expectHitTarget(closeButton, visibleTop, visibleBottom);
    await expectHitTarget(createButton, visibleTop, visibleBottom);

    const scrollRegion = dialog.locator(".overflow-y-auto.overscroll-contain");
    const scrollMetrics = await scrollRegion.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(scrollMetrics.overflowY).toBe("auto");
    expect(scrollMetrics.scrollHeight).toBeGreaterThanOrEqual(scrollMetrics.clientHeight);
    if (viewport.width === 390) {
      expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    }

    const editorGeometry = await descriptionEditor.evaluate((element, scrollSelector) => {
      const editorRect = element.getBoundingClientRect();
      const scrollRect = element.closest(scrollSelector)!.getBoundingClientRect();
      return {
        editorTop: editorRect.top,
        editorBottom: editorRect.bottom,
        scrollTop: scrollRect.top,
        scrollBottom: scrollRect.bottom,
      };
    }, ".overflow-y-auto.overscroll-contain");
    expect(editorGeometry.editorTop).toBeGreaterThanOrEqual(editorGeometry.scrollTop);
    expect(editorGeometry.editorBottom).toBeLessThanOrEqual(editorGeometry.scrollBottom);

    for (const name of ["CodexCoder", "Board UI"]) {
      const selector = scrollRegion.getByRole("button", { name });
      await selector.scrollIntoViewIfNeeded();
      await expectHitTarget(selector, visibleTop, visibleBottom);
    }
  });
}

test("leaves unconstrained desktop positioning to the dialog primitive", async ({ page }) => {
  const viewport: ViewportCase = {
    name: "unconstrained desktop",
    width: 1440,
    layoutHeight: 900,
    visualHeight: 900,
    offsetTop: 0,
  };
  const dialog = await renderDialog(page, viewport);

  const inlineStyle = await dialog.evaluate((element) => ({
    top: element.style.top,
    height: element.style.height,
    translate: element.style.translate,
  }));
  expect(inlineStyle).toEqual({ top: "", height: "", translate: "" });
  expect(await dialog.evaluate((element) => getComputedStyle(element).translate)).toBe("-50% -50%");
});
