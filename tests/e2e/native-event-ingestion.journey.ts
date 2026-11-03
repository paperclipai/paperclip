import { createServer, type ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

type Visible = { nonce: string; index: number; intendedMs: number; emittedMs: number; visibleMs: number };
type Case = { name: string; runs: number; events: number; intervalMs: number; prelude: number };
const smoke = process.env.PAPERCLIP_INGESTION_SMOKE === "1";
const cases: Case[] = smoke ? [{ name: "qualification", runs: 1, events: 16, intervalMs: 25, prelude: 0 }] : [
  { name: "paced", runs: 1, events: 128, intervalMs: 25, prelude: 0 },
  { name: "burst16", runs: 1, events: 16, intervalMs: 0, prelude: 0 },
  { name: "burst128", runs: 10, events: 128, intervalMs: 0, prelude: 0 },
  { name: "burst512", runs: 100, events: 512, intervalMs: 0, prelude: 0 },
  { name: "existing-history", runs: 10, events: 128, intervalMs: 0, prelude: 1000 },
];
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1),
    ...(values.length >= 100 ? { p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] } : {}) };
};

test("native ingestion reaches the shipped UI promptly and survives reload", async ({ page, request }, info) => {
  const pending = new Map<string, Map<string, ServerResponse>>();
  const gate = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const key = url.pathname.replace("/native-ingestion-gate/", "");
    const participant = url.searchParams.get("participant");
    if (req.method !== "GET" || !pending.has(key) || !participant || !/^[a-z0-9]+$/.test(participant)) {
      res.writeHead(404).end(); return;
    }
    pending.get(key)!.set(participant, res);
    res.on("close", () => pending.get(key)?.delete(participant));
  });
  await new Promise<void>(resolve => gate.listen(0, "127.0.0.1", resolve));
  const address = gate.address();
  if (!address || typeof address === "string") throw new Error("Local ingestion gate failed");
  const base = `http://127.0.0.1:${address.port}/native-ingestion-gate/`;
  await page.addInitScript(() => {
    const seen = new Set<string>(), visible: Visible[] = [];
    Object.assign(window, { nativeIngestionVisible: visible });
    let scheduled = false, dirty = false;
    const snapshot = () => {
      const text = document.body?.innerText ?? "";
      const pattern = /INGEST_([a-z0-9]+)_(\d+)_(\d+)_(\d+)/g;
      const entries: Omit<Visible, "visibleMs">[] = [];
      for (const match of text.matchAll(pattern)) {
        const key = `${match[1]}:${match[2]}`;
        if (seen.has(key)) continue;
        entries.push({ nonce: match[1], index: Number(match[2]), intendedMs: Number(match[3]), emittedMs: Number(match[4]) });
      }
      return entries;
    };
    const schedule = () => {
      dirty = true;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        dirty = false;
        const entries = snapshot();
        requestAnimationFrame(() => {
          // Only stamp the previous frame's snapshot. A token inserted
          // between frames has not had this snapshot's paint opportunity.
          const visibleMs = Date.now();
          for (const entry of entries) {
            const key = `${entry.nonce}:${entry.index}`;
            if (seen.has(key)) continue;
            seen.add(key); visible.push({ ...entry, visibleMs });
          }
          scheduled = false;
          if (dirty) schedule();
        });
      });
    };
    const install = () => {
      new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true });
      schedule();
    };
    if (document.body) install(); else addEventListener("DOMContentLoaded", install, { once: true });
  });
  const company = await json(await request.post("/api/companies", { data: { name: `Ingestion ${Date.now()}` } }));
  const original = await json(await request.get("/api/instance/settings/experimental"));
  const report: Record<string, unknown> = {
    dependency: "Deterministic Codex app-server fixture; real application/runtime/port/PostgreSQL/live WebSocket/shipped UI",
    variant: process.env.PAPERCLIP_INGESTION_VARIANT ?? "unlabelled", qualificationOnly: smoke,
    diagnosticOnly: Boolean(process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR),
    performanceAcceptanceEligible: !process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR,
    startedAtMs: Date.now(),
    emittedClock: "Provider process epoch; original schedule retained even if stdout backpressures",
    observedClock: "Browser epoch after a DOM update and one paint opportunity",
    cases: [], companyId: company.id,
    health: await json(await request.get("/api/health")),
    serverArtifact: process.env.PAPERCLIP_INGESTION_SERVER_ARTIFACT,
  };
  const appRoot = process.env.PAPERCLIP_INGESTION_APP_ROOT ?? path.resolve(import.meta.dirname, "../..");
  report.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }).trim();
  if (report.serverArtifact === "compiled") {
    const stamp = JSON.parse(await readFile(path.join(appRoot, "server/dist/build-info.json"), "utf8"));
    report.compiledBuildRevision = stamp.commit;
    if (!smoke) expect(stamp.commit, "Build the revision being measured before accepting compiled-app evidence").toBe(report.sourceRevision);
    report.serverEntrySha256 = createHash("sha256").update(await readFile(path.join(appRoot, "server/dist/index.js"))).digest("hex");
    report.runtimeArtifact = "Compiled server and vendored runner; TSX resolves workspace DB/shared source exports only; static built UI";
    const hotPaths = ["server/dist/services/heartbeat-run-events.js", "server/dist/services/native-runtime/paperclip-control-plane-port.js",
      "server/dist/vendor/paperclip-runner/native-session-runtime.js"];
    report.compiledHotPathHashes = Object.fromEntries(await Promise.all(hotPaths.map(async file => [file,
      createHash("sha256").update(await readFile(path.join(appRoot, file))).digest("hex")])));
  }
  report.fixtureSha256 = createHash("sha256").update(await readFile(path.resolve(import.meta.dirname, "fixtures/in-feed-codex.mjs"))).digest("hex");
  const protocolFiles = ["native-event-ingestion.journey.ts", "playwright-native-ingestion.config.ts", "fixtures/in-feed-codex.mjs",
    "fixtures/native-ingestion-bin/codex", "fixtures/composer-stop-codex-loader.mjs", "fixtures/native-ingestion-bootstrap.mjs"];
  report.measurementSha256 = createHash("sha256").update(Buffer.concat(await Promise.all(protocolFiles.map(file => readFile(path.resolve(import.meta.dirname, file)))))).digest("hex");
  try {
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: true, enableWorktreeRunExecution: true } }));
    await json(await request.post(`/api/companies/${company.id}/user-secret-definitions`, { data: { key: "OPENAI_API_KEY", name: "Fixture credential" } }));
    await json(await request.post(`/api/companies/${company.id}/me/user-secrets`, { data: { definitionKey: "OPENAI_API_KEY", value: "not-a-real-model-key" } }));
    const agents = [];
    const agentCount = Math.ceil(Math.max(...cases.map(item => item.runs)) / 50);
    for (let index = 0; index < agentCount; index++) {
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { timeout: 120_000, data: {
        name: `Ingestion ${index + 1}`, role: "engineer", adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex", model: "gpt-5.1-codex-mini", env: {
          OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", version: "latest", required: true },
        } }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 50 } },
      } }));
      await expect.poll(async () => (await json(await request.get(`/api/agents/${agent.id}`))).lifecycleState,
        { timeout: 60_000 }).toBe("ready");
      agents.push(agent);
    }

    async function perform(workload: Case, stop = false) {
      const key = randomUUID().replaceAll("-", ""), nonce = randomUUID().replaceAll("-", "");
      pending.set(key, new Map());
      const prompt = (token: string, prelude: number) => `Measure native streaming for ${token.slice(0, 8)}.\n\nINGESTION_PERF nonce=${token} events=${workload.events} intervalMs=${workload.intervalMs} prelude=${prelude} gate=${base}${key}`;
      const before = new Set((await json(await request.get(`/api/companies/${company.id}/issues`))).map((issue: { id: string }) => issue.id));
      await page.goto(`/${company.issuePrefix}/agents/${agents[0].id}/overview`);
      await page.getByRole("link", { name: "Tasks", exact: true }).click();
      await page.getByRole("button", { name: "New Task", exact: true }).last().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "editable markdown" }).fill(prompt(nonce, workload.prelude));
      await expect(dialog.getByRole("button", { name: "Select assignee" })).toContainText(agents[0].name);
      await dialog.getByRole("button", { name: "Create task", exact: true }).click();
      let issue: any;
      await expect.poll(async () => {
        issue = (await json(await request.get(`/api/companies/${company.id}/issues`))).find((item: { id: string; description?: string }) => !before.has(item.id) && item.description?.includes(nonce));
        return Boolean(issue);
      }).toBe(true);
      const issueIds = [issue.id];
      const issuedTokens = new Map<string, string>([[issue.id, nonce]]);
      for (let index = 1; index < workload.runs; index++) {
        const backgroundToken = randomUUID().replaceAll("-", "");
        const background = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
          title: `Ingestion background ${key} ${index}`, description: prompt(backgroundToken, 0),
          status: "backlog", assigneeAgentId: agents[Math.floor(index / 50)].id,
        } }));
        issueIds.push(background.id);
        issuedTokens.set(background.id, backgroundToken);
      }
      for (let offset = 1; offset < issueIds.length; offset += 10) {
        await Promise.all(issueIds.slice(offset, offset + 10).map(async id => json(await request.patch(`/api/issues/${id}`, { data: { status: "todo" } }))));
      }
      const route = `/${company.issuePrefix}/issues/${issue.identifier}`;
      await page.goto(route);
      await expect.poll(() => pending.get(key)!.size, { timeout: 180_000 }).toBe(workload.runs);
      if (workload.prelude) await expect(page.getByText(`PRELUDE_${nonce}_READY`, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
      const epochMs = Date.now() + 1000;
      const participants = [...pending.get(key)!.keys()];
      for (const response of pending.get(key)!.values()) response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ epochMs }));
      const observed = () => page.evaluate(token => (window as unknown as { nativeIngestionVisible: Visible[] }).nativeIngestionVisible.filter(item => item.nonce === token), nonce);
      await expect.poll(async () => (await observed()).length, { timeout: 120_000 }).toBeGreaterThanOrEqual(stop ? 3 : workload.events);
      let stopRequestedAt: number | undefined;
      if (stop) {
        const button = page.getByRole("button", { name: "Stop", exact: true });
        await expect(button).toBeVisible();
        stopRequestedAt = Date.now();
        await button.click();
      }
      let runs: any[] = [];
      await expect.poll(async () => {
        runs = (await json(await request.get(`/api/companies/${company.id}/heartbeat-runs?limit=1000`))).filter((run: { issueId?: string; nativeIssueId?: string; contextSnapshot?: { issueId?: string; taskId?: string } }) => issueIds.includes(run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId));
        return runs.length === issueIds.length && runs.every(run => ["succeeded", "cancelled", "failed"].includes(run.status));
      }, { timeout: 180_000 }).toBe(true);
      const settledAt = Date.now(), visible = await observed();
      const details = [];
      for (const run of runs) details.push(await json(await request.get(`/api/heartbeat-runs/${run.id}`)));
      runs = details;
      expect(runs.every(run => run.runtimeMode === "native")).toBe(true);
      expect(runs.every(run => run.status === (stop ? "cancelled" : "succeeded"))).toBe(true);
      if (stop) await expect.poll(async () =>
        (await json(await request.get(`/api/heartbeat-runs/${runs[0].id}`))).resultJson?.nativeCancellation?.dispatchState,
      { timeout: 30_000 }).toBe("acknowledged");
      const acknowledgedAt = stop ? Date.now() : undefined;
      if (!stop) expect(new Set(visible.map(item => item.index)).size).toBe(workload.events);
      const result = { ...workload, stop, nonce, runIds: runs.map(run => run.id), participants: participants.length, visible,
        firstVisibleAfterEmissionMs: visible[0].visibleMs - visible[0].emittedMs,
        emissionToVisible: stats(visible.map(item => item.visibleMs - item.emittedMs)),
        intendedToVisible: stats(visible.map(item => item.visibleMs - item.intendedMs)),
        providerLateness: stats(visible.map(item => item.emittedMs - item.intendedMs)),
        drainThroughTerminalMs: settledAt - epochMs,
        ...(stopRequestedAt === undefined ? {} : { stopThroughTerminalMs: settledAt - stopRequestedAt,
          stopThroughAcknowledgementMs: acknowledgedAt! - stopRequestedAt }) };
      await page.screenshot({ path: info.outputPath(`${workload.name}${stop ? "-stop" : ""}.png`), fullPage: true });
      await page.reload();
      if (!stop) await expect(page.getByText(`INGEST_${nonce}_${workload.events - 1}_`, { exact: false }).first()).toBeVisible();
      else await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      const comments = await json(await request.get(`/api/issues/${issue.id}/comments`));
      if (!stop) expect(JSON.stringify(comments)).toContain(`INGEST_${nonce}_${workload.events - 1}_`);
      else {
        const lastVisible = visible.at(-1)!;
        await expect(page.getByText(`INGEST_${nonce}_${lastVisible.index}_`, { exact: false }).first()).toBeVisible();
      }
      const durable = [];
      for (const run of runs) {
        const taskId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
        const token = issuedTokens.get(taskId)!;
        expect(token).toBeTruthy();
        const deltas: Array<{ index: number; identity: string }> = [];
        let afterSeq = 0;
        while (true) {
          const rows = await json(await request.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`));
          if (!rows.length) break;
          for (const row of rows) {
            const event = row.payload?.prpEvent;
            if (event?.eventType !== "item.delta") continue;
            for (const match of String(event.payload?.text ?? "").matchAll(new RegExp(`INGEST_${token}_(\\d+)_(\\d+)_(\\d+)`, "g"))) {
              deltas.push({ index: Number(match[1]), identity: `${event.sourceInstanceId}:${event.sourceEventId}:${event.sourceSeq}` });
            }
          }
          const next = Math.max(...rows.map((row: { seq: number }) => row.seq));
          expect(next).toBeGreaterThan(afterSeq); afterSeq = next;
        }
        expect(new Set(deltas.map(item => item.identity)).size).toBe(deltas.length);
        expect(deltas.map(item => item.index)).toEqual(Array.from({ length: stop ? deltas.length : workload.events }, (_, index) => index));
        if (stop) for (const item of visible) expect(deltas.some(delta => delta.index === item.index)).toBe(true);
        durable.push({ runId: run.id, token, individualDeltas: deltas.length, uniqueSourceIdentities: deltas.length, ordered: true });
      }
      (report.cases as unknown[]).push({ ...result, durable, persistedAfterReload: true });
      await info.attach(`${workload.name}${stop ? "-stop" : ""}-metrics`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
      pending.delete(key);
    }
    for (const workload of cases) await perform(workload);
    await perform({ name: "operator-stop", runs: 1, events: 512, intervalMs: 100, prelude: 0 }, true);
    report.complete = true;
  } finally {
    await info.attach("native-ingestion-evidence", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    for (const requests of pending.values()) for (const response of requests.values()) response.writeHead(503).end();
    gate.closeAllConnections();
    await new Promise<void>(resolve => gate.close(() => resolve()));
    const live = await json(await request.get(`/api/companies/${company.id}/live-runs`)).catch(() => []);
    for (const run of live) await request.post(`/api/heartbeat-runs/${run.id}/cancel`);
    await request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: original.enableNativeRunner,
      enableWorktreeRunExecution: original.enableWorktreeRunExecution } });
  }
});
