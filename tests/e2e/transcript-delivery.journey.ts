import { expect, test, type WebSocket } from "@playwright/test";
import { json } from "./agent-chat.shared";

test("native transcript survives two views and reload through negotiated streaming", async ({ page, context, request }, info) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const sockets = new Set<globalThis.WebSocket>();
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/events/ws")) sockets.add(this);
        this.addEventListener("close", () => sockets.delete(this));
      }
    };
    Object.assign(window, { closeTranscriptTransport: () => {
      for (const socket of sockets) socket.close();
    } });
  });
  const company = await json(await request.post("/api/companies", { data: { name: "Native transcript delivery" } }));
  const original = await json(await request.get("/api/instance/settings/experimental"));
  const frames: Array<{ type?: string; runIds?: string[]; revision?: number }> = [];
  let connections = 0;
  const activeConnections = new Set<WebSocket>();
  let transcriptReads = 0;
  page.on("request", request => { if (/\/heartbeat-runs\/[^/]+\/(events|log)(\?|$)/.test(request.url())) transcriptReads += 1; });
  page.on("websocket", socket => {
    if (!socket.url().includes("/events/ws")) return;
    connections += 1;
    activeConnections.add(socket);
    socket.on("close", () => { activeConnections.delete(socket); });
    socket.on("framesent", frame => { try { frames.push(JSON.parse(String(frame.payload))); } catch {} });
    socket.on("framereceived", frame => { try { frames.push(JSON.parse(String(frame.payload))); } catch {} });
  });
  try {
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: true, enableWorktreeRunExecution: true } }));
    await json(await request.post(`/api/companies/${company.id}/user-secret-definitions`, { data: { key: "OPENAI_API_KEY", name: "Fixture credential" } }));
    await json(await request.post(`/api/companies/${company.id}/me/user-secrets`, { data: { definitionKey: "OPENAI_API_KEY", value: "not-a-real-model-key" } }));
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: { name: "CEO", role: "ceo", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.1-codex-mini", env: {
        OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", version: "latest", required: true },
      } } } }));
    await expect.poll(async () => (await json(await request.get(`/api/agents/${agent.id}`))).lifecycleState,
      { timeout: 30_000 }).toBe("ready");
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}/overview`);
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await page.getByRole("button", { name: "New Task", exact: true }).last().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "editable markdown" }).fill("Summarize the launch decisions and include the source link");
    await expect(dialog.getByRole("button", { name: "Select assignee" })).toContainText("CEO");
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await expect.poll(async () => (await json(await request.get(`/api/companies/${company.id}/issues`))).length).toBe(1);
    const [issue] = await json(await request.get(`/api/companies/${company.id}/issues`));
    const route = `/${company.issuePrefix}/issues/${issue.identifier}`;
    activeConnections.clear();
    frames.length = 0;
    await page.goto(route);
    let runId = "";
    await expect.poll(async () => {
      const runs = await json(await request.get(`/api/companies/${company.id}/heartbeat-runs`));
      runId = runs[0]?.id ?? "";
      return runs[0]?.status;
    }).toBe("running");
    const subscribed = () => {
      const index = frames.findLastIndex(frame => frame.type === "live.interests");
      const interest = frames[index];
      return Boolean(interest?.runIds?.includes(runId)
        && frames.slice(index + 1).some(frame => frame.type === "live.subscribed" && frame.revision === interest.revision));
    };
    await expect.poll(subscribed).toBe(true);
    await expect(page.getByText("STREAM-42: waiting for the final answer.", { exact: false }).first()).toBeVisible();
    await page.waitForTimeout(2_000);
    const healthyReads = transcriptReads;
    await page.waitForTimeout(2_500);
    const healthyPollingReads = transcriptReads - healthyReads;
    expect(healthyPollingReads).toBe(0);
    expect(activeConnections.size).toBe(1);
    const second = await context.newPage();
    await second.goto(route);
    const other = await json(await request.post("/api/companies", { data: { name: "Transcript isolation" } }));
    await page.goto(`/${other.issuePrefix}/dashboard`);
    await expect.poll(() => frames.findLast(frame => frame.type === "live.interests")?.runIds).toEqual([]);
    await page.goto(route);
    await expect.poll(subscribed).toBe(true);
    const beforeReconnect = connections;
    await context.setOffline(true);
    await page.evaluate(() => (window as unknown as { closeTranscriptTransport(): void }).closeTranscriptTransport());
    await page.waitForTimeout(1_000);
    await context.setOffline(false);
    await expect.poll(() => connections, { timeout: 15_000 }).toBeGreaterThan(beforeReconnect);
    await expect.poll(subscribed).toBe(true);
    await expect.poll(async () => (await json(await request.get(`/api/companies/${company.id}/heartbeat-runs`)))[0]?.status, { timeout: 70_000 }).toBe("succeeded");
    for (const view of [page, second]) {
      await expect(view.getByText("STREAM-42: The launch has two stages.", { exact: false }).first()).toBeVisible();
      await view.reload();
      await expect(view.getByText("STREAM-42: The launch has two stages.", { exact: false }).first()).toBeVisible();
    }
    const runs = await json(await request.get(`/api/companies/${company.id}/heartbeat-runs`));
    expect(runs).toHaveLength(1);
    const comments = await json(await request.get(`/api/issues/${issue.id}/comments`));
    expect(comments.filter((comment: { body: string }) => comment.body.includes("STREAM-42"))).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("native-transcript.png"), fullPage: true });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}/runs/${runId}`);
    const eventDetails = page.getByText(/^Events \(\d+\)$/).locator("..");
    await expect(eventDetails.getByText("STREAM-42: The launch has two stages.", { exact: false }).first()).toBeVisible();
    await page.reload();
    await expect(eventDetails.getByText("STREAM-42: The launch has two stages.", { exact: false }).first()).toBeVisible();
    const eventsRoute = `**/api/heartbeat-runs/${runId}/events?*`;
    const logRoute = `**/api/heartbeat-runs/${runId}/log?*`;
    await page.route(eventsRoute, route => route.fulfill({ status: 503, json: { error: "History temporarily unavailable" } }));
    await page.route(logRoute, async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), content: "", nextOffset: 0 } });
    });
    await page.reload();
    await expect(page.getByText("Could not load events. Try again.", { exact: true })).toBeVisible();
    await expect(page.getByText("No log events.", { exact: true })).toHaveCount(0);
    await page.unroute(eventsRoute); await page.unroute(logRoute);
    await page.getByRole("button", { name: "Retry events", exact: true }).click();
    await expect(eventDetails.getByText("STREAM-42: The launch has two stages.", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Could not load events. Try again.", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("native-agent-events.png"), fullPage: true });
    await info.attach("delivery-evidence", { body: JSON.stringify({ dependency: "deterministic Codex app-server", runId: runs[0].id,
      connections, healthyPollingReads, negotiated: frames.some(frame => frame.type === "live.subscribed"),
      interestRevisions: frames.filter(frame => frame.type === "live.interests") }), contentType: "application/json" });
    await second.close();
  } finally {
    const live = await json(await request.get(`/api/companies/${company.id}/live-runs`));
    for (const run of live) await json(await request.post(`/api/heartbeat-runs/${run.id}/cancel`));
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: original.enableNativeRunner,
      enableWorktreeRunExecution: original.enableWorktreeRunExecution } }));
  }
});
