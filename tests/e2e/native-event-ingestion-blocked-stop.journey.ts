import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Request } from "@playwright/test";
import { json } from "./agent-chat.shared";
import { runtimeAuthority, processAbsent } from "./fixtures/native-ingestion-blocked-stop-authority";
import { openClock } from "./fixtures/native-ingestion-blocked-stop-clock";
import { ownedDatabase, cancellationSnapshot, blockers } from "./fixtures/native-ingestion-blocked-stop-db";
import { PROTOCOL, WORKLOAD as W, WORKLOAD_SHA256, assertHeldSample, assertIntentAudit, isAppendLockQuery, metrics, assertFunctional, cleanupOwnedRunBeforeClockClose }
  from "./fixtures/native-ingestion-blocked-stop-protocol.mjs";
import { observeRunSettlement } from "./fixtures/native-ingestion-h5.mjs";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const birth = (pid: number) => {
  const value = execFileSync("ps", ["-p", String(pid), "-o", "pid=,pgid=,lstart="], { encoding: "utf8" }).trim();
  const match = value.match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match || Number(match[1]) !== pid) throw new Error("Missing exact owned process birth identity");
  return { pid, group: Number(match[2]), birth: match[3] };
};

test("existing-history Stop preserves its durable barrier behind a real blocked append", async ({ page, request }, info) => {
  const appRoot = path.resolve(process.env.PAPERCLIP_INGESTION_APP_ROOT ?? "");
  expect(process.env.PAPERCLIP_INGESTION_SERVER_ARTIFACT).toBe("compiled");
  expect(process.env.PAPERCLIP_INGESTION_COMPANION_PROTOCOL).toBe(PROTOCOL);
  const report: any = { protocol: PROTOCOL, workload: W, workloadSha256: WORKLOAD_SHA256, complete: false,
    variant: process.env.PAPERCLIP_INGESTION_VARIANT, startedAtMs: Date.now(), timing: {}, heldSamples: [], observerSamples: [],
    observedClock: "Independent observer wall clock; PostgreSQL row recordedAt is not a commit timestamp",
    measurement: { pollIntervalMs: W.pollIntervalMs, releaseOrigin: "Owned COMMIT response acknowledgement",
      releaseCommitBracket: "releaseRequestedAtMs..releaseCommitAckAtMs; exact server commit instant is unknown",
      absenceAndAckUncertainty: "Last unsuccessful observation through successful query/process observation; polling plus query duration",
      actionToAckIncludesForcedWait: true, noUniversalClickAckDeadline: true,
      recording: { trace: info.project.use.trace, video: info.project.use.video }, quantitativeAcceptance: "Requires separately frozen companion A/A and five paired arms per comparison" } };
  const clock = await openClock(page);
  const company = await json(await request.post("/api/companies", { data: { name: `Blocked Stop ${Date.now()}` } }));
  report.companyId = company.id;
  const original = await json(await request.get("/api/instance/settings/experimental"));
  let holder: any, observer: any, held = false, companyRunId: string | undefined;
  let stopRequest: Request | undefined, stopSettled = false;
  const nonce = randomUUID().replaceAll("-", ""), key = randomUUID().replaceAll("-", ""), code = clock.nextMarkerCode();
  const stopFinished = (req: Request) => {
    if (req === stopRequest) { stopSettled = true; report.timing.httpSettledAtMs = Date.now(); }
  };
  page.on("requestfinished", stopFinished);
  page.on("requestfailed", stopFinished);
  try {
    const files = ["native-event-ingestion-blocked-stop.journey.ts", "playwright-native-ingestion-blocked-stop.config.ts",
      "fixtures/native-ingestion-blocked-stop-authority.ts", "fixtures/native-ingestion-blocked-stop-clock.ts",
      "fixtures/native-ingestion-blocked-stop-db.ts", "fixtures/native-ingestion-blocked-stop-protocol.mjs",
      "native-event-ingestion.journey.ts", "playwright-native-ingestion.config.ts", "fixtures/in-feed-codex.mjs",
      "fixtures/native-ingestion-bin/codex", "fixtures/composer-stop-codex-loader.mjs", "fixtures/native-ingestion-bootstrap.mjs",
      "fixtures/native-ingestion-remote-server.mjs", "fixtures/native-ingestion-protocol-qualification.mjs", "fixtures/native-ingestion-h5.mjs"];
    report.sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
      createHash("sha256").update(await readFile(path.join(import.meta.dirname, file))).digest("hex")])));
    const harnessRoot = path.resolve(import.meta.dirname, "../..");
    report.harnessProvenance = {
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: harnessRoot, encoding: "utf8" }).trim(),
      sourceStatus: execFileSync("git", ["status", "--porcelain", "--", "tests/e2e"], { cwd: harnessRoot, encoding: "utf8" }).trim(),
      driverLockSha256: createHash("sha256").update(await readFile(path.join(harnessRoot, "pnpm-lock.yaml"))).digest("hex"),
      inheritedH5cRevision: "e431ec63d41fe90c6fd68bd2fc2bb969feeca917",
    };
    report.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }).trim();
    report.buildInfo = JSON.parse(await readFile(path.join(appRoot, "server/dist/build-info.json"), "utf8"));
    expect(report.buildInfo.commit).toBe(report.sourceRevision);
    report.serverEntrySha256 = createHash("sha256").update(await readFile(path.join(appRoot, "server/dist/index.js"))).digest("hex");
    report.health = await json(await request.get("/api/health"));
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: true, enableWorktreeRunExecution: true } }));
    await json(await request.post(`/api/companies/${company.id}/user-secret-definitions`, { data: { key: "OPENAI_API_KEY", name: "Fixture credential" } }));
    await json(await request.post(`/api/companies/${company.id}/me/user-secrets`, { data: { definitionKey: "OPENAI_API_KEY", value: "not-a-real-model-key" } }));
    const environments = await json(await request.get(`/api/companies/${company.id}/environments?driver=local`));
    expect(environments).toHaveLength(1);
    const environment = environments[0]; expect(environment.driver).toBe("local");
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { timeout: 120_000, data: {
      name: "Blocked Stop local control", role: "engineer", adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
      adapterConfig: { provider: "codex", model: "gpt-5.1-codex-mini", env: {
        OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", version: "latest", required: true } } },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 50 } },
    } }));
    await expect.poll(async () => (await json(await request.get(`/api/agents/${agent.id}`))).lifecycleState,
      { timeout: 60_000 }).toBe("ready");
    report.setup = { environmentId: environment.id, agentId: agent.id,
      selection: "Normal local environment and control agent; existing deterministic Codex leaf command; no resolver override" };
    const text = ".".repeat(W.prelude - 1) + ` PRELUDE_${nonce}_READY `
      + Array.from({ length: W.events }, (_, index) => `[${code}${index.toString(36)}] `).join("");
    expect([...text].length).toBeLessThan(4000);
    const state = { events: W.events, intervalMs: W.intervalMs, streams: new Map(), errors: [] } as any;
    state.streams.set(nonce, { nonce, markerCode: code, opened: false, hello: false, ended: false, aborted: false,
      partialBytes: 0, records: new Map(), expectedLauncher: "host-local" });
    clock.clocks.set(key, state); clock.pending.set(key, new Map());
    const prompt = `Measure native streaming for ${nonce.slice(0, 8)}.\n\nINGESTION_PERF nonce=${nonce} events=${W.events} intervalMs=${W.intervalMs} prelude=${W.prelude} markerCode=${code} gate=${clock.base}${key}`;
    const before = new Set((await json(await request.get(`/api/companies/${company.id}/issues`))).map((row: any) => row.id));
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}/overview`);
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await page.getByRole("button", { name: "New Task", exact: true }).last().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "editable markdown" }).fill(prompt);
    await dialog.getByRole("button", { name: "Select assignee", exact: true }).click();
    await page.getByRole("listbox", { name: "Assignees", exact: true }).getByRole("option")
      .filter({ has: page.getByText(agent.name, { exact: true }) }).click();
    await expect(dialog.getByRole("button", { name: "Select assignee" })).toContainText(agent.name);
    report.setup.taskCreateActionAtMs = Date.now();
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    let issue: any;
    await expect.poll(async () => {
      issue = (await json(await request.get(`/api/companies/${company.id}/issues`)))
        .find((row: any) => !before.has(row.id) && row.description?.includes(nonce)); return Boolean(issue);
    }).toBe(true);
    report.issueId = issue.id;
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    await expect.poll(() => clock.pending.get(key)!.has(nonce) && state.streams.get(nonce).hello,
      { timeout: W.readinessMs, intervals: [W.pollIntervalMs] }).toBe(true);
    await expect(page.getByText(`PRELUDE_${nonce}_READY`, { exact: false }).first()).toBeVisible({ timeout: W.streamMs });
    let run: any;
    await expect.poll(async () => {
      run = (await json(await request.get(`/api/companies/${company.id}/heartbeat-runs?limit=1000`)))
        .find((row: any) => (row.issueId ?? row.nativeIssueId ?? row.contextSnapshot?.issueId ?? row.contextSnapshot?.taskId) === issue.id);
      return Boolean(run);
    }).toBe(true);
    companyRunId = run.id; report.runId = run.id;
    const readEvents = async () => {
      const result: any[] = []; let afterSeq = 0;
      for (;;) {
        const rows = await json(await request.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`));
        if (!rows.length) return result;
        result.push(...rows);
        const next = Math.max(...rows.map((row: any) => row.seq)); expect(next).toBeGreaterThan(afterSeq); afterSeq = next;
      }
    };
    const prelude = (await readEvents()).map(row => row.payload?.prpEvent)
      .filter(event => event?.eventType === "item.delta" && String(event.itemId).startsWith("prelude-"));
    expect(prelude).toHaveLength(W.prelude);
    prelude.forEach((event, index) => {
      expect(event.payload.text).toBe(index === W.prelude - 1 ? ` PRELUDE_${nonce}_READY ` : ".");
      expect(event.sourceInstanceId).toBeTruthy(); expect(event.sourceEventId).toBeTruthy();
      expect(Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > 0).toBe(true);
    });
    expect(new Set(prelude.map(event => `${event.sourceInstanceId}:${event.sourceEventId}:${event.sourceSeq}`)).size).toBe(W.prelude);
    report.prelude = { individualDeltas: prelude.length, uniqueIdentities: prelude.length, verifiedBeforeEpochAtMs: Date.now(),
      method: "Normal event API read of actual emitted and committed deltas; no outcome prepopulation" };
    const authority = await runtimeAuthority({ appRoot, companyId: company.id, environmentId: environment.id,
      issueIds: [issue.id], transport: "local" });
    const row = authority.rows[0], stream = state.streams.get(nonce);
    expect(row.run_id).toBe(run.id);
    expect(row.process_identity.processPid).toBe(row.process_pid);
    expect(row.process_identity.processGroupId).toBe(row.process_group_id);
    const provider = birth(stream.providerPid);
    const processes = { runner: birth(row.process_pid), provider, group: row.process_group_id, providerGroup: provider.group };
    expect(processes.runner.group).toBe(processes.group);
    expect(Number.isSafeInteger(processes.providerGroup) && processes.providerGroup > 1).toBe(true);
    const alive = () => !processAbsent(processes.runner.pid) && !processAbsent(-processes.group)
      && !processAbsent(processes.provider.pid) && !processAbsent(-processes.providerGroup);
    expect(alive()).toBe(true); report.authorityBefore = authority; report.processesBefore = processes;
    state.epochMs = Date.now() + 1000; report.epochMs = state.epochMs;
    clock.pending.get(key)!.get(nonce)!.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ epochMs: state.epochMs }));
    const visible = () => page.evaluate(markerCode => (window as any).nativeIngestionVisible.filter((item: any) => item.markerCode === markerCode), code);
    await expect.poll(async () => (await visible()).length, { timeout: W.streamMs }).toBeGreaterThanOrEqual(W.visibleBeforeLock);
    report.visibleBeforeLock = await visible();
    holder = await ownedDatabase(appRoot, "blocked_stop_owned_lock");
    observer = await ownedDatabase(appRoot, "blocked_stop_independent_observer");
    await holder.unsafe("BEGIN"); held = true;
    const owned = await holder`select id, company_id, pg_backend_pid() as holder_pid from heartbeat_runs
      where company_id = ${company.id} and id = ${run.id} for update`;
    expect(owned).toHaveLength(1); const holderPid = owned[0].holder_pid;
    report.lock = { ...owned[0], acquiredAtMs: Date.now(), scope: "One owned company/run row; no persisted mutation" };
    await expect.poll(async () => {
      const rows = await blockers(observer, holderPid);
      report.appendBlockedBeforeStop = { observedAtMs: Date.now(), rows };
      return rows.some((candidate: any) => isAppendLockQuery(candidate.query));
    }, { timeout: 10_000, intervals: [W.pollIntervalMs] }).toBe(true);
    const button = page.getByRole("button", { name: "Stop", exact: true }); await expect(button).toBeVisible();
    const stop = page.waitForRequest(req => {
      const matched = req.method() === "POST" && new URL(req.url()).pathname === `/api/heartbeat-runs/${run.id}/cancel`;
      if (matched) report.timing.requestAtMs = Date.now();
      return matched;
    });
    report.timing.actionAtMs = Date.now();
    const click = button.click();
    stopRequest = await stop; await click;
    const emissionsAtRequest = stream.records.size;
    do {
      const snapshot = await cancellationSnapshot(observer, company.id, run.id);
      const sample = { ...snapshot, httpPending: !stopSettled, auditIds: snapshot.audits.map((audit: any) => audit.id),
        processesAlive: alive(), processes: { runner: birth(processes.runner.pid), provider: birth(processes.provider.pid),
          group: processes.group, providerGroup: processes.providerGroup,
          runnerGroupAlive: !processAbsent(-processes.group), providerGroupAlive: !processAbsent(-processes.providerGroup) },
        clockOpen: !stream.ended && !stream.aborted,
        emittedCount: stream.records.size, blockers: await blockers(observer, holderPid) };
      report.heldSamples.push(sample); assertHeldSample(sample, holderPid, processes);
      if (Date.now() >= report.timing.requestAtMs + W.heldAfterActualRequestMs) break;
      await delay(Math.min(W.pollIntervalMs, report.timing.requestAtMs + W.heldAfterActualRequestMs - Date.now()));
    } while (true);
    expect(stream.records.size, "Real provider continues emitting while transcript writes and Stop await the run lock").toBeGreaterThan(emissionsAtRequest);
    report.timing.releaseRequestedAtMs = Date.now();
    await holder.unsafe("COMMIT"); held = false; report.timing.releaseCommitAckAtMs = Date.now();
    let acknowledged = false, absent = false;
    const observationStartedAtMs = Date.now();
    const observe = async () => {
      const snapshot = await cancellationSnapshot(observer, company.id, run.id);
      if (snapshot.intent) { assertIntentAudit(snapshot); report.intentObserved ??= snapshot; }
      if (!acknowledged) {
        const value = snapshot.intent?.dispatchState === "acknowledged";
        report.observerSamples.push({ kind: "ack-query", startedAtMs: snapshot.queryStartedAtMs,
          completedAtMs: snapshot.observedAtMs, durationMs: snapshot.observedAtMs - snapshot.queryStartedAtMs, value });
        if (value) {
          assertIntentAudit(snapshot); acknowledged = true; report.timing.ackObservedAtMs = snapshot.observedAtMs;
          report.ack = snapshot; report.timing.ackSuccessfulQueryStartedAtMs = snapshot.queryStartedAtMs;
        } else report.timing.lastAckNotObservedAtMs = snapshot.observedAtMs;
      }
      if (!absent) {
        const checkStartedAtMs = Date.now();
        const value = processAbsent(processes.runner.pid) && processAbsent(-processes.group)
          && processAbsent(processes.provider.pid) && processAbsent(-processes.providerGroup);
        const completedAtMs = Date.now();
        report.observerSamples.push({ kind: "process-check", startedAtMs: checkStartedAtMs,
          completedAtMs, durationMs: completedAtMs - checkStartedAtMs, value });
        if (value) {
          absent = true; report.timing.absenceObservedAtMs = completedAtMs;
          report.timing.absenceSuccessfulCheckStartedAtMs = checkStartedAtMs;
          report.processesAfter = { runnerAbsent: true, groupAbsent: true, providerAbsent: true, providerGroupAbsent: true,
            group: processes.group, providerGroup: processes.providerGroup, checkedAtMs: completedAtMs };
        } else report.timing.lastProcessesPresentAtMs = completedAtMs;
      }
    };
    await observe();
    const settlement = await observeRunSettlement({ expectedRuns: 1,
      readRuns: async () => { await observe(); return [await json(await request.get(`/api/heartbeat-runs/${run.id}`))]; },
      readRun: async () => json(await request.get(`/api/heartbeat-runs/${run.id}`)),
      poll: (read: () => Promise<boolean>, timeout: number) => expect.poll(read, { timeout, intervals: [W.pollIntervalMs] }).toBe(true),
      onOutcome: (outcome: unknown) => { report.settlement = outcome; } });
    expect(settlement.runs[0].status).toBe("cancelled"); report.settledAtMs = Date.now();
    const sharedDetail = await json(await request.get(`/api/heartbeat-runs/${run.id}`));
    report.sharedSettlement = { runId: sharedDetail.id, companyId: sharedDetail.companyId, status: sharedDetail.status,
      cancellation: sharedDetail.resultJson?.cancellation ?? null,
      executionCancellation: sharedDetail.resultJson?.executionCancellation ?? null,
      nativeCancellation: sharedDetail.resultJson?.nativeCancellation ?? null, observedAtMs: Date.now() };
    await expect.poll(async () => { await observe(); return acknowledged; },
      { timeout: W.acknowledgementAfterSettlementMs, intervals: [W.pollIntervalMs] }).toBe(true);
    await expect.poll(async () => { await observe(); return absent; },
      { timeout: W.acknowledgementAfterSettlementMs, intervals: [W.pollIntervalMs] }).toBe(true);
    report.timing.postReleaseObservationStartedAtMs = observationStartedAtMs;
    await expect.poll(() => stopSettled, { timeout: W.acknowledgementAfterSettlementMs,
      intervals: [W.pollIntervalMs] }).toBe(true);
    const response = await stopRequest.response(); expect(response?.ok()).toBe(true); report.stopHttpStatus = response!.status();
    report.authorityAfter = await runtimeAuthority({ appRoot, companyId: company.id, environmentId: environment.id,
      issueIds: [issue.id], transport: "local", afterStop: true });
    const stopped = report.authorityAfter.rows[0];
    expect(stopped.status).toBe("cancelled"); expect(stopped.cancellation_dispatch_state).toBe("acknowledged");
    expect(BigInt(stopped.process_stopped_seq)).toBeGreaterThan(BigInt(row.process_identity_seq));
    expect(stopped.process_stopped_source_event_id).toBeNull();
    expect(stopped.process_stopped.processPid).toBe(processes.runner.pid);
    expect(stopped.process_stopped.processGroupId).toBe(processes.group);
    let lease: any;
    await expect.poll(async () => {
      lease = (await json(await request.get(`/api/environments/${environment.id}/leases`)))
        .find((candidate: any) => candidate.heartbeatRunId === run.id);
      return Boolean(lease?.releasedAt && ["released", "expired", "failed"].includes(lease.status) && lease.cleanupStatus !== "failed");
    }, { timeout: W.leaseAfterSettlementMs }).toBe(true);
    expect(lease.provider).toBe("local"); expect(lease.providerLeaseId).toBeNull();
    report.lease = lease;
    const seen = await visible(), events = await readEvents();
    const deltas = events.map(event => event.payload?.prpEvent).filter(event => event?.eventType === "item.delta"
      && String(event.payload?.text).startsWith(`[${code}`));
    expect(deltas.length).toBeGreaterThanOrEqual(W.visibleBeforeLock);
    deltas.forEach((event, index) => {
      expect(event.payload.text).toBe(`[${code}${index.toString(36)}] `); expect(event.runId).toBe(run.id);
      expect(event.sourceInstanceId).toBeTruthy(); expect(event.sourceEventId).toBeTruthy();
      expect(Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > 0).toBe(true);
      expect(stream.records.has(index)).toBe(true);
    });
    expect(new Set(deltas.map(event => `${event.sourceInstanceId}:${event.sourceEventId}:${event.sourceSeq}`)).size).toBe(deltas.length);
    seen.forEach((marker: any) => expect(marker.index).toBeLessThan(deltas.length));
    expect(events.filter(event => event.eventType === "run.result.accepted" || event.payload?.prpEvent?.eventType === "run.result.accepted")).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("blocked-stop-existing-history.png"), fullPage: true });
    await page.reload();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(page.getByText(`[${code}${seen.at(-1).index.toString(36)}]`, { exact: false }).first()).toBeVisible();
    const transcriptRows = (rows: any[]) => rows.filter(row => row.payload?.prpEvent?.eventType === "item.delta")
      .map(row => ({ id: row.id, seq: row.seq, event: row.payload.prpEvent }));
    expect(transcriptRows(await readEvents())).toEqual(transcriptRows(events));
    await expect.poll(() => stream.ended || stream.aborted, { timeout: 30_000 }).toBe(true);
    expect(state.errors).toEqual([]);
    report.transcript = { individualDeltas: deltas.length, uniqueSourceIdentities: deltas.length, ordered: true,
      persistedAfterReload: true, resultAcceptedEvents: 0, seen, deltas, preludeCount: prelude.length };
    report.clock = { ...stream, records: [...stream.records.values()] };
    report.complete = true;
  } catch (error) {
    report.failure = { message: String(error), stack: error instanceof Error ? error.stack : undefined, atMs: Date.now() };
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (step: string, action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { cleanupErrors.push({ step, error: String(error) }); }
    };
    // Always release our exact owned lock before invoking any public cancellation cleanup.
    if (held) await cleanup("rollback-owned-lock", async () => { await holder.unsafe("ROLLBACK"); held = false; });
    if (holder) await cleanup("close-holder", () => holder.end({ timeout: 5 }));
    if (observer) await cleanup("close-observer", () => observer.end({ timeout: 5 }));
    report.cleanupSettlement = {};
    await cleanup("settle-owned-run-before-clock-close", () => cleanupOwnedRunBeforeClockClose({
      companyId: company.id, runId: companyRunId,
      readRun: companyRunId ? async () => json(await request.get(`/api/heartbeat-runs/${companyRunId}`)) : undefined,
      cancelRun: async () => { const response = await request.post(`/api/heartbeat-runs/${companyRunId}/cancel`);
        return { status: response.status(), run: await json(response) }; },
      closeClock: async () => {
        for (const pending of clock.pending.values()) for (const response of pending.values()) if (!response.writableEnded) response.writeHead(503).end();
        clock.gate.closeAllConnections(); await new Promise<void>(resolve => clock.gate.close(() => resolve()));
      }, record: report.cleanupSettlement,
    }));
    await cleanup("restore-experimental-settings", async () => json(await request.patch("/api/instance/settings/experimental", {
      data: { enableNativeRunner: original.enableNativeRunner, enableWorktreeRunExecution: original.enableWorktreeRunExecution } })));
    report.cleanup = { complete: cleanupErrors.length === 0, errors: cleanupErrors };
    report.complete &&= report.cleanup.complete; report.finishedAtMs = Date.now();
    let validationError: unknown;
    if (report.complete) {
      try { report.metrics = metrics(report); assertFunctional(report); }
      catch (error) { validationError = error; report.complete = false; report.validationFailure = String(error); }
    }
    await info.attach("native-ingestion-blocked-stop-evidence", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    if (validationError) throw validationError;
    if (!report.failure) expect(cleanupErrors).toEqual([]);
    page.off("requestfinished", stopFinished); page.off("requestfailed", stopFinished);
  }
});
