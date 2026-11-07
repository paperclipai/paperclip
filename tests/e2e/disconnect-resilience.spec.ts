import { expect, test, type APIRequestContext, type APIResponse, type Page, type WebSocketRoute } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });
test.use({ actionTimeout: 10_000 });

type SocketPair = { client: WebSocketRoute; server: WebSocketRoute };
type RealtimeControl = { until: number; sockets: Set<SocketPair> };
const realtime = new WeakMap<Page, RealtimeControl>();
const outageClose = { code: 1013, reason: "Simulated outage" };

async function closeSockets(control: RealtimeControl) {
  const sockets = [...control.sockets];
  control.sockets.clear();
  await Promise.all(sockets.flatMap(({ client, server }) => [client.close(outageClose), server.close(outageClose)]));
}

test.beforeEach(async ({ page }) => {
  const control: RealtimeControl = { until: 0, sockets: new Set() };
  realtime.set(page, control);
  // Intercept before navigation, including the first connection while its
  // server handshake is still pending. Reloads use the same outage deadline.
  await page.routeWebSocket("**/api/companies/*/events/ws", async client => {
    if (Date.now() < control.until) { await client.close(outageClose); return; }
    const server = client.connectToServer();
    const pair = { client, server };
    control.sockets.add(pair);
    // Custom close handlers must preserve Playwright's normal forwarding.
    client.onClose((code, reason) => control.sockets.delete(pair) ? server.close({ code, reason }) : undefined);
    server.onClose((code, reason) => control.sockets.delete(pair) ? client.close({ code, reason }) : undefined);
  });
});

test.afterEach(async ({ page }) => {
  const control = realtime.get(page);
  if (!control) return;
  control.until = Infinity;
  await closeSockets(control);
  realtime.delete(page);
});

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function fixture(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Disconnect recovery ${Date.now()}` } }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Keep this task visible", description: "Saved task context stays visible.", status: "backlog", assigneeAgentId: null, assigneeUserId: null },
  }));
  return { company, issue, route: `/${company.issuePrefix}/issues/${issue.identifier}` };
}

async function outage(page: Page) {
  const until = Date.now() + 20_000;
  let failures = 0;
  const control = realtime.get(page);
  if (!control) throw new Error("Realtime interception must be installed before navigation");
  control.until = until;
  await page.route("**/api/**", async route => {
    if (Date.now() >= until) return route.fallback();
    failures += 1;
    await route.fulfill({ status: 503, json: { error: "tenant_app_unavailable" } });
  });
  await closeSockets(control);
  return { until, failures: () => failures };
}

test("an outage closes the first realtime socket before it can report a late recovery", async ({ page, request }) => {
  const data = await fixture(request);
  await page.addInitScript(() => {
    const browser = window as typeof window & { outageSockets: WebSocket[]; initialOutageSockets: WebSocket[] };
    browser.outageSockets = [];
    browser.initialOutageSockets = [];
    browser.WebSocket = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(url, location.href).pathname.endsWith("/events/ws")) browser.outageSockets.push(this);
      }
    };
  });
  try {
    await page.goto(data.route);
    // Do not wait for open or history readiness: catch the first connection
    // as soon as the app creates it, including a pending handshake.
    await expect.poll(() => page.evaluate(() => {
      const browser = window as typeof window & { outageSockets: WebSocket[]; initialOutageSockets: WebSocket[] };
      browser.initialOutageSockets = browser.outageSockets.filter(socket => socket.readyState <= WebSocket.OPEN);
      return browser.initialOutageSockets.length;
    })).toBeGreaterThan(0);
    const interruption = await outage(page);
    await expect.poll(() => page.evaluate(() => (window as typeof window & { initialOutageSockets: WebSocket[] })
      .initialOutageSockets.every(socket => socket.readyState === WebSocket.CLOSED))).toBe(true);
    expect(await page.evaluate(async () => (await fetch("/api/health")).status)).toBe(503);
    await expect.poll(interruption.failures).toBeGreaterThan(0);
    await expectReconnecting(page);
    expect(Date.now()).toBeLessThan(interruption.until);
  } finally {
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});

async function expectReconnecting(page: Page) {
  await expect(page.locator('[data-connection-status="reconnecting"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByText("tenant_app_unavailable", { exact: false })).toHaveCount(0);
  await expect(page.locator('p.text-destructive, span.text-destructive, div.text-destructive, [role="alert"]')
    .filter({ hasNotText: /^Danger Zone$/ }).filter({ visible: true })).toHaveCount(0);
}

async function expectCachedTask(page: Page, issue: { id: string; title: string }) {
  await expect.poll(() => page.evaluate(task => Object.entries(localStorage).some(([key, value]) => {
    if (!key.startsWith("paperclip:query-cache:v1:")) return false;
    try {
      const record = JSON.parse(value) as { state?: { queries?: Array<{ state?: { data?: { id?: string; title?: string } } }> } };
      return record.state?.queries?.some(query => query.state?.data?.id === task.id && query.state.data.title === task.title) ?? false;
    } catch { return false; }
  }), issue)).toBe(true);
}

test("a comment typed during a 20-second outage posts once and loaded task content stays visible", async ({ page, request }) => {
  const data = await fixture(request);
  const body = "A comment retained through the disconnect";
  let successfulPosts = 0;
  page.on("response", response => {
    if (response.request().method() === "POST" && response.url().endsWith("/comments")
      && response.request().postDataJSON()?.body === body && response.ok()) successfulPosts += 1;
  });
  try {
    await page.goto(data.route);
    const header = page.getByTestId("issue-detail-header");
    await expect(page.getByTestId("task-chat-history-content")).toBeVisible({ timeout: 30_000 });
    await expect(header.getByRole("heading", { name: data.issue.title, exact: true })).toBeVisible();
    await expect(page.getByText(data.issue.description, { exact: true }).first()).toBeVisible();
    const interruption = await outage(page);
    await page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]').fill(body);
    await page.getByTestId("task-chat-composer-send").click();
    await expect.poll(interruption.failures).toBeGreaterThan(0);
    await expectReconnecting(page);
    await expect(header.getByRole("heading", { name: data.issue.title, exact: true })).toBeVisible();
    await expect(page.getByText(body, { exact: true }).first()).toBeVisible();
    expect((await json(await request.get(`/api/issues/${data.issue.id}/comments`))).filter((comment: { body: string }) => comment.body === body)).toHaveLength(0);
    await expect(page.locator('[data-connection-status="back_online"]')).toBeVisible({ timeout: 35_000 });
    expect(Date.now()).toBeGreaterThanOrEqual(interruption.until);
    await expect.poll(async () => (await json(await request.get(`/api/issues/${data.issue.id}/comments`)))
      .filter((comment: { body: string }) => comment.body === body).length).toBe(1);
    await expect.poll(() => successfulPosts).toBe(1);
    await page.reload();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    expect((await json(await request.get(`/api/issues/${data.issue.id}`))).assigneeAgentId).toBeNull();
  } finally {
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});

test("a queued comment survives an outage reload and sends once after session verification", async ({ page, request }) => {
  const data = await fixture(request);
  const body = "A pending comment retained across reload";
  let reloading = false, replayPosts = 0, sessionHeld = false;
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>(resolve => { releaseSession = resolve; });
  page.on("request", request => {
    if (reloading && request.method() === "POST" && request.url().endsWith("/comments") && request.postDataJSON()?.body === body) replayPosts += 1;
  });
  try {
    await page.goto(data.route);
    await expect(page.getByTestId("task-chat-history-content")).toBeVisible({ timeout: 30_000 });
    const interruption = await outage(page);
    await page.route("**/api/auth/get-session", async route => {
      if (Date.now() < interruption.until) return route.fallback();
      sessionHeld = true;
      await sessionGate;
      await route.continue();
    });
    await page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]').fill(body);
    await page.getByTestId("task-chat-composer-send").click();
    await expectReconnecting(page);
    await expect.poll(() => page.evaluate(text => Object.values(localStorage).some(value => value.includes(text)), body)).toBe(true);
    reloading = true;
    await page.reload();
    await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: data.issue.title, exact: true })).toBeVisible();
    await expectReconnecting(page);
    expect((await json(await request.get(`/api/issues/${data.issue.id}/comments`))).filter((comment: { body: string }) => comment.body === body)).toHaveLength(0);
    await expect(page.locator('[data-connection-status="back_online"]')).toBeVisible({ timeout: 35_000 });
    await expect.poll(() => sessionHeld).toBe(true);
    expect(await page.evaluate(async () => (await fetch("/api/health")).ok)).toBe(true);
    expect(replayPosts).toBe(0);
    releaseSession();
    await expect.poll(async () => (await json(await request.get(`/api/issues/${data.issue.id}/comments`)))
      .filter((comment: { body: string }) => comment.body === body).length).toBe(1);
    expect(replayPosts).toBe(1);
    await page.reload();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
  } finally {
    releaseSession();
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});

test("a document edit stays visible and saves after a 20-second outage", async ({ page, request }) => {
  const data = await fixture(request);
  const original = "The original document body.";
  const edited = "The document edit retained during the outage.";
  try {
    await json(await request.put(`/api/issues/${data.issue.id}/documents/handoff`, {
      data: { title: "Recovery handoff", format: "markdown", body: original, baseRevisionId: null },
    }));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => localStorage.setItem("paperclip:panel-visible", "true"));
    await page.goto(data.route);
    await expect(page.getByTestId("task-chat-history-content")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Show properties", exact: true }).click();
    const panel = page.locator("aside").filter({ has: page.getByRole("button", { name: "Open a new tab", exact: true }) });
    await panel.getByRole("option", { name: "Artifacts", exact: true }).click();
    const document = panel.locator("#document-handoff");
    await expect(document.getByText(original, { exact: true })).toBeVisible();
    await document.getByRole("button", { name: "Document actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit document", exact: true }).click();
    await outage(page);
    await document.locator('[contenteditable="true"]').fill(edited);
    await expectReconnecting(page);
    await expect(document.locator('[contenteditable="true"]')).toContainText(edited);
    expect((await json(await request.get(`/api/issues/${data.issue.id}/documents/handoff`))).body).toBe(original);
    await expect(page.locator('[data-connection-status="back_online"]')).toBeVisible({ timeout: 35_000 });
    await expect.poll(async () => (await json(await request.get(`/api/issues/${data.issue.id}/documents/handoff`))).body).toBe(edited);
    await page.reload();
    await expect(page.getByText(edited, { exact: true }).first()).toBeVisible();
  } finally {
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});

test("a reload during a 20-second outage restores settings, sidebar and a recent task", async ({ page, request }) => {
  const data = await fixture(request);
  try {
    await page.goto(data.route);
    await expect(page.getByTestId("task-chat-history-content")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: data.issue.title, exact: true })).toBeVisible();
    await expectCachedTask(page, data.issue);
    await page.getByRole("button", { name: "Open account menu", exact: true }).click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(page.locator('input[type="text"]').first()).toHaveValue(data.company.name);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("paperclip:query-cache:v1:") && key.endsWith(":root")))).toBe(true);
    await outage(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(page.locator('input[type="text"]').first()).toHaveValue(data.company.name);
    await expectReconnecting(page);
    await page.goBack();
    await expect(page.getByRole("link").filter({ hasText: data.issue.title }).first()).toBeVisible();
    await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: data.issue.title, exact: true })).toBeVisible();
    await expectReconnecting(page);
    await expect(page.getByText(data.issue.description, { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-connection-status="back_online"]')).toBeVisible({ timeout: 35_000 });
  } finally {
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});

test("a legacy Inbox reload retains its saved task rows during a 20-second outage", async ({ page, request }) => {
  const data = await fixture(request);
  try {
    const session = await json(await request.get("/api/auth/get-session"));
    await json(await request.patch(`/api/issues/${data.issue.id}`, { data: { status: "todo", assigneeUserId: session.user.id } }));
    // Serve complete server-derived settings throughout reloads without
    // retaining route.fetch responses that can be disposed during teardown.
    const [experimental, preferences] = await Promise.all([
      request.get("/api/instance/settings/experimental").then(json),
      request.get("/api/workspace-preferences/me").then(json),
    ]);
    await page.route("**/api/instance/settings/experimental", route => route.fulfill({
      json: { ...experimental, enableClassicTaskInterface: true, enableStreamlinedUi: false },
    }));
    await page.route("**/api/workspace-preferences/me", route => route.fulfill({
      json: { ...preferences, coordinatorWorkspaceEnabled: false },
    }));
    await page.goto(`/${data.company.issuePrefix}/inbox/all`);
    const row = page.locator("[data-inbox-item]").filter({ hasText: data.issue.title });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(id => Object.entries(localStorage).some(([key, value]) => {
      if (!key.startsWith("paperclip:query-cache:v1:")) return false;
      try {
        return JSON.parse(value).state?.queries?.some((query: { queryKey: unknown[]; state: { data?: Array<{ id: string }> } }) =>
          query.queryKey.includes("compact") && Array.isArray(query.state.data) && query.state.data.some(task => task.id === id)) ?? false;
      } catch { return false; }
    }), data.issue.id)).toBe(true);
    await outage(page);
    await page.reload();
    await expectReconnecting(page);
    await expect(row).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading tasks" })).toHaveCount(0);
    await expect(page.locator('[data-connection-status="back_online"]')).toBeVisible({ timeout: 35_000 });
    await expect(row).toBeVisible();
  } finally {
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});

for (const status of [403, 404]) test(`a genuine ${status} replaces cached task content with readable copy`, async ({ page, request }) => {
  const data = await fixture(request);
  try {
    await page.goto(data.route);
    await expect(page.getByTestId("task-chat-history-content")).toBeVisible({ timeout: 30_000 });
    await expectCachedTask(page, data.issue);
    await page.route("**/api/issues/*?view=core", route => route.fulfill({ status, json: { error: status === 403 ? "forbidden" : "not_found" } }));
    await page.reload();
    await expect(page.getByText(status === 403 ? "You don’t have permission to do that." : "This item doesn’t exist or was moved.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("issue-detail-header")).toHaveCount(0);
    await expect(page.locator("[data-connection-status]")).toHaveCount(0);
  } finally {
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});

test("signing out clears saved query data before a later outage reload", async ({ page, request }) => {
  const data = await fixture(request);
  let signedOut = false;
  const additionalCompanies: Array<{ id: string }> = [];
  try {
    // Exercise native Storage deletion with multiple company records; a
    // single-company run can conceal key reordering during removal.
    for (let i = 0; i < 6; i += 1) additionalCompanies.push(await json(await request.post("/api/companies", { data: { name: `Sign-out cache scope ${i}` } })));
    await page.goto(data.route);
    await expect(page.getByTestId("task-chat-history-content")).toBeVisible({ timeout: 30_000 });
    await expectCachedTask(page, data.issue);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key =>
      key.startsWith("paperclip:query-cache:v1:") && !key.endsWith(":active")).length)).toBeGreaterThanOrEqual(8);
    await page.getByRole("button", { name: "Open account menu", exact: true }).click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await outage(page);
    await page.route("**/api/auth/get-session", route => signedOut ? route.fulfill({ status: 200, json: null }) : route.fallback());
    await page.route("**/api/auth/sign-out", route => {
      signedOut = true;
      return route.fulfill({ status: 200, json: { success: true } });
    });
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect.poll(() => signedOut).toBe(true);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("paperclip:query-cache:v1:")))).toEqual([]);
    await page.goto(data.route);
    await expect(page.getByTestId("issue-detail-header")).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("paperclip:query-cache:v1:")))).toEqual([]);
  } finally {
    for (const company of additionalCompanies) await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});


test("a restored title draft cannot overwrite an edit made after its cached base", async ({ page, request }) => {
  const data = await fixture(request);
  const draft = "My restored title B";
  const newer = "A newer server title C";
  let releaseReads!: () => void;
  const gate = new Promise<void>(resolve => { releaseReads = resolve; });
  let replayWrites = 0;
  page.on("request", incoming => {
    if (incoming.method() === "PATCH" && incoming.postDataJSON()?.title === draft) replayWrites += 1;
  });
  try {
    await page.goto(data.route);
    await expect(page.getByTestId("task-chat-history-content")).toBeVisible({ timeout: 30_000 });
    await expectCachedTask(page, data.issue);
    const session = await json(await request.get("/api/auth/get-session"));
    const owner = session.user.id as string;
    const key = `paperclip:inline-draft:v2:${owner}:issue:${data.issue.id}:title`;
    await page.evaluate(({ key, draft, base }) => localStorage.setItem(key, JSON.stringify({ version: 1, draft, base })), { key, draft, base: data.issue.title });
    const paths = new Set([data.issue.id, data.issue.identifier].map(ref => `/api/issues/${ref}`.toLowerCase()));
    await page.route("**/api/issues/**", async route => {
      if (route.request().method() === "GET" && paths.has(new URL(route.request().url()).pathname.toLowerCase())) await gate;
      await route.fallback();
    });
    await json(await request.patch(`/api/issues/${data.issue.id}`, { data: { title: newer } }));
    const verifiedSession = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/get-session" && response.ok());
    await page.reload();
    await verifiedSession;
    const editor = page.getByTestId("issue-detail-header").locator("textarea");
    await expect(editor).toHaveValue(draft, { timeout: 30_000 });
    expect(replayWrites).toBe(0);
    releaseReads();
    await expect(editor).toHaveAttribute("aria-invalid", "true", { timeout: 30_000 });
    await expect(editor).toHaveValue(draft);
    expect((await json(await request.get(`/api/issues/${data.issue.id}`))).title).toBe(newer);
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toContain(draft);
    expect(replayWrites).toBe(0);
  } finally {
    releaseReads();
    await page.unroute("**/api/issues/**");
    await request.patch(`/api/companies/${data.company.id}`, { data: { status: "archived" } });
  }
});
