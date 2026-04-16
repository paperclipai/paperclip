import type { Page } from "playwright";
import type { ClickCall, BrowserToolResult } from "../../server/tools/types.js";

const CLICK_TIMEOUT_MS = 10_000;

export async function execClick(page: Page, call: ClickCall): Promise<BrowserToolResult> {
  const startedAt = new Date().toISOString();
  try {
    if (call.selector) {
      const nth = call.nth ?? 0;
      const locator = page.locator(call.selector).nth(nth);
      await locator.click({ timeout: CLICK_TIMEOUT_MS });
    } else if (call.text) {
      await page.getByText(call.text, { exact: false }).first().click({ timeout: CLICK_TIMEOUT_MS });
    } else {
      throw new Error("click requires either selector or text");
    }

    return {
      ok: true,
      tool: "click",
      startedAt,
      finishedAt: new Date().toISOString(),
      data: { url: page.url() },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      tool: "click",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "CLICK_FAILED",
    };
  }
}
