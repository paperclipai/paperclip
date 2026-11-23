import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  freshContext, median, minePath, observeMineLoad, returningVisitFixture, savedQueryCache, type ReturningVisitFixture,
} from "./returning-visit-fixture";

// A returning visit to Mine restores its rows, approvals, join requests and
// dismissals from the saved query cache, so rows show before any company read
// answers. The reads still run and replace the saved values.
let fixture: ReturningVisitFixture;
test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  fixture = await returningVisitFixture(request);
});

const companyRead = (companyId: string) => (url: URL) => url.pathname.startsWith(`/api/companies/${companyId}/`);
const taskLink = (page: Page, identifier: string) => page.locator(`[data-inbox-issue-link][href$="/${identifier}"]`);
const approvalRow = (page: Page, approvalId: string) => page.locator(`a[href$="/approvals/${approvalId}"]`);

function holdReads(page: Page, matches: (url: URL) => boolean) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const answered: string[] = [];
  page.on("requestfinished", request => {
    const url = new URL(request.url());
    if (matches(url)) answered.push(url.pathname);
  });
  const ready = page.route(matches, async route => {
    await held;
    await route.continue().catch(() => {});
  });
  return { ready, release, answered };
}

test("a returning visit shows Mine rows and approvals from the saved cache before any company read answers", async ({ browser, baseURL }) => {
  const storageState = await savedQueryCache(browser, baseURL, fixture);
  const context = await freshContext(browser, baseURL, storageState);
  try {
    const page = await context.newPage();
    const hold = holdReads(page, companyRead(fixture.company.id));
    await hold.ready;
    try {
      await page.goto(minePath(fixture));
      for (const task of fixture.tasks.slice(0, 5)) {
        await expect(taskLink(page, task.identifier), "Mine rows waited for a company read").toBeVisible({ timeout: 10_000 });
      }
      for (const id of fixture.approvalIds) await expect(approvalRow(page, id)).toBeVisible();
      expect(hold.answered, "No company read may answer before the saved rows show").toEqual([]);
    } finally { hold.release(); }
    // The held reads then answer and leave the same rows in place.
    await expect.poll(() => hold.answered.some(path => path.endsWith("/inbox/mine"))).toBe(true);
    await expect(taskLink(page, fixture.tasks[0]!.identifier)).toBeVisible();
  } finally { await context.close(); }
});

test("a saved approval that left Mine since the last visit goes when the reads answer", async ({ browser, baseURL, request }) => {
  const created = await request.post(`/api/companies/${fixture.company.id}/approvals`, { data: {
    type: "request_board_approval", payload: { title: "Returning visit stale approval", summary: "Dismissed after the cache was saved." },
  } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const stale = (await created.json()).id as string;
  const storageState = await savedQueryCache(browser, baseURL, fixture);
  // Dismissed from another device after this browser saved its cache.
  const dismissed = await request.post(`/api/companies/${fixture.company.id}/inbox-dismissals`, { data: { itemKey: `approval:${stale}` } });
  expect(dismissed.ok(), await dismissed.text()).toBeTruthy();
  const context = await freshContext(browser, baseURL, storageState);
  try {
    const page = await context.newPage();
    const hold = holdReads(page, companyRead(fixture.company.id));
    await hold.ready;
    await page.goto(minePath(fixture));
    await expect(approvalRow(page, stale), "The saved approval stands in until the reads answer").toBeVisible();
    hold.release();
    await expect(approvalRow(page, stale)).toHaveCount(0);
    await expect(taskLink(page, fixture.tasks[0]!.identifier)).toBeVisible();
  } finally { await context.close(); }
});

test("a saved cache never shows one company's rows in another company's Mine", async ({ browser, baseURL, request }) => {
  const other = await request.post("/api/companies", { data: { name: "Returning visit other company" } });
  expect(other.ok(), await other.text()).toBeTruthy();
  const otherCompany = await other.json() as { id: string; issuePrefix: string };
  const storageState = await savedQueryCache(browser, baseURL, fixture);
  const context = await freshContext(browser, baseURL, storageState);
  try {
    const page = await context.newPage();
    const hold = holdReads(page, companyRead(otherCompany.id));
    await hold.ready;
    try {
      await page.goto(`/${otherCompany.issuePrefix}/issues?view=mine`);
      await page.waitForTimeout(1_500);
      await expect(page.locator("[data-inbox-issue-link]")).toHaveCount(0);
      for (const id of fixture.approvalIds) await expect(approvalRow(page, id)).toHaveCount(0);
    } finally { hold.release(); }
  } finally {
    await context.close();
    await request.delete(`/api/companies/${otherCompany.id}`);
  }
});

// Time from navigation start to the first Mine row (two frames after mount),
// with every API response delayed by PAPERCLIP_COLLECTION_PERF_API_DELAY_MS
// (default 300 ms), in fresh browser contexts with and without the saved cache.
// Each sample names the last API response that finished before the rows and
// counts the load's API requests. Timings are evidence, not budgets.
test("records returning-visit time to Mine rows", async ({ browser, baseURL }, testInfo) => {
  const runs = Number(process.env.PAPERCLIP_COLLECTION_PERF_TIMING_RUNS ?? 5);
  const delayMs = Number(process.env.PAPERCLIP_COLLECTION_PERF_API_DELAY_MS ?? 300);
  expect(Number.isInteger(runs) && runs >= 5, "Record at least five samples").toBe(true);
  test.setTimeout(60_000 + runs * 2 * 30_000);
  const storageState = await savedQueryCache(browser, baseURL, fixture);
  const sample = async (cache: "saved" | "cleared") => {
    const context = await freshContext(browser, baseURL, cache === "saved" ? storageState : undefined);
    try {
      const page = await context.newPage();
      const { reads, rowsAt, shellReadCounts } = await observeMineLoad(page, delayMs);
      await page.goto(minePath(fixture));
      const rows = await rowsAt();
      const navigationStart = await page.evaluate(() => performance.timeOrigin);
      await page.waitForTimeout(5_000);
      const before = reads.filter(read => read.finishedAt !== null && read.finishedAt <= rows)
        .sort((a, b) => b.finishedAt! - a.finishedAt!);
      return {
        timeToRowsMs: Math.round(rows - navigationStart),
        releasedBy: before[0] ? { path: before[0].path, msBeforeRows: Math.round(rows - before[0].finishedAt!) } : null,
        responsesBeforeRows: before.length,
        apiRequests: reads.length,
        shellReads: shellReadCounts(),
      };
    } finally { await context.close(); }
  };
  type Sample = Awaited<ReturnType<typeof sample>>;
  const samples: Record<"saved" | "cleared", Sample[]> = { saved: [], cleared: [] };
  for (let run = 0; run < runs; run++) {
    samples.saved.push(await sample("saved"));
    samples.cleared.push(await sample("cleared"));
  }
  const report = (["saved", "cleared"] as const).map(cache => {
    const times = samples[cache].map(entry => entry.timeToRowsMs);
    console.log(`Mine time to rows, ${cache} cache, API +${delayMs} ms: median ${median(times)} ms over ${runs} runs (${[...times].sort((a, b) => a - b).join(", ")} ms); API requests ${samples[cache].map(entry => entry.apiRequests).join(", ")}`);
    return { cache, apiDelayMs: delayMs, medianMs: median(times), samples: samples[cache] };
  });
  await testInfo.attach("mine-returning-visit-timing", { contentType: "application/json", body: Buffer.from(JSON.stringify(report, null, 2)) });
  const output = process.env.PAPERCLIP_COLLECTION_PERF_OUTPUT;
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2));
});
