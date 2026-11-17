import fs from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { collectionFixture, type CollectionFixture } from "./fixture";

const RECENT_COUNT = 8;
const COMMENTS_PER_TASK = 12;
const IDLE_SETTLE_MS = 3_000;

type RecentTask = { id: string; identifier: string; title: string; marker: string };
let fixture: CollectionFixture;
let recents: RecentTask[];

async function ensureRecentTasks(request: APIRequestContext): Promise<RecentTask[]> {
  const tasks: RecentTask[] = [];
  for (const id of fixture.taskIds.slice(0, RECENT_COUNT)) {
    const issueResponse = await request.get(`/api/issues/${id}?view=core`);
    expect(issueResponse.ok(), await issueResponse.text()).toBeTruthy();
    const issue = await issueResponse.json() as { id: string; identifier: string; title: string };
    // No identifier in the marker: the chat would turn it into a task link.
    const marker = `Recent chat marker ${issue.id.slice(0, 8)}`;
    const recent = await (await request.get(`/api/issues/${id}/recent-comments`)).json() as { comments: Array<{ body: string }> };
    if (!recent.comments.some(comment => comment.body === marker)) {
      for (let index = recent.comments.length; index < COMMENTS_PER_TASK - 1; index += 1) {
        const created = await request.post(`/api/issues/${id}/comments`, { data: { body: `Saved context ${index} for ${issue.identifier}. `.repeat(8) } });
        expect(created.ok(), await created.text()).toBeTruthy();
      }
      const created = await request.post(`/api/issues/${id}/comments`, { data: { body: marker } });
      expect(created.ok(), await created.text()).toBeTruthy();
    }
    tasks.push({ id: issue.id, identifier: issue.identifier, title: issue.title, marker });
  }
  return tasks;
}

async function seedRecents(page: Page, request: APIRequestContext, tasks = recents) {
  const session = await (await request.get("/api/auth/get-session")).json().catch(() => null);
  const userId: string | null = session?.user?.id ?? session?.session?.userId ?? null;
  await page.addInitScript(({ companyId, userId, recents }) => {
    const entries = recents.map((task, index) => ({
      id: task.id, companyId, title: task.title, identifier: task.identifier, status: "backlog", recordedAt: Date.now() - index * 1000,
    }));
    for (const owner of new Set([userId ?? "__local_board__", "__local_board__"])) {
      localStorage.setItem(`paperclip.recentTasks.v2:${companyId}:${owner}`, JSON.stringify(entries));
    }
  }, { companyId: fixture.company.id, userId, recents: tasks });
}

async function addRecent(page: Page, task: RecentTask) {
  await page.evaluate(({ companyId, task }) => {
    for (const key of Object.keys(localStorage).filter(key => key.startsWith(`paperclip.recentTasks.v2:${companyId}:`))) {
      const oldValue = localStorage.getItem(key);
      const entries = JSON.parse(oldValue ?? "[]").filter((entry: { id: string }) => entry.id !== task.id);
      const newValue = JSON.stringify([{ ...task, companyId, status: "backlog", recordedAt: Date.now() }, ...entries]);
      localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue, storageArea: localStorage }));
    }
  }, { companyId: fixture.company.id, task });
  await expect(page.getByRole("link", { name: task.title }).first()).toBeVisible();
}

/** Per-task reads that gate the chat's first frame, plus the full detail read. */
function classifyTaskRead(url: URL): string | null {
  const match = url.pathname.match(/^\/api\/issues\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const rest = match[2] ?? "";
  const view = url.searchParams.get("view");
  if (rest === "" || rest === "/") return view === "core" ? "core" : "detail";
  if (rest === "/recent-comments") return "recent-comments";
  if (rest === "/activity" && view === "recent") return "activity";
  if (rest === "/activity" && view === "comment-inputs") return "comment-inputs";
  if (rest === "/runs" && view === "recent") return "runs";
  if (rest === "/interactions") return "interactions";
  if (rest === "/attachments") return "attachments";
  if (rest === "/live-runs") return "live-runs";
  if (rest === "/active-run") return "active-run";
  if (rest === "/chat-bootstrap") return "chat-bootstrap-single";
  return `other:${rest}`;
}
const FIRST_FRAME_READS = new Set(["core", "recent-comments", "activity", "comment-inputs", "runs", "interactions", "attachments", "live-runs", "active-run"]);

function recordRequests(page: Page) {
  const requests: URL[] = [];
  page.on("request", item => {
    const url = new URL(item.url());
    if (url.pathname.startsWith("/api/")) requests.push(url);
  });
  return requests;
}

async function loadIdle(page: Page) {
  await page.goto(`/${fixture.company.issuePrefix}/projects`);
  await expect(page.getByRole("link", { name: recents[0]!.title }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(IDLE_SETTLE_MS);
}

/** Click a Recents link and return ms from the click to the latest saved comment being on screen. */
async function openRecent(page: Page, task: RecentTask) {
  await page.evaluate((marker) => {
    const state = window as unknown as { __recentOpen?: { clickedAt?: number; shownAt?: number } };
    state.__recentOpen = {};
    document.addEventListener("pointerdown", () => { state.__recentOpen!.clickedAt ??= performance.now(); }, { capture: true, once: true });
    const check = () => {
      const thread = document.querySelector('[data-testid="task-chat-thread"] > [aria-busy="false"]');
      const composer = document.querySelector('[data-testid="task-chat-composer-stack"] [contenteditable="true"]');
      const visible = thread && [...thread.querySelectorAll("p")].some(element => {
        const box = element.getBoundingClientRect();
        return element.textContent?.trim() === marker && box.bottom > 0 && box.top < innerHeight && box.height > 0;
      });
      if (visible && composer) {
        state.__recentOpen!.shownAt = performance.now();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, task.marker);
  await page.getByRole("link", { name: task.title }).first().click();
  await expect(page.getByText(task.marker, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => (window as unknown as { __recentOpen?: { shownAt?: number } }).__recentOpen?.shownAt !== undefined);
  return page.evaluate(() => {
    const state = (window as unknown as { __recentOpen: { clickedAt: number; shownAt: number } }).__recentOpen;
    return state.shownAt - state.clickedAt;
  });
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

test.beforeAll(async ({ request }) => {
  fixture = await collectionFixture(request);
  recents = await ensureRecentTasks(request);
});

test("an idle page with Recents makes one chat-bootstrap read and no per-task reads", async ({ page, request }) => {
  await seedRecents(page, request);
  const requests = recordRequests(page);
  await loadIdle(page);
  const bootstraps = requests.filter(url => url.pathname === `/api/companies/${fixture.company.id}/issues/chat-bootstrap`);
  expect(bootstraps).toHaveLength(1);
  const ids = bootstraps[0]!.searchParams.get("ids")!.split(",");
  expect(ids.length).toBeLessThanOrEqual(10);
  expect(ids).toContain(recents[0]!.id);
  expect(requests.map(classifyTaskRead).filter(Boolean)).toEqual([]);
});

test("clicking a preloaded recent task shows its chat without first-frame reads", async ({ page, request }) => {
  await seedRecents(page, request);
  await loadIdle(page);
  const requests = recordRequests(page);
  const before = requests.length;
  const task = recents[1]!;
  await openRecent(page, task);
  const reads = requests.slice(before).map(classifyTaskRead).filter((kind): kind is string => !!kind);
  // The full detail read revalidates after the first frame; it is not a gate.
  test.info().annotations.push({ type: "after-click task reads", description: JSON.stringify(reads) });
  expect(reads.filter(kind => FIRST_FRAME_READS.has(kind))).toEqual([]);
});

test("a task added after the initial Recents preload opens without first-frame reads", async ({ page, request }) => {
  const added = recents.at(-1)!;
  await seedRecents(page, request, recents.slice(0, -1));
  await loadIdle(page);
  const requests = recordRequests(page);
  await addRecent(page, added);
  await expect.poll(() => requests.some(url => url.pathname.endsWith("/issues/chat-bootstrap")
    && url.searchParams.get("ids")?.split(",").includes(added.id))).toBe(true);
  await page.waitForLoadState("networkidle");
  requests.length = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/issues\//, async route => { await held; await route.continue(); });
  try {
    await openRecent(page, added);
    expect(requests.map(classifyTaskRead).filter(kind => kind && FIRST_FRAME_READS.has(kind))).toEqual([]);
    const editor = page.getByTestId("task-chat-composer-stack").locator('[contenteditable="true"]').first();
    await editor.fill("Keep this draft during background refresh");
    const savedEditor = await editor.elementHandle();
    const message = page.getByText(added.marker, { exact: true }).first();
    const before = await message.boundingBox();
    release();
    await page.waitForLoadState("networkidle");
    await expect(editor).toContainText("Keep this draft during background refresh");
    expect(await savedEditor!.evaluate(element => element.isConnected)).toBe(true);
    const after = await message.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: test.info().outputPath("added-recent-loaded.png") });
  } finally { release(); }
});

// Native loopback, then a diagnostic scenario that adds latency to every API
// response, as a slow hosted database would. Timings are evidence, not budgets.
for (const scenario of ["initial", "added"] as const) for (const apiDelayMs of [0, 150]) {
  test(`timing: ${scenario} recent task to first chat frame (+${apiDelayMs} ms API latency)`, async ({ browser, request, baseURL }) => {
    const profile = process.env.PAPERCLIP_COLLECTION_PERF_PROFILE === "1";
    const runs = profile ? 1 : Math.max(5, Number(process.env.PAPERCLIP_COLLECTION_PERF_TIMING_RUNS ?? 5));
    const timings: number[] = [];
    const idleCounts: number[] = [];
    const afterClick: string[][] = [];
    for (let run = 0; run < runs; run += 1) {
      // A fresh context per run: empty HTTP cache, memory cache and storage,
      // except the seeded Recents history.
      // browser.newContext() does not inherit the project `use` options.
      const context = await browser.newContext({ baseURL, serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      if (apiDelayMs) {
        await page.route("**/api/**", async route => {
          await new Promise(resolve => setTimeout(resolve, apiDelayMs));
          await route.fallback();
        });
      }
      await seedRecents(page, request, scenario === "added" ? recents.slice(0, -1) : recents);
      const requests = recordRequests(page);
      await loadIdle(page);
      if (scenario === "added") {
        await addRecent(page, recents.at(-1)!);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(IDLE_SETTLE_MS);
      }
      idleCounts.push(requests.length);
      const task = scenario === "added" ? recents.at(-1)! : recents[(run % (RECENT_COUNT - 1)) + 1]!;
      const cdp = await context.newCDPSession(page);
      if (profile) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.start");
      }
      timings.push(await openRecent(page, task));
      if (profile) {
        const result = await cdp.send("Profiler.stop");
        const file = test.info().outputPath(`cpu-${run}.cpuprofile`);
        await fs.writeFile(file, JSON.stringify(result.profile));
        await test.info().attach(`cpu-${run}`, { path: file, contentType: "application/json" });
      }
      const waterfall = await page.evaluate(() => performance.getEntriesByType("resource").filter(entry => entry.name.includes("/api/"))
        .map(entry => ({ ...entry.toJSON(), serverTiming: (entry as PerformanceResourceTiming).serverTiming.map(timing => timing.toJSON()) })));
      const file = test.info().outputPath(`waterfall-${run}.json`);
      await fs.writeFile(file, JSON.stringify(waterfall, null, 2));
      await test.info().attach(`waterfall-${run}`, { path: file, contentType: "application/json" });
      afterClick.push(requests.slice(idleCounts.at(-1)).map(classifyTaskRead).filter((kind): kind is string => !!kind));
      await context.close();
    }
    const summary = {
      scenario, apiDelayMs, runs, profile, clickToFirstFrameMs: timings.map(Math.round), medianMs: Math.round(median(timings)),
      idleApiRequests: idleCounts, medianIdleApiRequests: median(idleCounts), taskReadsAfterClick: afterClick,
    };
    console.log(`recent-task-open timing ${JSON.stringify(summary)}`);
    const file = test.info().outputPath("timings.json");
    await fs.writeFile(file, JSON.stringify(summary, null, 2));
    await test.info().attach("recent-task-open-timing", { path: file, contentType: "application/json" });
  });
}
