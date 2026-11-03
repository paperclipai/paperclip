import { createServer, type ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

type SeenMarker = { markerCode: string; index: number; visibleMs: number };
type Emission = { nonce: string; markerCode: string; index: number; intendedMs: number; emittedMs: number; receivedAtMs: number };
type Visible = SeenMarker & Emission;
type ClockStream = { nonce: string; markerCode: string; opened: boolean; hello: boolean; ended: boolean; aborted: boolean;
  partialBytes: number; records: Map<number, Emission>; error?: string };
type ClockCase = { events: number; intervalMs: number; epochMs?: number; streams: Map<string, ClockStream>; errors: string[] };
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
  const clocks = new Map<string, ClockCase>();
  let markerCounter = 0;
  const nextMarkerCode = () => {
    expect(markerCounter).toBeLessThan(36 ** 2);
    return (markerCounter++).toString(36).padStart(2, "0");
  };
  const gate = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const route = url.pathname.match(/^\/native-ingestion-gate\/([a-f0-9]{32})(\/clock)?$/);
    const key = route?.[1], participant = url.searchParams.get("participant");
    const state = key ? clocks.get(key) : undefined;
    const stream = participant ? state?.streams.get(participant) : undefined;
    if (!key || !participant || !state || !stream) { res.writeHead(404).end(); return; }
    if (!route?.[2] && req.method === "GET") {
      if (pending.get(key)!.has(participant)) { res.writeHead(409).end(); return; }
      pending.get(key)!.set(participant, res);
      res.on("close", () => pending.get(key)?.delete(participant));
      return;
    }
    if (!route?.[2] || req.method !== "POST" || stream.opened) { res.writeHead(409).end(); return; }
    stream.opened = true;
    let buffered = "";
    req.setEncoding("utf8");
    const fail = (message: string) => {
      stream.error = message; state.errors.push(`${participant}: ${message}`);
      if (!res.writableEnded) res.writeHead(400).end();
    };
    const line = (text: string) => {
      const value = JSON.parse(text);
      if (value.nonce !== participant || value.markerCode !== stream.markerCode) throw new Error("Clock identity mismatch");
      if (!stream.hello) {
        if (value.type !== "hello" || value.events !== state.events || value.intervalMs !== state.intervalMs) throw new Error("Clock hello mismatch");
        stream.hello = true; return;
      }
      if (value.type !== "emission" || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= state.events
        || !Number.isSafeInteger(value.intendedMs) || !Number.isSafeInteger(value.emittedMs) || value.emittedMs <= 0
        || value.intendedMs !== state.epochMs! + value.index * state.intervalMs) throw new Error("Invalid original emission clock");
      if (stream.records.has(value.index)) throw new Error("Duplicate or conflicting original emission clock");
      stream.records.set(value.index, { nonce: participant, markerCode: stream.markerCode, index: value.index,
        intendedMs: value.intendedMs, emittedMs: value.emittedMs, receivedAtMs: Date.now() });
    };
    req.on("data", (chunk: string) => {
      if (stream.error) return;
      try {
        buffered += chunk;
        for (;;) {
          const end = buffered.indexOf("\n"); if (end < 0) break;
          const text = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (text.length > 1024) throw new Error("Clock record exceeds bounded metadata size");
          if (text) line(text);
        }
        if (buffered.length > 1024) throw new Error("Clock record exceeds bounded metadata size");
      } catch (error) { fail(String(error)); }
    });
    req.on("end", () => {
      stream.ended = true; stream.partialBytes = Buffer.byteLength(buffered);
      if (buffered.length) fail("Clock stream ended with a partial record");
      if (!stream.error && !res.writableEnded) res.writeHead(200).end();
    });
    req.on("aborted", () => { stream.aborted = true; stream.partialBytes = Buffer.byteLength(buffered); });
    req.on("error", error => { if (!stream.aborted) fail(String(error)); });
  });
  await new Promise<void>(resolve => gate.listen(0, "127.0.0.1", resolve));
  const address = gate.address();
  if (!address || typeof address === "string") throw new Error("Local ingestion gate failed");
  const base = `http://127.0.0.1:${address.port}/native-ingestion-gate/`;
  await page.addInitScript(() => {
    const seen = new Set<string>(), visible: SeenMarker[] = [];
    Object.assign(window, { nativeIngestionVisible: visible });
    let scheduled = false, dirty = false;
    const snapshot = () => {
      const text = document.body?.innerText ?? "";
      const pattern = /\[([a-z0-9]{2})([a-z0-9]{1,3})\]/g;
      const entries: Omit<SeenMarker, "visibleMs">[] = [];
      for (const match of text.matchAll(pattern)) {
        const index = Number.parseInt(match[2], 36);
        const key = `${match[1]}:${index}`;
        if (seen.has(key)) continue;
        entries.push({ markerCode: match[1], index });
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
            const key = `${entry.markerCode}:${entry.index}`;
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
  const captureMode = (value: unknown) => typeof value === "string" ? value
    : value && typeof value === "object" && "mode" in value ? String(value.mode) : "off";
  const browserRecording = { trace: captureMode(info.project.use.trace), video: captureMode(info.project.use.video),
    screencast: captureMode(info.project.use.trace) !== "off" || captureMode(info.project.use.video) !== "off" };
  const report: Record<string, unknown> = {
    protocolVersion: "v2-compact-markers-original-clock-stream",
    dependency: "Deterministic Codex app-server fixture; real application/runtime/port/PostgreSQL/live WebSocket/shipped UI",
    variant: process.env.PAPERCLIP_INGESTION_VARIANT ?? "unlabelled", qualificationOnly: smoke,
    diagnosticOnly: Boolean(process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR),
    performanceAcceptanceEligible: !process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR && !browserRecording.screencast,
    browserRecording,
    startedAtMs: Date.now(),
    emittedClock: "Original provider-process clocks on one pre-opened streamed HTTP channel per provider; no per-token request or flush wait",
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
  const protocolSources = await Promise.all(protocolFiles.map(async file => ({ file, bytes: await readFile(path.resolve(import.meta.dirname, file)) })));
  report.measurementSha256 = createHash("sha256").update(Buffer.concat(protocolSources.map(source => source.bytes))).digest("hex");
  const harnessRoot = path.resolve(import.meta.dirname, "../..");
  report.harnessProvenance = {
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: harnessRoot, encoding: "utf8" }).trim(),
    sourceStatus: execFileSync("git", ["status", "--porcelain", "--", "tests/e2e"], { cwd: harnessRoot, encoding: "utf8" }).trim(),
    sourceHashes: Object.fromEntries(protocolSources.map(source => [source.file, createHash("sha256").update(source.bytes).digest("hex")])),
    driverDependencySource: process.env.PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES ?? "Checkout tooling dependencies",
    driverLockSha256: createHash("sha256").update(await readFile(path.join(harnessRoot, "pnpm-lock.yaml"))).digest("hex"),
    scope: "Separate browser harness and driver-only tooling; every measured app uses its own frozen clean source and matching compiled stamp",
  };
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
      const markerCode = nextMarkerCode();
      pending.set(key, new Map());
      const state: ClockCase = { events: workload.events, intervalMs: workload.intervalMs, streams: new Map(), errors: [] };
      clocks.set(key, state);
      const register = (token: string, code: string) => state.streams.set(token, { nonce: token, markerCode: code,
        opened: false, hello: false, ended: false, aborted: false, partialBytes: 0, records: new Map() });
      register(nonce, markerCode);
      const compactOutput = Array.from({ length: workload.events }, (_, index) => `[${markerCode}${index.toString(36)}] `).join("");
      const preludeOutput = workload.prelude ? `${".".repeat(Math.max(0, workload.prelude - 1))} PRELUDE_${nonce}_READY ` : "";
      expect([...compactOutput].length, "Full measured completion must fit the unchanged Rust text bound").toBeLessThan(4000);
      expect([...preludeOutput + compactOutput].length, "Prelude and measured text must remain below that bound").toBeLessThan(4000);
      const active: Record<string, unknown> = { ...workload, stop, nonce, markerCode, phase: "setup", key };
      report.activeCase = active;
      const prompt = (token: string, code: string, prelude: number) => `Measure native streaming for ${token.slice(0, 8)}.\n\nINGESTION_PERF nonce=${token} events=${workload.events} intervalMs=${workload.intervalMs} prelude=${prelude} markerCode=${code} gate=${base}${key}`;
      const before = new Set((await json(await request.get(`/api/companies/${company.id}/issues`))).map((issue: { id: string }) => issue.id));
      await page.goto(`/${company.issuePrefix}/agents/${agents[0].id}/overview`);
      await page.getByRole("link", { name: "Tasks", exact: true }).click();
      await page.getByRole("button", { name: "New Task", exact: true }).last().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "editable markdown" }).fill(prompt(nonce, markerCode, workload.prelude));
      await expect(dialog.getByRole("button", { name: "Select assignee" })).toContainText(agents[0].name);
      await dialog.getByRole("button", { name: "Create task", exact: true }).click();
      let issue: any;
      await expect.poll(async () => {
        issue = (await json(await request.get(`/api/companies/${company.id}/issues`))).find((item: { id: string; description?: string }) => !before.has(item.id) && item.description?.includes(nonce));
        return Boolean(issue);
      }).toBe(true);
      const issueIds = [issue.id];
      active.issueIds = issueIds;
      const issuedTokens = new Map<string, string>([[issue.id, nonce]]);
      for (let index = 1; index < workload.runs; index++) {
        const backgroundToken = randomUUID().replaceAll("-", ""), backgroundCode = nextMarkerCode();
        register(backgroundToken, backgroundCode);
        const background = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
          title: `Ingestion background ${key} ${index}`, description: prompt(backgroundToken, backgroundCode, 0),
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
      active.phase = "provider-and-clock-readiness";
      await expect.poll(() => ({ providers: pending.get(key)!.size,
        clocks: [...state.streams.values()].filter(stream => stream.hello).length }),
      { timeout: 180_000 }).toEqual({ providers: workload.runs, clocks: workload.runs });
      let preludeProof: Record<string, unknown> | undefined;
      if (workload.prelude) {
        await expect(page.getByText(`PRELUDE_${nonce}_READY`, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
        active.phase = "independent-prelude-verification";
        const listed = await json(await request.get(`/api/companies/${company.id}/heartbeat-runs?limit=1000`));
        const foreground = listed.find((run: any) => (run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) === issue.id);
        expect(foreground).toBeTruthy();
        const identities = new Set<string>(); let count = 0, afterSeq = 0;
        while (true) {
          const rows = await json(await request.get(`/api/heartbeat-runs/${foreground.id}/events?afterSeq=${afterSeq}&limit=1000`));
          if (!rows.length) break;
          for (const row of rows) {
            const event = row.payload?.prpEvent;
            if (event?.eventType !== "item.delta" || !String(event.itemId ?? "").startsWith("prelude-")) continue;
            expect(event.payload?.text).toBe(count === workload.prelude - 1 ? ` PRELUDE_${nonce}_READY ` : ".");
            count++; identities.add(`${event.sourceInstanceId}:${event.sourceEventId}:${event.sourceSeq}`);
          }
          const next = Math.max(...rows.map((row: { seq: number }) => row.seq));
          expect(next).toBeGreaterThan(afterSeq); afterSeq = next;
        }
        preludeProof = { runId: foreground.id, individualDeltas: count, uniqueSourceIdentities: identities.size,
          retainedGlobalHead: afterSeq, verifiedAtMs: Date.now(), method: "Independent normal event API read before common emission gate release" };
        active.preludeProof = preludeProof;
        expect(count).toBe(workload.prelude); expect(identities.size).toBe(count);
      }
      const epochMs = Date.now() + 1000;
      state.epochMs = epochMs; active.epochMs = epochMs; active.phase = "streaming";
      const participants = [...pending.get(key)!.keys()];
      active.participants = participants;
      for (const response of pending.get(key)!.values()) response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ epochMs }));
      const observed = () => page.evaluate(code => (window as unknown as { nativeIngestionVisible: SeenMarker[] }).nativeIngestionVisible.filter(item => item.markerCode === code), markerCode);
      await expect.poll(async () => (await observed()).length, { timeout: 120_000 }).toBeGreaterThanOrEqual(stop ? 3 : workload.events);
      let stopRequestedAt: number | undefined;
      if (stop) {
        const button = page.getByRole("button", { name: "Stop", exact: true });
        await expect(button).toBeVisible();
        stopRequestedAt = Date.now();
        await button.click();
      }
      active.phase = "terminal-drainage";
      let runs: any[] = [];
      await expect.poll(async () => {
        runs = (await json(await request.get(`/api/companies/${company.id}/heartbeat-runs?limit=1000`))).filter((run: { issueId?: string; nativeIssueId?: string; contextSnapshot?: { issueId?: string; taskId?: string } }) => issueIds.includes(run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId));
        return runs.length === issueIds.length && runs.every(run => ["succeeded", "cancelled", "failed"].includes(run.status));
      }, { timeout: 180_000 }).toBe(true);
      const settledAt = Date.now(), seenMarkers = await observed();
      active.settledAt = settledAt; active.seenMarkers = seenMarkers;
      const details = [];
      for (const run of runs) details.push(await json(await request.get(`/api/heartbeat-runs/${run.id}`)));
      runs = details;
      expect(runs.every(run => run.runtimeMode === "native")).toBe(true);
      expect(runs.every(run => run.status === (stop ? "cancelled" : "succeeded"))).toBe(true);
      if (stop) await expect.poll(async () =>
        (await json(await request.get(`/api/heartbeat-runs/${runs[0].id}`))).resultJson?.nativeCancellation?.dispatchState,
      { timeout: 30_000 }).toBe("acknowledged");
      const acknowledgedAt = stop ? Date.now() : undefined;
      active.phase = "clock-reconciliation";
      await expect.poll(() => [...state.streams.values()].every(stream => !stream.error && (stop
        ? seenMarkers.every(marker => state.streams.get(nonce)!.records.has(marker.index))
        : stream.records.size === workload.events && stream.ended)), { timeout: 30_000 }).toBe(true);
      expect(state.errors).toEqual([]);
      const visible: Visible[] = seenMarkers.map(marker => {
        const original = state.streams.get(nonce)!.records.get(marker.index);
        expect(original, `Missing original provider clock for visible ${marker.markerCode}:${marker.index}`).toBeTruthy();
        return { ...original!, ...marker }; // Keep the original paint timestamp; never restamp after clock arrival.
      });
      if (!stop) expect(new Set(visible.map(item => item.index)).size).toBe(workload.events);
      const clockEvidence: Array<Record<string, unknown>> = [];
      const result = { ...workload, stop, nonce, markerCode, epochMs, preludeProof, clockEvidence, runIds: runs.map(run => run.id), participants: participants.length, visible, matchedVisibleClocks: visible.length,
        firstVisibleAfterEmissionMs: visible[0].visibleMs - visible[0].emittedMs,
        emissionToVisible: stats(visible.map(item => item.visibleMs - item.emittedMs)),
        intendedToVisible: stats(visible.map(item => item.visibleMs - item.intendedMs)),
        providerLateness: stats(visible.map(item => item.emittedMs - item.intendedMs)),
        drainThroughTerminalMs: settledAt - epochMs,
        ...(stopRequestedAt === undefined ? {} : { stopThroughTerminalMs: settledAt - stopRequestedAt,
          stopThroughAcknowledgementMs: acknowledgedAt! - stopRequestedAt }) };
      await page.screenshot({ path: info.outputPath(`${workload.name}${stop ? "-stop" : ""}.png`), fullPage: true });
      await page.reload();
      if (!stop) await expect(page.getByText(`[${markerCode}${(workload.events - 1).toString(36)}]`, { exact: false }).first()).toBeVisible();
      else await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      const comments = await json(await request.get(`/api/issues/${issue.id}/comments`));
      if (!stop) expect(JSON.stringify(comments)).toContain(`[${markerCode}${(workload.events - 1).toString(36)}]`);
      else {
        const lastVisible = visible.at(-1)!;
        await expect(page.getByText(`[${markerCode}${lastVisible.index.toString(36)}]`, { exact: false }).first()).toBeVisible();
      }
      active.phase = "independent-durable-verification";
      const durable = [];
      for (const run of runs) {
        const taskId = run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
        const token = issuedTokens.get(taskId)!;
        const code = state.streams.get(token)!.markerCode;
        expect(token).toBeTruthy();
        const deltas: Array<{ index: number; identity: string }> = [];
        let afterSeq = 0;
        while (true) {
          const rows = await json(await request.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`));
          if (!rows.length) break;
          for (const row of rows) {
            const event = row.payload?.prpEvent;
            if (event?.eventType !== "item.delta") continue;
            for (const match of String(event.payload?.text ?? "").matchAll(new RegExp(`\\[${code}([a-z0-9]{1,3})\\]`, "g"))) {
              const index = Number.parseInt(match[1], 36);
              expect(event.payload.text, "Every durable normalized delta retains its complete compact payload").toBe(`[${code}${index.toString(36)}] `);
              deltas.push({ index, identity: `${event.sourceInstanceId}:${event.sourceEventId}:${event.sourceSeq}` });
            }
          }
          const next = Math.max(...rows.map((row: { seq: number }) => row.seq));
          expect(next).toBeGreaterThan(afterSeq); afterSeq = next;
        }
        active.latestDurableRead = { runId: run.id, nonce: token, markerCode: code, deltas };
        await expect.poll(() => deltas.every(delta => state.streams.get(token)!.records.has(delta.index)), { timeout: 30_000 }).toBe(true);
        for (const delta of deltas) {
          const original = state.streams.get(token)!.records.get(delta.index)!;
          expect({ nonce: original.nonce, markerCode: original.markerCode, index: original.index })
            .toEqual({ nonce: token, markerCode: code, index: delta.index });
        }
        expect(new Set(deltas.map(item => item.identity)).size).toBe(deltas.length);
        expect(deltas.map(item => item.index)).toEqual(Array.from({ length: stop ? deltas.length : workload.events }, (_, index) => index));
        if (stop) for (const item of visible) expect(deltas.some(delta => delta.index === item.index)).toBe(true);
        durable.push({ runId: run.id, token, markerCode: code, individualDeltas: deltas.length, uniqueSourceIdentities: deltas.length, matchedSourceClocks: deltas.length, ordered: true });
      }
      await expect.poll(() => [...state.streams.values()].every(stream => stream.ended || stream.aborted), { timeout: 30_000 }).toBe(true);
      expect(state.errors).toEqual([]);
      expect([...state.streams.values()].every(stream => !stream.error)).toBe(true);
      clockEvidence.push(...[...state.streams.values()].map(stream => ({ nonce: stream.nonce, markerCode: stream.markerCode,
        hello: stream.hello, ended: stream.ended, aborted: stream.aborted, error: stream.error, partialBytes: stream.partialBytes,
        emissions: [...stream.records.values()].sort((a, b) => a.index - b.index) })));
      (report.cases as unknown[]).push({ ...result, durable, persistedAfterReload: true });
      await info.attach(`${workload.name}${stop ? "-stop" : ""}-metrics`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
      pending.delete(key); clocks.delete(key); delete report.activeCase;
    }
    for (const workload of cases) await perform(workload);
    await perform({ name: "operator-stop", runs: 1, events: 512, intervalMs: 100, prelude: 0 }, true);
    report.complete = true;
  } finally {
    if (report.activeCase) {
      const active = report.activeCase as Record<string, unknown>;
      try {
        active.failureBrowser = await page.evaluate(code => ({ capturedAtMs: Date.now(),
          observed: (window as unknown as { nativeIngestionVisible?: SeenMarker[] }).nativeIngestionVisible?.filter(item => item.markerCode === code),
          domTextLength: (document.body?.innerText ?? "").length,
          renderedTexts: [...document.querySelectorAll("[data-conversation-text]")].map(node => ({ kind: node.getAttribute("data-conversation-text"), text: node.textContent })),
          domMarkers: [...(document.body?.innerText ?? "").matchAll(/\[([a-z0-9]{2})([a-z0-9]{1,3})\]/g)]
            .filter(match => match[1] === code).map(match => ({ markerCode: match[1], index: Number.parseInt(match[2], 36) })),
        }), active.markerCode as string);
      } catch (error) { active.captureError = String(error); }
      active.failurePendingProviders = [...(pending.get(active.key as string)?.keys() ?? [])];
      const state = clocks.get(active.key as string);
      active.failureClockEvidence = state && { errors: state.errors, streams: [...state.streams.values()].map(stream => ({
        ...stream, records: [...stream.records.values()],
      })) };
    }
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
