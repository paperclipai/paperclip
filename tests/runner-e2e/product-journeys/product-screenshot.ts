import type { Page } from "@playwright/test";
import { JourneyError } from "./types.js";

export async function captureProductScreenshot(page: Page, origin: string, file: string) {
  const url = new URL(page.url());
  if (url.origin !== origin || !/^\/[^/]+\/(issues|search)(\/|$)/.test(url.pathname)) throw new JourneyError("failed", "product_screen_unavailable");
  // CloudAccessGate replaces Layout on expiry without necessarily changing the
  // URL. Capture Layout's main element, so auth screens can never be included.
  const product = page.locator("main#main-content");
  if (!await product.isVisible()) throw new JourneyError("failed", "product_screen_unavailable");
  await product.screenshot({ path: file, timeout: 2000 });
}
