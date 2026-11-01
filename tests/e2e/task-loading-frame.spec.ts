import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function createTask(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: "Loading frame verification" } }));
  const title = "Investigate a long-running workspace and preserve its saved findings, document cards, and pending review without moving the initial reading position";
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
    title, status: "backlog", description: "## Saved investigation\n\n" + "Preserve the original report and all saved evidence. ".repeat(20),
  } }));
  return { company, issue, title, route: `/${company.issuePrefix}/issues/${issue.identifier}` };
}

for (const mobile of [false, true]) test(`a rich task uses one stable loading frame (${mobile ? "mobile" : "desktop"})`, async ({ page, request }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
  const fixture = await createTask(request);
  try {
    for (let index = 0; index < 20; index++) await json(await request.post(`/api/issues/${fixture.issue.id}/comments`, { data: {
      body: `## Saved findings ${index}\n\n` + "Checked the recorded evidence and retained the result for review. ".repeat(12),
    } }));
    await json(await request.put(`/api/issues/${fixture.issue.id}/documents/plan`, { data: {
      title: "Investigation plan", format: "markdown", body: "# Plan\n\nKeep the findings with the original task.",
    } }));
    await json(await request.post(`/api/issues/${fixture.issue.id}/work-products`, { data: {
      type: "pull_request", provider: "github", title: "Saved investigation patch", status: "active",
      url: "https://github.com/example/layout-fixture/pull/42", metadata: { repository: "example/layout-fixture", number: 42 },
    } }));
    await json(await request.post(`/api/issues/${fixture.issue.id}/interactions`, { data: {
      kind: "request_confirmation", title: "Review the saved patch", continuationPolicy: "none",
      payload: { version: 1, prompt: "Approve the saved findings?", acceptLabel: "Approve patch", rejectLabel: "Request changes" },
    } }));
    await page.route("**/api/workspace-preferences/me", async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: true } });
    });
    await page.addInitScript(() => {
      const frames: Array<{ ready: boolean; headerVisible: boolean; loading: number[] | null; loadingComposer: number[] | null; composer: number[] | null; latestY?: number; scrollHeight?: number; loadingFont?: string; titleFont?: string }> = [];
      Object.assign(window, { taskLoadingFrames: frames });
      const sample = () => {
        const box = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element || getComputedStyle(element).visibility !== "visible") return null;
          const rect = element.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        };
        const font = (selector: string) => {
          const element = document.querySelector(selector);
          return element ? getComputedStyle(element).font : undefined;
        };
        const header = document.querySelector('[data-testid="issue-detail-header"]');
        const bounds = header?.getBoundingClientRect();
        frames.push({
          ready: !!document.querySelector('[data-testid="task-chat-thread"] > [aria-busy="false"]'),
          headerVisible: !!header && getComputedStyle(header).visibility === "visible" && bounds!.bottom > 60 && bounds!.top < innerHeight,
          loading: box('[data-testid="task-chat-loading-frame"]'),
          loadingComposer: box('[data-testid="task-chat-loading-composer"] .paperclip-task-chat-composer'),
          composer: box('[data-testid="task-chat-composer-stack"] .paperclip-task-chat-composer'),
          latestY: [...document.querySelectorAll('[id^="comment-"]')].at(-1)?.getBoundingClientRect().y,
          scrollHeight: document.querySelector('[data-testid="task-chat-scroller"]')?.scrollHeight,
          loadingFont: font('[data-slot="task-loading-title"]'),
          titleFont: font('[data-testid="task-chat-history-content"] [data-testid="issue-detail-header"] h2'),
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto(fixture.route);
    await expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve patch", exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    const frames = await page.evaluate(() => (window as unknown as { taskLoadingFrames: Array<{ ready: boolean; headerVisible: boolean; loading: number[] | null; loadingComposer: number[] | null; composer: number[] | null; latestY?: number; scrollHeight?: number; loadingFont?: string; titleFont?: string }> }).taskLoadingFrames);
    await info.attach("loading-frames", { body: JSON.stringify(frames), contentType: "application/json" });
    expect(frames.filter(frame => !frame.ready && frame.headerVisible)).toEqual([]);
    const loading = frames.filter(frame => frame.loading);
    const ready = frames.filter(frame => frame.ready && frame.latestY !== undefined);
    expect(loading.length).toBeGreaterThan(1);
    expect(ready.length).toBeGreaterThan(5);
    for (let dimension = 0; dimension < 4; dimension++) {
      const values = loading.map(frame => frame.loading![dimension]);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(2);
      expect(Math.abs(loading.at(-1)!.loadingComposer![dimension] - ready[0].composer![dimension])).toBeLessThanOrEqual(2);
    }
    expect(loading.at(-1)!.loadingFont).toBe(ready[0].titleFont);
    expect(Math.max(...ready.map(frame => frame.latestY!)) - Math.min(...ready.map(frame => frame.latestY!))).toBeLessThanOrEqual(2);
    expect(new Set(ready.map(frame => frame.scrollHeight)).size).toBe(1);
  } finally {
    await request.patch(`/api/companies/${fixture.company.id}`, { data: { status: "archived" } });
  }
});

test("Classic startup does not guess a chat layout while personal preferences are pending", async ({ page, request }) => {
  const fixture = await createTask(request);
  let release!: () => void;
  const preferenceReady = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route("**/api/instance/settings/experimental", async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), enableClassicTaskInterface: true, enableStreamlinedUi: false } });
    });
    await page.route("**/api/workspace-preferences/me", async route => {
      await preferenceReady;
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: false } });
    });
    await page.goto(fixture.route);
    await expect(page.getByTestId("shell-configuration-loading")).toBeVisible();
    await expect(page.locator("[data-task-chat-shell]")).toHaveCount(0);
    await expect(page.getByTestId("issue-detail-header")).toHaveCount(0);
    release();
    await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: fixture.title, exact: true })).toBeVisible();
    await expect(page.locator("[data-task-chat-shell]")).toHaveCount(0);
  } finally {
    release();
    await request.patch(`/api/companies/${fixture.company.id}`, { data: { status: "archived" } });
  }
});

test("a stalled web font does not hide an otherwise prepared conversation indefinitely", async ({ page, request }) => {
  const fixture = await createTask(request);
  let release!: () => void;
  const fontReady = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route("**/api/workspace-preferences/me", async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: true } });
    });
    await page.route("**/*.woff2", async route => { await fontReady; await route.abort(); });
    await page.goto(fixture.route, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("task-chat-loading-frame")).toBeVisible();
    await expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("task-chat-composer-stack").locator('[contenteditable="true"]')).toBeEditable();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await request.patch(`/api/companies/${fixture.company.id}`, { data: { status: "archived" } });
  }
});

for (const coordinator of [false, true]) test(`mobile chrome stays fixed when personal preferences resolve (Coordinator=${coordinator})`, async ({ page, request }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await createTask(request);
  let release!: () => void;
  const preferenceReady = new Promise<void>(resolve => { release = resolve; });
  await page.addInitScript(() => {
    const frames: number[][] = [];
    Object.assign(window, { mobileShellFrames: frames });
    const sample = () => {
      const shell = document.querySelector(".paperclip-app-shell");
      if (shell && shell.getBoundingClientRect().width > 0) {
        const rects = [".app-breadcrumb", ".mobile-bottom-nav", "#main-content"].map(selector => document.querySelector(selector)!.getBoundingClientRect());
        frames.push([innerWidth, innerHeight, scrollX, scrollY, ...rects.flatMap((rect, index) => index === 2 ? [rect.x, rect.y, rect.width] : [rect.x, rect.y, rect.width, rect.height])]);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  try {
    await page.route("**/api/instance/settings/experimental", async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), enableClassicTaskInterface: true, enableStreamlinedUi: false } });
    });
    await page.route("**/api/workspace-preferences/me", async route => {
      await preferenceReady;
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: coordinator } });
    });
    await page.goto(fixture.route);
    await expect(page.getByTestId("shell-configuration-loading")).toBeVisible();
    await expect(page.locator(".paperclip-app-shell")).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { mobileShellFrames: number[][] }).mobileShellFrames)).toEqual([]);
    release();
    if (coordinator) await expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible();
    else await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: fixture.title, exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    const frames = await page.evaluate(() => (window as unknown as { mobileShellFrames: number[][] }).mobileShellFrames);
    await info.attach("mobile-preference-chrome", { body: JSON.stringify(frames), contentType: "application/json" });
    expect(frames.length).toBeGreaterThan(5);
    for (let dimension = 0; dimension < frames[0].length; dimension++) {
      const values = frames.map(frame => frame[dimension]);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(2);
    }
  } finally {
    release();
    await request.patch(`/api/companies/${fixture.company.id}`, { data: { status: "archived" } });
  }
});

test("a seeded Classic loading title uses the resolved title typography", async ({ page, request }) => {
  const fixture = await createTask(request);
  let release!: () => void;
  const coreReady = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route("**/api/instance/settings/experimental", async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), enableClassicTaskInterface: true, enableStreamlinedUi: false } });
    });
    await page.route("**/api/workspace-preferences/me", async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: false } });
    });
    await page.goto(`/${fixture.company.issuePrefix}/issues`);
    await page.getByRole("link").filter({ hasText: fixture.title }).first().click();
    await expect(page.getByTestId("issue-detail-header").getByRole("heading", { name: fixture.title, exact: true })).toBeVisible();
    await page.route("**/api/issues/*", async route => { await coreReady; await route.continue(); });
    await page.reload({ waitUntil: "domcontentloaded" });
    const loadingTitle = page.getByRole("heading", { name: fixture.title, exact: true });
    await expect(loadingTitle).toBeVisible();
    await expect(page.getByTestId("issue-detail-header")).toHaveCount(0);
    const font = await loadingTitle.evaluate(element => getComputedStyle(element).font);
    release();
    const title = page.getByTestId("issue-detail-header").getByRole("heading", { name: fixture.title, exact: true });
    await expect(title).toBeVisible();
    expect(await title.evaluate(element => getComputedStyle(element).font)).toBe(font);
  } finally {
    release();
    await request.patch(`/api/companies/${fixture.company.id}`, { data: { status: "archived" } });
  }
});
