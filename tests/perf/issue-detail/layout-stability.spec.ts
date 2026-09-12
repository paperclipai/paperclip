import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90_000);

test.use({ video: "on", trace: "retain-on-failure", viewport: { width: 1440, height: 900 } });

let prefix: string;
let issue: { id: string; identifier: string };
let other: { id: string; identifier: string };
let oldestCommentId: string;

test.beforeAll(async ({ request }) => {
  const company = await (await request.post("/api/companies", { data: { name: `Layout acceptance ${Date.now()}` } })).json();
  prefix = company.issuePrefix;
  const createIssue = async (title: string) => {
    const response = await request.post(`/api/companies/${company.id}/issues`, {
      data: { title, status: "backlog", description: "A rich task with a long conversation.\n\n".repeat(15) },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  issue = await createIssue("Stable conversation acceptance");
  other = await createIssue("Rapid navigation destination");
  for (let i = 0; i < 160; i++) {
    const response = await request.post(`/api/issues/${issue.id}/comments`, {
      data: { body: `## Historical message ${i}\n\n${"Long Markdown with **emphasis**, detail, and enough text to wrap across several lines. ".repeat(8)}\n\n\`\`\`js\nconsole.log(${i});\n\`\`\`\n\n| State | Result |\n|---|---|\n| Complete | Stable |${i === 159 ? `\n\n[Read the oldest message](#comment-${oldestCommentId})` : ""}` },
    });
    expect(response.ok()).toBeTruthy();
    if (i === 0) oldestCommentId = (await response.json()).id;
  }
  const interaction = await (await request.post(`/api/issues/${issue.id}/interactions`, {
    data: { kind: "request_confirmation", title: "Geometry review", payload: { version: 1, prompt: "Inspect the conversation." }, continuationPolicy: "none" },
  })).json();
  await request.post(`/api/issues/${issue.id}/interactions/${interaction.id}/accept`, { data: {} });
});

async function ready(page: Page) {
  await expect(page.getByTestId("task-chat-thread").locator('[aria-busy="false"]')).toBeVisible({ timeout: 90_000 });
}

async function installMeasurements(page: Page) {
  await page.addInitScript(() => {
    const evidence = { frames: [] as unknown[], shifts: [] as unknown[] };
    Object.assign(window, { taskLayoutEvidence: evidence });
    new PerformanceObserver((list) => {
      evidence.shifts.push(...list.getEntries().map((e) => e.toJSON()));
    }).observe({ type: "layout-shift", buffered: true });
    const sample = () => {
      const scroller = document.querySelector('[data-testid="task-chat-scroller"]');
      const busy = document.querySelector('[data-testid="task-chat-thread"] [aria-busy]');
      if (scroller) {
        const viewport = scroller.getBoundingClientRect();
        const row = [...scroller.querySelectorAll<HTMLElement>("[data-thread-anchor]")].find((el) => el.getBoundingClientRect().bottom > viewport.top);
        evidence.frames.push({ time: performance.now(), busy: busy?.getAttribute("aria-busy"), top: scroller.scrollTop, width: viewport.width, fonts: document.fonts.status, rows: scroller.querySelectorAll("[data-thread-anchor]").length, height: scroller.scrollHeight, anchor: row?.dataset.threadAnchor, offset: row ? row.getBoundingClientRect().top - viewport.top : null });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => (window as unknown as { taskLayoutEvidence?: unknown }).taskLayoutEvidence).catch(() => null);
  if (evidence) {
    const file = info.outputPath("layout.json");
    await fs.writeFile(file, JSON.stringify(evidence));
    await info.attach("layout-frames-and-shifts", { path: file, contentType: "application/json" });
  }
});

test("Inbox click reveals once after reordered initial responses; refresh retains rows", async ({ page }) => {
  await installMeasurements(page);
  await page.goto(`/${prefix}/inbox/all`);
  const link = page.getByRole("link", { name: new RegExp(`Open ${issue.identifier}:`) });
  await expect(link).toBeVisible({ timeout: 90_000 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/issues/*/comments?*", async (route) => { await held; await route.continue(); });
  await link.click();
  await expect(page.getByTestId("task-chat-thread").locator('[aria-busy="true"]')).toBeVisible();
  await expect(page.getByText("Historical message 159", { exact: true })).not.toBeVisible();
  release();
  await ready(page);
  const scroller = page.getByTestId("task-chat-scroller");
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  await page.waitForTimeout(1200);
  const frames = await page.evaluate(() => (window as unknown as { taskLayoutEvidence: { frames: { busy: string; top: number; anchor: string; offset: number }[] } }).taskLayoutEvidence.frames);
  const visibleFrames = frames.filter((frame) => frame.busy === "false");
  expect(visibleFrames.length).toBeGreaterThan(2);
  expect(new Set(visibleFrames.map((f) => f.anchor)).size).toBe(1);
  expect(Math.max(...visibleFrames.map((f) => f.offset)) - Math.min(...visibleFrames.map((f) => f.offset))).toBeLessThanOrEqual(2);
});

test("reading anchor survives late media, composer resizing, older history and browser Back", async ({ page }) => {
  await installMeasurements(page);
  await page.goto(`/${prefix}/issues/${issue.identifier}`);
  await ready(page);
  const scroller = page.getByTestId("task-chat-scroller");
  await expect(page.getByText("Historical message 10", { exact: true })).toBeAttached();
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
  await page.waitForTimeout(100);
  const anchor = await scroller.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-thread-anchor]")].find((r) => r.getBoundingClientRect().bottom > top)!;
    return { id: row.dataset.threadAnchor!, top: row.getBoundingClientRect().top - top };
  });
  // Deterministic late media sizing above the reader, after the initial data
  // has arrived. This exercises the actual route's ResizeObserver owner.
  await scroller.evaluate((el) => {
    const media = document.createElement("div");
    media.style.height = "360px";
    el.querySelector("[data-thread-anchor]")!.append(media);
  });
  const offset = () => scroller.evaluate((el, id) => {
    const row = [...el.querySelectorAll<HTMLElement>("[data-thread-anchor]")].find((r) => r.dataset.threadAnchor === id)!;
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, anchor.id);
  await expect.poll(async () => Math.abs(await offset() - anchor.top)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Hide properties", exact: true }).click();
  await page.waitForTimeout(300);
  await expect.poll(async () => Math.abs(await offset() - anchor.top)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Show properties", exact: true }).click();
  await page.waitForTimeout(300);
  await expect.poll(async () => Math.abs(await offset() - anchor.top)).toBeLessThanOrEqual(2);
  await page.locator('[contenteditable="true"]').last().fill("A multiline draft\n".repeat(8));
  await expect.poll(async () => Math.abs(await offset() - anchor.top)).toBeLessThanOrEqual(2);
  // Invoke the real older-history control without scrolling it into view.
  await page.getByRole("button", { name: /Load earlier/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByText("Historical message 0", { exact: true })).toBeAttached();
  await expect.poll(async () => Math.abs(await offset() - anchor.top)).toBeLessThanOrEqual(2);

  await page.getByRole("link", { name: "Tasks", exact: true }).first().click();
  await page.goBack();
  await ready(page);
  await expect.poll(async () => Math.abs(await offset() - anchor.top)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Scroll to latest" }).click();
  await page.locator('[contenteditable="true"]').last().fill("Change the composer during the glide\n".repeat(5));
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
});

test("explicit comment links resolve older pages before revealing at the target", async ({ page }) => {
  await page.goto(`/${prefix}/issues/${issue.identifier}#comment-${oldestCommentId}`);
  await ready(page);
  const target = page.locator(`[id="comment-${oldestCommentId}"]`);
  await expect(target).toBeVisible();
  await expect.poll(async () => {
    const row = await target.boundingBox();
    const viewport = await page.getByTestId("task-chat-scroller").boundingBox();
    return Math.abs(row!.y - viewport!.y);
  }).toBeLessThanOrEqual(2);
});

test("failed initial comments expose retry, then recover without an indefinite skeleton", async ({ page }) => {
  await page.route("**/api/issues/*/comments?*", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Temporarily unavailable"}' }));
  await page.goto(`/${prefix}/issues/${issue.identifier}`);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.unroute("**/api/issues/*/comments?*");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await ready(page);
  await expect(page.getByText("Historical message 159", { exact: true })).toBeAttached();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeHidden();
});

test("mobile reduced-motion cold open and rapid task switching", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/${prefix}/issues/${issue.identifier}`);
  await ready(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.scrollY - window.innerHeight)).toBeLessThan(2);
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(100);
  const saved = await page.evaluate(() => window.scrollY);
  await page.reload();
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1200);
  // A fresh navigation must show the new task, never retain the previous feed.
  await page.goto(`/${prefix}/issues/${other.identifier}`);
  await ready(page);
  await expect(page.getByText("Historical message 159", { exact: true })).not.toBeAttached();
  expect(saved).toBe(1200);
});

for (const mobile of [false, true]) {
  test(`same-task comment links and Back restore the mounted ${mobile ? "mobile" : "desktop"} conversation`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${prefix}/issues/${issue.identifier}`);
    await ready(page);
    await page.getByText("Historical message 10", { exact: true }).waitFor({ state: "attached" });
    await expect(page.locator(`[id="comment-${oldestCommentId}"]`)).toHaveCount(0);
    const originalThread = await page.getByTestId("task-chat-thread").elementHandle();
    const before = await page.evaluate((mobile) => {
      const root = document.querySelector(mobile ? '[data-testid="task-chat-thread"]' : '[data-testid="task-chat-scroller"]')!;
      const top = mobile ? 0 : root.getBoundingClientRect().top;
      const row = [...root.querySelectorAll<HTMLElement>("[data-thread-anchor]")].find((el) => el.getBoundingClientRect().bottom > top)!;
      return { id: row.dataset.threadAnchor!, offset: row.getBoundingClientRect().top - top };
    }, mobile);
    await page.getByRole("link", { name: "Read the oldest message", exact: true }).click();
    const target = page.locator(`[id="comment-${oldestCommentId}"]`);
    await expect(target).toBeAttached();
    const targetOffset = () => target.evaluate((el, mobile) => el.getBoundingClientRect().top - (mobile ? 0 : document.querySelector('[data-testid="task-chat-scroller"]')!.getBoundingClientRect().top), mobile);
    await expect.poll(async () => Math.abs(await targetOffset())).toBeLessThanOrEqual(2);
    expect(await originalThread!.evaluate((el) => el === document.querySelector('[data-testid="task-chat-thread"]'))).toBe(true);
    await page.goBack();
    await expect.poll(async () => Math.abs(await page.evaluate(({ mobile, before }) => {
      const root = document.querySelector(mobile ? '[data-testid="task-chat-thread"]' : '[data-testid="task-chat-scroller"]')!;
      const row = [...root.querySelectorAll<HTMLElement>("[data-thread-anchor]")].find((el) => el.dataset.threadAnchor === before.id)!;
      return row.getBoundingClientRect().top - (mobile ? 0 : root.getBoundingClientRect().top) - before.offset;
    }, { mobile, before }))).toBeLessThanOrEqual(2);
  });
}

test("stalled native and log history reveal loaded content with Retry after the request deadline", async ({ page }) => {
  const runId = "20000000-0000-4000-8000-000000000001";
  const at = new Date().toISOString();
  await page.route("**/api/issues/*/runs", (route) => route.fulfill({ json: [{ runId, runtimeMode: "native", status: "succeeded", agentId: "20000000-0000-4000-8000-000000000002", adapterType: "paperclip_runner", createdAt: at, startedAt: at, finishedAt: at }] }));
  let stalled = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/heartbeat-runs/${runId}/events?*`, async (route) => {
    if (stalled) await held;
    await route.fulfill({ json: [] }).catch(() => {});
  });
  await page.route(`**/api/heartbeat-runs/${runId}/log?*`, async (route) => {
    if (stalled) await held;
    await route.fulfill({ json: { runId, content: "", nextOffset: 0 } }).catch(() => {});
  });
  try {
    await page.goto(`/${prefix}/issues/${issue.identifier}`);
    await expect(page.getByTestId("task-chat-history-loading")).toBeVisible();
    await expect(page.getByText("Some task history could not be loaded.")).toBeVisible({ timeout: 25_000 });
    await ready(page);
    await expect(page.getByText("Historical message 159", { exact: true })).toBeVisible();
    stalled = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Some task history could not be loaded.")).not.toBeVisible();
  } finally {
    release();
  }
});
