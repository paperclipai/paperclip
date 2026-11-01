import type { Page } from "@playwright/test";
import { JourneyError } from "./types.js";

export async function captureProductScreenshot(page: Page, origin: string, file: string, deadlineAt = Date.now() + 10_000) {
  const permitted = () => {
    const url = new URL(page.url());
    return url.origin === origin && /^\/[^/]+\/(issues|search)(\/|$)/.test(url.pathname);
  };
  const timeout = (maximum: number) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new JourneyError("failed", "product_screen_unavailable");
    return Math.min(maximum, remaining);
  };
  if (!permitted() || deadlineAt <= Date.now()) throw new JourneyError("failed", "product_screen_unavailable");
  // CloudAccessGate replaces Layout on expiry without necessarily changing the
  // URL. Capture Layout's main element, so auth screens can never be included.
  const product = page.locator("main#main-content");
  try { await product.waitFor({ state: "visible", timeout: timeout(10_000) }); }
  catch { throw new JourneyError("failed", "product_screen_unavailable"); }
  if (!permitted() || !await product.isVisible() || deadlineAt <= Date.now()) throw new JourneyError("failed", "product_screen_unavailable");
  await product.screenshot({ path: file, timeout: timeout(2000) });
}
