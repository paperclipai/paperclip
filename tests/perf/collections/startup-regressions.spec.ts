import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { CompactIssue, HeartbeatRun, InboxMineSnapshot } from "../../../packages/shared/src/index.js";

type Company = { id: string; issuePrefix: string; [key: string]: unknown };
type Task = { id: string; identifier: string; title: string };
let company: Company;
let otherCompany: Company;
let child: Task;
let failureTask: Task;
const userId = "local-board";

async function json<T>(request: APIRequestContext, method: string, url: string, data?: unknown): Promise<T> {
  const response = await request.fetch(url, { method, data });
  expect(response.ok(), `${method} ${url}: ${response.status()}`).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json();
}
const minePath = () => `/api/companies/${company.id}/inbox/mine`;
const childLink = (page: Page) => page.locator(`[data-inbox-issue-link][href$="/${child.identifier}"]`);
const twoFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test.beforeAll(async ({ request }) => {
  company = await json(request, "POST", "/api/companies", { name: "Inbox startup regressions" });
  otherCompany = await json(request, "POST", "/api/companies", { name: "Other inbox startup scope" });
  await json(request, "PUT", `/api/companies/${company.id}/workspace-preferences/me`, { coordinatorWorkspaceEnabled: true });
  const parent = await json<Task>(request, "POST", `/api/companies/${company.id}/issues`, { title: "Archived required parent", status: "done" });
  child = await json(request, "POST", `/api/companies/${company.id}/issues`, { title: "Inbox startup child", status: "todo", parentId: parent.id });
  failureTask = await json(request, "POST", `/api/companies/${company.id}/issues`, { title: "Saved failed attempt task", status: "done" });
  for (const task of [parent, failureTask]) await json(request, "POST", `/api/issues/${task.id}/inbox-archive`, {});
});
test.afterAll(async ({ request }) => {
  for (const value of [company, otherCompany]) if (value) {
    const response = await request.delete(`/api/companies/${value.id}`);
    expect(response.ok(), `Fixture cleanup: ${response.status()}`).toBeTruthy();
  }
});

// This isolates the authenticated browser bootstrap contract. Backend access is
// still the disposable local board; it does not qualify a hosted login.
for (const bootstrap of ["embedded", "absent", "wrong-user"] as const) {
  test(`authenticated startup uses ${bootstrap} session bootstrap correctly`, async ({ page }) => {
    const reads: URL[] = [];
    const isLegacyBootstrap = (url: URL) => url.pathname === "/api/companies" || url.pathname === "/api/cli-auth/me";
    let legacyResponses = 0;
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) reads.push(url);
    });
    page.on("response", response => { if (isLegacyBootstrap(new URL(response.url()))) legacyResponses += 1; });
    await page.route("**/api/health", async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), deploymentMode: "authenticated", bootstrapStatus: "ready" } });
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let releaseLegacy!: () => void;
    const legacyHeld = new Promise<void>(resolve => { releaseLegacy = resolve; });
    if (bootstrap === "embedded") await page.route(isLegacyBootstrap, async route => {
      await legacyHeld;
      await route.continue();
    });
    await page.route("**/api/auth/get-session", async route => {
      await held;
      await route.fulfill({ json: {
        user: { id: userId, name: "Local operator", email: "operator@example.test", image: null },
        session: { id: "simulated-local-session", userId }, sentryDsn: null,
        ...(bootstrap === "absent" ? {} : { boardBootstrap: {
          userId: bootstrap === "wrong-user" ? "previous-user" : userId,
          companies: bootstrap === "wrong-user" ? [otherCompany] : [company],
          boardAccess: { userId: bootstrap === "wrong-user" ? "previous-user" : userId,
            isInstanceAdmin: false, companyIds: bootstrap === "wrong-user" ? [otherCompany.id] : [company.id] },
        } }),
      } });
    });
    const sessionRequest = page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/get-session");
    try {
      try {
        await page.goto(`/${company.issuePrefix}/inbox/mine`);
        await sessionRequest;
        expect(await page.locator("[data-inbox-item]").count()).toBe(0);
        expect(reads.some(url => url.pathname === minePath())).toBe(false);
      } finally { release(); }
      await expect(childLink(page)).toBeVisible();
      const legacy = reads.filter(isLegacyBootstrap);
      // Initial WS gap reconciliation may start legacy reads in the background.
      // Bootstrap must reveal Mine without waiting for their held responses.
      if (bootstrap === "embedded") expect(legacyResponses).toBe(0);
      else {
        expect(legacy.some(url => url.pathname === "/api/companies")).toBe(true);
        expect(legacy.some(url => url.pathname === "/api/cli-auth/me")).toBe(true);
      }
      expect(reads.some(url => url.pathname === minePath())).toBe(true);
      expect(reads.some(url => url.pathname.startsWith(`/api/companies/${otherCompany.id}/`))).toBe(false);
      expect(reads.filter(url => url.pathname === "/api/auth/get-session")).toHaveLength(1);
      await test.info().attach("authenticated-startup-readiness", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        bootstrap, legacyRequestsAtRows: legacy.map(url => url.pathname), legacyResponsesAtRows: legacyResponses,
        mineStarted: true, sessionRequestsAtRows: reads.filter(url => url.pathname === "/api/auth/get-session").length,
      })) });
    } finally { release(); releaseLegacy(); }
  });
}

function failedRun(): HeartbeatRun {
  const now = new Date();
  return {
    id: "browser-failed-attempt", issueId: failureTask.id, scopeKind: "issue", companyId: company.id,
    agentId: "browser-fixture-agent", responsibleUserId: userId, invocationSource: "assignment", triggerDetail: null,
    status: "failed", error: "Synthetic attempt stopped", wakeupRequestId: null, exitCode: null, signal: null,
    usageJson: null, resultJson: null, sessionIdBefore: null, sessionIdAfter: null, logStore: null, logRef: null,
    logBytes: null, logSha256: null, logCompressed: false, stdoutExcerpt: null, stderrExcerpt: null, errorCode: null,
    externalRunId: null, processPid: null, processGroupId: null, processStartedAt: null, lastOutputAt: null,
    lastOutputSeq: 0, lastOutputStream: null, lastOutputBytes: null, retryOfRunId: null, processLossRetryCount: 0,
    livenessState: null, livenessReason: null, continuationAttempt: 0, lastUsefulActionAt: null, nextAction: null,
    contextSnapshot: null, startedAt: now, finishedAt: now, createdAt: now, updatedAt: now,
  };
}

for (const failure of ["failureError", "contextError"] as const) {
  test(`partial ${failure} keeps rows readable and retries the assembled source`, async ({ page, request }) => {
    const source = await json<InboxMineSnapshot>(request, "GET", minePath());
    const failureRows = await json<CompactIssue[]>(request, "GET", `/api/companies/${company.id}/issues?view=rows&includeRoutineExecutions=true&limit=1&ids=${failureTask.id}`);
    expect(failureRows).toHaveLength(1);
    const run = failedRun();
    const resolved: CompactIssue = { ...failureRows[0]!, interruption: {
      intentId: "browser-saved-input", responsibility: "system", state: "resolved", nextRetryAt: null,
      canRetry: false, userAction: null, sourceRunIds: [run.id], observedRunId: run.id,
    } };
    let attempts = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === minePath(), async route => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ json: { ...source, contextIssues: failure === "contextError" ? [] : source.contextIssues,
          failureRuns: [], failureIssueIds: [],
          [failure]: { status: 503, message: "Optional source temporarily unavailable" } } });
      } else {
        await held;
        await route.fulfill({ json: { ...source, contextIssues: [...source.contextIssues, resolved],
          failureRuns: [run], failureIssueIds: [failureTask.id] } });
      }
    });
    try {
      await page.goto(`/${company.issuePrefix}/inbox/mine`);
      await expect(childLink(page)).toBeVisible();
      await expect(page.getByText("Some inbox items couldn’t load. Showing available items.", { exact: true })).toBeVisible();
      const node = await childLink(page).elementHandle();
      const before = await childLink(page).boundingBox();
      await page.getByRole("button", { name: "Retry missing items", exact: true }).click();
      await expect.poll(() => attempts).toBe(2);
      await expect(childLink(page)).toBeVisible();
      expect(await node!.evaluate(element => element.isConnected)).toBe(true);
      release();
      await expect(page.getByText("Some inbox items couldn’t load. Showing available items.", { exact: true })).toHaveCount(0);
      await twoFrames(page);
      expect(await node!.evaluate(element => element.isConnected)).toBe(true);
      const after = await childLink(page).boundingBox();
      expect(Math.abs(before!.y - after!.y)).toBeLessThan(1);
      expect(Math.abs(before!.height - after!.height)).toBeLessThan(1);
      await expect(page.getByText("Couldn’t finish this attempt. Your message is saved.", { exact: true })).toHaveCount(0);
      await expect(page.getByText(failureTask.title, { exact: true })).toHaveCount(0);
    } finally { release(); }
  });
}

test("an initial Mine 429 has a scoped retry and does not take the app offline", async ({ page }) => {
  let busy = true;
  await page.route(url => url.pathname === minePath(), async route => {
    if (busy) await route.fulfill({ status: 429, headers: { "Retry-After": "1" }, json: { error: "Inbox source is busy" } });
    else await route.continue();
  });
  await page.goto(`/${company.issuePrefix}/inbox/mine`);
  // Keep the inherited 429 backoff and Retry-After policy. The explicit Retry
  // action appears after that bounded automatic retry window is exhausted.
  await expect(page.getByText("Unable to load the inbox: Inbox source is busy", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Reconnecting to Paperclip", { exact: true })).toHaveCount(0);
  busy = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(childLink(page)).toBeVisible();
});

test("a background Mine 429 preserves readable rows and a retry does not duplicate them", async ({ page, request }) => {
  let busy = false;
  let busyReads = 0;
  await page.route(url => url.pathname === minePath(), async route => {
    if (busy) {
      busyReads += 1;
      await route.fulfill({ status: 429, headers: { "Retry-After": "1" }, json: { error: "Inbox source is busy" } });
    } else await route.continue();
  });
  await page.goto(`/${company.issuePrefix}/inbox/mine`);
  await expect(childLink(page)).toBeVisible();
  const node = await childLink(page).elementHandle();
  busy = true;
  await json(request, "PATCH", `/api/issues/${child.id}`, { title: "Inbox startup child updated" });
  await expect.poll(() => busyReads).toBeGreaterThan(0);
  await expect(childLink(page)).toBeVisible();
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.getByText("Reconnecting to Paperclip", { exact: true })).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Retry missing items", exact: true });
  await expect(retry).toBeVisible({ timeout: 45_000 });
  await expect(childLink(page)).toBeVisible();
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  busy = false;
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === minePath()
    && response.request().method() === "GET");
  await retry.click();
  expect((await retried).ok()).toBeTruthy();
  await expect(childLink(page)).toHaveCount(1);
  await expect(childLink(page)).toBeVisible();
});

test("Mine archive and Undo persist through the assembled source and reload", async ({ page, request }) => {
  await page.goto(`/${company.issuePrefix}/inbox/mine`);
  const link = childLink(page);
  await expect(link).toBeVisible();
  const row = page.locator("[data-inbox-item]").filter({ has: link });
  const archived = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${child.id}/inbox-archive` && response.request().method() === "POST");
  await row.getByRole("button", { name: "Archive", exact: true }).click();
  expect((await archived).ok()).toBeTruthy();
  await expect(link).toHaveCount(0);
  const afterArchive = await json<InboxMineSnapshot>(request, "GET", minePath());
  expect(afterArchive.issues.some(issue => issue.id === child.id)).toBe(false);
  const unarchived = page.waitForResponse(response => new URL(response.url()).pathname === `/api/issues/${child.id}/inbox-archive`
    && response.request().method() === "DELETE");
  await page.keyboard.press("u");
  expect((await unarchived).ok()).toBeTruthy();
  await expect(link).toBeVisible();
  const restored = await json<InboxMineSnapshot>(request, "GET", minePath());
  expect(restored.issues.some(issue => issue.id === child.id)).toBe(true);
  await page.reload();
  await expect(link).toBeVisible();
});
