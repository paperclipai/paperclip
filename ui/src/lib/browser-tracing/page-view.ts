// The `paperclip.page.view` dimension: which view a page's `?view=` selects,
// for the pages where that parameter picks a different list (for example
// `/:companyPrefix/issues?view=mine`). Main-bundle code, no OpenTelemetry.
//
// Only fixed view names from the code's own view registries are reported. A
// value that is not in the page's list becomes `other`, so a hand-edited URL
// never puts free text into a span.

import { ATTENTION_PERSONAL_VIEWS } from "@paperclipai/shared";
import { TASK_VIEW_KEYS, TASK_VIEW_PARAM } from "@/lib/task-views";
import { ATTENTION_VIEW_PARAM } from "@/lib/attention-views";

/** Reported for a `?view=` value that is not one of the page's views. */
export const OTHER_PAGE_VIEW = "other";

interface PageViewRule {
  param: string;
  views: ReadonlySet<string>;
  /** Reported when the URL has no `?view=`. */
  missing: string;
}

const PAGE_VIEW_RULES: ReadonlyMap<string, PageViewRule> = new Map([
  // Tasks resolves a missing view from the last one used and writes it into
  // the URL, so a finished measurement usually sees the resolved view.
  ["/:companyPrefix/issues", { param: TASK_VIEW_PARAM, views: new Set<string>(TASK_VIEW_KEYS), missing: "default" }],
  // Decisions shows "For you" (`mine`) when the URL names no view.
  ["/:companyPrefix/decisions", { param: ATTENTION_VIEW_PARAM, views: new Set<string>(ATTENTION_PERSONAL_VIEWS), missing: "mine" }],
]);

/**
 * The view for `routeTemplate` given the URL's query string, or null for a
 * page that has no views.
 */
export function pageViewFor(routeTemplate: string, search: string): string | null {
  const rule = PAGE_VIEW_RULES.get(routeTemplate);
  if (!rule) return null;
  let value: string | null;
  try {
    value = new URLSearchParams(search).get(rule.param);
  } catch {
    return OTHER_PAGE_VIEW;
  }
  if (value === null || value === "") return rule.missing;
  return rule.views.has(value) ? value : OTHER_PAGE_VIEW;
}
