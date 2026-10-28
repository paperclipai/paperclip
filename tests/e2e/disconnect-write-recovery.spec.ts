import { test, expect, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body);
}

test("a task title survives an outage and saves after server recovery", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", { data: { name: `Write recovery ${Date.now()}` } }));
  try {
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Original task title", status: "backlog" },
    }));
    const other = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Another task stays unchanged", status: "backlog" },
    }));
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    const header = page.getByTestId("issue-detail-header");
    await expect(header.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();

    let unavailable = true;
    let failedWrites = 0;
    await page.route("**/api/**", async route => {
      if (!unavailable) return route.continue();
      if (route.request().method() === "PATCH" && [`/api/issues/${issue.id}`, `/api/issues/${issue.identifier}`].includes(new URL(route.request().url()).pathname)) {
        failedWrites += 1;
      }
      if (!failedWrites) return route.continue();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "tenant_app_unavailable" }) });
    });
    await header.getByRole("heading", { name: issue.title, exact: true }).click();
    const title = header.locator("textarea");
    await title.fill("A title retained through the outage");
    await title.press("Enter");
    await expect.poll(() => failedWrites).toBeGreaterThan(0);
    await expect(page.locator('[data-connection-status="reconnecting"]')).toBeVisible();
    expect((await json(await request.get(`/api/issues/${issue.id}`))).title).toBe(issue.title);
    await expect(header).toBeVisible();

    unavailable = false;
    await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}`))).title,
      { timeout: 30_000 }).toBe("A title retained through the outage");
    expect((await json(await request.get(`/api/issues/${other.id}`))).title).toBe(other.title);
    await page.reload();
    await expect(header.getByRole("heading", { name: "A title retained through the outage", exact: true })).toBeVisible();
    expect((await json(await request.get(`/api/issues/${issue.id}`))).status).toBe("backlog");
  } finally {
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
  }
});

test("two cached tasks keep separate title saves while the browser is offline", async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await json(await request.post("/api/companies", { data: { name: `Queued writes ${Date.now()}` } }));
  try {
    const first = await json(await request.post(`/api/companies/${company.id}/issues`, { data: { title: "First queued task", status: "todo" } }));
    const second = await json(await request.post(`/api/companies/${company.id}/issues`, { data: { title: "Second queued task", status: "todo" } }));
    await page.goto(`/${company.issuePrefix}/issues/${second.id}`);
    await expect(page.getByRole("heading", { name: second.title, exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Tasks", exact: true }).first().click();
    await page.getByRole("link").filter({ hasText: first.title }).first().click();
    const header = page.getByTestId("issue-detail-header");
    await expect(header.getByRole("heading", { name: first.title, exact: true })).toBeVisible();
    const dismissAnnouncement = page.getByRole("button", { name: "Dismiss announcement" });
    if (await dismissAnnouncement.isVisible()) await dismissAnnouncement.click();
    const secondLink = page.getByRole("link").filter({ hasText: second.title }).first();
    await expect(secondLink).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.locator('[data-connection-status="offline"]')).toBeVisible();
    await header.getByRole("heading", { name: first.title, exact: true }).click();
    await header.locator("textarea").fill("First title retained offline");
    await header.locator("textarea").press("Enter");
    await secondLink.focus();
    await secondLink.press("Enter", { timeout: 5_000 });
    await expect(page).toHaveURL(new RegExp(`${second.id}$`));
    await expect(header.getByRole("heading", { name: second.title, exact: true })).toBeVisible();
    await header.getByRole("heading", { name: second.title, exact: true }).click();
    await expect(header.locator("textarea")).toHaveValue(second.title);
    await header.locator("textarea").fill("Second title retained offline");
    await header.locator("textarea").press("Enter");
    expect((await json(await request.get(`/api/issues/${first.id}`))).title).toBe(first.title);
    expect((await json(await request.get(`/api/issues/${second.id}`))).title).toBe(second.title);
    await page.context().setOffline(false);
    await expect.poll(async () => (await json(await request.get(`/api/issues/${first.id}`))).title, { timeout: 30_000 }).toBe("First title retained offline");
    await expect.poll(async () => (await json(await request.get(`/api/issues/${second.id}`))).title, { timeout: 30_000 }).toBe("Second title retained offline");
    await page.reload();
    await expect(header.getByRole("heading", { name: "Second title retained offline", exact: true })).toBeVisible();
  } finally {
    await page.context().setOffline(false).catch(() => {});
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
  }
});

test("a queued startup save survives the first session lookup during an API outage", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", { data: { name: `Startup recovery ${Date.now()}` } }));
  const session = await json(await request.get("/api/auth/get-session"));
  let releaseSession!: () => void;
  const sessionReady = new Promise<void>(resolve => { releaseSession = resolve; });
  const savedTitle = "Saved through first session lookup";
  let apiUnavailable = false;
  try {
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Startup original title", status: "backlog" },
    }));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (apiUnavailable && (path === "/api/health" || (route.request().method() === "PATCH" && path.startsWith("/api/issues/")))) {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "tenant_app_unavailable" }) });
      }
      await route.continue();
    });
    await page.route("**/api/auth/get-session", async route => {
      await sessionReady;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) });
    });
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    const header = page.getByTestId("issue-detail-header");
    await expect(header.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
    apiUnavailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.locator('[data-connection-status="offline"]')).toBeVisible();
    await header.getByRole("heading", { name: issue.title, exact: true }).click();
    await header.locator("textarea").fill(savedTitle);
    await header.locator("textarea").press("Enter");
    expect((await json(await request.get(`/api/issues/${issue.id}`))).title).toBe(issue.title);
    releaseSession();
    await expect.poll(() => page.evaluate(({ owner, title }) => Object.keys(localStorage).some(key =>
      key.startsWith(`paperclip:inline-draft:v2:${owner}:`) && JSON.parse(localStorage.getItem(key) ?? "null")?.draft === title),
    { owner: session.user.id, title: savedTitle })).toBe(true);
    apiUnavailable = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}`))).title,
      { timeout: 15_000 }).toBe(savedTitle);
    await page.reload();
    await expect(header.getByRole("heading", { name: savedTitle, exact: true })).toBeVisible();
  } finally {
    releaseSession();
    apiUnavailable = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online"))).catch(() => {});
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
  }
});

test("replaying an accepted comment does not reopen completed work", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", { data: { name: `Comment recovery ${Date.now()}` } }));
  try {
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Completed work stays completed", status: "backlog", assigneeAgentId: null, assigneeUserId: null },
    }));
    const body = "A comment whose response was lost";
    const clientRequestId = crypto.randomUUID();
    const first = await json(await request.post(`/api/issues/${issue.id}/comments`, { data: { body, clientRequestId } }));
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
      data: { name: "Completed comment worker", role: "engineer", adapterType: "process", runner: "legacy",
        adapterConfig: { command: "/usr/bin/true" }, runtimeConfig: { heartbeat: { enabled: false } } },
    }));
    await json(await request.patch(`/api/issues/${issue.id}`, { data: { status: "done", assigneeAgentId: agent.id } }));
    const receipt = await json(await request.post(`/api/issues/${issue.id}/comments`, { data: { body, clientRequestId } }));
    expect(receipt.id).toBe(first.id);
    expect((await json(await request.get(`/api/issues/${issue.id}`))).status).toBe("done");
    const conflict = await request.post(`/api/issues/${issue.id}/comments`, { data: { body: "Different request", clientRequestId } });
    expect(conflict.status()).toBe(409);
    expect((await json(await request.get(`/api/issues/${issue.id}`))).status).toBe("done");
    const comments = await json(await request.get(`/api/issues/${issue.id}/comments`));
    expect(comments.filter((comment: { clientRequestId?: string }) => comment.clientRequestId === clientRequestId)).toHaveLength(1);
    const activity = await json(await request.get(`/api/issues/${issue.id}/activity`));
    expect(activity.filter((entry: { action: string; details?: { commentId?: string } }) =>
      entry.action === "issue.comment_added" && entry.details?.commentId === first.id)).toHaveLength(1);
    await page.goto(`/${company.issuePrefix}/issues/${issue.id}`);
    await expect(page.getByRole("heading", { name: issue.title, exact: true })).toBeVisible();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
  } finally {
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
  }
});

test("startup work retries a failed session lookup while other APIs stay healthy", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", { data: { name: `Session recovery ${Date.now()}` } }));
  const session = await json(await request.get("/api/auth/get-session"));
  let healthy = false, saving = false, failedAfterSave = 0;
  try {
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Before session recovery", status: "backlog" },
    }));
    await page.route("**/api/auth/get-session", async route => {
      if (healthy) return route.fulfill({ status: 200, json: session });
      if (saving) failedAfterSave += 1;
      await route.fulfill({ status: 500, json: { error: "session_lookup_failed" } });
    });
    await page.goto(`/${company.issuePrefix}/issues/${issue.id}`);
    const header = page.getByTestId("issue-detail-header");
    await header.getByRole("heading", { name: issue.title, exact: true }).click();
    await header.locator("textarea").fill("Saved after session recovery");
    saving = true;
    await header.locator("textarea").press("Enter");
    await expect.poll(() => failedAfterSave).toBeGreaterThan(0);
    healthy = true;
    await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}`))).title,
      { timeout: 15_000 }).toBe("Saved after session recovery");
    await page.reload();
    await expect(header.getByRole("heading", { name: "Saved after session recovery", exact: true })).toBeVisible();
  } finally {
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
  }
});
