import type { Page } from "@playwright/test";

/**
 * Once-per-browser prompts a returning person has already dismissed. Chat
 * journeys test chat, not first-visit nudges: the GitHub star prompt (#20453)
 * opens after five done tasks and covers the composer. The product is
 * unchanged; the eval browser carries the same saved choice a returning user's
 * browser would. Keys mirror ui/src/components/GitHubStarPrompt.tsx (checked
 * by chat-returning-browser.test.ts).
 */
export const RETURNING_BROWSER_SEEN_KEYS = ["paperclip.github-star-prompt.seen"] as const;
const SEEN_AT = "2026-01-01T00:00:00.000Z";

function markSeen({ origin, keys, seenAt }: { origin: string; keys: readonly string[]; seenAt: string }) {
  try {
    if (window.location.origin !== origin) return;
    for (const key of keys) if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, seenAt);
  } catch { /* opaque or storage-less document */ }
}

/** Marks the prompts seen for every later document of this app origin, and for the one already open. */
export async function markReturningBrowser(page: Page, appOrigin: string) {
  // Flow unit tests drive the flow with page stand-ins that have no browser context; there is nothing to mark.
  const context = typeof page?.context === "function" ? page.context() : undefined;
  if (!context || typeof appOrigin !== "string") return;
  const args = { origin: new URL(appOrigin).origin, keys: [...RETURNING_BROWSER_SEEN_KEYS], seenAt: SEEN_AT };
  await context.addInitScript(markSeen, args);
  let current: string | undefined;
  try { current = new URL(page.url()).origin; } catch { current = undefined; }
  // The prompt rereads storage before it opens, so an already-open page needs no reload.
  if (current === args.origin) await page.evaluate(markSeen, args);
}
