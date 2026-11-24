// Shared privacy markers for browser product analytics (PostHog).
//
// Session replay shows text by default and masks ALL input values. Text is
// masked only inside customer content marked with `ANALYTICS_MASK_CLASS`,
// inside secrets marked with `ANALYTICS_NO_CAPTURE_CLASS` (blocked entirely),
// inside editable content, and inside work content marked with
// `ANALYTICS_WORK_CONTENT_CLASS` unless the company holds no Google or Slack
// data. Autocapture never records element text or
// attribute values at all (see `product-analytics.ts`).
//
// Apply these markers instead of PostHog class names, so `product-analytics.ts`
// stays the one place that knows about PostHog. They have no effect when
// analytics is off (self-hosted and local installs).

import { redactUrlSecrets } from "@/lib/redact-url-secrets";

/**
 * Customer content: comments, chat messages, run output, connected-account
 * data and anything else that is not work content (see
 * `ANALYTICS_WORK_CONTENT_CLASS`). Session replay always masks its text, and
 * autocapture records nothing from inside it.
 */
export const ANALYTICS_MASK_CLASS = "ph-mask ph-sensitive";

/**
 * Secrets and credentials: API keys, tokens, passwords, environment values.
 * Session replay records a blank placeholder instead of the element and its
 * children, and autocapture records nothing from inside it.
 */
export const ANALYTICS_NO_CAPTURE_CLASS = "ph-no-capture";

/**
 * Work content: task descriptions, document bodies and artifact contents.
 * Session replay masks it unless the page says the active company holds no
 * Google or Slack data (`REPLAY_WORK_CONTENT_ATTRIBUTE` on `<html>`, set by
 * `ReplayWorkContentVisibility`). Agents copy connected-account content into
 * these surfaces, and our privacy policy and the Google API Limited Use rules
 * say no person may read that content in a replay.
 *
 * A strict marker inside work content still wins: `ANALYTICS_MASK_CLASS`,
 * `ANALYTICS_NO_CAPTURE_CLASS` and editors stay masked (see `maskReplayText`).
 */
export const ANALYTICS_WORK_CONTENT_CLASS = "ph-work-content";

/** `<html>` attribute that shows work content in replays when set to `"visible"`. */
export const REPLAY_WORK_CONTENT_ATTRIBUTE = "data-replay-work-content";

/** Markers that always mask, wherever they sit. */
const STRICT_MASK_SELECTOR = [
  ...ANALYTICS_MASK_CLASS.split(" "),
  ANALYTICS_NO_CAPTURE_CLASS,
].map((name) => `.${name}`).concat("[contenteditable]:not([contenteditable=\"false\"])").join(", ");

/**
 * Session replay masks text only inside these markers. Work content is in the
 * selector too, so it fails closed: `maskReplayText` decides whether it shows.
 */
export const ANALYTICS_MASK_TEXT_SELECTOR = `${STRICT_MASK_SELECTOR}, .${ANALYTICS_WORK_CONTENT_CLASS}`;

/** True when the page has confirmed that work content may show in replays. */
export function replayWorkContentVisible(doc: Document | null | undefined = globalThis.document): boolean {
  return doc?.documentElement?.getAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE) === "visible";
}

/**
 * Session replay `maskTextFn`. rrweb calls it only for text inside
 * `ANALYTICS_MASK_TEXT_SELECTOR`. The nearest marker decides: work content
 * shows when the page allows it, and every other marker masks. Whitespace
 * stays, so the layout stays readable.
 */
export function maskReplayText(text: string, element?: HTMLElement | null): string {
  const nearest = element?.closest?.(ANALYTICS_MASK_TEXT_SELECTOR);
  if (
    nearest
    && nearest.classList.contains(ANALYTICS_WORK_CONTENT_CLASS)
    && !nearest.matches(STRICT_MASK_SELECTOR)
    && replayWorkContentVisible(nearest.ownerDocument)
  ) {
    return text;
  }
  return text.replace(/\S/g, "*");
}

/**
 * Attributes that only describe layout, state or structure. Every other
 * attribute (title, alt, aria-label, placeholder, value, src, href, data-*,
 * and element references such as id, for and aria-labelledby, which often
 * embed names or slugs) can carry customer text, so replay masks it.
 */
const LAYOUT_ATTRIBUTES = new Set([
  "class", "style", "type", "role", "tabindex", "disabled", "checked", "selected", "hidden",
  "open", "dir", "lang", "rel", "target", "colspan", "rowspan", "width", "height",
  "viewbox", "xmlns", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "points", "transform", "opacity",
  "aria-hidden", "aria-expanded", "aria-selected", "aria-checked", "aria-current", "aria-disabled",
  "aria-orientation", "aria-haspopup", "aria-modal", "aria-pressed", "aria-invalid", "aria-live", "aria-busy",
  "data-slot", "data-state", "data-side", "data-align", "data-orientation", "data-variant",
  "data-size", "data-disabled", "data-highlighted", "data-placeholder",
]);

/** Fixed IDs that page CSS targets (`#root`, `#main-content`); never customer data. */
const LAYOUT_IDS = new Set(["root", "main-content", "properties-pane-header-slot"]);

/**
 * Session replay `maskAttributeFn`. Deny by default: only layout attributes,
 * rrweb's own metadata, stylesheets and links outside customer content keep
 * their values. Free-text attributes stay masked everywhere, because labels
 * such as `aria-label` often name customer data (for example the
 * organization switcher's "Open <name> switcher").
 */
export function maskReplayAttribute(name: string, value: string, element?: Element | null): string {
  const key = name.toLowerCase();
  // rrweb's own serialized metadata (`rr_width`, `_cssText`, ...).
  if (key.startsWith("rr_") || key.startsWith("_")) return value;
  if (LAYOUT_ATTRIBUTES.has(key)) return value;
  if (key === "id" && LAYOUT_IDS.has(value)) return value;
  // Stylesheets render the page. Every other `href` (download links carry
  // file paths, markdown links carry customer URLs) stays masked.
  if (key === "href" && element?.tagName?.toLowerCase() === "link") return redactAnalyticsUrl(value);
  return value.replace(/\S/g, "*");
}

/** Routes whose next path segment is a one-time secret (claim and invite links). */
const SECRET_PATH_SEGMENT = /(\/(?:board-claim|invite)\/)[^/?#\s"']+/gi;

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Prepares a URL or path for analytics. Deny by default: a URL keeps only its
 * origin and path, because query and hash values can hold credentials
 * (`token`, `code`, `state`), file paths or search text. The token segment of
 * claim and invite links is redacted. Any other string only has secret
 * `key=value` pairs redacted.
 */
export function redactAnalyticsUrl(value: string): string {
  if (!value.includes("/") && !value.includes("?") && !value.includes("#")) return value;
  const trimmed = value.trim();
  let result: string;
  if (ABSOLUTE_URL.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      result = `${url.origin === "null" ? `${url.protocol}//` : url.origin}${url.pathname}`;
    } catch {
      result = redactUrlSecrets(value);
    }
  } else if (trimmed.startsWith("/")) {
    result = trimmed.replace(/[?#].*$/, "");
  } else {
    result = redactUrlSecrets(value);
  }
  return result.replace(SECRET_PATH_SEGMENT, "$1REDACTED");
}
