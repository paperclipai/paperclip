import { expect, test, type Page } from "@playwright/test";
import { isolatedWorkspaceSettings, workspaceFixture, WORKSPACE_COUNT, type WorkspaceFixture } from "./workspace-fixture";

// Mine must not wait on a company-wide execution-workspace list. With thousands
// of workspaces that list was megabytes and seconds long, and Mine held every
// row hidden until it finished. These checks run against a company with
// WORKSPACE_COUNT workspaces and Mine rows that each reference their own.
let fixture: WorkspaceFixture;
test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  fixture = await workspaceFixture(request);
});

const workspaceListPath = () => `/api/companies/${fixture.company.id}/execution-workspaces`;
const minePage = () => `/${fixture.company.issuePrefix}/issues?view=mine`;
const mineLink = (page: Page, identifier: string) => page.locator(`[data-inbox-issue-link][href$="/${identifier}"]`);
const mineRow = (page: Page, identifier: string) => page.locator("[data-inbox-item]", { has: mineLink(page, identifier) });
const showWorkspaceColumn = (page: Page) => page.addInitScript(() => {
  localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "workspace", "updated"]));
});
function recordWorkspaceReads(page: Page) {
  const reads: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === workspaceListPath()) reads.push(url);
  });
  return reads;
}
function holdWorkspaceReads(page: Page) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let pending = 0;
  const ready = page.route(url => url.pathname === workspaceListPath(), async route => {
    pending += 1;
    await held;
    await route.continue();
  });
  return { ready, release, pending: () => pending };
}

test("Mine reads only the execution workspaces its rows reference", async ({ page }) => {
  await isolatedWorkspaceSettings(page);
  const reads = recordWorkspaceReads(page);
  await page.goto(minePage());
  for (const row of fixture.mine) await expect(mineLink(page, row.identifier)).toBeVisible();
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  // Late reads (background refetches) must follow the same rule.
  await page.waitForTimeout(1_000);
  const unfiltered = reads.filter(url => !url.searchParams.has("ids")).map(url => `${url.pathname}${url.search}`);
  expect(unfiltered, `Mine requested the company-wide list of ${WORKSPACE_COUNT} workspaces`).toEqual([]);
  const expected = fixture.mine.map(row => row.workspaceId).sort();
  expect([...new Set(reads.flatMap(url => url.searchParams.get("ids")!.split(",")))].sort()).toEqual(expected);
  for (const url of reads) {
    expect(url.searchParams.get("summary")).toBe("true");
    expect(url.searchParams.get("ids")!.split(",").every(id => expected.includes(id))).toBe(true);
  }
});

test("Mine rows appear while workspace reads are pending when no workspace data is shown", async ({ page }) => {
  await isolatedWorkspaceSettings(page);
  const hold = holdWorkspaceReads(page);
  await hold.ready;
  try {
    await page.goto(minePage());
    for (const row of fixture.mine) {
      await expect(mineLink(page, row.identifier), "Mine rows waited for the workspace read").toBeVisible({ timeout: 15_000 });
    }
    expect(hold.pending()).toBeGreaterThan(0);
  } finally { hold.release(); }
});

test("the Workspace column resolves each Mine row's isolated workspace name", async ({ page }) => {
  await isolatedWorkspaceSettings(page);
  await showWorkspaceColumn(page);
  await page.goto(minePage());
  for (const row of fixture.mine) await expect(mineRow(page, row.identifier)).toContainText(row.workspaceName);
});

// Cold time to first Mine row, from navigation start (two frames after the
// first row mounts, as in measure-mine-context.ts), in fresh browser contexts
// with the real instance setting. The native scenario uses no request
// interception. The delayed scenario holds every workspace read for
// WORKSPACE_DELAY_MS and is diagnostic evidence only: it shows whether rows wait
// on that read. Neither is a budget; the structural checks above are the guard.
const WORKSPACE_DELAY_MS = 3_000;
type Sample = { timeToRowsMs: number; workspaceReads: string[] };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

test("records cold time to Mine rows", async ({ browser, request, baseURL }, testInfo) => {
  const runs = Number(process.env.PAPERCLIP_COLLECTION_PERF_TIMING_RUNS ?? 5);
  expect(Number.isInteger(runs) && runs >= 5, "Record at least five samples").toBe(true);
  test.setTimeout(60_000 + runs * 60_000);
  const settingsUrl = "/api/instance/settings/experimental";
  const original = await (await request.get(settingsUrl)).json() as { enableIsolatedWorkspaces: boolean };
  const enable = await request.patch(settingsUrl, { data: { enableIsolatedWorkspaces: true } });
  expect(enable.ok(), await enable.text()).toBeTruthy();
  const sample = async (delayMs: number): Promise<Sample> => {
    const context = await browser.newContext({ baseURL, serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      const reads = recordWorkspaceReads(page);
      if (delayMs > 0) await page.route(url => url.pathname === workspaceListPath(), async route => {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        await route.continue();
      });
      await page.addInitScript(() => {
        const state = window as unknown as { __mineRowsAt: number | null };
        state.__mineRowsAt = null;
        const observer = new MutationObserver(() => {
          if (!document.querySelector("[data-inbox-item]")) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => { state.__mineRowsAt = performance.now(); }));
        });
        observer.observe(document, { subtree: true, childList: true });
      });
      await page.goto(minePage());
      await page.waitForFunction(() => (window as unknown as { __mineRowsAt: number | null }).__mineRowsAt !== null, null, { timeout: 30_000 });
      const timeToRowsMs = Math.round(await page.evaluate(() => (window as unknown as { __mineRowsAt: number }).__mineRowsAt));
      await expect(mineLink(page, fixture.mine[0]!.identifier)).toBeVisible();
      return { timeToRowsMs, workspaceReads: reads.map(url => url.search) };
    } finally { await context.close(); }
  };
  const scenarios = [
    { name: "native loopback, no interception", delayMs: 0, samples: [] as Sample[] },
    { name: `workspace reads delayed ${WORKSPACE_DELAY_MS} ms (diagnostic, intercepted)`, delayMs: WORKSPACE_DELAY_MS, samples: [] as Sample[] },
  ];
  try {
    for (const scenario of scenarios) for (let run = 0; run < runs; run++) scenario.samples.push(await sample(scenario.delayMs));
  } finally {
    const restore = await request.patch(settingsUrl, { data: { enableIsolatedWorkspaces: original.enableIsolatedWorkspaces } });
    expect(restore.ok(), await restore.text()).toBeTruthy();
  }
  const report = scenarios.map(({ name, samples }) => {
    const times = samples.map(entry => entry.timeToRowsMs);
    console.log(`Mine cold time to rows, ${name}: median ${median(times)} ms over ${runs} runs (${[...times].sort((a, b) => a - b).join(", ")} ms)`);
    return { scenario: name, workspaces: WORKSPACE_COUNT, mineRows: fixture.mine.length, medianMs: median(times), samples };
  });
  await testInfo.attach("mine-workspace-scale-timing", { contentType: "application/json", body: Buffer.from(JSON.stringify(report, null, 2)) });
});
