import type { Locator, Page } from "@playwright/test";

/**
 * Grade a personal-secret setup reply by its rendered link, never by its
 * wording. The reply passes when its rendered message holds a visible link to
 * this company's secrets settings and clicking that link, as a person would,
 * reaches the current person's own-value entry for the required definition.
 * The reply's wording is left to human review.
 */
export interface PersonalSecretReplyLinkProof {
  commentId: string;
  /** The rendered link's resolved target, as the person's click followed it. */
  route: string;
  linkText: string;
  reachedOwnValueEntry: true;
  definitionKey: string;
}

/** A rendered link target is supported only for this origin and company's secrets settings. */
export function supportedSecretSettingsLink(href: string | null, origin: string, prefix: string, definitionId: string): string | undefined {
  try {
    const url = new URL(href ?? "", origin);
    const query = [...url.searchParams.keys()];
    if (url.origin !== origin || url.username || url.password || url.hash) return;
    if (url.pathname !== `/${prefix}/company/settings/secrets`) return;
    if (query.some(key => key !== "definition") || url.searchParams.getAll("definition").length > 1) return;
    if (url.searchParams.has("definition") && url.searchParams.get("definition") !== definitionId) return;
    return url.href;
  } catch {
    return;
  }
}

async function visible(node: Locator, timeout: number): Promise<boolean> {
  if (await node.count() !== 1 || !await node.isVisible()) return false;
  await node.scrollIntoViewIfNeeded({ timeout });
  return node.evaluate(element => {
    const rect = element.getBoundingClientRect();
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || rect.width <= 0 || rect.height <= 0
      || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/hidden|clip/.test(style.overflowX) && (rect.right <= box.left || rect.left >= box.right)) return false;
      if (/hidden|clip/.test(style.overflowY) && (rect.bottom <= box.top || rect.top >= box.bottom)) return false;
    }
    return true;
  });
}

/**
 * Find the visible supported link in the rendered reply, click it, and prove
 * the click reached the own-value entry ("Set value" on the definition's row in
 * My secrets). Returns to the conversation afterwards. Undefined when the reply
 * has no such link or the click does not reach the entry.
 */
export async function followPersonalSecretReplyLink(page: Page, input: {
  commentId: string; origin: string; prefix: string; definitionId: string; definitionKey: string; timeout: number;
}): Promise<PersonalSecretReplyLinkProof | undefined> {
  const deadline = Date.now() + input.timeout;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Personal secret reply link deadline exceeded");
    return ms;
  };
  const comment = page.locator(`[id=${JSON.stringify(`comment-${input.commentId}`)}]`);
  await comment.waitFor({ state: "visible", timeout: remaining() }).catch(() => undefined);
  if (!await comment.isVisible()) return;
  let chosen: { anchor: Locator; route: string; text: string } | undefined;
  for (const anchor of await comment.locator("a[href]").all()) {
    const route = supportedSecretSettingsLink(await anchor.getAttribute("href"), input.origin, input.prefix, input.definitionId);
    if (route && await visible(anchor, remaining())) { chosen = { anchor, route, text: (await anchor.innerText()).trim() }; break; }
  }
  if (!chosen) return;
  const original = page.url();
  try {
    await chosen.anchor.click({ timeout: remaining() });
    await page.waitForURL(url => url.origin === input.origin && url.pathname === new URL(chosen!.route).pathname, { timeout: remaining() });
    const tab = page.getByRole("tab", { name: "My secrets", exact: true });
    if (await tab.count() === 1 && await tab.getAttribute("aria-selected") !== "true") await tab.click({ timeout: remaining() });
    // The row is bound to the required definition by its identity, and shows its key.
    const row = page.locator(`[data-testid=${JSON.stringify(`my-secret-${input.definitionId}`)}]`)
      .filter({ has: page.getByText(input.definitionKey, { exact: true }) });
    const entry = row.getByRole("button", { name: "Set value", exact: true });
    await entry.waitFor({ state: "visible", timeout: remaining() }).catch(() => undefined);
    if (Date.now() >= deadline || !await visible(entry, remaining())) return;
    return { commentId: input.commentId, route: chosen.route, linkText: chosen.text, reachedOwnValueEntry: true, definitionKey: input.definitionKey };
  } finally {
    // Returning to the conversation has its own bound so a failed check still restores the page.
    if (page.url() !== original) await page.goto(original, { waitUntil: "domcontentloaded", timeout: 15_000 });
  }
}
