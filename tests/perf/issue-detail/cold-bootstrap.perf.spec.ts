import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";

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

async function measure(browser: Browser, baseURL: string, seedData: Seed, run: number): Promise<Sample> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  if (WARM_HTTP_CACHE) {
    // Load the app's JavaScript into this context's HTTP cache, then clear
    // every app store so the measured load starts without app data.
    const warm = await context.newPage();
    await warm.goto(`/${seedData.prefix}/issues/${seedData.identifier}`);
    await warm.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]').waitFor({ timeout: 60_000 });
    await warm.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
      for (const key of (await caches?.keys?.()) ?? []) await caches.delete(key);
    });
    await warm.close();
  }
  const page = await context.newPage();
  // Delay API requests through CDP request interception. Playwright routing
  // would disable the HTTP cache and download the warmed JavaScript again.
  const cdp = await context.newCDPSession(page);
  cdp.on("Fetch.requestPaused", (event: { requestId: string }) => {
    setTimeout(() => { void cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {}); }, API_DELAY_MS);
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

