import type { Page } from "playwright";
import type { TypeCall, BrowserToolResult } from "../../server/tools/types.js";

const TYPE_TIMEOUT_MS = 10_000;

/**
 * Types text into a field. The `value` may include `{{SECRET:NAME}}` tokens
 * that the sidecar resolves before sending keystrokes — resolved values
 * never travel back to the Paperclip server.
 *
 * Secret resolution is handled upstream (in the dispatcher) before this
 * function is called; the value here is already plaintext.
 */
export async function execType(page: Page, call: TypeCall, resolvedValue: string): Promise<BrowserToolResult> {
  const startedAt = new Date().toISOString();
  try {
    const locator = page.locator(call.selector);
    await locator.waitFor({ state: "visible", timeout: TYPE_TIMEOUT_MS });

    if (call.clearFirst) {
      await locator.fill("");
    }

    if (call.delayMs && call.delayMs > 0) {
      await locator.pressSequentially(resolvedValue, { delay: call.delayMs });
    } else {
      await locator.fill(resolvedValue);
    }

    return {
      ok: true,
      tool: "type",
      startedAt,
      finishedAt: new Date().toISOString(),
      // Never echo the resolved value back
      data: { selector: call.selector, charsTyped: resolvedValue.length },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      tool: "type",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "TYPE_FAILED",
    };
  }
}
