import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeRegisteredClients, createDb, heartbeatRunEvents, heartbeatRuns, issueComments } from "../../packages/db/src/index.ts";

test("long native history opens at the latest activity and older events remain browsable", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const databaseUrl = config.database.mode === "postgres"
    ? config.database.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${(await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8")).split("\n")[3]}/paperclip`;
  const db = createDb(databaseUrl);
  const companyResponse = await request.post("/api/companies", { data: { name: `History window ${Date.now()}` } });
  expect(companyResponse.ok()).toBe(true);
  const company = await companyResponse.json();
  try {
    const agentResponse = await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "History reader", role: "engineer", adapterType: "process", adapterConfig: { command: "true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } });
    expect(agentResponse.ok(), await agentResponse.text()).toBe(true);
    const agent = await agentResponse.json();
    const issueResponse = await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Review a long conversation", status: "backlog", assigneeAgentId: agent.id,
    } });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json();
    const now = Date.now();
    const runs = Array.from({ length: 30 }, (_, index) => ({
      id: randomUUID(), companyId: company.id, agentId: agent.id, status: "succeeded",
      runtimeMode: "native", responsibleUserId: issue.responsibleUserId,
      contextSnapshot: { issueId: issue.id },
      createdAt: new Date(now - (30 - index) * 10_000),
      startedAt: new Date(now - (30 - index) * 10_000),
      finishedAt: new Date(now - (30 - index) * 10_000 + 1_000),
    }));
    await db.insert(heartbeatRuns).values(runs);
    const run = runs.at(-1)!;
    await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
      authorAgentId: agent.id, runId: run.id, body: "The final answer stays visible after a long conversation." });
    for (let batch = 0; batch < 10; batch += 1) {
      await db.insert(heartbeatRunEvents).values(Array.from({ length: 1_000 }, (_, index) => ({
        companyId: company.id, agentId: agent.id, runId: run.id,
        seq: batch * 1_000 + index + 1, eventType: "history.fixture",
        message: `Recorded activity ${batch * 1_000 + index + 1}`, payload: { text: "x".repeat(256) },
      })));
    }
    const eventRequests: URL[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (/\/heartbeat-runs\/[^/]+\/events$/.test(url.pathname)) eventRequests.push(url);
    });
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    await expect(page.getByText("The final answer stays visible after a long conversation.", { exact: false }).first()).toBeVisible();
    // Ten old runs plus the newest run's truncated event window have markers.
    // Wait for that window to hydrate before choosing its navigation link.
    await expect(page.getByRole("button", { name: /Earlier activity/ })).toHaveCount(11);
    const windows = eventRequests.filter((url) => url.searchParams.get("view") !== "context");
    expect(new Set(windows.map((url) => url.pathname)).size).toBeLessThanOrEqual(20);
    expect(windows.every((url) => url.searchParams.get("afterSeq") === "tail")).toBe(true);
    await page.screenshot({ path: info.outputPath("long-conversation.png"), fullPage: true });

    await page.getByRole("button", { name: /Earlier activity/ }).last().click();
    await page.getByRole("link", { name: "View run", exact: true }).last().click();
    await expect(page).toHaveURL(new RegExp(`/runs/${run.id}$`));
    await expect(page.getByTestId("run-event-history-notice")).toBeVisible();
    await page.getByRole("button", { name: /Inspect/ }).first().click();
    await page.getByRole("tab", { name: "Pipeline", exact: true }).click();
    await expect(page.getByText("Recent activity · 1,000 events")).toBeVisible();
    await page.getByRole("button", { name: "Older events", exact: true }).click();
    await expect(page.getByText("Earlier activity · 1,000 events")).toBeVisible();
    await expect.poll(() => eventRequests.some((url) => url.searchParams.get("beforeSeq") === "9001")).toBe(true);
    await page.getByRole("button", { name: "Latest events", exact: true }).click();
    await expect(page.getByText("Recent activity · 1,000 events")).toBeVisible();
    await page.screenshot({ path: info.outputPath("paged-run-inspector.png"), fullPage: true });
  } finally {
    try {
      await request.delete(`/api/companies/${company.id}`);
    } catch (error) {
      if (info.status === info.expectedStatus) throw error;
    } finally {
      await closeRegisteredClients(databaseUrl);
    }
  }
});
