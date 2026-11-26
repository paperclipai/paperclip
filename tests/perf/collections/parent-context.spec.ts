import { expect, test } from "@playwright/test";

let companyId: string | undefined;
test.afterEach(async ({ request }) => {
  if (!companyId) return;
  const response = await request.delete(`/api/companies/${companyId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  companyId = undefined;
});

test("Mine reveals assembled parent metadata before loading visible diagnostics", async ({ page, request }) => {
  const created = await request.post("/api/companies", { data: { name: "Parent context browser check" } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const company = await created.json() as { id: string; issuePrefix: string };
  companyId = company.id;
  const preference = await request.put(`/api/companies/${company.id}/workspace-preferences/me`, {
    data: { coordinatorWorkspaceEnabled: true },
  });
  expect(preference.ok(), await preference.text()).toBeTruthy();
  const create = async (title: string, status: string, parentId?: string) => {
    const response = await request.post(`/api/companies/${company.id}/issues`, { data: { title, status, parentId } });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json() as Promise<{ id: string; identifier: string; title: string }>;
  };
  const loaded = await create("Indexed parent context", "blocked");
  const missing = await create("Archived parent context", "done");
  const first = await create("Child of indexed parent", "todo", loaded.id);
  const second = await create("Child of archived parent", "todo", missing.id);
  const archived = await request.post(`/api/issues/${missing.id}/inbox-archive`, { data: {} });
  expect(archived.ok(), await archived.text()).toBeTruthy();

  const reads: Array<{ projection: string | null; ids: string[] }> = [];
  const sourceRead = (url: URL) => url.pathname === `/api/companies/${company.id}/inbox/mine`;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === `/api/companies/${company.id}/issues` && url.searchParams.has("ids")) {
      reads.push({ projection: url.searchParams.get("view"), ids: url.searchParams.get("ids")!.split(",") });
    }
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let releaseDetails!: () => void;
  const detailsHeld = new Promise<void>(resolve => { releaseDetails = resolve; });
  const detailRead = (url: URL) => url.pathname === `/api/companies/${company.id}/issues`
    && url.searchParams.get("view") === "rows"
    && url.searchParams.get("ids")?.split(",").includes(second.id) === true;
  await page.route(detailRead, async route => { await detailsHeld; await route.continue(); });
  await page.route(sourceRead, async route => { await held; await route.continue(); });
  const sourceRequest = page.waitForRequest(request => sourceRead(new URL(request.url())));
  try {
    await page.goto(`/${company.issuePrefix}/inbox/mine`);
    await sourceRequest;
    expect(await page.locator("[data-inbox-item]").count()).toBe(0);
    expect(reads).toEqual([]);
  } finally { release(); }

  const child = page.locator(`[data-inbox-issue-link][href$="/${second.identifier}"]`);
  await expect(child).toBeVisible();
  const node = await child.elementHandle();
  const row = child.locator("..");
  // Visible task diagnostics remain deferred, and their completion must retain
  // the title's node, position and row height.
  await expect.poll(() => reads.some(read => read.projection === "rows" && read.ids.includes(second.id))).toBe(true);
  const before = await row.boundingBox();
  const detailsResponse = page.waitForResponse(response => detailRead(new URL(response.url())));
  releaseDetails();
  await (await detailsResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator(`[data-inbox-issue-link][href$="/${first.identifier}"]`)).toBeVisible();
  expect(reads.some(read => read.ids.includes(missing.id))).toBe(false);
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  const after = await row.boundingBox();
  expect(Math.abs(before!.height - after!.height)).toBeLessThan(1);
  expect(Math.abs(before!.y - after!.y)).toBeLessThan(1);
});
