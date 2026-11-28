import fs from "node:fs/promises";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

// A company with Mine tasks and pending board approvals, for hard loads of
// Mine with and without the saved query cache
// (`paperclip:query-cache:v1:<user>:<company>`). Retained in
// test-results/collections with the same 404 rule as the other fixtures.
export type ReturningVisitFixture = {
  company: { id: string; issuePrefix: string };
  tasks: Array<{ id: string; identifier: string }>;
  approvalIds: string[];
};
const fixturePath = "test-results/collections/mine-returning-visit-fixture.json";
const TASK_COUNT = 24;
const APPROVAL_COUNT = 3;

export async function returningVisitFixture(request: APIRequestContext): Promise<ReturningVisitFixture> {
  const saved = await fs.readFile(fixturePath, "utf8").then(text => JSON.parse(text) as ReturningVisitFixture).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (saved) {
    const existing = await request.get(`/api/companies/${saved.company.id}`);
    if (existing.ok()) return saved;
    expect(existing.status(), await existing.text()).toBe(404);
  }
  const created = await request.post("/api/companies", { data: { name: "Mine returning visit fixture" } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const company = await created.json() as ReturningVisitFixture["company"];
  const tasks: ReturningVisitFixture["tasks"] = [];
  for (let index = 0; index < TASK_COUNT; index++) {
    const response = await request.post(`/api/companies/${company.id}/issues`, { data: { title: `Returning visit task ${index}`, status: "todo" } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const task = await response.json();
    tasks.push({ id: task.id, identifier: task.identifier });
  }
  const approvalIds: string[] = [];
  for (let index = 0; index < APPROVAL_COUNT; index++) {
    const response = await request.post(`/api/companies/${company.id}/approvals`, { data: {
      type: "request_board_approval", payload: { title: `Returning visit approval ${index}`, summary: "Synthetic decision context." },
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
    approvalIds.push((await response.json()).id);
  }
  const fixture = { company, tasks, approvalIds };
  await fs.mkdir("test-results/collections", { recursive: true });
  await fs.writeFile(fixturePath, JSON.stringify(fixture));
  return fixture;
}

export const minePath = (fixture: ReturningVisitFixture) => `/${fixture.company.issuePrefix}/issues?view=mine`;
export const firstMineRow = (page: Page) => page.locator("[data-inbox-issue-link]").first();
export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
export const freshContext = (browser: Browser, baseURL: string | undefined, storageState?: StorageState) =>
  browser.newContext({ baseURL, serviceWorkers: "block", viewport: { width: 1440, height: 900 }, storageState });

/** Visits Mine once and returns the browser storage that visit saved, including the query cache. */
export async function savedQueryCache(browser: Browser, baseURL: string | undefined, fixture: ReturningVisitFixture): Promise<StorageState> {
  const context = await freshContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto(minePath(fixture));
    await expect(firstMineRow(page)).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction((companyId) => Object.keys(localStorage).some(key => key.startsWith("paperclip:query-cache:v1:")
      && key.endsWith(`:${encodeURIComponent(companyId)}`) && (localStorage.getItem(key) ?? "").includes("mine-context")),
    fixture.company.id, { timeout: 15_000 });
    // Let the debounced writer settle after the last background read.
    await page.waitForTimeout(1_500);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    return await context.storageState();
  } finally { await context.close(); }
}

/** Shell and inbox reads that a hard load of Mine used to repeat about 1.5–2.5 s after load. */
export const SHELL_READS: ReadonlyArray<readonly [string, (url: URL) => boolean]> = [
  ["auth/get-session", url => url.pathname === "/api/auth/get-session"],
  ["health", url => url.pathname === "/api/health"],
  ["companies?scope=accessible", url => url.pathname === "/api/companies" && url.searchParams.get("scope") === "accessible"],
  ["agents", url => /^\/api\/companies\/[^/]+\/agents$/.test(url.pathname)],
  ["inbox-dismissals", url => /^\/api\/companies\/[^/]+\/inbox-dismissals$/.test(url.pathname)],
  ["user-directory", url => /^\/api\/companies\/[^/]+\/user-directory$/.test(url.pathname)],
  ["approvals", url => /^\/api\/companies\/[^/]+\/approvals$/.test(url.pathname)],
  ["execution-workspaces", url => /^\/api\/companies\/[^/]+\/execution-workspaces$/.test(url.pathname)],
];

export type ApiRead = { path: string; startedAt: number; finishedAt: number | null };

/**
 * Delays every API response by `delayMs`, records each read, and marks the
 * first Mine row (two frames after it mounts) in page time.
 */
export async function observeMineLoad(page: Page, delayMs: number) {
  const reads: ApiRead[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const url = new URL(route.request().url());
    reads.push({ path: `${url.pathname}${url.search}`, startedAt: Date.now(), finishedAt: null });
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    // A closed page aborts outstanding routes; that read never finished.
    await route.continue().catch(() => {});
  });
  page.on("requestfinished", request => {
    const url = new URL(request.url());
    const read = reads.find(entry => entry.finishedAt === null && entry.path === `${url.pathname}${url.search}`);
    if (read) read.finishedAt = Date.now();
  });
  await page.addInitScript(() => {
    const state = window as unknown as { __mineRowsAt: number | null };
    state.__mineRowsAt = null;
    const observer = new MutationObserver(() => {
      if (!document.querySelector("[data-inbox-issue-link]")) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => { state.__mineRowsAt = performance.timeOrigin + performance.now(); }));
    });
    observer.observe(document, { subtree: true, childList: true });
  });
  const rowsAt = async () => {
    await page.waitForFunction(() => (window as unknown as { __mineRowsAt: number | null }).__mineRowsAt !== null, null, { timeout: 30_000 });
    return await page.evaluate(() => (window as unknown as { __mineRowsAt: number }).__mineRowsAt);
  };
  const shellReadCounts = () => Object.fromEntries(SHELL_READS.map(([name, matches]) => [name,
    reads.filter(read => matches(new URL(read.path, "http://local"))).length])) as Record<string, number>;
  return { reads, rowsAt, shellReadCounts };
}

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
