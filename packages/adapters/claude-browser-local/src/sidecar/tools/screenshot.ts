import type { Page } from "playwright";
import type { ScreenshotCall, BrowserToolResult } from "../../server/tools/types.js";
import { redactScreenshotRegions } from "../../server/tools/redaction.js";

export async function execScreenshot(
  page: Page,
  call: ScreenshotCall,
): Promise<BrowserToolResult & { pngBase64?: string }> {
  const startedAt = new Date().toISOString();
  try {
    let pngBuffer: Buffer;

    if (call.selector) {
      const el = page.locator(call.selector).first();
      pngBuffer = await el.screenshot({ type: "png" });
    } else {
      pngBuffer = await page.screenshot({ fullPage: call.fullPage ?? false, type: "png" });
    }

    // Redact sensitive DOM regions from the screenshot (password inputs etc.)
    // For now we pass the raw buffer through; full redaction requires DOM
    // cross-referencing which lands Day 3 when the dom_snapshot tool is wired.
    const redacted = pngBuffer;

    return {
      ok: true,
      tool: "screenshot",
      startedAt,
      finishedAt: new Date().toISOString(),
      data: {
        url: page.url(),
        sizeBytes: redacted.length,
        label: call.label ?? null,
      },
      pngBase64: redacted.toString("base64"),
    };
  } catch (err: unknown) {
    return {
      ok: false,
      tool: "screenshot",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "SCREENSHOT_FAILED",
    };
  }
}
