import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });
test.setTimeout(60_000);
test.skip(!process.env.PAPERCLIP_ISSUE_PERF_DATABASE_URL, "The native saved-reply fixture requires a disposable PostgreSQL database");

let fixture: { prefix: string; identifier: string; runId: string; lastCommentId: string };

test.beforeAll(async ({ request }) => {
  const databaseUrl = process.env.PAPERCLIP_ISSUE_PERF_DATABASE_URL;
  if (!databaseUrl) throw new Error("Set PAPERCLIP_ISSUE_PERF_DATABASE_URL for a disposable local database");
  const target = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !target.pathname.endsWith("_test")) {
    throw new Error("The saved-reply fixture requires a disposable loopback database ending in _test");
  }
  const { createDb, closeRegisteredClients, heartbeatRuns, heartbeatRunEvents, issueComments, activityLog } = await import("../../../packages/db/src/index");
  const companyResponse = await request.post("/api/companies", { data: { name: `Saved reply startup ${Date.now()}` } });
  expect(companyResponse.ok(), await companyResponse.text()).toBeTruthy();
  const company = await companyResponse.json();
  const agentResponse = await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "Saved investigation author", role: "engineer", status: "paused", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" },
  } });
  expect(agentResponse.ok(), await agentResponse.text()).toBeTruthy();
  const agent = await agentResponse.json();
  const issueResponse = await request.post(`/api/companies/${company.id}/issues`, { data: {
    title: "Read the saved investigation", status: "backlog", description: "Review the latest findings and load older investigation history when needed.",
  } });
  expect(issueResponse.ok(), await issueResponse.text()).toBeTruthy();
  const issue = await issueResponse.json();
  const planResponse = await request.put(`/api/issues/${issue.id}/documents/plan`, { data: {
    title: "Saved investigation plan", format: "markdown", body: "# Saved investigation plan\n\nKeep the saved evidence available before loading its completed run output.",
  } });
  expect(planResponse.ok(), await planResponse.text()).toBeTruthy();
  const plan = await planResponse.json();
  const db = createDb(databaseUrl);
  const comments: (typeof issueComments.$inferInsert)[] = [];
  const runs: (typeof heartbeatRuns.$inferInsert)[] = [];
  const activity: (typeof activityLog.$inferInsert)[] = [];
  const base = Date.now() - 30 * 24 * 3600_000;
  for (let index = 0; index < 200; index++) {
    const runId = randomUUID(), id = randomUUID(), createdAt = index === 199
      ? new Date(new Date(plan.updatedAt).getTime() + 50)
      : new Date(base + index * 60_000);
    const startedAt = index === 199 ? new Date(new Date(plan.updatedAt).getTime() - 1000) : new Date(+createdAt - 900);
    runs.push({ id: runId, companyId: company.id, agentId: agent.id, issueId: issue.id, runtimeMode: "native", status: "succeeded",
      createdAt: new Date(+startedAt - 100), startedAt, finishedAt: createdAt, contextSnapshot: { issueId: issue.id } });
    comments.push({ id, companyId: company.id, issueId: issue.id, authorType: "agent", authorAgentId: agent.id,
      createdByRunId: runId, body: `## Saved investigation ${index}\n\n${"Verified the saved evidence and checked the result. ".repeat(60)}`, createdAt, updatedAt: createdAt });
    activity.push({ companyId: company.id, actorType: "agent", actorId: agent.id, agentId: agent.id, runId,
      entityType: "issue", entityId: issue.id, action: "issue.comment_added", details: { commentId: id }, createdAt });
  }
  const last = comments.at(-1)!, runId = runs.at(-1)!.id!;
  try {
    for (let offset = 0; offset < runs.length; offset += 100) await db.insert(heartbeatRuns).values(runs.slice(offset, offset + 100));
    for (let offset = 0; offset < comments.length; offset += 100) await db.insert(issueComments).values(comments.slice(offset, offset + 100));
    for (let offset = 0; offset < activity.length; offset += 100) await db.insert(activityLog).values(activity.slice(offset, offset + 100));
    await db.insert(heartbeatRunEvents).values({ companyId: company.id, agentId: agent.id, runId, seq: 1, eventType: "item.completed", createdAt: last.createdAt,
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, eventType: "item.completed", runId,
        emittedAt: last.createdAt!.toISOString(), itemId: `answer-${runId}`, payload: { kind: "agentMessage", text: last.body } } } });
  } finally { await closeRegisteredClients(databaseUrl); }
  fixture = { prefix: company.issuePrefix, identifier: issue.identifier, runId, lastCommentId: last.id! };
});

for (const coordinator of [false, true]) for (const mobile of [false, true]) test(`saved task replies reveal before historical output and keep their geometry (Coordinator=${coordinator}, mobile=${mobile})`, async ({ page }, info) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.route("**/api/workspace-preferences/me", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), coordinatorWorkspaceEnabled: coordinator } });
  });
  await page.addInitScript(() => {
    const frames: { height: number; latest: number }[] = [];
    Object.assign(window, { savedReplyFrames: frames });
    const sample = () => {
      const thread = document.querySelector('[data-testid="task-chat-thread"] > [aria-busy="false"]');
      const scroller = thread?.querySelector('[data-testid="task-chat-scroller"]');
      if (scroller) frames.push({ height: scroller.scrollHeight, latest: [...scroller.querySelectorAll('[id^="comment-"]')].at(-1)?.getBoundingClientRect().top ?? 0 });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const reads: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/heartbeat-runs/*/{events,log}?*`, async route => {
    reads.push(route.request().url());
    await held;
    await route.continue();
  });
  try {
    const started = performance.now();
    await page.goto(`/${fixture.prefix}/issues/${fixture.identifier}`);
    await expect(page.getByTestId("task-chat-thread").locator(':scope > [aria-busy="false"]')).toBeVisible({ timeout: 8_000 });
    const readyMs = performance.now() - started;
    const reply = page.locator(`[id="comment-${fixture.lastCommentId}"]`);
    await expect(reply).toContainText("Saved investigation 199");
    await expect(page.getByTestId("task-chat-plan-preview")).toHaveCount(1);
    await expect(page.getByTestId("task-chat-plan-preview")).toContainText("Saved investigation plan");
    expect(reads).toEqual([]);
    await page.waitForTimeout(600);
    const frames = await page.evaluate(() => (window as unknown as { savedReplyFrames: { height: number; latest: number }[] }).savedReplyFrames);
    expect(frames.length).toBeGreaterThan(5);
    for (const dimension of ["height", "latest"] as const) {
      const values = frames.map(frame => frame[dimension]);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(2);
    }
    const editor = page.getByTestId("task-chat-composer-stack").locator('[contenteditable="true"]');
    await editor.fill("Keep this draft while historical output is unavailable.");
    const originalEditor = await editor.elementHandle();
    const before = await reply.boundingBox();
    const height = () => page.getByTestId("task-chat-scroller").evaluate(element => element.scrollHeight);
    const beforeHeight = await height();
    await page.waitForTimeout(600);
    expect(await height()).toBe(beforeHeight);
    expect(Math.abs((await reply.boundingBox())!.y - before!.y)).toBeLessThanOrEqual(2);
    await page.getByRole("button", { name: "More messages", exact: true }).evaluate(element => (element as HTMLButtonElement).click());
    await expect.poll(() => reads.some(url => url.includes(fixture.runId))).toBe(true);
    await expect(editor).toHaveText("Keep this draft while historical output is unavailable.");
    expect(await originalEditor!.evaluate(element => element.isConnected)).toBe(true);
    release();
    await expect(page.getByRole("heading", { name: "Saved investigation 195", exact: true })).toBeAttached();
    await expect(editor).toHaveText("Keep this draft while historical output is unavailable.");
    await fs.writeFile(info.outputPath("readiness.json"), JSON.stringify({ readyMs, reads, frames }, null, 2));
  } finally { release(); }
});
