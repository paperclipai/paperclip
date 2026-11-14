import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

/**
 * Cold direct load of a task URL with every API response delayed, so serial
 * request stages show up as wall-clock time. The finish event is the first
 * readable chat frame: the history is revealed (`aria-busy="false"`), the saved
 * messages are visible and the composer is editable.
 *
 * `PAPERCLIP_ISSUE_PERF_COLD_RUNS` (>= 5) enables the benchmark and writes
 * `test-results/issue-detail-perf/cold-bootstrap-<label>.{json,md}`. The request-shape
 * test always runs.
 */

const API_DELAY_MS = Number(process.env.PAPERCLIP_ISSUE_PERF_API_DELAY_MS ?? 300);
const requestedRuns = Number(process.env.PAPERCLIP_ISSUE_PERF_COLD_RUNS ?? 0);
const RUNS = Number.isFinite(requestedRuns) && requestedRuns > 0 ? Math.max(5, Math.floor(requestedRuns)) : 0;
const OUTPUT_DIR = path.resolve(process.cwd(), "test-results/issue-detail-perf");
const LABEL = process.env.PAPERCLIP_ISSUE_PERF_LABEL ?? "candidate";
const COMMENT_COUNT = 24;
// The staging measurement had the app's JavaScript in the HTTP cache. Set
// PAPERCLIP_ISSUE_PERF_COLD_HTTP_CACHE=1 to download it on every run instead.
const WARM_HTTP_CACHE = process.env.PAPERCLIP_ISSUE_PERF_COLD_HTTP_CACHE !== "1";
const LAST_COMMENT = `Cold bootstrap comment ${COMMENT_COUNT}: the latest saved message.`;

type Seed = { companyId: string; prefix: string; issueId: string; identifier: string };
type RequestRecord = { path: string; method: string; startMs: number; endMs: number | null };
type Sample = { run: number; revealMs: number; jsTransferBytes: number; socketMs: number | null; apiRequestsBeforeReveal: number; requests: RequestRecord[]; releasedBy: string[] };

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

async function seed(request: APIRequestContext): Promise<Seed> {
  const companyResponse = await request.post("/api/companies", { data: { name: `Cold bootstrap ${Date.now()}` } });
  expect(companyResponse.ok(), await companyResponse.text()).toBe(true);
  const company = await companyResponse.json();
  const issueResponse = await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: `Cold bootstrap task ${Date.now()}`, description: "A task opened by a direct URL.", status: "todo" },
  });
  expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
  const issue = await issueResponse.json();
  for (let index = 1; index <= COMMENT_COUNT; index += 1) {
    const body = index === COMMENT_COUNT ? LAST_COMMENT : `Cold bootstrap comment ${index}: ${"saved conversation text ".repeat(12)}`;
    const response = await request.post(`/api/issues/${issue.id}/comments`, { data: { body } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const planResponse = await request.put(`/api/issues/${issue.id}/documents/plan`, {
    data: { format: "markdown", title: "Plan", body: "# Plan\n\nOpen the task in one round trip." },
  });
  expect(planResponse.ok(), await planResponse.text()).toBe(true);
  return { companyId: company.id, prefix: company.issuePrefix, issueId: issue.id, identifier: issue.identifier };
}

function scrub(url: string, seedData: Seed) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`
    .replaceAll(seedData.issueId, ":id")
    .replaceAll(seedData.identifier, ":ref")
    .replaceAll(seedData.companyId, ":company");
}

/**
 * What the measured load starts with:
 * - `empty`: no app storage at all.
 * - `no-saved-reads`: a returning browser whose saved read cache was cleared.
 * - `saved-reads`: a returning browser with the saved read cache of an earlier
 *   visit to this task (`paperclip:query-cache:v1:*` in local storage).
 */
type StartState = "empty" | "no-saved-reads" | "saved-reads";
const SAVED_READS_PREFIX = "paperclip:query-cache:v1:";

type MeasureHooks = {
  /** Runs after the warm-up visit saved its reads, before the measured load. */
  beforeLoad?: () => Promise<void>;
  /** Runs after the first frame, before the browser closes. */
  afterReveal?: (page: Page) => Promise<void>;
};

async function measure(browser: Browser, baseURL: string, seedData: Seed, run: number, start: StartState = "empty", apiDelayMs = API_DELAY_MS, hooks: MeasureHooks = {}): Promise<Sample> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  if (WARM_HTTP_CACHE || start !== "empty") {
    // Load the app's JavaScript into this context's HTTP cache, then clear
    // the app stores the measured load must start without.
    const warm = await context.newPage();
    await warm.goto(`/${seedData.prefix}/issues/${seedData.identifier}`);
    await warm.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]').waitFor({ timeout: 60_000 });
    if (start === "saved-reads") {
      // The read cache saves after a short debounce; wait until it holds this task.
      await warm.waitForFunction(({ prefix, issueId }) => Object.keys(localStorage).some((key) => key.startsWith(prefix)
        && (localStorage.getItem(key) ?? "").includes(issueId)), { prefix: SAVED_READS_PREFIX, issueId: seedData.issueId }, { timeout: 30_000 });
    }
    // Closing the app saves its read cache, so clear storage afterwards from
    // a same-origin page that does not run the app.
    await warm.close();
    const cleaner = await context.newPage();
    await cleaner.goto("/api/health");
    await cleaner.evaluate(async ({ start, prefix }) => {
      if (start === "empty") localStorage.clear();
      else if (start === "no-saved-reads") for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
      sessionStorage.clear();
      for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
      for (const key of (await caches?.keys?.()) ?? []) await caches.delete(key);
    }, { start, prefix: SAVED_READS_PREFIX });
    await cleaner.close();
  }
  await hooks.beforeLoad?.();
  const page = await context.newPage();
  // Delay API requests through CDP request interception. Playwright routing
  // would disable the HTTP cache and download the warmed JavaScript again.
  const cdp = await context.newCDPSession(page);
  cdp.on("Fetch.requestPaused", (event: { requestId: string }) => {
    setTimeout(() => { void cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {}); }, apiDelayMs);
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  const records = new Map<object, RequestRecord>();
  let origin = 0;
  page.on("request", (req) => {
    if (!new URL(req.url()).pathname.startsWith("/api/")) return;
    records.set(req, { path: scrub(req.url(), seedData), method: req.method(), startMs: Date.now() - origin, endMs: null });
  });
  const finish = (req: object) => {
    const record = records.get(req);
    if (record) record.endMs = Date.now() - origin;
  };
  let socketMs: number | null = null;
  // When the live-update socket is created. It refreshes every open query on
  // open, which follows creation, so later reads may be that catch-up.
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/api/")) socketMs ??= Date.now() - origin;
  });
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  // Record the first frame in the page so polling does not add latency.
  await page.addInitScript((lastComment) => {
    const check = () => {
      if ((window as Window & { __coldReveal?: number }).__coldReveal) return;
      const ready = document.querySelector('[data-testid="task-chat-thread"] > [aria-busy="false"]');
      const composer = document.querySelector('[data-testid="task-chat-composer-stack"] [contenteditable="true"]');
      const message = ready && [...ready.querySelectorAll("p, div")].some((el) => el.textContent === lastComment);
      if (ready && composer && message) (window as Window & { __coldReveal?: number }).__coldReveal = performance.now();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, LAST_COMMENT);
  origin = Date.now();
  await page.goto(`/${seedData.prefix}/issues/${seedData.identifier}`);
  await page.waitForFunction(() => (window as Window & { __coldReveal?: number }).__coldReveal, null, { timeout: 60_000, polling: 50 });
  const { revealMs, navStartEpoch, jsTransferBytes } = await page.evaluate(() => ({
    // Bytes of JavaScript fetched over the network; near zero when the HTTP cache served it.
    jsTransferBytes: (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => entry.initiatorType === "script" || /\.m?js(\?|$)/.test(entry.name))
      .reduce((sum, entry) => sum + entry.transferSize, 0),
    revealMs: (window as Window & { __coldReveal?: number }).__coldReveal!,
    navStartEpoch: performance.timeOrigin,
  }));
  await hooks.afterReveal?.(page);
  await page.waitForTimeout(1_500);
  await context.close();
  // Re-base node-side timestamps on the navigation start.
  const shift = navStartEpoch - origin;
  const requests = [...records.values()]
    .map((record) => ({ ...record, startMs: record.startMs - shift, endMs: record.endMs === null ? null : record.endMs - shift }))
    .sort((left, right) => left.startMs - right.startMs);
  const before = requests.filter((record) => record.startMs <= revealMs);
  const finishedBefore = before.filter((record) => record.endMs !== null && record.endMs <= revealMs);
  const lastEnd = Math.max(...finishedBefore.map((record) => record.endMs!));
  const releasedBy = finishedBefore.filter((record) => record.endMs! >= lastEnd - 50).map((record) => record.path);
  return { run, revealMs, jsTransferBytes, socketMs: socketMs === null ? null : socketMs - shift, apiRequestsBeforeReveal: before.length, requests, releasedBy };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// The per-endpoint reads the chat bootstrap answers. The full task read
// (`/api/issues/:ref`) is not among them: it adds related data and never
// gates the first frame.
const FIRST_FRAME_ENDPOINTS = [
  /^\/api\/issues\/[^/]+\?view=core$/,
  /^\/api\/issues\/[^/]+\/(recent-)?comments(\?|$)/,
  /^\/api\/issues\/[^/]+\/activity(\?|$)/,
  /^\/api\/issues\/[^/]+\/runs(\?|$)/,
  /^\/api\/issues\/[^/]+\/interactions(\?|$)/,
  /^\/api\/issues\/[^/]+\/attachments(\?|$)/,
  /^\/api\/issues\/[^/]+\/live-runs(\?|$)/,
  /^\/api\/issues\/[^/]+\/active-run(\?|$)/,
];

test("a cold direct task load reads its first frame from one chat bootstrap", async ({ browser, baseURL, request }) => {
  const seedData = await seed(request);
  const sample = await measure(browser, baseURL!, seedData, 1);
  await test.info().attach("requests.json", { body: JSON.stringify(sample, null, 2), contentType: "application/json" });
  const perEndpoint = (record: RequestRecord) => FIRST_FRAME_ENDPOINTS.some((pattern) => pattern.test(record.path));
  const startedBefore = sample.requests.filter((record) => record.startMs <= sample.revealMs);
  // Once the live-update socket opens, it refreshes every open query
  // to cover events between the initial reads and the subscription. Those
  // refreshes are not first-frame reads.
  const catchUpFrom = sample.socketMs ?? Number.POSITIVE_INFINITY;
  const firstFrameReads = startedBefore.filter((record) => perEndpoint(record) && record.startMs < catchUpFrom);
  if (firstFrameReads.length > 0) {
    console.log(`frame at ${Math.round(sample.revealMs)} ms, socket ${sample.socketMs === null ? "none" : Math.round(sample.socketMs)} ms\n${sample.requests.map((r) => `${Math.round(r.startMs)}-${r.endMs === null ? "pending" : Math.round(r.endMs)} ${r.method} ${r.path}`).join("\n")}`);
  }
  expect(startedBefore.filter((record) => record.path.startsWith("/api/issues/:ref/chat-bootstrap"))).toHaveLength(1);
  expect(firstFrameReads.map((record) => record.path)).toEqual([]);
});

test("a returning task load with saved reads revalidates its first frame through one chat bootstrap", async ({ browser, baseURL, request }) => {
  const seedData = await seed(request);
  const sample = await measure(browser, baseURL!, seedData, 1, "saved-reads");
  await test.info().attach("requests.json", { body: JSON.stringify(sample, null, 2), contentType: "application/json" });
  // The saved task (header, core fields) is restored, but no chat history
  // is saved: its reads must share the page's bootstrap like a cold load,
  // including the restored task's own revalidation and its plan projection.
  const perEndpoint = (record: RequestRecord) => FIRST_FRAME_ENDPOINTS.some((pattern) => pattern.test(record.path))
    || /^\/api\/issues\/[^/]+\/documents\/plan$/.test(record.path);
  const startedBefore = sample.requests.filter((record) => record.startMs <= sample.revealMs);
  const catchUpFrom = sample.socketMs ?? Number.POSITIVE_INFINITY;
  const firstFrameReads = startedBefore.filter((record) => perEndpoint(record) && record.startMs < catchUpFrom);
  if (firstFrameReads.length > 0) {
    console.log(`frame at ${Math.round(sample.revealMs)} ms, socket ${sample.socketMs === null ? "none" : Math.round(sample.socketMs)} ms\n${sample.requests.map((r) => `${Math.round(r.startMs)}-${r.endMs === null ? "pending" : Math.round(r.endMs)} ${r.method} ${r.path}`).join("\n")}`);
  }
  expect(startedBefore.filter((record) => record.path.startsWith("/api/issues/:ref/chat-bootstrap"))).toHaveLength(1);
  expect(firstFrameReads.map((record) => record.path)).toEqual([]);
});

test("a returning task load shows its saved chat before any API response, then revalidates", async ({ browser, baseURL, request }) => {
  const seedData = await seed(request);
  // Every response arrives well after the app has booted, so a frame before
  // the first response can only come from the saved read cache.
  const change = `Server-side change after the save ${Date.now()}`;
  let shownBeforeRevalidation: boolean | null = null;
  const sample = await measure(browser, baseURL!, seedData, 1, "saved-reads", 2_500, {
    // A reply posted while the browser was closed: the saved chat lacks it.
    beforeLoad: async () => {
      const response = await request.post(`/api/issues/${seedData.issueId}/comments`, { data: { body: change } });
      expect(response.ok(), await response.text()).toBe(true);
    },
    afterReveal: async (page) => {
      shownBeforeRevalidation = await page.getByText(change).isVisible();
      // The bootstrap's answer replaces the saved chat.
      await expect(page.getByText(change)).toBeVisible({ timeout: 20_000 });
    },
  });
  await test.info().attach("requests.json", { body: JSON.stringify(sample, null, 2), contentType: "application/json" });
  const firstResponse = Math.min(...sample.requests.filter((record) => record.endMs !== null).map((record) => record.endMs!));
  expect(sample.revealMs).toBeLessThan(firstResponse);
  expect(shownBeforeRevalidation).toBe(false);
  // The saved chat is revalidated through the page's one bootstrap.
  expect(sample.requests.filter((record) => record.path.startsWith("/api/issues/:ref/chat-bootstrap"))).toHaveLength(1);
});

test("cold direct task load benchmark", async ({ browser, baseURL, request }) => {
  test.skip(RUNS === 0, "Set PAPERCLIP_ISSUE_PERF_COLD_RUNS to run the benchmark.");
  test.setTimeout(15 * 60_000);
  const seedData = await seed(request);
  const samples: Sample[] = [];
  for (let run = 1; run <= RUNS; run += 1) samples.push(await measure(browser, baseURL!, seedData, run));
  const reveals = samples.map((sample) => sample.revealMs);
  const counts = samples.map((sample) => sample.apiRequestsBeforeReveal);
  const report = [
    `# Cold direct task load (${LABEL})`,
    "",
    `API delay ${API_DELAY_MS} ms per request, ${RUNS} runs, fresh browser context each run, JavaScript ${WARM_HTTP_CACHE ? "in the HTTP cache" : "downloaded"}, no app storage.`,
    "",
    `- First readable frame: median ${Math.round(median(reveals))} ms, min ${Math.round(Math.min(...reveals))}, max ${Math.round(Math.max(...reveals))}`,
    `- API requests started before the frame: median ${median(counts)}, min ${Math.min(...counts)}, max ${Math.max(...counts)}`,
    `- JavaScript transferred over the network: median ${Math.round(median(samples.map((sample) => sample.jsTransferBytes)) / 1024)} KiB`,
    `- Released by (run 1): ${samples[0]!.releasedBy.join(", ")}`,
    "",
    "## Run 1 requests (ms from navigation start)",
    "",
    "| start | end | request |",
    "| ---: | ---: | --- |",
    ...samples[0]!.requests.map((record) => `| ${Math.round(record.startMs)} | ${record.endMs === null ? "pending" : Math.round(record.endMs)} | ${record.method} ${record.path}${record.startMs > samples[0]!.revealMs ? " (after frame)" : ""} |`),
    "",
    `Frame at ${Math.round(samples[0]!.revealMs)} ms.`,
  ].join("\n");
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, `cold-bootstrap-${LABEL}.json`), JSON.stringify({ apiDelayMs: API_DELAY_MS, samples }, null, 2));
  await fs.writeFile(path.join(OUTPUT_DIR, `cold-bootstrap-${LABEL}.md`), report);
  console.log(`\n${report}\n`);
});


function summary(samples: Sample[]) {
  const reveals = samples.map((sample) => sample.revealMs);
  const counts = samples.map((sample) => sample.apiRequestsBeforeReveal);
  return {
    median: Math.round(median(reveals)), min: Math.round(Math.min(...reveals)), max: Math.round(Math.max(...reveals)),
    requestsMedian: median(counts), requestsMin: Math.min(...counts), requestsMax: Math.max(...counts),
  };
}

test("returning task load benchmark: saved read cache present versus cleared", async ({ browser, baseURL, request }) => {
  test.skip(RUNS === 0, "Set PAPERCLIP_ISSUE_PERF_COLD_RUNS to run the benchmark.");
  test.setTimeout(20 * 60_000);
  const seedData = await seed(request);
  const pairs: Array<{ cleared: Sample; saved: Sample }> = [];
  // Alternate the order within each pair so drift does not favour one side.
  for (let run = 1; run <= RUNS; run += 1) {
    if (run % 2) {
      const cleared = await measure(browser, baseURL!, seedData, run, "no-saved-reads");
      pairs.push({ cleared, saved: await measure(browser, baseURL!, seedData, run, "saved-reads") });
    } else {
      const saved = await measure(browser, baseURL!, seedData, run, "saved-reads");
      pairs.push({ cleared: await measure(browser, baseURL!, seedData, run, "no-saved-reads"), saved });
    }
  }
  const cleared = summary(pairs.map((pair) => pair.cleared));
  const saved = summary(pairs.map((pair) => pair.saved));
  const deltas = pairs.map((pair) => pair.saved.revealMs - pair.cleared.revealMs);
  const row = (name: string, value: ReturnType<typeof summary>) =>
    `| ${name} | ${value.median} | ${value.min}–${value.max} | ${value.requestsMedian} (${value.requestsMin}–${value.requestsMax}) |`;
  const timeline = (sample: Sample) => sample.requests.map((record) =>
    `| ${Math.round(record.startMs)} | ${record.endMs === null ? "pending" : Math.round(record.endMs)} | ${record.method} ${record.path}${record.startMs > sample.revealMs ? " (after frame)" : ""} |`);
  const report = [
    `# Returning task load (${LABEL})`,
    "",
    `API delay ${API_DELAY_MS} ms per request, ${RUNS} alternating pairs, fresh browser context each run, JavaScript in the HTTP cache.`,
    "",
    "| saved read cache | median ms | spread ms | requests before frame |",
    "| --- | ---: | ---: | ---: |",
    row("cleared", cleared),
    row("present", saved),
    "",
    `Paired delta (present − cleared): median ${Math.round(median(deltas))} ms, ${deltas.map((delta) => Math.round(delta)).join(", ")}.`,
    `Released by (pair 1): cleared ${pairs[0]!.cleared.releasedBy.join(", ")}; present ${pairs[0]!.saved.releasedBy.join(", ")}.`,
    "",
    "## Pair 1, saved read cache present (ms from navigation start)",
    "",
    "| start | end | request |",
    "| ---: | ---: | --- |",
    ...timeline(pairs[0]!.saved),
    "",
    `Frame at ${Math.round(pairs[0]!.saved.revealMs)} ms.`,
    "",
    "## Pair 1, saved read cache cleared",
    "",
    "| start | end | request |",
    "| ---: | ---: | --- |",
    ...timeline(pairs[0]!.cleared),
    "",
    `Frame at ${Math.round(pairs[0]!.cleared.revealMs)} ms.`,
  ].join("\n");
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, `returning-task-${LABEL}.json`), JSON.stringify({ apiDelayMs: API_DELAY_MS, pairs }, null, 2));
  await fs.writeFile(path.join(OUTPUT_DIR, `returning-task-${LABEL}.md`), report);
  console.log(`\n${report}\n`);
});
