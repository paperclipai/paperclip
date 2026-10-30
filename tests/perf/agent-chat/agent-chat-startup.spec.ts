import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { longChatFixture, type ChatFixture } from "./agent-chat-fixture";

let fixture: ChatFixture;
let chatPath: string;
const scroller = (page: Page) => page.getByTestId("task-chat-scroller");
const editor = (page: Page) => page.getByTestId("task-chat-composer-stack").locator('[contenteditable="true"]').last();
async function ready(page: Page) {
  await expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible({ timeout: 20_000 });
  await expect(editor(page)).toBeVisible();
}
async function anchor(page: Page) {
  return scroller(page).evaluate(root => {
    const rect = root.getBoundingClientRect();
    const row = [...root.querySelectorAll<HTMLElement>("[data-thread-anchor]")].find(row => row.getBoundingClientRect().height && row.getBoundingClientRect().bottom > rect.top && row.getBoundingClientRect().top < rect.bottom)!;
    return { id: row.dataset.threadAnchor!, top: row.getBoundingClientRect().top - rect.top };
  });
}
async function offset(page: Page, id: string) {
  return scroller(page).evaluate((root, id) => {
    const row = [...root.querySelectorAll<HTMLElement>("[data-thread-anchor]")].find(row => row.dataset.threadAnchor === id)!;
    return row.getBoundingClientRect().top - root.getBoundingClientRect().top;
  }, id);
}
async function scrollUp(page: Page, distance = 100_000) {
  await scroller(page).hover();
  const wheel = page.evaluate(() => new Promise<void>(resolve => {
    window.addEventListener("wheel", () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), { once: true, capture: true });
  }));
  await page.mouse.wheel(0, -distance);
  await wheel;
  await scroller(page).evaluate(root => new Promise<void>(resolve => {
    let previous = root.scrollTop, stable = 0;
    const sample = () => {
      const next = root.scrollTop;
      stable = next === previous ? stable + 1 : 0;
      previous = next;
      if (stable >= 3) resolve(); else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}
test.beforeAll(async ({ request }) => {
  const experimental = await request.patch("/api/instance/settings/experimental", { data: { enableAgentChat: true, enableStreamlinedUi: true } });
  expect(experimental.ok()).toBeTruthy();
  fixture = await longChatFixture(request);
  const preference = await request.put(`/api/companies/${fixture.company.id}/workspace-preferences/me`, { data: { coordinatorWorkspaceEnabled: true } });
  expect(preference.ok()).toBeTruthy();
  const announcementResponse = await request.get("/api/announcements/current");
  const announcement = await announcementResponse.json();
  if (announcement) {
    const dismissed = await request.post(`/api/announcements/${announcement.id}/dismiss`, { data: { companyId: fixture.company.id } });
    expect(dismissed.ok()).toBeTruthy();
  }
  chatPath = `/${fixture.company.issuePrefix}/chats/${fixture.agent.id}`;
});

test("cold long chat reveals one recent window without full-history reads or redraws", async ({ page, request }, info) => {
  const snapshot = await request.get(`/api/issues/${fixture.issue.id}/recent-comments`);
  const latestId = (await snapshot.json()).latestCommentId;
  const reads: string[] = [], failures: string[] = [];
  page.on("request", request => { if (request.url().includes(`/api/issues/${fixture.issue.id}/`)) reads.push(request.url()); });
  page.on("pageerror", error => failures.push(error.message));
  await page.addInitScript(() => {
    const frames: { height: number; latest: number; rows: number }[] = [];
    Object.assign(window, { chatFrames: frames });
    const sample = () => {
      const root = document.querySelector('[data-testid="task-chat-thread"] > [aria-busy="false"] [data-testid="task-chat-scroller"]');
      if (root) {
        const rows = root.querySelectorAll('[id^="comment-"]');
        frames.push({ height: root.scrollHeight, latest: rows[rows.length - 1]?.getBoundingClientRect().top ?? 0, rows: rows.length });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto(chatPath);
  await ready(page);
  await expect(page.locator('[id^="comment-"]')).toHaveCount(20);
  await expect(page.locator(`[id="comment-${latestId}"]`)).toBeVisible();
  const reply = await page.locator(`[id="comment-${latestId}"]`).boundingBox();
  const composer = await page.getByTestId("task-chat-composer-dock").boundingBox();
  expect(reply!.y + reply!.height).toBeLessThanOrEqual(composer!.y + 2);
  await expect(page.getByRole("button", { name: /^(More messages|Load earlier (comments|decisions|tasks))$/ })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(reads.filter(url => /\/comments\?/.test(url))).toEqual([]);
  expect(reads.filter(url => /\/(activity|runs)$/.test(url))).toEqual([]);
  expect(failures).toEqual([]);
  const frames = await page.evaluate(() => (window as unknown as { chatFrames: { height: number; latest: number; rows: number }[] }).chatFrames);
  expect(new Set(frames.map(frame => frame.rows)).size).toBe(1);
  expect(Math.max(...frames.map(frame => frame.height)) - Math.min(...frames.map(frame => frame.height))).toBeLessThanOrEqual(2);
  expect(Math.max(...frames.map(frame => frame.latest)) - Math.min(...frames.map(frame => frame.latest))).toBeLessThanOrEqual(2);
  await fs.writeFile(info.outputPath("first-reveal.json"), JSON.stringify({ reads, frames }));
  await page.screenshot({ path: info.outputPath("recent-chat.png") });
});

test("upward scrolling loads one delayed page and preserves the row, viewport and draft", async ({ page }, info) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let pageReads = 0;
  await page.route(`**/api/issues/${fixture.issue.id}/comments?**`, async route => {
    if (new URL(route.request().url()).searchParams.get("order") === "desc") { pageReads++; await held; }
    await route.continue();
  });
  await page.goto(chatPath); await ready(page);
  await editor(page).fill("Keep this draft while I read earlier messages.");
  await editor(page).evaluate(element => element.setAttribute("data-retained-editor", "yes"));
  try {
    await scrollUp(page);
    await expect(page.getByTestId("chat-history-status")).toHaveText("Loading earlier messages…");
    expect(pageReads).toBe(1);
    const saved = await anchor(page);
    await scrollUp(page, 100);
    expect(pageReads).toBe(1);
    release();
    await expect(page.locator('[id^="comment-"]')).toHaveCount(70);
    await expect(page.getByTestId("chat-history-status")).toHaveText("Scroll up for earlier messages");
    await expect.poll(() => offset(page, saved.id)).toBeCloseTo(saved.top, 0);
    await page.waitForTimeout(300);
    expect(Math.abs(await offset(page, saved.id) - saved.top)).toBeLessThanOrEqual(2);
    await expect(editor(page)).toHaveAttribute("data-retained-editor", "yes");
    await expect(editor(page)).toContainText("Keep this draft");
    await page.screenshot({ path: info.outputPath("older-page.png") });
  } finally { release(); }
});

test("failed history stops automatic retries and leaves a working inline retry", async ({ page }) => {
  let attempts = 0;
  await page.route(`**/api/issues/${fixture.issue.id}/comments?**`, async route => {
    if (++attempts === 1) await route.fulfill({ status: 500, json: { error: "Synthetic older-page failure" } });
    else await route.continue();
  });
  await page.goto(chatPath); await ready(page);
  await editor(page).fill("A draft survives a history outage.");
  await scrollUp(page);
  await expect(page.getByTestId("chat-history-status")).toContainText("Earlier messages couldn’t load.");
  const saved = await anchor(page);
  await scrollUp(page, 100);
  await page.waitForTimeout(300);
  expect(attempts).toBe(1);
  await expect(page.locator('[id^="comment-"]')).toHaveCount(20);
  await page.getByTestId("chat-history-status").getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[id^="comment-"]')).toHaveCount(70);
  expect(Math.abs(await offset(page, saved.id) - saved.top)).toBeLessThanOrEqual(2);
  await expect(editor(page)).toContainText("A draft survives");
});

test("Back restores paged history and the reading position", async ({ page }) => {
  await page.goto(chatPath); await ready(page);
  await scrollUp(page);
  await expect(page.locator('[id^="comment-"]')).toHaveCount(70);
  await scrollUp(page, 400);
  const saved = await anchor(page);
  const navigation = page.viewportSize()!.width < 768
    ? page.getByRole("navigation", { name: "Mobile navigation" })
    : page.getByRole("navigation", { name: "Workspace navigation" });
  await navigation.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await page.goBack(); await ready(page);
  await expect(page.locator('[id^="comment-"]')).toHaveCount(70);
  expect(Math.abs(await offset(page, saved.id) - saved.top)).toBeLessThanOrEqual(2);
});

test("an older comment link keeps compact loading and a usable target", async ({ page }) => {
  const fullReads: string[] = [];
  page.on("request", request => { if (/\/(comments|activity|runs)$/.test(new URL(request.url()).pathname) && !new URL(request.url()).search) fullReads.push(request.url()); });
  await page.goto(`${chatPath}#comment-${fixture.comments[5].id}`); await ready(page);
  await expect(page.locator(`[id="comment-${fixture.comments[5].id}"]`)).toBeVisible();
  await expect(page.locator('[id^="comment-"]')).toHaveCount(21);
  expect(fullReads).toEqual([]);
});

test("live updates keep an unpinned reader and draft, and the saved message appears once", async ({ page, request }) => {
  await page.goto(chatPath); await ready(page);
  await editor(page).fill("An unsent draft stays mounted during live refresh.");
  await editor(page).evaluate(element => element.setAttribute("data-retained-editor", "yes"));
  await scrollUp(page, 400);
  const saved = await anchor(page);
  const keyResponse = await request.post(`/api/agents/${fixture.agent.id}/keys`, { data: { name: "Disposable chat history regression" } });
  expect(keyResponse.status()).toBe(201);
  const key = await keyResponse.json();
  const recentResponse = await request.get(`/api/issues/${fixture.issue.id}/recent-comments`);
  const recentRuns = new Set((await recentResponse.json()).comments.map((row: { createdByRunId: string | null }) => row.createdByRunId));
  let sourceRunId: string | undefined;
  for (const source of fixture.comments.filter((_, index) => index % 2 === 1).slice(0, 25)) {
    const sourceResponse = await request.get(`/api/issues/${fixture.issue.id}/comments/${source.id}`);
    const runId = (await sourceResponse.json()).createdByRunId;
    if (runId && !recentRuns.has(runId)) { sourceRunId = runId; break; }
  }
  expect(sourceRunId).toBeTruthy();
  const body = `Live saved message ${randomUUID()}`;
  const response = await request.post(`/api/issues/${fixture.issue.id}/comments`, {
    headers: { authorization: `Bearer ${key.token}`, "x-paperclip-run-id": sourceRunId! }, data: { body },
  });
  await request.delete(`/api/agents/${fixture.agent.id}/keys/${key.id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const message = await response.json();
  await expect(page.locator(`[id="comment-${message.id}"]`)).toBeAttached({ timeout: 15_000 });
  expect(Math.abs(await offset(page, saved.id) - saved.top)).toBeLessThanOrEqual(2);
  await expect(editor(page)).toHaveAttribute("data-retained-editor", "yes");
  await expect(editor(page)).toContainText("An unsent draft stays mounted");
  const persisted = await request.get(`/api/issues/${fixture.issue.id}/comments?order=desc&limit=50`);
  expect((await persisted.json()).filter((row: { body: string }) => row.body === body)).toHaveLength(1);
  await page.getByRole("button", { name: "Scroll to latest", exact: true }).click();
  await expect(page.locator(`[id="comment-${message.id}"]`)).toBeVisible();
});

test("sending before the first upward scroll leaves earlier history reachable", async ({ page, request }, info) => {
  const own = await longChatFixture(request, `send-first-${info.project.name}`);
  const snapshot = await request.get(`/api/issues/${own.issue.id}/recent-comments`);
  const oldest = (await snapshot.json()).oldestCommentId;
  await page.goto(`/${own.company.issuePrefix}/chats/${own.agent.id}`); await ready(page);
  const body = `Saved before paging ${randomUUID()}`;
  await editor(page).fill(body);
  const posted = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/issues/${own.issue.id}/comments`);
  await page.getByTestId("task-chat-composer-send").click();
  const receipt = await posted;
  expect(receipt.ok(), await receipt.text()).toBeTruthy();
  await expect(page.getByTestId("chat-history-status")).toHaveText("Scroll up for earlier messages");
  const older = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${own.issue.id}/comments`
    && new URL(response.url()).searchParams.get("order") === "desc");
  await scrollUp(page);
  const pageResponse = await older;
  expect(new URL(pageResponse.url()).searchParams.get("after")).toBe(oldest);
  await expect(page.locator(`[id="comment-${own.comments.at(-21)!.id}"]`)).toBeAttached();
});

test("a receipts outage leaves message paging available with one independent retry", async ({ page }) => {
  await page.route("**/decision-receipts?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Receipt fixture unavailable"}' }));
  await page.goto(chatPath); await ready(page);
  await expect(page.getByText("Decision updates couldn’t load.")).toBeVisible();
  await scrollUp(page);
  await expect(page.locator('[id^="comment-"]')).toHaveCount(70);
  await expect(page.getByTestId("chat-history-status")).toHaveText("Scroll up for earlier messages");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1);
});

test("successive older pages hydrate each message and run id only once", async ({ page, request }) => {
  const fixture = await longChatFixture(request, "metadata");
  await request.put(`/api/companies/${fixture.company.id}/workspace-preferences/me`, { data: { coordinatorWorkspaceEnabled: true } });
  const chatPath = `/${fixture.company.issuePrefix}/chats/${fixture.agent.id}`;
  const nativeIds: string[] = [];
  page.on("response", response => {
    const match = new URL(response.url()).pathname.match(/^\/api\/heartbeat-runs\/([^/]+)\/events$/);
    if (match && response.status() === 200) nativeIds.push(match[1]);
  });
  const seen: Record<string, string[]> = { commentIds: [], runIds: [] };
  page.on("request", request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith(`/api/issues/${fixture.issue.id}/`)) return;
    for (const field of ["commentIds", "runIds"]) seen[field].push(...(url.searchParams.get(field)?.split(",") ?? []));
  });
  await page.goto(chatPath); await ready(page);
  await page.waitForLoadState("networkidle");
  const initialNative = new Set(nativeIds);
  await scrollUp(page); await expect(page.locator('[id^="comment-"]')).toHaveCount(70);
  await expect.poll(() => new Set(nativeIds.filter(id => !initialNative.has(id))).size).toBe(25);
  await page.waitForLoadState("networkidle");
  const secondPageStart = Object.fromEntries(Object.entries(seen).map(([key, ids]) => [key, ids.length]));
  const firstPageNative = new Set(nativeIds);
  const firstPageReads = nativeIds.length;
  await scrollUp(page); await expect(page.locator('[id^="comment-"]')).toHaveCount(120);
  await expect.poll(() => seen.commentIds.length - secondPageStart.commentIds).toBe(50);
  await expect.poll(() => new Set(nativeIds.filter(id => !firstPageNative.has(id))).size).toBe(25);
  await page.waitForLoadState("networkidle");
  expect(nativeIds.slice(firstPageReads).filter(id => firstPageNative.has(id))).toEqual([]);
  for (const [key, ids] of Object.entries(seen)) {
    const secondPage = ids.slice(secondPageStart[key]);
    const previous = new Set(ids.slice(0, secondPageStart[key]));
    expect(new Set(secondPage).size).toBe(secondPage.length);
    expect(secondPage.filter(id => previous.has(id))).toEqual([]);
  }
});

for (const pinned of [true, false]) test(`a delayed image preserves ${pinned ? "latest following" : "the reading anchor"}`, async ({ page, request }, info) => {
  const own = await longChatFixture(request, `image-v3-${pinned}-${info.project.name}`, { delayedImage: true });
  const preference = await request.put(`/api/companies/${own.company.id}/workspace-preferences/me`, { data: { coordinatorWorkspaceEnabled: true } });
  expect(preference.ok()).toBeTruthy();
  let release!: () => void, requested!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pendingImage = new Promise<void>(resolve => { requested = resolve; });
  await page.route("**/__chat-history-image.svg", async route => {
    requested(); await held;
    await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="gray"/></svg>' });
  });
  try {
    await page.goto(`/${own.company.issuePrefix}/chats/${own.agent.id}`); await ready(page);
    await scrollUp(page, 1200);
    const images = await page.locator('img[alt="Delayed evidence"]').evaluateAll(nodes => nodes.map(node => ({ src: (node as HTMLImageElement).src, complete: (node as HTMLImageElement).complete, rect: node.getBoundingClientRect().toJSON() })));
    await fs.writeFile(info.outputPath("image-before-release.json"), JSON.stringify({ images }));
    await pendingImage;
    await page.getByRole("button", { name: "Scroll to latest", exact: true }).click();
    await expect.poll(() => scroller(page).evaluate(root => root.scrollHeight - root.scrollTop - root.clientHeight)).toBeLessThanOrEqual(2);
    if (!pinned) await scrollUp(page, 200);
    const saved = await anchor(page);
    release();
    await expect(page.locator('img[alt="Delayed evidence"]')).toHaveJSProperty("complete", true);
    await expect(page.locator('img[alt="Delayed evidence"]')).toHaveJSProperty("naturalWidth", 640);
    await page.waitForTimeout(200);
    if (pinned) {
      const latest = await page.locator(`[id="comment-${own.comments.at(-1)!.id}"]`).boundingBox();
      const composer = await page.getByTestId("task-chat-composer-dock").boundingBox();
      expect(latest!.y + latest!.height).toBeLessThanOrEqual(composer!.y + 2);
    } else expect(Math.abs(await offset(page, saved.id) - saved.top)).toBeLessThanOrEqual(2);
  } finally { release(); }
});
