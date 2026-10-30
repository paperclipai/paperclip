import { test, expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

async function pauseTask(page: Page) {
  const actions = page.getByRole("button", { name: "More task actions", exact: true });
  await expect(actions).toBeVisible({ timeout: 10_000 });
  // During hydration the loading overlay contains a temporary header copy.
  // Use the real revealed header before sending its ordinary key action.
  await expect(page.getByTestId("task-chat-history-loading")).toHaveCount(0, { timeout: 10_000 });
  const history = page.getByTestId("task-chat-history-content");
  if (await history.count()) {
    await expect(history).toBeVisible({ timeout: 10_000 });
    await expect(history).not.toHaveAttribute("inert", "", { timeout: 10_000 });
  }
  await actions.focus({ timeout: 10_000 });
  await expect(actions).toBeFocused({ timeout: 10_000 });
  // The production trigger explicitly supports Enter to open the popover.
  await actions.press("Enter", { timeout: 10_000 });
  await expect(actions).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
  await page.getByRole("button", { name: "Pause work", exact: true }).click({ timeout: 10_000 });
}

async function cleanupFixture(request: APIRequestContext, companyId: string, classic: boolean, primaryFailed: boolean) {
  const operations = [
    { name: "archive fixture company", run: () => request.patch(`/api/companies/${companyId}`, { data: { status: "archived" } }) },
    { name: "restore task interface", run: () => request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: classic } }) },
  ];
  const outcomes = await Promise.allSettled(operations.map(async operation => {
    const response = await operation.run();
    if (!response.ok()) throw new Error(`${operation.name}: HTTP ${response.status()}`);
  }));
  const failures = outcomes.flatMap((outcome, index) => outcome.status === "rejected"
    ? [{ operation: operations[index]!.name, error: String(outcome.reason) }] : []);
  if (!failures.length) return;
  if (!primaryFailed) throw new AggregateError(failures.map(failure => new Error(`${failure.operation}: ${failure.error}`)), "Paused composer fixture cleanup failed");
  // A timeout may have disposed the request fixture. Keep that original
  // failure while retaining both cleanup outcomes for diagnosis.
  console.warn("Paused composer fixture cleanup failed after the primary failure", failures);
  await test.info().attach("paused-composer-cleanup-errors", {
    body: Buffer.from(JSON.stringify(failures, null, 2)), contentType: "application/json",
  }).catch(() => {});
}

for (const classic of [false, true]) {
  test(`resume preview: ${classic ? "classic" : "task chat"} does not promise to wake blocked work`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const company = await json(await request.post("/api/companies", { data: { name: `Resume preview ${Date.now()}` } }));
    const settings = await json(await request.get("/api/instance/settings/experimental"));
    let primaryFailed = false;
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: classic } }));
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "Resume preview fixture", role: "engineer", adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      } }));
      const task = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "Blocked work stays blocked", status: "blocked", assigneeAgentId: agent.id,
      } }));
      await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
      await pauseTask(page);
      const takeover = page.getByTestId("paused-composer-takeover");
      await expect(takeover).toBeVisible();
      // Enable dispatch only after the hold exists; assignment itself otherwise starts a run.
      expect((await json(await request.get(`/api/issues/${task.id}`))).status).toBe("blocked");
      await json(await request.patch(`/api/agents/${agent.id}`, { data: {
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      } }));
      await takeover.getByRole("button", { name: "Resume task" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("The pause will be removed from 1 task.");
      const wake = dialog.getByRole("checkbox", { name: "Wake affected agents (0)" });
      await expect(wake).toBeDisabled();
      await expect(wake).not.toBeChecked();
      await expect(dialog).toContainText("Blocked, backlog, and unassigned tasks will be unpaused but will not start.");
      await dialog.getByRole("button", { name: "Resume work", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(takeover).toHaveCount(0);
      await page.reload();
      const editor = (classic ? page.getByTestId("issue-chat-composer") : page).getByRole("textbox", { name: "editable markdown" });
      await expect(editor).toBeVisible();
      expect((await json(await request.get(`/api/issues/${task.id}`))).status).toBe("blocked");
      expect(await json(await request.get(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`))).toEqual([]);
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      await cleanupFixture(request, company.id, settings.enableClassicTaskInterface, primaryFailed);
    }
  });

  test(`paused composer: ${classic ? "classic" : "task chat"} preserves drafts and requires resume`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const company = await json(await request.post("/api/companies", { data: { name: `Paused composer ${Date.now()}` } }));
    const settings = await json(await request.get("/api/instance/settings/experimental"));
    let primaryFailed = false;
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: classic } }));
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "Paused composer fixture", role: "engineer", adapterType: "process",
        adapterConfig: { command: "/usr/bin/true" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      } }));
      const task = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "Review the paused composer", status: "backlog", assigneeAgentId: agent.id,
      } }));
      await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
      const editor = (classic ? page.getByTestId("issue-chat-composer") : page).getByRole("textbox", { name: "editable markdown" });
      await editor.fill("Keep this draft until I resume.");
      await pauseTask(page);
      const takeover = page.getByTestId("paused-composer-takeover");
      await expect(takeover).toBeVisible();
      await expect(takeover).toContainText("Your draft is saved.");
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
      await page.keyboard.press("Meta+Enter");
      const rejected = await request.post(`/api/issues/${task.id}/comments`, { data: { body: "Cannot send yet", reopen: true } });
      expect(rejected.status()).toBe(409);
      const rejectedUpdate = await request.patch(`/api/issues/${task.id}`, { data: { comment: "Cannot reassign and send", assigneeAgentId: null } });
      expect(rejectedUpdate.status()).toBe(409);
      expect((await json(await request.get(`/api/issues/${task.id}`))).assigneeAgentId).toBe(agent.id);
      expect(await json(await request.get(`/api/issues/${task.id}/comments`))).toHaveLength(0);
      await page.reload();
      await expect(takeover).toBeVisible();
      await expect(takeover).toContainText("Your draft is saved.");
      await takeover.getByRole("button", { name: "Resume task" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Resume work", exact: true }).click();
      await expect(takeover).toHaveCount(0);
      await expect(editor).toHaveText("Keep this draft until I resume.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}/comments`))).map((comment: { body: string }) => comment.body)).toEqual(["Keep this draft until I resume."]);

      // Ancestor pause is effective even when this child was created after it.
      await pauseTask(page);
      await expect(takeover).toBeVisible();
      const child = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "Child held by parent", parentId: task.id, status: "backlog", assigneeAgentId: agent.id,
      } }));
      await page.goto(`/${company.issuePrefix}/issues/${child.identifier}`);
      await expect(takeover).toContainText("Subtree is paused.");
      await expect(editor).toHaveCount(0);
      expect((await request.post(`/api/issues/${child.id}/comments`, { data: { body: "Still paused" } })).status()).toBe(409);
      await takeover.getByRole("link", { name: "Resume subtree" }).click();
      await expect(page).toHaveURL(new RegExp(task.identifier));
      await takeover.getByRole("button", { name: "Resume subtree" }).click();
      const subtreeWake = page.getByRole("dialog").getByRole("checkbox");
      if (await subtreeWake.isEnabled()) await subtreeWake.uncheck();
      else await expect(subtreeWake).not.toBeChecked();
      const released = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && new URL(response.url()).pathname.startsWith(`/api/issues/${task.identifier}/tree-holds/`)
        && new URL(response.url()).pathname.endsWith("/release"),
      );
      await page.getByRole("dialog").getByRole("button", { name: "Resume subtree", exact: true }).click();
      expect((await released).ok()).toBe(true);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.goto(`/${company.issuePrefix}/issues/${child.identifier}`);
      await expect(takeover).toHaveCount(0);
      await expect(editor).toBeVisible();
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      await cleanupFixture(request, company.id, settings.enableClassicTaskInterface, primaryFailed);
    }
  });
}
