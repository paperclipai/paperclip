import { expect, test } from "@playwright/test";
import { collectionFixture, coordinatorPreference, type CollectionFixture } from "./fixture";

let fixture: CollectionFixture;
let otherCompanyId: string;
test.beforeAll(async ({ request }) => {
  fixture = await collectionFixture(request);
  expect(fixture.otherCompanyId).toBeTruthy();
  otherCompanyId = fixture.otherCompanyId!;
});

test("repeated fixture setup retains both companies without growing the instance", async ({ request }) => {
  const before = await (await request.get("/api/companies")).json();
  const again = await collectionFixture(request);
  const after = await (await request.get("/api/companies")).json();
  expect(again.company.id).toBe(fixture.company.id);
  expect(again.otherCompanyId).toBe(otherCompanyId);
  expect(after.map((company: { id: string }) => company.id).sort()).toEqual(before.map((company: { id: string }) => company.id).sort());
});
for (const route of ["issues", "inbox/mine"]) test(`${route} leaves task-detail code out of collection startup`, async ({ page }) => {
  await coordinatorPreference(page);
  await page.addInitScript(id => localStorage.setItem("paperclip.selectedCompanyId", id), otherCompanyId);
  const detailReads: string[] = [];
  const companyReads: string[] = [];
  page.on("request", request => {
    if (/\/assets\/issue-detail-[^/]+\.js$/.test(request.url())) detailReads.push(request.url());
    const companyId = new URL(request.url()).pathname.match(/^\/api\/companies\/([^/]+)\//)?.[1];
    if (companyId) companyReads.push(companyId);
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const isIndex = (url: URL) => url.pathname === `/api/companies/${fixture.company.id}/issues` && url.searchParams.get("view") === "index";
  await page.route(isIndex, async request => { await held; await request.continue(); });
  const indexRequest = page.waitForRequest(request => isIndex(new URL(request.url())));
  const warmed = page.waitForResponse(response => /\/assets\/issue-detail-[^/]+\.js$/.test(response.url()));
  try {
    await page.goto(`/${fixture.company.issuePrefix}/${route}`);
    await indexRequest;
    expect(detailReads).toEqual([]);
  } finally { release(); }
  const first = page.getByRole("main").locator("[data-inbox-issue-link]").first();
  await expect(first).toBeVisible();
  const node = await first.elementHandle();
  const before = await first.boundingBox();
  await (await warmed).finished();
  const after = await first.boundingBox();
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  expect(Math.abs(before!.y - after!.y)).toBeLessThan(1);
  expect(Math.abs(before!.height - after!.height)).toBeLessThan(1);
  expect(new Set(companyReads)).toEqual(new Set([fixture.company.id]));
  await first.focus();
  await first.press("Enter");
  await expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible();
  await expect(page.getByTestId("issue-detail-header")).toBeVisible();
  await expect(page.getByTestId("task-chat-composer-stack").locator('[contenteditable="true"]')).toBeEditable();
});

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

test("a failed speculative preload keeps the collection usable and permits task navigation", async ({ page }) => {
  await coordinatorPreference(page);
  let navigations = 0;
  page.on("request", request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  const pattern = /\/assets\/issue-detail-[^/]+\.js$/;
  await page.route(pattern, route => route.abort("failed"));
  const failure = page.waitForEvent("requestfailed", request => pattern.test(request.url()));
  await page.goto(`/${fixture.company.issuePrefix}/issues`);
  const first = page.getByRole("main").locator("[data-inbox-issue-link]").first();
  await expect(first).toBeVisible();
  await first.focus();
  await failure;
  await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toBeEditable();
  expect(navigations).toBe(1);
  await page.unroute(pattern);
  await first.press("Enter");
  await expect(page.getByTestId("task-chat-composer-stack").locator('[contenteditable="true"]')).toBeEditable();
  expect(navigations).toBe(1);
});

test("direct task opens preload their code while identity is still loading", async ({ page }) => {
  await coordinatorPreference(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/auth/get-session", async route => { await held; await route.continue(); });
  try {
    const detailRequest = page.waitForRequest(request => /\/assets\/issue-detail-[^/]+\.js$/.test(request.url()));
    await page.goto(`/${fixture.company.issuePrefix}/issues/${fixture.taskIds[0]}`);
    await detailRequest;
  } finally { release(); }
  await expect(page.getByTestId("task-chat-composer-stack").locator('[contenteditable="true"]')).toBeEditable();
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
