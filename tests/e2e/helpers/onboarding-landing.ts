import { expect, type Page } from "@playwright/test";

/**
 * Regression guard for PAP-404: onboarding must land the user on the newly
 * created first-task detail page and must NOT bounce to the company dashboard.
 *
 * The bounce is a navigation race: the wizard `navigate(/…/issues/…)` used to
 * be clobbered by `useCompanyPageMemory`, which restores a company's remembered
 * page (falling back to `/dashboard`) on a non-`route_sync` selection change.
 *
 * react-router-dom drives client-side navigation through the History API, so a
 * Playwright `framenavigated` listener never fires for these SPA transitions.
 * Instead we hook `history.pushState`/`replaceState` before the app boots and
 * record every path the router visits — a `/dashboard` bounce (even a transient
 * one that later self-corrects) leaves a trace in the log.
 */

const ISSUE_URL = /\/issues\/[^/]+$/;
const DASHBOARD_PATH = /\/dashboard(\/|$)/;

/**
 * Install a History-API tap that records every client-side path change into
 * `window.__navLog`. Must be called BEFORE the first `page.goto` so the init
 * script is present when the SPA boots.
 */
export async function instrumentNavLog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __navLog?: string[] };
    if (w.__navLog) return;
    const log: string[] = [];
    w.__navLog = log;
    const record = () => log.push(window.location.pathname);
    const wrap = <T extends (...args: never[]) => unknown>(fn: T): T =>
      function (this: unknown, ...args: never[]) {
        const result = fn.apply(this, args);
        record();
        return result;
      } as unknown as T;
    history.pushState = wrap(history.pushState.bind(history));
    history.replaceState = wrap(history.replaceState.bind(history));
    window.addEventListener("popstate", record);
    record();
  });
}

async function readNavLog(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __navLog?: string[] }).__navLog ?? [],
  );
}

/**
 * Assert the wizard settled on the first-task detail page and never rested on
 * (or bounced through) the dashboard.
 *
 * Fails if a dashboard bounce is reintroduced: the History-API log will contain
 * a `/dashboard` entry and/or the settled URL will not be the issue page.
 */
export async function expectLandsOnFirstTaskWithoutDashboardBounce(
  page: Page,
): Promise<void> {
  // The wizard's launch handler does async work (hire + create issue) before
  // navigating, so give reaching the issue page a generous budget.
  await expect(page).toHaveURL(ISSUE_URL, { timeout: 30_000 });
  const settledUrl = page.url();

  // Short settle window: the page-memory effect fires on the selection change
  // that accompanies the launch navigate, so any bounce lands within ~1s. If
  // the URL is still the issue after this window it has genuinely settled.
  await page.waitForTimeout(1_500);
  expect(page.url(), "onboarding bounced away from the first task").toBe(settledUrl);
  await expect(page).toHaveURL(ISSUE_URL);

  const navLog = await readNavLog(page);
  const bounced = navLog.filter((path) => DASHBOARD_PATH.test(path));
  expect(
    bounced,
    `onboarding navigated to the dashboard (nav log: ${navLog.join(" -> ")})`,
  ).toEqual([]);
}
