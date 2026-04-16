import type { Page } from "playwright";
import type { GotoCall, BrowserToolResult } from "../../server/tools/types.js";

const GOTO_TIMEOUT_MS = 30_000;

export async function execGoto(page: Page, call: GotoCall): Promise<BrowserToolResult> {
  const startedAt = new Date().toISOString();
  try {
    const waitUntil = call.waitUntil ?? "domcontentloaded";
    await page.goto(call.url, { waitUntil, timeout: GOTO_TIMEOUT_MS });
    return {
      ok: true,
      tool: "goto",
      startedAt,
      finishedAt: new Date().toISOString(),
      data: { url: page.url(), title: await page.title() },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      tool: "goto",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "GOTO_FAILED",
    };
  }
}
