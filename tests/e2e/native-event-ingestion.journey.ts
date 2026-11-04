import { createServer, type ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";
import { h5Enabled, H5_MODE, H5_PROTOCOL, H4D_PROTOCOL, H5_TOPOLOGY, H5_LIMITS, H5_WORKLOAD_SHA256, ORIGINAL_BUDGETS,
  observeStreaming, originalTerminal, prepareParticipantAgents, assertParticipantTopology } from "./fixtures/native-ingestion-h5.mjs";

type SeenMarker = { markerCode: string; index: number; visibleMs: number };
type Emission = { nonce: string; markerCode: string; index: number; intendedMs: number; emittedMs: number; receivedAtMs: number };
type Visible = SeenMarker & Emission;
type ClockStream = { nonce: string; markerCode: string; opened: boolean; hello: boolean; ended: boolean; aborted: boolean;
  partialBytes: number; records: Map<number, Emission>; error?: string;
  expectedLauncher: "host-local" | "staged-remote"; launcher?: string; providerPid?: number;
  providerReadyAtMs?: number; clockHelloAtMs?: number; readinessObservedAtMs?: number };
type ClockCase = { events: number; intervalMs: number; epochMs?: number; streams: Map<string, ClockStream>; errors: string[] };
type Case = { name: string; runs: number; events: number; intervalMs: number; prelude: number };
type SetupActivation = { index: number; issueId: string; token: string; waveIndex: number | null; startedAtMs: number;
  requestSettledAtMs?: number; providerReadyAtMs?: number; clockHelloAtMs?: number; readinessObservedAtMs?: number;
  settledAtMs?: number; status: "pending" | "fulfilled" | "rejected"; failure?: string };
type SetupWave = { index: number; indices: number[]; startedAtMs: number; settledAtMs?: number;
  statuses?: Array<"fulfilled" | "rejected"> };
const smoke = process.env.PAPERCLIP_INGESTION_SMOKE === "1";
const h5 = h5Enabled(process.env.PAPERCLIP_INGESTION_OBSERVATION_MODE);
const transport = process.env.PAPERCLIP_INGESTION_TRANSPORT ?? "sandbox-remote-with-local-stop";
const providerReadinessMs = 300_000;
const setupActivationConcurrency = 2;
const cases: Case[] = smoke ? [{ name: "qualification", runs: 3, events: 16, intervalMs: 25, prelude: 0 }] : [
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

async function runtimeAuthority(input: {
  appRoot: string; companyId: string; environmentId: string; issueIds: string[]; transport: "local" | "sandbox-remote";
  afterStop?: boolean;
}) {
  const configuration = process.env.PAPERCLIP_E2E_SERVER_CONFIG;
  if (!configuration) throw new Error("Missing owned server configuration");
  const config = JSON.parse(await readFile(configuration, "utf8"));
  expect(config.database.mode).toBe("embedded-postgres");
  const dataDirectory = await realpath(config.database.embeddedPostgresDataDir);
  const ownedHome = await realpath(path.resolve(path.dirname(configuration), "../.."));
  expect(dataDirectory.startsWith(`${ownedHome}${path.sep}`)).toBe(true);
  const owner = (await readFile(path.join(dataDirectory, "postmaster.pid"), "utf8")).split(/\r?\n/);
  expect(await realpath(owner[1])).toBe(dataDirectory);
  const port = Number(owner[3]);
  expect(Number.isSafeInteger(port) && port > 0 && port <= 65535).toBe(true);
  const require = createRequire(path.join(input.appRoot, "packages/db/package.json"));
  const postgres = require("postgres");
  const sql = postgres({ host: "127.0.0.1", port, database: "paperclip", username: "paperclip", password: "paperclip",
    max: 1, connect_timeout: 10, connection: { application_name: "native_ingestion_remote_authority_proof" } });
  let proof;
  try {
    proof = await sql.begin("isolation level repeatable read read only", async (tx: any) => {
      const settings = await tx`select current_setting('transaction_read_only') as read_only,
        current_setting('transaction_isolation') as isolation`;
      expect(settings[0].read_only).toBe("on");
      expect(settings[0].isolation).toBe("repeatable read");
      const rows = await tx`select r.id as run_id, r.company_id, r.agent_id, r.native_issue_id as issue_id, r.runtime_mode,
        r.native_session_id, r.runner_instance_id, r.status, r.process_pid, r.process_group_id, r.process_started_at,
        r.runner_profile_json->'nativeExecutionInput'->'binding'->>'executionWorkspaceId' as admitted_execution_workspace_id,
        r.result_json->'nativeCancellation'->>'dispatchState' as cancellation_dispatch_state,
        i.seq as process_identity_seq, i.payload as process_identity, i.source_event_id as process_identity_source_event_id,
        s.seq as process_stopped_seq, s.payload as process_stopped, s.source_event_id as process_stopped_source_event_id,
        l.id as lease_id, l.environment_id, l.provider, l.provider_lease_id,
        c.part as checkpoint_part, octet_length(c.material::text) as checkpoint_header_bytes
        from heartbeat_runs r
        join environment_leases l on l.heartbeat_run_id = r.id and l.company_id = r.company_id
        left join native_runner_checkpoints c on c.run_id = r.id and c.company_id = r.company_id
          and c.issue_id = r.native_issue_id and c.part = 'header'
        left join lateral (select seq, payload, source_event_id from heartbeat_run_events e where e.run_id = r.id
          and e.company_id = r.company_id and e.event_type = 'native.process_identity_recorded'
          and e.source_event_id is null order by seq desc limit 1) i on true
        left join lateral (select seq, payload, source_event_id from heartbeat_run_events e where e.run_id = r.id
          and e.company_id = r.company_id and e.event_type = 'native.local_process_stopped'
          and e.source_event_id is null order by seq desc limit 1) s on true
        where r.company_id = ${input.companyId} and r.native_issue_id = any(${input.issueIds}::uuid[])`;
      expect(rows).toHaveLength(input.issueIds.length);
      expect(new Set(rows.map((row: any) => row.issue_id)).size).toBe(input.issueIds.length);
      for (const row of rows) {
        expect(row.company_id).toBe(input.companyId);
        expect(row.runtime_mode).toBe("native");
        expect(row.environment_id).toBe(input.environmentId);
        if (input.transport === "sandbox-remote") {
          expect(row.provider).toBe("fake-plugin");
          expect(row.provider_lease_id).toMatch(/^fake-plugin:\/\//);
          expect(row.checkpoint_part).toBe("header");
          expect(Number(row.checkpoint_header_bytes)).toBeGreaterThan(0);
        } else {
          expect(row.provider).toBe("local"); expect(row.provider_lease_id).toBeNull();
          expect(row.checkpoint_part, "Local raw transport keeps its existing host-file journal authority").toBeNull();
          expect(row.process_identity?.targetKind).toBe("local"); expect(row.process_identity?.hostname).toBe(hostname());
          expect(row.process_identity_source_event_id).toBeNull();
          expect(BigInt(String(row.process_identity_seq))).toBeGreaterThan(0n);
          expect(row.admitted_execution_workspace_id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
          if (row.process_started_at) expect(row.process_identity.processStartedAt).toBe(new Date(row.process_started_at).toISOString());
        }
      }
      return { kind: input.transport === "local" ? "host-file-journal" : "database-controller-checkpoint",
        checkedBeforeMeasuredEpoch: !input.afterStop, checkedAtMs: Date.now(), transaction: "READ ONLY REPEATABLE READ",
        observedReadOnly: settings[0].read_only, observedIsolation: settings[0].isolation, rows };
    });
  } finally { await sql.end({ timeout: 5 }); }
  const connectionClosedAtMs = Date.now();
  let localJournal;
  if (input.transport === "local" && !input.afterStop) {
    expect(input.issueIds).toHaveLength(1);
    const base = await realpath(path.join(path.dirname(configuration), "runtime/paperclip-runner/durable-sessions"));
    expect(base.startsWith(`${ownedHome}${path.sep}`)).toBe(true);
    const directories = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
    expect(directories.length, "Bound the owned fixture journal metadata search").toBeLessThanOrEqual(256);
    for (const directory of directories) {
      const file = path.join(base, directory.name, "control-plane/control-plane-state.json");
      const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null; throw error;
      });
      if (!metadata) continue;
      expect(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 16 * 1024 * 1024).toBe(true);
      expect((await realpath(file)).startsWith(`${base}${path.sep}`)).toBe(true);
      const bytes = await readFile(file), state = JSON.parse(bytes.toString("utf8"));
      if (state.identity?.runId !== proof!.rows[0].run_id) continue;
      expect(localJournal, "Exactly one owned local journal must match the actual run").toBeUndefined();
      expect(state.schema).toBe("paperclip.runner.durable.control-plane-state.v1");
      expect(state.checkpointEventPolicy).not.toBe("control-v1");
      expect(state.identity.runnerInstanceId).toBe(proof!.rows[0].runner_instance_id);
      expect(state.identity.normalizedSessionId).toBe(proof!.rows[0].native_session_id);
      expect(state.identity.environmentLeaseId).toBe(proof!.rows[0].admitted_execution_workspace_id);
      localJournal = { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
        schema: state.schema, identity: Object.fromEntries(["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"]
          .map(key => [key, state.identity[key]])), checkpointEventPolicy: state.checkpointEventPolicy, checkedAtMs: Date.now() };
    }
    expect(localJournal, "Missing actual owned local raw journal").toBeTruthy();
  }
  return { ...proof, connectionClosedAtMs, localJournal };
}

const processAbsent = (pid: number) => {
  expect(Number.isSafeInteger(pid) && Math.abs(pid) > 1).toBe(true);
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
};

test("native ingestion reaches the shipped UI promptly and survives reload", async ({ page, request }, info) => {
  const bodyStartedAtMs = Date.now();
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
      stream.providerReadyAtMs = Date.now();
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
        if (value.type !== "hello" || value.events !== state.events || value.intervalMs !== state.intervalMs
          || value.launcher !== stream.expectedLauncher || !Number.isSafeInteger(value.providerPid) || value.providerPid <= 1
          || Object.keys(value).sort().join(",") !== "events,intervalMs,launcher,markerCode,nonce,providerPid,type") throw new Error("Clock hello mismatch");
        stream.launcher = value.launcher; stream.providerPid = value.providerPid;
        stream.hello = true; stream.clockHelloAtMs = Date.now(); return;
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
    protocolVersion: h5 ? H5_PROTOCOL : H4D_PROTOCOL, transport, bodyStartedAtMs,
    agentTopology: { ...H5_TOPOLOGY, remoteAgentPoolSize: Math.max(...cases.map(item => item.runs)) },
    ...(h5 ? { observationMode: H5_MODE, workloadSha256: H5_WORKLOAD_SHA256, observationLimits: H5_LIMITS,
      observationComplete: false, actualPlaywrightTimeoutMs: info.timeout,
      originalInvocationBudgetAssessment: "Requires independent owning Playwright observed total duration; conservative original900 assessment, not exact timeout expiration" } : {}),
    transportPolicy: { streaming: "sandbox-remote", operatorStop: "local",
      realCloudStop: "Separate required qualification; fake-plugin void receipts grant no remote Stop authority" },
    resourceBudgets: h5 ? ORIGINAL_BUDGETS : { providerReadinessMs, fullInvocationMs: info.timeout, streamingMs: 120_000,
      terminalDrainageMs: 180_000, stopAcknowledgementMs: 30_000, remoteLeaseCleanupMs: 30_000 },
    admissionProtocol: "two-at-a-time-provider-and-clock-readiness-before-common-epoch",
    setupActivationConcurrency,
    setupReadinessPollingMs: 50,
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
    "fixtures/native-ingestion-bin/codex", "fixtures/composer-stop-codex-loader.mjs", "fixtures/native-ingestion-bootstrap.mjs",
    "fixtures/native-ingestion-remote-server.mjs", "fixtures/native-ingestion-protocol-qualification.mjs",
    "fixtures/native-ingestion-h5.mjs"];
  const protocolSources = await Promise.all(protocolFiles.map(async file => ({ file, bytes: await readFile(path.resolve(import.meta.dirname, file)) })));
  report.measurementSha256 = createHash("sha256").update(Buffer.concat(protocolSources.map(source => source.bytes))).digest("hex");
  const harnessRoot = path.resolve(import.meta.dirname, "../..");
  report.harnessProvenance = {
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: harnessRoot, encoding: "utf8" }).trim(),
    sourceStatus: execFileSync("git", ["status", "--porcelain", "--", "tests/e2e"], { cwd: harnessRoot, encoding: "utf8" }).trim(),
    sourceHashes: Object.fromEntries(protocolSources.map(source => [source.file, createHash("sha256").update(source.bytes).digest("hex")])),
    driverDependencySource: process.env.PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES
      ?? "Independent locked H4 driver install; every measured app owns separate dependencies and compiled output",
    driverLockSha256: createHash("sha256").update(await readFile(path.join(harnessRoot, "pnpm-lock.yaml"))).digest("hex"),
    scope: "Separate browser harness and driver-only tooling; every measured app uses its own frozen clean source and matching compiled stamp",
  };
  try {
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: true, enableWorktreeRunExecution: true } }));
    await json(await request.post(`/api/companies/${company.id}/user-secret-definitions`, { data: { key: "OPENAI_API_KEY", name: "Fixture credential" } }));
    await json(await request.post(`/api/companies/${company.id}/me/user-secrets`, { data: { definitionKey: "OPENAI_API_KEY", value: "not-a-real-model-key" } }));
    let remoteEnvironment: { id: string };
    {
      const pluginPath = path.join(appRoot, "packages/plugins/paperclip-plugin-fake-sandbox");
      const plugin = await json(await request.post("/api/plugins/install", { timeout: 120_000,
        data: { packageName: pluginPath, isLocalPath: true } }));
      expect(plugin.pluginKey).toBe("paperclip.fake-sandbox-provider");
      const serverConfig = process.env.PAPERCLIP_E2E_SERVER_CONFIG;
      if (!serverConfig) throw new Error("Missing owned server configuration for remote fixture provenance");
      const remoteProvenance = JSON.parse(await readFile(path.resolve(path.dirname(serverConfig), "../..", "ingestion-remote-provenance.json"), "utf8"));
      remoteEnvironment = await json(await request.post(`/api/companies/${company.id}/environments`, { data: {
        name: "Native ingestion remote fixture", driver: "sandbox",
        config: { provider: "fake-plugin", image: "fake:latest", reuseLease: false, runnerLifecycleMode: "per_turn" },
        envVars: { PATH: `${path.dirname(remoteProvenance.provider.node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` },
      } }));
      report.remote = { ...remoteProvenance, plugin: { id: plugin.id, pluginKey: plugin.pluginKey, path: pluginPath },
        environmentId: remoteEnvironment!.id,
        selection: "Normal plugin install + sandbox environment + agent defaultEnvironmentId; no runtime resolver override" };
      (report.remote as any).plugin.assetHashes = Object.fromEntries(await Promise.all(
        ["worker.js", "plugin.js", "manifest.js", "lease-cleanup.js"].map(async file => [file,
          createHash("sha256").update(await readFile(path.join(pluginPath, "dist", file))).digest("hex")])));
    }
    const localEnvironments = await json(await request.get(`/api/companies/${company.id}/environments?driver=local`));
    expect(localEnvironments).toHaveLength(1);
    const localEnvironment = localEnvironments[0];
    expect(localEnvironment.driver).toBe("local");
    const agentCount = Math.max(...cases.map(item => item.runs));
    const agents = await prepareParticipantAgents({ count: agentCount,
      onOutcome: (value: unknown) => { (report.remote as any).agentSetup = value; },
      createAndReady: async (index: number) => {
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { timeout: 120_000, data: {
        name: `Ingestion ${index + 1}`, role: "engineer", adapterType: "paperclip_runner",
        defaultEnvironmentId: remoteEnvironment.id,
        adapterConfig: { provider: "codex", model: "gpt-5.1-codex-mini", env: {
          OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", version: "latest", required: true },
        } }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 50 } },
      } }));
      await expect.poll(async () => (await json(await request.get(`/api/agents/${agent.id}`))).lifecycleState,
        { timeout: 60_000 }).toBe("ready");
      return agent;
    } }) as Array<{ id: string; name: string }>;
    (report.remote as any).agentIds = agents.map(agent => agent.id);
    const controlAgent = await json(await request.post(`/api/companies/${company.id}/agents`, { timeout: 120_000, data: {
      name: "Ingestion local Stop control", role: "engineer", adapterType: "paperclip_runner",
      defaultEnvironmentId: localEnvironment.id,
      adapterConfig: { provider: "codex", model: "gpt-5.1-codex-mini", env: {
        OPENAI_API_KEY: { type: "user_secret_ref", key: "OPENAI_API_KEY", version: "latest", required: true },
      } }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 50 } },
    } }));
    await expect.poll(async () => (await json(await request.get(`/api/agents/${controlAgent.id}`))).lifecycleState,
      { timeout: 60_000 }).toBe("ready");
    report.local = { transport: "local", environmentId: localEnvironment.id, controlAgentId: controlAgent.id,
      selection: "Normal local environment + separate control agent defaultEnvironmentId; existing test-only Codex leaf command fixture",
      commandSha256: (report.harnessProvenance as any).sourceHashes["fixtures/native-ingestion-bin/codex"],
      loaderSha256: (report.harnessProvenance as any).sourceHashes["fixtures/composer-stop-codex-loader.mjs"] };

    async function perform(workload: Case, stop = false) {
      const caseTransport = stop ? "local" : "sandbox-remote";
      const caseEnvironment = stop ? localEnvironment : remoteEnvironment;
      const caseAgents = stop ? [controlAgent] : agents;
      const key = randomUUID().replaceAll("-", ""), nonce = randomUUID().replaceAll("-", "");
      const markerCode = nextMarkerCode();
      pending.set(key, new Map());
      const state: ClockCase = { events: workload.events, intervalMs: workload.intervalMs, streams: new Map(), errors: [] };
      clocks.set(key, state);
      const register = (token: string, code: string) => state.streams.set(token, { nonce: token, markerCode: code,
        opened: false, hello: false, ended: false, aborted: false, partialBytes: 0, records: new Map(),
        expectedLauncher: stop ? "host-local" : "staged-remote" });
      register(nonce, markerCode);
      const compactOutput = Array.from({ length: workload.events }, (_, index) => `[${markerCode}${index.toString(36)}] `).join("");
      const preludeOutput = workload.prelude ? `${".".repeat(Math.max(0, workload.prelude - 1))} PRELUDE_${nonce}_READY ` : "";
      expect([...compactOutput].length, "Full measured completion must fit the unchanged Rust text bound").toBeLessThan(4000);
      expect([...preludeOutput + compactOutput].length, "Prelude and measured text must remain below that bound").toBeLessThan(4000);
      const active: Record<string, unknown> = { ...workload, stop, transport: caseTransport,
        environmentId: caseEnvironment.id, nonce, markerCode, phase: "setup", key };
      report.activeCase = active;
      const prompt = (token: string, code: string, prelude: number) => `Measure native streaming for ${token.slice(0, 8)}.\n\nINGESTION_PERF nonce=${token} events=${workload.events} intervalMs=${workload.intervalMs} prelude=${prelude} markerCode=${code} gate=${base}${key}`;
      const before = new Set((await json(await request.get(`/api/companies/${company.id}/issues`))).map((issue: { id: string }) => issue.id));
      await page.goto(`/${company.issuePrefix}/agents/${caseAgents[0].id}/overview`);
      await page.getByRole("link", { name: "Tasks", exact: true }).click();
      await page.getByRole("button", { name: "New Task", exact: true }).last().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "editable markdown" }).fill(prompt(nonce, markerCode, workload.prelude));
      await dialog.getByRole("button", { name: "Select assignee", exact: true }).click();
      await page.getByRole("listbox", { name: "Assignees", exact: true }).getByRole("option")
        .filter({ has: page.getByText(caseAgents[0].name, { exact: true }) }).click();
      await expect(dialog.getByRole("button", { name: "Select assignee" })).toContainText(caseAgents[0].name);
      const foregroundActivationStartedAtMs = Date.now();
      await dialog.getByRole("button", { name: "Create task", exact: true }).click();
      let issue: any;
      await expect.poll(async () => {
        issue = (await json(await request.get(`/api/companies/${company.id}/issues`))).find((item: { id: string; description?: string }) => !before.has(item.id) && item.description?.includes(nonce));
        return Boolean(issue);
      }).toBe(true);
      const issueIds = [issue.id];
      active.issueIds = issueIds;
      const activations: SetupActivation[] = [{ index: 0, issueId: issue.id, token: nonce, waveIndex: null,
        startedAtMs: foregroundActivationStartedAtMs, requestSettledAtMs: Date.now(), status: "pending" }];
      const activationWaves: SetupWave[] = [];
      active.activations = activations; active.activationWaves = activationWaves;
      active.setupActivationConcurrency = setupActivationConcurrency;
      const issuedTokens = new Map<string, string>([[issue.id, nonce]]);
      for (let index = 1; index < workload.runs; index++) {
        const backgroundToken = randomUUID().replaceAll("-", ""), backgroundCode = nextMarkerCode();
        register(backgroundToken, backgroundCode);
        const background = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
          title: `Ingestion background ${key} ${index}`, description: prompt(backgroundToken, backgroundCode, 0),
          status: "backlog", assigneeAgentId: caseAgents[index].id,
        } }));
        issueIds.push(background.id);
        issuedTokens.set(background.id, backgroundToken);
      }
      const setupReadinessStartedAtMs = Date.now();
      const readinessDeadlineMs = setupReadinessStartedAtMs + providerReadinessMs;
      active.setupReadinessStartedAtMs = setupReadinessStartedAtMs; active.readinessDeadlineMs = readinessDeadlineMs;
      active.phase = "activation-and-provider-readiness";
      for (let firstIndex = 1; firstIndex < issueIds.length; firstIndex += setupActivationConcurrency) {
        expect(Date.now(), "Do not activate a later wave after the shared readiness deadline").toBeLessThanOrEqual(readinessDeadlineMs);
        const indices = Array.from({ length: Math.min(setupActivationConcurrency, issueIds.length - firstIndex) }, (_, offset) => firstIndex + offset);
        const wave: SetupWave = { index: activationWaves.length, indices, startedAtMs: Date.now() };
        activationWaves.push(wave); active.activationWave = wave;
        const settled = await Promise.allSettled(indices.map(async index => {
          const id = issueIds[index], token = issuedTokens.get(id)!;
          const activation: SetupActivation = { index, issueId: id, token, waveIndex: wave.index,
            startedAtMs: Date.now(), status: "pending" };
          activations.push(activation);
          try {
            await json(await request.patch(`/api/issues/${id}`, { data: { status: "todo" } }));
            activation.requestSettledAtMs = Date.now();
            // Keep the gate closed until both actual providers in this wave have
            // opened their GET and clock hello; never overlap a later wave.
            await expect.poll(() => pending.get(key)!.has(token) && state.streams.get(token)!.hello,
              { timeout: Math.max(1, readinessDeadlineMs - Date.now()), intervals: [50] }).toBe(true);
            const stream = state.streams.get(token)!;
            stream.readinessObservedAtMs = Date.now();
            Object.assign(activation, { providerReadyAtMs: stream.providerReadyAtMs, clockHelloAtMs: stream.clockHelloAtMs,
              readinessObservedAtMs: stream.readinessObservedAtMs, status: "fulfilled" });
          } catch (error) {
            activation.status = "rejected"; activation.failure = String(error); throw error;
          } finally { activation.settledAtMs = Date.now(); }
        }));
        wave.settledAtMs = Date.now(); wave.statuses = settled.map(result => result.status);
        const failure = settled.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      const route = `/${company.issuePrefix}/issues/${issue.identifier}`;
      await page.goto(route);
      active.phase = "provider-and-clock-readiness";
      await expect.poll(() => ({ providers: pending.get(key)!.size,
        clocks: [...state.streams.values()].filter(stream => stream.hello).length }),
      { timeout: Math.max(1, readinessDeadlineMs - Date.now()), intervals: [50] }).toEqual({ providers: workload.runs, clocks: workload.runs });
      expect(Date.now(), "All participants must be ready within the shared activation/readiness budget").toBeLessThanOrEqual(readinessDeadlineMs);
      const allReadyObservedAtMs = Date.now(), foregroundStream = state.streams.get(nonce)!;
      foregroundStream.readinessObservedAtMs = allReadyObservedAtMs;
      Object.assign(activations[0], { providerReadyAtMs: foregroundStream.providerReadyAtMs, clockHelloAtMs: foregroundStream.clockHelloAtMs,
        readinessObservedAtMs: allReadyObservedAtMs, settledAtMs: allReadyObservedAtMs, status: "fulfilled" });
      active.allReadyObservedAtMs = allReadyObservedAtMs;
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
      const controllerAuthority = await runtimeAuthority({
        appRoot, companyId: company.id, environmentId: caseEnvironment.id, issueIds, transport: caseTransport,
      });
      active.controllerAuthority = controllerAuthority;
      assertParticipantTopology(report, { ...workload, stop, controllerAuthority });
      const providerClocks = controllerAuthority.rows.map((row: any) => {
        const token = issuedTokens.get(row.issue_id)!, stream = state.streams.get(token)!;
        return { runId: row.run_id, nonce: token, launcher: stream.launcher, providerPid: stream.providerPid };
      });
      let localProcesses;
      if (stop) {
        const row = controllerAuthority.rows[0], identity = row.process_identity;
        expect(identity.processPid).toBe(row.process_pid); expect(identity.processGroupId).toBe(row.process_group_id);
        const providerPid = providerClocks[0].providerPid!;
        localProcesses = { runnerPid: row.process_pid, processGroupId: row.process_group_id, providerPid,
          hostname: hostname(), checkedAtMs: Date.now(), runnerAlive: !processAbsent(row.process_pid),
          groupAlive: !processAbsent(-row.process_group_id), providerAlive: !processAbsent(providerPid) };
        expect(localProcesses.runnerAlive && localProcesses.groupAlive && localProcesses.providerAlive).toBe(true);
      }
      const participants = [...pending.get(key)!.keys()];
      expect(participants, "Every actual provider GET must still be open after the authority snapshot").toHaveLength(workload.runs);
      const epochMs = Date.now() + 1000;
      state.epochMs = epochMs; active.epochMs = epochMs; active.phase = "streaming";
      active.participants = participants;
      for (const response of pending.get(key)!.values()) response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ epochMs }));
      const observed = () => page.evaluate(code => (window as unknown as { nativeIngestionVisible: SeenMarker[] }).nativeIngestionVisible.filter(item => item.markerCode === code), markerCode);
      let streamingObservation: Awaited<ReturnType<typeof observeStreaming>> | undefined;
      if (h5) streamingObservation = await observeStreaming({ readCount: async () => (await observed()).length,
        target: stop ? 3 : workload.events,
        poll: (read: () => Promise<number>, timeout: number, target: number) => expect.poll(read, { timeout }).toBeGreaterThanOrEqual(target),
        onOutcome: (value: unknown) => { active.streamingObservation = value; } });
      else await expect.poll(async () => (await observed()).length, { timeout: 120_000 }).toBeGreaterThanOrEqual(stop ? 3 : workload.events);
      let stopRequestedAt: number | undefined;
      if (stop) {
        const button = page.getByRole("button", { name: "Stop", exact: true });
        await expect(button).toBeVisible();
        stopRequestedAt = Date.now();
        await button.click();
      }
      active.phase = "terminal-drainage";
      let runs: any[] = [];
      const terminalStartedAtMs = h5 ? Date.now() : undefined;
      const terminalObservation = h5 ? { startedAtMs: terminalStartedAtMs!, deadlineMs: terminalStartedAtMs! + H5_LIMITS.terminalDrainageMs,
        assessedAtMs: 0, lastObservedAtMs: 0, observedRuns: 0, terminalRuns: 0,
        lastStatuses: [] as Array<{ runId: string; status: string }>, complete: false, censored: false } : undefined;
      if (h5) active.terminalObservation = terminalObservation;
      try { await expect.poll(async () => {
        runs = (await json(await request.get(`/api/companies/${company.id}/heartbeat-runs?limit=1000`))).filter((run: { issueId?: string; nativeIssueId?: string; contextSnapshot?: { issueId?: string; taskId?: string } }) => issueIds.includes(run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId));
        if (terminalObservation) Object.assign(terminalObservation, { lastObservedAtMs: Date.now(), observedRuns: runs.length,
          terminalRuns: runs.filter(run => ["succeeded", "cancelled", "failed"].includes(run.status)).length,
          lastStatuses: runs.map(run => ({ runId: run.id, status: run.status })) });
        return runs.length === issueIds.length && runs.every(run => ["succeeded", "cancelled", "failed"].includes(run.status));
      }, { timeout: 180_000 }).toBe(true); }
      catch (error) {
        if (terminalObservation) { terminalObservation.assessedAtMs = Date.now(); terminalObservation.censored = true;
          active.terminalOriginal = originalTerminal(streamingObservation!, terminalObservation); }
        throw error;
      }
      const settledAt = Date.now(), seenMarkers = await observed();
      if (terminalObservation) { terminalObservation.assessedAtMs = settledAt; terminalObservation.complete = true; }
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
      let remoteLeases: unknown[] | undefined;
      let remoteLeasesCheckedAtMs: number | undefined;
      if (!stop) {
        let leases: any[] = [];
        await expect.poll(async () => {
          leases = await json(await request.get(`/api/environments/${remoteEnvironment.id}/leases`));
          return runs.every(run => leases.some(lease => lease.heartbeatRunId === run.id && lease.releasedAt
            && ["released", "expired", "failed"].includes(lease.status) && lease.cleanupStatus === "success"));
        }, { timeout: 30_000 }).toBe(true);
        remoteLeasesCheckedAtMs = Date.now();
        remoteLeases = runs.map(run => {
          const lease = leases.find((candidate: any) => candidate.heartbeatRunId === run.id);
          expect(lease, `Missing normal sandbox lease for ${run.id}`).toBeTruthy();
          expect(lease.environmentId).toBe(remoteEnvironment.id);
          expect(lease.providerLeaseId).toMatch(/^fake-plugin:\/\//);
          return { id: lease.id, runId: run.id, companyId: lease.companyId, environmentId: lease.environmentId, provider: lease.provider,
            providerLeaseId: lease.providerLeaseId, status: lease.status, releasedAt: lease.releasedAt, cleanupStatus: lease.cleanupStatus,
            terminationReceipt: lease.metadata?.remoteExecutionTermination };
        });
      }
      let localStopProof;
      if (stop) {
        let leases: any[] = [];
        await expect.poll(async () => {
          leases = await json(await request.get(`/api/environments/${localEnvironment.id}/leases`));
          return leases.some(lease => lease.heartbeatRunId === runs[0].id && lease.provider === "local"
            && lease.releasedAt && lease.cleanupStatus !== "failed");
        }, { timeout: 30_000 }).toBe(true);
        const processIdentity = localProcesses!;
        await expect.poll(() => processAbsent(processIdentity.runnerPid) && processAbsent(-processIdentity.processGroupId)
          && processAbsent(processIdentity.providerPid), { timeout: 30_000 }).toBe(true);
        const database = await runtimeAuthority({ appRoot, companyId: company.id, environmentId: localEnvironment.id,
          issueIds, transport: "local", afterStop: true });
        const row = database.rows[0];
        expect(row.status).toBe("cancelled"); expect(row.cancellation_dispatch_state).toBe("acknowledged");
        if (!row.process_pid && !row.process_group_id) {
          expect(BigInt(String(row.process_stopped_seq))).toBeGreaterThan(BigInt(String(row.process_identity_seq)));
          expect(row.process_stopped?.processPid).toBe(processIdentity.runnerPid);
          expect(row.process_stopped?.processGroupId).toBe(processIdentity.processGroupId);
        }
        localStopProof = { checkedAtMs: Date.now(), database, processes: { ...processIdentity,
          runnerAbsent: processAbsent(processIdentity.runnerPid), groupAbsent: processAbsent(-processIdentity.processGroupId),
          providerAbsent: processAbsent(processIdentity.providerPid) },
          lease: Object.fromEntries(["id", "companyId", "environmentId", "heartbeatRunId", "provider", "providerLeaseId", "status", "releasedAt", "cleanupStatus"]
            .map(key => [key, leases.find(lease => lease.heartbeatRunId === runs[0].id)[key]])) };
      }
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
      // Terminal drainage has finished. Derive paint gaps from the retained
      // observer timestamps without adding work to the streaming observer.
      const paintTimes = [...new Set(visible.map(item => item.visibleMs))].sort((a, b) => a - b);
      const { count, medianMs, maxMs } = stats(paintTimes.slice(1).map((at, index) => at - paintTimes[index]));
      const interChunkGaps = { paintCount: paintTimes.length, count, medianMs, maxMs };
      const clockEvidence: Array<Record<string, unknown>> = [];
      const result = { ...workload, stop, transport: caseTransport, environmentId: caseEnvironment.id,
        ...(h5 ? { h5: { streaming: streamingObservation, terminalObservation,
          terminalOriginal: originalTerminal(streamingObservation!, terminalObservation!),
          visibleCountByOriginalPaintDeadline: seenMarkers.filter(marker => marker.visibleMs <= streamingObservation!.original.deadlineMs).length,
          deadlineCountScope: "Original poll last count/time retained separately; paint-deadline count derives from unchanged2RAF timestamps" } } : {}),
        ...(h5 ? { terminalStatuses: runs.map(run => ({ runId: run.id, runtimeMode: run.runtimeMode, status: run.status })) } : {}),
        setupActivationConcurrency, setupReadinessStartedAtMs, readinessDeadlineMs, allReadyObservedAtMs, activations, activationWaves,
        nonce, markerCode, epochMs, settledAtMs: settledAt, stopRequestedAtMs: stopRequestedAt,
        stopAcknowledgedAtMs: acknowledgedAt, preludeProof, controllerAuthority, clockEvidence, interChunkGaps,
        providerClocks, localProcesses, localStopProof,
        remoteLeases, remoteLeasesCheckedAtMs, runIds: runs.map(run => run.id), participants: participants.length, visible, matchedVisibleClocks: visible.length,
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
        let afterSeq = 0, resultAcceptedEvents = 0;
        while (true) {
          const rows = await json(await request.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`));
          if (!rows.length) break;
          for (const row of rows) {
            const event = row.payload?.prpEvent;
            if (h5 && (row.eventType === "run.result.accepted" || event?.eventType === "run.result.accepted")) resultAcceptedEvents++;
            if (event?.eventType !== "item.delta") continue;
            for (const match of String(event.payload?.text ?? "").matchAll(new RegExp(`\\[${code}([a-z0-9]{1,3})\\]`, "g"))) {
              const index = Number.parseInt(match[1], 36);
              expect(event.payload.text, "Every durable normalized delta retains its complete compact payload").toBe(`[${code}${index.toString(36)}] `);
              if (h5) { expect(event.runId).toBe(run.id); expect(event.sourceInstanceId).toBeTruthy();
                expect(event.sourceEventId).toBeTruthy(); expect(Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > 0).toBe(true); }
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
        if (h5) expect(resultAcceptedEvents).toBe(stop ? 0 : 1);
        durable.push({ runId: run.id, token, markerCode: code, individualDeltas: deltas.length, uniqueSourceIdentities: deltas.length,
          matchedSourceClocks: deltas.length, ordered: true, ...(h5 ? { resultAcceptedEvents } : {}) });
      }
      await expect.poll(() => [...state.streams.values()].every(stream => stream.ended || stream.aborted), { timeout: 30_000 }).toBe(true);
      expect(state.errors).toEqual([]);
      expect([...state.streams.values()].every(stream => !stream.error)).toBe(true);
      if (h5) {
        const verifiedAtMs = Date.now();
        Object.assign(result.h5!, { independentDrain: { verifiedAtMs, elapsedFromEpochMs: verifiedAtMs - epochMs,
          deltaCount: durable.reduce((count, row) => count + row.individualDeltas, 0),
          resultAcceptedCount: durable.reduce((count, row) => count + (row.resultAcceptedEvents ?? 0), 0),
          clockStreamsClosed: true,
          scope: "Independent completion upper bound after existing reload/API/clock/lease checks; includes verification and screenshot overhead, not exact last-commit time" } });
      }
      clockEvidence.push(...[...state.streams.values()].map(stream => ({ nonce: stream.nonce, markerCode: stream.markerCode,
        launcher: stream.launcher, providerPid: stream.providerPid,
        hello: stream.hello, ended: stream.ended, aborted: stream.aborted, error: stream.error, partialBytes: stream.partialBytes,
        providerReadyAtMs: stream.providerReadyAtMs, clockHelloAtMs: stream.clockHelloAtMs, readinessObservedAtMs: stream.readinessObservedAtMs,
        emissions: [...stream.records.values()].sort((a, b) => a.index - b.index) })));
      (report.cases as unknown[]).push({ ...result, durable, persistedAfterReload: true });
      await info.attach(`${workload.name}${stop ? "-stop" : ""}-metrics`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
      pending.delete(key); clocks.delete(key); delete report.activeCase;
    }
    for (const workload of cases) await perform(workload);
    await perform({ name: "operator-stop", runs: 1, events: 512, intervalMs: 100, prelude: 0 }, true);
    report.complete = true;
    if (h5) report.observationComplete = true;
  } catch (error) {
    report.primaryFailure = { name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
    throw error;
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
    // Retain primary failure evidence even if API teardown cannot finish. This
    // attachment is never eligible for the standalone acceptance comparator.
    await info.attach("native-ingestion-precleanup-evidence", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    for (const requests of pending.values()) for (const response of requests.values()) response.writeHead(503).end();
    gate.closeAllConnections();
    await new Promise<void>(resolve => gate.close(() => resolve()));
    const cleanupErrors: Array<{ step: string; message: string }> = [];
    const attemptCleanup = async (step: string, action: () => Promise<unknown>) => {
      try { return await action(); } catch (error) { cleanupErrors.push({ step, message: String(error) }); }
    };
    const live = await attemptCleanup("list-live-runs", async () => json(await request.get(`/api/companies/${company.id}/live-runs`))) as any[] | undefined;
    for (const run of live ?? []) await attemptCleanup(`cancel-${run.id}`, async () => json(await request.post(`/api/heartbeat-runs/${run.id}/cancel`)));
    await attemptCleanup("restore-experimental-settings", async () => json(await request.patch("/api/instance/settings/experimental", {
      data: { enableNativeRunner: original.enableNativeRunner, enableWorktreeRunExecution: original.enableWorktreeRunExecution } })));
    report.cleanup = { errors: cleanupErrors, complete: cleanupErrors.length === 0 };
    if (cleanupErrors.length) { report.complete = false; report.performanceAcceptanceEligible = false;
      if (h5) report.observationComplete = false; }
    if (h5) report.bodyFinishedAtMs = Date.now();
    await info.attach("native-ingestion-evidence", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    if (!report.primaryFailure) expect(cleanupErrors, "API cleanup must succeed before accepting an invocation").toEqual([]);
  }
});
