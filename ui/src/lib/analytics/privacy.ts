// Shared privacy markers for browser product analytics (PostHog).
//
// Session replay masks ALL text and ALL input values by default. Only UI
// chrome that opts in with `ANALYTICS_UNMASK_PROPS` (navigation, buttons,
// labels, tabs, empty states) shows its text. A surface nobody marked stays
// masked. Autocapture never records element text or attribute values at all
// (see `product-analytics.ts`).
//
// Apply these markers instead of PostHog class names, so `product-analytics.ts`
// stays the one place that knows about PostHog. They have no effect when
// analytics is off (self-hosted and local installs).

export const ANALYTICS_UNMASK_ATTRIBUTE = "data-analytics-unmask";

/**
 * Spread on shared UI chrome whose text is product copy, never customer
 * content: `<button {...ANALYTICS_UNMASK_PROPS}>`.
 */
export const ANALYTICS_UNMASK_PROPS = { [ANALYTICS_UNMASK_ATTRIBUTE]: "" } as const;

/**
 * Customer content: task and issue bodies, comments, chat messages, documents
 * and artifacts. Its text stays masked even inside unmasked chrome, and
 * autocapture records nothing from inside it.
 */
export const ANALYTICS_MASK_CLASS = "ph-mask ph-sensitive";

/**
 * Secrets and credentials: API keys, tokens, passwords, environment values.
 * Session replay records a blank placeholder instead of the element and its
 * children, and autocapture records nothing from inside it.
 */
export const ANALYTICS_NO_CAPTURE_CLASS = "ph-no-capture";

/** Session replay sends every text node through `maskReplayText`. */
export const ANALYTICS_MASK_TEXT_SELECTOR = "*";

const FORCED_MASK_SELECTOR = ".ph-mask, .ph-no-capture, [contenteditable]:not([contenteditable=\"false\"])";
const UNMASK_SELECTOR = `[${ANALYTICS_UNMASK_ATTRIBUTE}]`;

/** True only for text inside opted-in chrome and outside customer content. */
export function isReplayTextRevealed(element: Element | null | undefined): boolean {
  if (!element || typeof element.closest !== "function") return false;
  if (element.closest(FORCED_MASK_SELECTOR)) return false;
  return element.closest(UNMASK_SELECTOR) !== null;
}

/** Session replay `maskTextFn`: keeps whitespace so the layout stays readable. */
export function maskReplayText(text: string, element?: HTMLElement | null): string {
  return isReplayTextRevealed(element) ? text : text.replace(/\S/g, "*");
}
