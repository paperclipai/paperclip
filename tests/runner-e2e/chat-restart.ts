import type { Page } from "@playwright/test";

/** Restart the test server without letting the old Vite client race navigation. */
export async function restartChatServer(page: Page, restart: () => Promise<void>) {
  await page.goto("about:blank", { waitUntil: "commit", timeout: 30_000 });
  await restart();
}

/** Chromium reports a navigation another navigation replaced as net::ERR_ABORTED. */
export function isAbortedNavigation(error: unknown): boolean {
  return error instanceof Error && /\bnet::ERR_ABORTED\b/.test(error.message);
}

/**
 * Open `url` on a page whose document predates a server restart. The old
 * document's Vite client reloads itself when the replacement server comes up;
 * if that reload lands while this navigation is in flight, Chromium aborts one
 * of them with net::ERR_ABORTED. Retry only that abort, within the caller's
 * deadline and a bounded attempt count, and rethrow every other error. A
 * timeout still resolves: the replacement server can commit and render a fresh
 * document while its lifecycle stays unsettled, so callers must assert the new
 * document and durable state explicitly afterwards.
 */
export async function gotoAfterServerRestart(
  page: Pick<Page, "goto">,
  url: string,
  input: { deadlineAt: number; maxAttempts?: number; retryDelayMs?: number; now?: () => number },
): Promise<void> {
  const now = input.now ?? Date.now;
  const maxAttempts = input.maxAttempts ?? 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "commit" });
      return;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") return;
      if (!isAbortedNavigation(error) || attempt >= maxAttempts || now() >= input.deadlineAt) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, input.retryDelayMs ?? 500));
  }
}
