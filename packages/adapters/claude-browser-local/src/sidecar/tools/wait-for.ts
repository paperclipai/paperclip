import type { Page } from "playwright";
import type { WaitForCall, BrowserToolResult } from "../../server/tools/types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

export async function execWaitFor(page: Page, call: WaitForCall): Promise<BrowserToolResult> {
  const startedAt = new Date().toISOString();
  const timeout = call.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  try {
    if (call.selector) {
      await page.locator(call.selector).waitFor({ state: "visible", timeout });
    } else if (call.urlPattern) {
      await page.waitForURL(new RegExp(call.urlPattern), { timeout });
    } else if (call.networkIdle) {
      await page.waitForLoadState("networkidle", { timeout });
    } else {
      await page.waitForTimeout(timeout);
    }

    return {
      ok: true,
      tool: "wait_for",
      startedAt,
      finishedAt: new Date().toISOString(),
      data: { url: page.url() },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      tool: "wait_for",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "WAIT_FOR_FAILED",
    };
  }
}
