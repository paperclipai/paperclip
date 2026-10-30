import { expect, test } from "@playwright/test";
import { collectionFixture, coordinatorPreference, type CollectionFixture } from "./fixture";

let fixture: CollectionFixture;
test.beforeAll(async ({ request }) => { fixture = await collectionFixture(request); });
for (const mobile of [false, true]) test(`Tasks use a bounded render and a shared count on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await coordinatorPreference(page);
  const reads: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) reads.push(request.url()); });
  await page.goto(`/${fixture.company.issuePrefix}/issues`);
  const rows = page.locator('[data-slot="task-row"][data-issue-id]');
  await expect(rows).toHaveCount(100);
  await expect(page.getByText("Rendering 100 of 200 tasks")).toBeVisible();
  await expect.poll(() => reads.filter(url => url.includes("/attention/summary")).length).toBe(1);
  expect(reads.filter(url => /\/attention\?/.test(url))).toEqual([]);
  const first = await rows.first().elementHandle();
  const before = await rows.first().boundingBox();
  // Reaching the sentinel loads the next batch before a button click is needed.
  await page.getByRole("button", { name: "Show more tasks", exact: true }).scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(200);
  expect(await first!.evaluate(node => node.isConnected)).toBe(true);
  await rows.first().scrollIntoViewIfNeeded();
  const after = await rows.first().boundingBox();
  expect(Math.abs(before!.height - after!.height)).toBeLessThan(1);
  await page.screenshot({ path: test.info().outputPath("tasks.png") });
});

test("Coordinator Inbox retains index reads when Streamlined UI is disabled", async ({ page }) => {
  await coordinatorPreference(page, false);
  const reads: URL[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) reads.push(new URL(request.url())); });
  await page.goto(`/${fixture.company.issuePrefix}/inbox/mine`);
  await expect(page.locator("[data-inbox-issue-link]").first()).toBeVisible();
  const tasks = reads.filter(url => /\/companies\/[^/]+\/issues$/.test(url.pathname) && url.searchParams.get("view") !== "rows");
  expect(tasks).toHaveLength(1);
  expect(tasks[0].searchParams.get("view")).toBe("index");
  expect(reads.filter(url => url.pathname.endsWith("/dashboard"))).toEqual([]);
  expect(reads.filter(url => url.pathname.endsWith("/attention") && url.searchParams.get("all") === "true")).toEqual([]);
});

test("Needs You owns one complete feed and no redundant summary read", async ({ page }) => {
  await coordinatorPreference(page);
  const reads: URL[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) reads.push(new URL(request.url())); });
  await page.goto(`/${fixture.company.issuePrefix}/decisions`);
  await expect(page.getByRole("main").getByRole("heading", { name: "Needs You", exact: true })).toBeVisible();
  await expect.poll(() => reads.filter(url => url.pathname.endsWith("/attention") && url.searchParams.get("all") === "true").length).toBe(1);
  expect(reads.filter(url => url.pathname.endsWith("/attention/summary"))).toEqual([]);
});

test("Needs attention reads task membership without downloading decision cards", async ({ page }) => {
  await coordinatorPreference(page);
  const reads: URL[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) reads.push(new URL(request.url())); });
  await page.goto(`/${fixture.company.issuePrefix}/issues?view=needs_attention`);
  await expect(page.getByText("No tasks need a decision.", { exact: true })).toBeVisible();
  expect(reads.filter(url => url.pathname.endsWith("/attention/tasks"))).toHaveLength(1);
  expect(reads.filter(url => url.pathname.endsWith("/attention/summary"))).toEqual([]);
  expect(reads.filter(url => url.pathname.endsWith("/attention") && url.searchParams.get("all") === "true")).toEqual([]);
});

test("older pages and Back keep revealed task rows and the reading position", async ({ page }) => {
  await coordinatorPreference(page);
  await page.goto(`/${fixture.company.issuePrefix}/issues`);
  const rows = page.locator('[data-slot="task-row"][data-issue-id]');
  await expect(rows).toHaveCount(100);
  const loadPage = page.getByRole("button", { name: "Load more tasks", exact: true });
  await loadPage.scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(200);
  const retained = await rows.last().elementHandle();
  await loadPage.click();
  await expect(rows).toHaveCount(220);
  expect(await retained!.evaluate(node => node.isConnected)).toBe(true);
  await rows.last().scrollIntoViewIfNeeded();
  const before = await rows.last().boundingBox();
  await rows.last().locator("[data-inbox-issue-link]").click();
  await expect(page.getByTestId("issue-detail-header")).toBeVisible();
  await page.goBack();
  await expect(rows).toHaveCount(220);
  const after = await rows.last().boundingBox();
  expect(Math.abs(before!.y - after!.y)).toBeLessThan(2);
});
