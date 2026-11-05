import assert from "node:assert/strict";
import { H5_MODE, H5_PROTOCOL, H4E_PROTOCOL, H5_TOPOLOGY, H5_LIMITS, H5_WORKLOAD_SHA256, H5_BASELINE_REVISIONS,
  originalTerminal, assessH5Arm, requireH5Candidate } from "../tests/e2e/fixtures/native-ingestion-h5.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { evaluateServiceRepeatability, noiseExceedingPairedWins } from "./native-ingestion-performance-gates.mjs";

test("four pairs must individually improve beyond noise", () => {
  const threeBeyondNoise = noiseExceedingPairedWins([0.30, 0.30, 0.30, 0.01, -0.01], 0.10);
  assert.equal(threeBeyondNoise.noiseExceedingPairedWins, 3);
  assert.equal(threeBeyondNoise.pairedWinRequirementPassed, false);
  assert.equal(noiseExceedingPairedWins([0.30, 0.25, 0.20, 0.15, 0.01], 0.10).pairedWinRequirementPassed, true);
  assert.equal(noiseExceedingPairedWins([0.30, 0.30, 0.30, 0.10, -0.01], 0.10).pairedWinRequirementPassed, false);
});

function repeatabilityReport() {
  return { phase: "aa", incomplete: false, cleanupComplete: true,
    workload: { quick: false, pairs: 5, events: 32, groups: 16, histories: [1000, 10000, 100000],
      scenarios: ["ordered", "replay", "late-gap", "warm-suffix"] },
    results: [1000, 10000, 100000].flatMap(history => ["ordered", "replay", "late-gap", "warm-suffix"].map(scenario => ({ history, scenario,
      baseline: { samples: Array.from({ length: 5 }, () => ({ elapsedMs: 100 })) },
      candidate: { samples: Array.from({ length: 5 }, () => ({ elapsedMs: 101 })) },
    }))) };
}

test("service A/A enforces both preregistered limits on every timing case", () => {
  assert.equal(evaluateServiceRepeatability(repeatabilityReport()).passed, true);
  const variance = repeatabilityReport(); variance.results[11].candidate.samples[0].elapsedMs = 121;
  assert.equal(evaluateServiceRepeatability(variance).passed, false);
  const drift = repeatabilityReport(); drift.results[0].candidate.samples.forEach(value => { value.elapsedMs = 111; });
  assert.equal(evaluateServiceRepeatability(drift).passed, false);
  const boundary = repeatabilityReport(); boundary.results[0].candidate.samples.forEach(value => { value.elapsedMs = 110; });
  boundary.results[0].candidate.samples[0].elapsedMs = 120;
  assert.equal(evaluateServiceRepeatability(boundary).passed, true, "The stated inclusive 20%/10% boundaries qualify");
  const late = repeatabilityReport(); late.results[2].candidate.samples[0].elapsedMs = 1000;
  assert.equal(evaluateServiceRepeatability(late).passed, true, "Late-gap time stays structural-only");
});

test("smoke, partial, missing matrix, insufficient pairs and unfinished cleanup cannot qualify A/A", () => {
  for (const change of [report => { report.workload.quick = true; }, report => { report.incomplete = true; },
    report => { report.cleanupComplete = false; }, report => { report.workload.pairs = 4; },
    report => { report.results.pop(); }, report => { report.phase = "compare"; }]) {
    const report = repeatabilityReport(); change(report);
    assert.equal(evaluateServiceRepeatability(report).passed, false);
  }
});

test("owner report-validation CLI enforces repeatability without opening a database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-ingestion-owner-gates-"));
  const root = path.resolve(import.meta.dirname, "..");
  const report = repeatabilityReport();
  report.candidateSourceHashes = Object.fromEntries(await Promise.all([
    "scripts/benchmark-native-event-ingestion.ts", "scripts/native-ingestion-performance-gates.mjs",
  ].map(async file => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
  const file = path.join(directory, "report.json");
  const run = () => spawnSync(process.execPath, ["--import", "./server/node_modules/tsx/dist/loader.mjs",
    "scripts/benchmark-native-event-ingestion.ts", `--validate-report=${file}`, "--require-repeatability"], { cwd: root, encoding: "utf8" });
  try {
    await writeFile(file, JSON.stringify(report));
    const valid = run(); assert.equal(valid.status, 0, valid.stderr);
    report.results[0].candidate.samples[0].elapsedMs = 150;
    await writeFile(file, JSON.stringify(report));
    const invalid = run(); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /repeatability gate failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const workloads = [
  { name: "paced", runs: 1, events: 128, intervalMs: 25, prelude: 0 },
  { name: "burst16", runs: 1, events: 16, intervalMs: 0, prelude: 0 },
  { name: "burst128", runs: 10, events: 128, intervalMs: 0, prelude: 0 },
  { name: "burst512", runs: 100, events: 512, intervalMs: 0, prelude: 0 },
  { name: "existing-history", runs: 10, events: 128, intervalMs: 0, prelude: 1000 },
  { name: "operator-stop", runs: 1, events: 512, intervalMs: 100, prelude: 0, stop: true },
];
function syntheticSettlement(item) {
  const states = item.runIds.map(runId => ({ runId, status: item.stop ? "cancelled" : "succeeded",
    runtimeMode: null, nativePhase: null, errorCode: null }));
  return { startedAtMs: item.settledAtMs, deadlineMs: item.settledAtMs + 180000,
    assessedAtMs: item.settledAtMs, lastObservedAtMs: item.settledAtMs, observedRuns: item.runs, terminalRuns: item.runs,
    pendingRetryRuns: 0, lastStatuses: states, transitions: states.map(row => ({ observedAtMs: item.settledAtMs, ...row })),
    uniqueRetryableRuns: 0, recoveredRuns: 0, nonretryableFailures: 0, retryableErrorClasses: {}, complete: true, censored: false };
}

function browserReport(revision, latency) {
  const companyId = "00000000-0000-4000-8000-000000000001", environmentId = "00000000-0000-4000-8000-000000000002";
  const localEnvironmentId = "00000000-0000-4000-8000-000000000003", controlAgentId = "00000000-0000-4000-8000-000000000004";
  const id = (kind, caseIndex, index) => `00000000-0000-4000-8000-${(kind * 100000 + caseIndex * 1000 + index).toString(16).padStart(12, "0")}`;
  const remoteAgentIds = Array.from({ length: 100 }, (_, index) => id(9, 0, index));
  const transportPolicy = { streaming: "sandbox-remote", operatorStop: "local",
    realCloudStop: "Separate required qualification; fake-plugin void receipts grant no remote Stop authority" };
  return { protocolVersion: H4E_PROTOCOL, transport: "sandbox-remote-with-local-stop", transportPolicy, companyId,
    bodyStartedAtMs: 1, agentTopology: { ...H5_TOPOLOGY, remoteAgentPoolSize: 100 },
    harnessProvenance: { sourceRevision: "b".repeat(40), sourceStatus: "", driverLockSha256: "8".repeat(64),
      sourceHashes: { "native-event-ingestion.journey.ts": "9".repeat(64), "fixtures/native-ingestion-h5.mjs": "a".repeat(64) } },
    resourceBudgets: { providerReadinessMs: 300000, fullInvocationMs: 900000, streamingMs: 120000,
      terminalDrainageMs: 180000, stopAcknowledgementMs: 30000, remoteLeaseCleanupMs: 30000 },
    local: { transport: "local", environmentId: localEnvironmentId, controlAgentId,
      selection: "Normal local environment + separate control agent defaultEnvironmentId; existing test-only Codex leaf command fixture",
      commandSha256: "6".repeat(64), loaderSha256: "7".repeat(64) },
    remote: { transport: "sandbox-remote", revision, buildRevision: revision, environmentId, agentIds: remoteAgentIds,
      agentSetup: { count: 100, concurrency: 8, complete: true, startedAtMs: 2, settledAtMs: 40,
        attempts: remoteAgentIds.map((agentId, index) => ({ index, agentId, status: "fulfilled",
          startedAtMs: 3 + Math.floor(index / 8) * 2, settledAtMs: 4 + Math.floor(index / 8) * 2 })) },
      runnerPublicUrl: "wss://127.0.0.1:32100",
      selection: "Normal plugin install + sandbox environment + agent defaultEnvironmentId; no runtime resolver override",
      plugin: { pluginKey: "paperclip.fake-sandbox-provider", assetHashes: Object.fromEntries(["worker.js", "plugin.js", "manifest.js", "lease-cleanup.js"].map(file => [file, "5".repeat(64)])) },
      tls: { peerVerification: true, caSha256: "e".repeat(64), serverCertificateSha256: "f".repeat(64) },
      runner: { sha256: "d".repeat(64), metadata: { prpTransportModes: ["dial_wss"] } },
      provider: { nodeSha256: "b".repeat(64), wrapperSha256: "c".repeat(64), fixtureSha256: "a".repeat(64) } },
    fixtureSha256: "a".repeat(64), admissionProtocol: "two-at-a-time-provider-and-clock-readiness-before-common-epoch", setupActivationConcurrency: 2, setupReadinessPollingMs: 50, complete: true, cleanup: { complete: true, errors: [] }, qualificationOnly: false, diagnosticOnly: false, performanceAcceptanceEligible: true, browserRecording: { trace: "off", video: "off", screencast: false },
    sourceRevision: revision, compiledBuildRevision: revision, serverArtifact: "compiled", serverEntrySha256: `${revision}-compiled`,
    measurementSha256: "synthetic-fixed-fixture", compiledHotPathHashes: { append: "append", port: "port", runtime: "runtime" },
    cases: workloads.map((workload, caseIndex) => {
      const stop = Boolean(workload.stop), actualEnvironmentId = stop ? localEnvironmentId : environmentId;
      const launcher = stop ? "host-local" : "staged-remote", pid = 20000 + caseIndex * 1000;
      const snapshot = { checkedBeforeMeasuredEpoch: true, checkedAtMs: 998, connectionClosedAtMs: 999,
        observedReadOnly: "on", observedIsolation: "repeatable read", kind: stop ? "host-file-journal" : "database-controller-checkpoint" };
      const rows = Array.from({ length: workload.runs }, (_, index) => ({
        run_id: id(1, caseIndex, index), issue_id: id(2, caseIndex, index), company_id: companyId,
        agent_id: stop ? controlAgentId : remoteAgentIds[index],
        lease_id: id(3, caseIndex, index), environment_id: actualEnvironmentId, runtime_mode: "native", provider: stop ? "local" : "fake-plugin",
        provider_lease_id: stop ? null : `fake-plugin://${id(1, caseIndex, index)}/fixture`,
        checkpoint_part: stop ? null : "header", checkpoint_header_bytes: stop ? null : 256,
        runner_instance_id: id(6, caseIndex, index), native_session_id: id(7, caseIndex, index), admitted_execution_workspace_id: id(8, caseIndex, index),
        ...(stop ? { process_pid: pid - 1, process_group_id: pid - 1, process_started_at: "2026-11-03T00:00:00.000Z",
          process_identity_seq: "9", process_identity_source_event_id: null,
          process_identity: { targetKind: "local", hostname: "fixture-host", processPid: pid - 1, processGroupId: pid - 1,
            processStartedAt: "2026-11-03T00:00:00.000Z" } } : {}),
      }));
      const lease = { id: rows[0].lease_id, heartbeatRunId: rows[0].run_id, companyId, environmentId: localEnvironmentId,
        provider: "local", providerLeaseId: null, status: "released", releasedAt: "2026-11-03T00:00:01.000Z", cleanupStatus: null };
      const localProcesses = { runnerPid: pid - 1, processGroupId: pid - 1, providerPid: pid, hostname: "fixture-host",
        checkedAtMs: 999, runnerAlive: true, groupAlive: true, providerAlive: true };
      const activations = rows.map((row, index) => {
        const waveIndex = index ? Math.floor((index - 1) / 2) : null, startedAtMs = index ? 110 + waveIndex * 10 : 50;
        return { index, issueId: row.issue_id, token: String(index), waveIndex, startedAtMs,
          requestSettledAtMs: startedAtMs + (index ? 3 : 5), providerReadyAtMs: startedAtMs + (index ? 1 : 10),
          clockHelloAtMs: startedAtMs + (index ? 2 : 20), readinessObservedAtMs: index ? startedAtMs + 6 : 700,
          settledAtMs: index ? startedAtMs + 7 : 700, status: "fulfilled" };
      });
      const activationWaves = Array.from({ length: Math.ceil((workload.runs - 1) / 2) }, (_, index) => ({
        index, indices: Array.from({ length: Math.min(2, workload.runs - 1 - index * 2) }, (_, offset) => 1 + index * 2 + offset),
        startedAtMs: 110 + index * 10, settledAtMs: 118 + index * 10,
        statuses: Array(Math.min(2, workload.runs - 1 - index * 2)).fill("fulfilled"),
      }));
      return { ...workload, stop, transport: stop ? "local" : "sandbox-remote", environmentId: actualEnvironmentId, persistedAfterReload: true,
        setupActivationConcurrency: 2, setupReadinessStartedAtMs: 100, readinessDeadlineMs: 300100, allReadyObservedAtMs: 700,
        participants: workload.runs, activations, activationWaves,
        epochMs: 1000, preludeProof: workload.prelude ? { individualDeltas: workload.prelude, uniqueSourceIdentities: workload.prelude, verifiedAtMs: 999 } : undefined,
        terminalObservation: syntheticSettlement({ ...workload, stop, runIds: rows.map(row => row.run_id), settledAtMs: 1000 + latency }),
        settledAtMs: 1000 + latency, stopRequestedAtMs: stop ? 1000 : undefined,
        recordedFailures: { kind: "recorded-run-failure-codes", transaction: "READ ONLY REPEATABLE READ",
          observedReadOnly: "on", observedIsolation: "repeatable read", queryStartedAtMs: 1002 + latency,
          checkedAtMs: 1003 + latency, connectionClosedAtMs: 1004 + latency,
          rows: rows.map(row => ({ run_id: row.run_id, company_id: companyId, agent_id: row.agent_id, runtime_mode: "native",
            status: stop ? "cancelled" : "succeeded", native_phase: "committed", current_error_code: stop ? "cancelled" : null, current_has_error: stop,
            recovered_type: null, recovered_schema: null, recovered_error_code: null, recovered_observed_at: null, finalization_attempt: 1 })) },
        stopAcknowledgedAtMs: stop ? 1000 + latency : undefined, remoteLeasesCheckedAtMs: stop ? undefined : 1001 + latency,
        runIds: rows.map(row => row.run_id), controllerAuthority: { ...snapshot, rows,
          ...(stop ? { localJournal: { schema: "paperclip.runner.durable.control-plane-state.v1", sha256: "8".repeat(64), bytes: 512, checkedAtMs: 999,
            identity: { runId: rows[0].run_id, runnerInstanceId: rows[0].runner_instance_id, normalizedSessionId: rows[0].native_session_id, environmentLeaseId: rows[0].admitted_execution_workspace_id } } } : {}) },
        providerClocks: rows.map((row, index) => ({ runId: row.run_id, nonce: String(index), launcher, providerPid: pid + index })),
        clockEvidence: rows.map((row, index) => ({ nonce: String(index), launcher, providerPid: pid + index,
          hello: true, providerReadyAtMs: activations[index].providerReadyAtMs, clockHelloAtMs: activations[index].clockHelloAtMs,
          readinessObservedAtMs: activations[index].readinessObservedAtMs })),
        ...(stop ? { localProcesses, localStopProof: { checkedAtMs: 1001 + latency, lease,
          processes: { ...localProcesses, runnerAbsent: true, groupAbsent: true, providerAbsent: true },
          database: { ...snapshot, checkedBeforeMeasuredEpoch: false, checkedAtMs: 1000 + latency, connectionClosedAtMs: 1000 + latency,
            rows: [{ ...rows[0], process_pid: null, process_group_id: null, process_started_at: null, status: "cancelled", cancellation_dispatch_state: "acknowledged",
              process_stopped_seq: "64", process_stopped_source_event_id: null, process_stopped: { processPid: pid - 1, processGroupId: pid - 1, processStartedAt: rows[0].process_started_at } }] } } }
          : { remoteLeases: rows.map(row => ({ id: row.lease_id, runId: row.run_id, companyId, environmentId, provider: "fake-plugin", providerLeaseId: row.provider_lease_id,
            status: "released", cleanupStatus: "success", releasedAt: "2026-11-03T00:00:00.000Z" })) }),
        visible: Array(stop ? 3 : workload.events).fill({}), matchedVisibleClocks: stop ? 3 : workload.events,
        firstVisibleAfterEmissionMs: latency, emissionToVisible: { medianMs: latency, p95Ms: latency },
        interChunkGaps: { paintCount: workload.events, count: workload.events - 1, medianMs: latency, maxMs: latency },
        intendedToVisible: { p95Ms: latency }, drainThroughTerminalMs: latency,
        stopThroughTerminalMs: latency, stopThroughAcknowledgementMs: latency,
        durable: rows.map((row, index) => ({ runId: row.run_id, token: String(index), ordered: true,
          resultAcceptedEvents: stop ? 0 : 1,
          uniqueSourceIdentities: stop ? 3 : workload.events, individualDeltas: stop ? 3 : workload.events, matchedSourceClocks: stop ? 3 : workload.events })),
      };
    }) };
}

function h5Report(revision, loadedLatency) {
  const report = browserReport(({ ...H5_BASELINE_REVISIONS, B2: "c".repeat(40) })[revision], 1000);
  if (revision === "B2") report.remote.runner.sha256 = "8".repeat(64);
  Object.assign(report, { protocolVersion: H5_PROTOCOL, observationMode: H5_MODE,
    workloadSha256: H5_WORKLOAD_SHA256, observationLimits: H5_LIMITS, observationComplete: true,
    actualPlaywrightTimeoutMs: H5_LIMITS.fullInvocationMs, measurementSha256: "h5-synthetic-fixed-fixture",
    serverEntrySha256: "e".repeat(64), compiledHotPathHashes: {
      "server/dist/services/heartbeat-run-events.js": "f".repeat(64),
      "server/dist/services/native-runtime/paperclip-control-plane-port.js": "1".repeat(64),
      "server/dist/vendor/paperclip-runner/native-session-runtime.js": "2".repeat(64) } });
  for (const item of report.cases) {
    const latency = item.name === "burst512" ? loadedLatency : 1000;
    item.settledAtMs = item.epochMs + latency; item.drainThroughTerminalMs = latency;
    item.firstVisibleAfterEmissionMs = latency; item.emissionToVisible = { medianMs: latency, p95Ms: latency };
    item.intendedToVisible = { p95Ms: latency };
    if (!item.stop) item.remoteLeasesCheckedAtMs = item.settledAtMs + 1;
    Object.assign(item.recordedFailures, { queryStartedAtMs: item.settledAtMs + 2,
      checkedAtMs: item.settledAtMs + 3, connectionClosedAtMs: item.settledAtMs + 4 });
    item.visible = Array.from({ length: item.stop ? 3 : item.events }, (_, index) => ({ index, visibleMs: item.settledAtMs }));
    const missed = latency > 120000, assessedAtMs = missed ? item.epochMs + 120000 : item.settledAtMs;
    const streaming = { original: { status: missed ? "failed" : "passed", reason: missed ? "original_streaming_deadline" : null,
      startedAtMs: item.epochMs, deadlineMs: item.epochMs + 120000, assessedAtMs,
      target: item.stop ? 3 : item.events, lastObservedCount: missed ? 30 : item.visible.length,
      lastObservedAtMs: missed ? assessedAtMs - 1 : assessedAtMs,
      error: missed ? "Timeout 120000ms exceeded while waiting on the predicate" : null },
      observation: { ceilingMs: 600000, deadlineMs: item.epochMs + 600000, complete: true, censored: false, completedAtMs: item.settledAtMs } };
    const terminalObservation = syntheticSettlement(item);
    item.h5 = { streaming, terminalObservation, terminalOriginal: originalTerminal(streaming, terminalObservation),
      visibleCountByOriginalPaintDeadline: missed ? 0 : item.visible.length,
      independentDrain: { verifiedAtMs: item.settledAtMs + 10, elapsedFromEpochMs: latency + 10,
        deltaCount: item.runs * (item.stop ? 3 : item.events), resultAcceptedCount: item.stop ? 0 : item.runs, clockStreamsClosed: true } };
    item.terminalStatuses = item.runIds.map(runId => ({ runId, runtimeMode: "native", status: item.stop ? "cancelled" : "succeeded" }));
    for (const row of item.durable) row.resultAcceptedEvents = item.stop ? 0 : 1;
  }
  return report;
}

test("H5 assessor retains an original SLA failure assessed before its nominal streaming deadline", () => {
  const report = h5Report("B0", 180000), streaming = report.cases[3].h5.streaming.original;
  streaming.assessedAtMs = streaming.deadlineMs - 750;
  streaming.lastObservedAtMs = streaming.assessedAtMs - 1;
  const outcome = assessH5Arm(report, { status: "passed", retry: 0, errors: [], timeoutMs: H5_LIMITS.fullInvocationMs,
    startedAt: "2026-11-03T00:00:00.000Z", durationMs: 500000 });
  assert.equal(outcome.originalSlaPassed, false);
  assert.deepEqual(outcome.misses, ["burst512:streaming120"]);
  assert.throws(() => requireH5Candidate("final-b2", outcome, outcome), /every original SLA/);
});

test("H5 CLI retains baseline SLA failure, rejects final SLA misses and requires complete owning evidence", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-ingestion-h5-gates-"));
  const script = new URL("./compare-native-ingestion-browser.ts", import.meta.url);
  const save = async (name, value) => { const file = path.join(directory, name); await writeFile(file, JSON.stringify(value)); return file; };
  const run = args => spawnSync(process.execPath, [script.pathname, `--observation-mode=${H5_MODE}`, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const hash = value => createHash("sha256").update(value).digest("hex"), inventories = new Map();
  async function inventory(report, playwrightFile, name) {
    const variant = ({ [H5_BASELINE_REVISIONS.B0]: "B0", [H5_BASELINE_REVISIONS.B1]: "B1", ["c".repeat(40)]: "B2" })[report.sourceRevision];
    if (!inventories.has(variant)) {
      const roots = ["server/dist", "ui/dist", "packages/db/src", "packages/shared/src"];
      const files = Object.entries({ ...report.compiledHotPathHashes, "server/dist/index.js": report.serverEntrySha256,
        "packages/db/src/client.ts": "3".repeat(64), "packages/shared/src/index.ts": "4".repeat(64), "ui/dist/index.html": "5".repeat(64) })
        .map(([path, sha256]) => ({ bytes: 10, path, sha256 })).sort((left, right) => left.path.localeCompare(right.path, "en"));
      const aggregateSha256 = hash(files.map(row => JSON.stringify({ bytes: row.bytes, path: row.path, sha256: row.sha256 })).join("\n") + "\n");
      const manifestBytes = gzipSync(Buffer.from(JSON.stringify({ variant, revision: report.sourceRevision,
        compiledBuildRevision: report.compiledBuildRevision, roots, fileCount: files.length, files, aggregateSha256 })));
      const manifestFile = path.join(directory, `${variant}-artifact-inventory.json.gz`); await writeFile(manifestFile, manifestBytes);
      const manifestFileSha256 = hash(manifestBytes);
      const inventorySummaryFile = await save(`${variant}-summary.json`, { inventories: { [variant]: {
        manifest: path.basename(manifestFile), manifestSha256: manifestFileSha256, aggregateSha256, fileCount: files.length } } });
      const qualifiedReceiptFile = await save(`${variant}-qualified.json`, { results: [{ variant, revision: report.sourceRevision,
        compiledBuildRevision: report.compiledBuildRevision, sourceClean: true }], rustSourceTree: (variant === "B2" ? "8" : "9").repeat(40),
        binarySha256: report.remote.runner.sha256, nativeStageHashes: [{ variant, binarySha256: report.remote.runner.sha256 }],
        artifactInventorySummary: inventorySummaryFile });
      inventories.set(variant, { manifestFile, manifestFileSha256, aggregateSha256, inventorySummaryFile,
        inventorySummarySha256: hash(await readFile(inventorySummaryFile)), qualifiedReceiptFile,
        qualifiedReceiptSha256: hash(await readFile(qualifiedReceiptFile)) });
    }
    return save(`${name}-inventory.json`, { schema: "paperclip.native-ingestion.arm-inventory.v1", variant,
      sourceRevision: report.sourceRevision, compiledBuildRevision: report.compiledBuildRevision,
      playwrightReportSha256: hash(await readFile(playwrightFile)), ...inventories.get(variant) });
  }
  async function manifest(prefix, candidateLatency, { sameRevision = false, baselineRevision = "B0", candidateRevision = "B2", mutate, mutateArm, duration = 500000 } = {}) {
    const entries = [];
    for (let index = 0; index < 5; index++) {
      const entry = {};
      for (const arm of ["baseline", "candidate"]) {
        const ordinal = 2 * index + (arm === "baseline" ? index % 2 : index % 2 ? 0 : 1);
        const startedAtMs = Date.parse(sameRevision ? "2026-11-02T00:00:00.000Z" : "2026-11-03T00:00:00.000Z") + ordinal * 2000000;
        const ownedIdPrefix = createHash("sha256").update(prefix).digest("hex").slice(0,6) + ordinal.toString(16).padStart(2,"0");
        const report = JSON.parse(JSON.stringify(h5Report(arm === "baseline" || sameRevision ? baselineRevision : candidateRevision,
          arm === "baseline" ? 180000 : candidateLatency)).replaceAll("00000000-", `${ownedIdPrefix}-`), (key, value) =>
          typeof value === "number" && (key.endsWith("AtMs") || ["epochMs", "deadlineMs", "readinessDeadlineMs", "visibleMs", "intendedMs", "emittedMs"].includes(key)) ? value + startedAtMs : value);
        report.bodyFinishedAtMs = startedAtMs + duration - 1;
        const owner = { timeout: 1200000, expectedStatus: "passed", results: [{ status: "passed", retry: 0,
          duration, startTime: new Date(startedAtMs).toISOString(), errors: [], attachments: [] }] };
        if (index === 0 && arm === "candidate") mutate?.(report, owner);
        mutateArm?.(report, { index, arm, owner });
        owner.results[0].attachments.push({ name: "native-ingestion-evidence", contentType: "application/json",
          body: Buffer.from(JSON.stringify(report)).toString("base64") });
        entry[`${arm}File`] = await save(`${prefix}-${index}-${arm}.json`, report);
        entry[`${arm}PlaywrightFile`] = await save(`${prefix}-${index}-${arm}-playwright.json`, { suites: [{ tests: [owner] }] });
        entry[`${arm}InventoryFile`] = await inventory(report, entry[`${arm}PlaywrightFile`], `${prefix}-${index}-${arm}`);
      }
      entries.push(entry);
    }
    return save(`${prefix}-pairs.json`, entries);
  }
  async function requalifyNative(entry, arm, binarySha256, rustSourceTree) {
    const report = JSON.parse(await readFile(entry[`${arm}File`], "utf8"));
    report.remote.runner.sha256 = binarySha256;
    await writeFile(entry[`${arm}File`], JSON.stringify(report));
    const owner = JSON.parse(await readFile(entry[`${arm}PlaywrightFile`], "utf8"));
    owner.suites[0].tests[0].results[0].attachments[0].body = Buffer.from(JSON.stringify(report)).toString("base64");
    await writeFile(entry[`${arm}PlaywrightFile`], JSON.stringify(owner));
    const sidecar = JSON.parse(await readFile(entry[`${arm}InventoryFile`], "utf8"));
    const receipt = JSON.parse(await readFile(sidecar.qualifiedReceiptFile, "utf8"));
    receipt.binarySha256 = binarySha256; receipt.rustSourceTree = rustSourceTree;
    receipt.nativeStageHashes[0].binarySha256 = binarySha256;
    sidecar.qualifiedReceiptFile = await save(`${path.basename(entry[`${arm}File`])}-qualified-native.json`, receipt);
    sidecar.qualifiedReceiptSha256 = hash(await readFile(sidecar.qualifiedReceiptFile));
    sidecar.playwrightReportSha256 = hash(await readFile(entry[`${arm}PlaywrightFile`]));
    await writeFile(entry[`${arm}InventoryFile`], JSON.stringify(sidecar));
  }
  try {
    const proof = JSON.parse(JSON.stringify(h5Report("B2", 1000)).replaceAll("00000000-", "10000000-"));
    proof.protocolVersion = H4E_PROTOCOL;
    proof.measurementSha256 = "h5-synthetic-fixed-fixture";
    // H4e defaults use the same frozen source/geometry as the observation arms.
    for (const field of ["observationMode", "observationLimits", "observationComplete", "workloadSha256", "actualPlaywrightTimeoutMs"]) delete proof[field];
    for (const item of proof.cases) { item.terminalObservation = item.h5.terminalObservation; delete item.h5; }
    const originalProof = await save("original-h4e-playwright.json", { suites: [{ tests: [{ timeout: 900000, expectedStatus: "passed", results: [{
      status: "passed", retry: 0, duration: 5000, startTime: "2026-11-04T00:00:00.000Z", errors: [], attachments: [{
        name: "native-ingestion-evidence", body: Buffer.from(JSON.stringify(proof)).toString("base64") }] }] }] }] });
    const originalInventory = await inventory(proof, originalProof, "original-h4c");
    const finalProofArgs = [`--original-h4e-proof=${originalProof}`, `--original-h4e-inventory=${originalInventory}`];
    const noise = path.join(directory, "aa.json");
    const aaManifest = await manifest("aa", 181000, { sameRevision: true });
    const aa = run(["--phase=aa", `--pairs=${aaManifest}`, `--output=${noise}`]);
    assert.equal(aa.status, 0, aa.stderr);
    const aaReport = JSON.parse(await readFile(noise, "utf8"));
    assert.equal(aaReport.h5Assessments.length, 5);
    assert.equal(aaReport.measurements.filter(item => item.metric === "h5.independentDrain.elapsedFromEpochMs").length, 5,
      "Every non-Stop case needs its own verified-completion A/A noise");
    assert(aaReport.measurements.find(item => item.name === "burst512" && item.metric === "h5.independentDrain.elapsedFromEpochMs").aaNoiseEnvelopeRelative > 0);
    assert.deepEqual(aaReport.h5Assessments[0].baseline.misses, ["burst512:streaming120"]);
    assert.equal(aaReport.aaSuitability.passed, true); assert.equal(aaReport.armChronology.length, 10);
    assert.equal(new Set(aaReport.armChronology.map(arm => arm.companyId)).size, 10);
    for (const [name, mutateArm, expectation] of [
      ["aa-paired-jitter", (report, { arm, index }) => { if (arm === "candidate" && index === 4) report.cases[0].firstVisibleAfterEmissionMs = 1300; }, "paired"],
      ["aa-chronological-drift", (report, { index }) => { report.cases[0].firstVisibleAfterEmissionMs = 1000 + index * 60; }, "chronological"],
      ["aa-role-bias", (report, { arm }) => { report.cases[0].firstVisibleAfterEmissionMs = arm === "candidate" ? 1120 : 1000; }, "role"],
    ]) {
      const output = path.join(directory, `${name}.json`);
      const attempt = run(["--phase=aa", `--pairs=${await manifest(name, 180000, { sameRevision: true, mutateArm })}`, `--output=${output}`]);
      assert.notEqual(attempt.status, 0, name); assert.match(attempt.stderr, /A\/A suitability failed/);
      const unsuitable = JSON.parse(await readFile(output, "utf8"));
      assert.equal(unsuitable.aaSuitability.passed, false); assert.equal(unsuitable.armChronology.length, 10);
      const metric = unsuitable.measurements.find(item => item.name === "paced" && item.metric === "firstVisibleAfterEmissionMs").aaSuitability;
      if (expectation === "paired") assert(metric.pairedDifferencesMs.some((value,index) => value > metric.pairedLimitsMs[index]));
      if (expectation === "chronological") { assert.equal(metric.observedNoiseAbsoluteMs, 0); assert(metric.chronologicalMedianDriftMs > metric.chronologicalDriftLimitMs); }
      if (expectation === "role") assert(metric.roleMedianDriftMs > metric.roleDriftLimitMs);
    }
    for (const [name, mutateArm] of [
      ["aa-missing-owner-time", (_report, { arm, index, owner }) => { if (arm === "candidate" && index === 0) delete owner.results[0].startTime; }],
      ["aa-overlap", (_report, { arm, index, owner }) => { if (arm === "candidate" && index === 0) owner.results[0].startTime = "2026-11-02T00:00:00.001Z"; }],
      ["aa-wrong-order", (_report, { arm, index, owner }) => { if (index === 1) owner.results[0].startTime = new Date(Date.parse("2026-11-02T00:00:00.000Z") + (arm === "baseline" ? 4 : 5) * 1000000).toISOString(); }],
      ["aa-reused-company-run", (report) => { const prefix = report.companyId.slice(0,8); Object.assign(report, JSON.parse(JSON.stringify(report).replaceAll(`${prefix}-`, "00000000-"))); }],
    ]) {
      const attempt = run(["--phase=aa", `--pairs=${await manifest(name, 180000, { sameRevision: true, mutateArm })}`]);
      assert.notEqual(attempt.status, 0, name);
    }
    for (const [name, forge] of [
      ["forged-absolute-noise", noise => { noise.measurements[0].aaNoiseEnvelopeAbsoluteMs = 9999; }],
      ["forged-relative-noise", noise => { noise.measurements[0].aaNoiseEnvelopeRelative = 9; }],
      ["forged-representation", noise => { noise.measurements[0].representationLimited = !noise.measurements[0].representationLimited; }],
      ["forged-suitability", noise => { noise.measurements[0].aaSuitability.pairedLimitsMs[0] = 9999; }],
      ["forged-sample", noise => { noise.measurements[0].samples[0].improvementMs++; }],
      ["forged-rule", noise => { noise.aaSuitability.rule.contrastRepresentationFloorMs = 1000; }],
    ]) {
      const forged = structuredClone(aaReport); forge(forged);
      const attempt = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression",
        `--pairs=${await manifest(name, 180000, { candidateRevision: "B1" })}`, `--noise-report=${await save(`${name}-noise.json`, forged)}`, "--require-performance"]);
      assert.notEqual(attempt.status, 0, name); assert.match(attempt.stderr, /forged|rule changed/);
    }
    for (const repeat of [1,2]) {
      const shortNoise = path.join(directory, `short-${repeat}-noise.json`);
      const aa = run(["--phase=aa", `--pairs=${await manifest(`short-${repeat}-aa`, 180000, { sameRevision: true,
        mutateArm: (report, { arm }) => { report.cases[0].firstVisibleAfterEmissionMs = arm === "candidate" ? repeat : 1; } })}`, `--output=${shortNoise}`]);
      assert.equal(aa.status, 0, aa.stderr);
      const calibrated = JSON.parse(await readFile(shortNoise, "utf8"));
      const control = calibrated.measurements.find(item => item.name === "paced" && item.metric === "firstVisibleAfterEmissionMs");
      assert.equal(control.representationLimited, true); assert.equal(control.percentageGainClaimAllowed, false);
      assert.equal(control.medianPairedImprovementRelative, null); assert.equal(control.aaNoiseEnvelopeAbsoluteMs, repeat - 1);
      const output = path.join(directory, `short-${repeat}-regression.json`);
      const attempt = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression",
        `--pairs=${await manifest(`short-${repeat}-regression`, 180000, { candidateRevision: "B1", mutateArm: (report, { arm }) => {
          report.cases[0].firstVisibleAfterEmissionMs = repeat === 1 ? arm === "candidate" ? 2 : 1 : arm === "candidate" ? 12 : 10;
        } })}`, `--noise-report=${shortNoise}`, `--output=${output}`, "--require-performance"]);
      assert.notEqual(attempt.status, 0, "The suitability floor must not pad actual observed absolute noise");
      const compared = JSON.parse(await readFile(output, "utf8"));
      const gate = compared.gates.find(item => item.name === "paced" && item.metric === "firstVisibleAfterEmissionMs");
      assert.equal(gate.noiseEnvelopeAbsoluteMs, repeat - 1); assert.equal(gate.representationLimited, true); assert.equal(gate.passed, false);
      if (repeat === 2) {
        const improving = path.join(directory, "short-calibrated-improvement.json");
        const changed = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression",
          `--pairs=${await manifest("short-calibrated-improvement", 180000, { candidateRevision: "B1", mutateArm: (report, { arm }) => {
            report.cases[0].firstVisibleAfterEmissionMs = arm === "candidate" ? 1 : 100;
          } })}`, `--noise-report=${shortNoise}`, `--output=${improving}`, "--require-performance"]);
        assert.equal(changed.status, 0, changed.stderr);
        const measured = JSON.parse(await readFile(improving, "utf8")).measurements.find(item => item.name === "paced" && item.metric === "firstVisibleAfterEmissionMs");
        assert.equal(measured.representationLimited, true); assert.equal(measured.percentageGainClaimAllowed, false);
        assert.equal(measured.medianPairedImprovementRelative, null, "Short calibration cannot turn into a percentage gain claim");
      }
    }
    const replayedOwners = JSON.parse(await readFile(await manifest("reused-aa-owner", 180000, { candidateRevision: "B1" }), "utf8"));
    const oldOwners = JSON.parse(await readFile(aaManifest, "utf8"));
    for (const field of ["baselineFile", "baselinePlaywrightFile", "baselineInventoryFile"]) replayedOwners[0][field] = oldOwners[0][field];
    const replay = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression",
      `--pairs=${await save("reused-aa-owner-pairs.json", replayedOwners)}`, `--noise-report=${noise}`, "--require-performance"]);
    assert.notEqual(replay.status, 0); assert.match(replay.stderr, /calibration|reus/);
    const cursor = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression",
      `--pairs=${await manifest("cursor", 180000, { candidateRevision: "B1" })}`, `--noise-report=${noise}`, "--require-acceptance"]);
    assert.equal(cursor.status, 0, cursor.stderr);
    const cursor900 = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression",
      `--pairs=${await manifest("cursor-matched900", 180000, { candidateRevision: "B1", duration: 950000 })}`,
      `--noise-report=${noise}`, "--require-acceptance"]);
    assert.equal(cursor900.status, 0, cursor900.stderr);
    const added900 = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression",
      `--pairs=${await manifest("cursor-added900", 180000, { candidateRevision: "B1", mutate: (_report, owner) => { owner.results[0].duration = 950000; } })}`,
      `--noise-report=${noise}`, "--require-acceptance"]);
    assert.notEqual(added900.status, 0, "Cursor candidate cannot add an unmatched900 miss");
    const goodPairs = await manifest("good", 1000);
    const good = run(["--candidate-policy=final-b2", `--pairs=${goodPairs}`, `--noise-report=${noise}`, ...finalProofArgs, "--require-acceptance"]);
    assert.equal(good.status, 0, good.stderr);
    const goodReport = JSON.parse(good.stdout);
    assert.equal(goodReport.artifactInventories.baseline.binarySha256, "d".repeat(64));
    assert.equal(goodReport.artifactInventories.candidate.binarySha256, "8".repeat(64));
    assert.notEqual(goodReport.artifactInventories.baseline.rustSourceTree, goodReport.artifactInventories.candidate.rustSourceTree);
    await context.test("each arm accepts its distinct qualified Runner binary", () => {
      assert.equal(goodReport.performancePassed, true); assert.equal(goodReport.acceptancePassed, true);
      assert.equal(goodReport.originalH4eConfirmation.inventory.binarySha256, "8".repeat(64));
    });
    await context.test("a serving binary outside its qualified receipt is rejected", async () => {
      const attempt = run(["--candidate-policy=final-b2", `--pairs=${await manifest("unqualified-native", 1000, {
        mutateArm: (report, { arm, index }) => { if (arm === "candidate" && index === 2) report.remote.runner.sha256 = "7".repeat(64); },
      })}`, `--noise-report=${noise}`, "--require-performance"]);
      assert.notEqual(attempt.status, 0); assert.match(attempt.stderr, /Serving native binary differs from qualified build/);
    });
    await context.test("a second qualified binary within one arm is rejected", async () => {
      const file = await manifest("changed-qualified-native", 1000), entries = JSON.parse(await readFile(file, "utf8"));
      await requalifyNative(entries[2], "candidate", "7".repeat(64), "7".repeat(40));
      const attempt = run(["--candidate-policy=final-b2", `--pairs=${file}`, `--noise-report=${noise}`, "--require-performance"]);
      assert.notEqual(attempt.status, 0); assert.match(attempt.stderr, /Qualified Runner binary changed between samples of an arm/);
    });
    await context.test("A/A cannot compare two qualified Runner binaries", async () => {
      const file = await manifest("aa-changed-qualified-native", 181000, { sameRevision: true }), entries = JSON.parse(await readFile(file, "utf8"));
      await requalifyNative(entries[0], "candidate", "7".repeat(64), "7".repeat(40));
      const attempt = run(["--phase=aa", `--pairs=${file}`]);
      assert.notEqual(attempt.status, 0); assert.match(attempt.stderr, /Qualified Runner binary changed between samples of an arm/);
    });
    await context.test("later original-deadline proof must use the candidate's qualified binary", async () => {
      const entry = { candidateFile: await save("changed-proof-evidence.json", proof),
        candidatePlaywrightFile: await save("changed-proof-playwright.json", JSON.parse(await readFile(originalProof, "utf8"))),
        candidateInventoryFile: await save("changed-proof-inventory.json", JSON.parse(await readFile(originalInventory, "utf8"))) };
      await requalifyNative(entry, "candidate", "7".repeat(64), "7".repeat(40));
      const result = path.join(directory, "changed-proof-result.json");
      const attempt = run(["--candidate-policy=final-b2", `--pairs=${goodPairs}`, `--noise-report=${noise}`,
        `--original-h4e-proof=${entry.candidatePlaywrightFile}`, `--original-h4e-inventory=${entry.candidateInventoryFile}`, `--output=${result}`, "--require-acceptance"]);
      assert.notEqual(attempt.status, 0);
      const rejected = JSON.parse(await readFile(result, "utf8"));
      assert.equal(rejected.performancePassed, true); assert.equal(rejected.acceptancePassed, false);
      assert.match(rejected.originalH4eConfirmation.reason, /Original confirmation used a different full qualified artifact inventory/);
    });
    const completionRegressionPairs = await manifest("verified-drain-regression", 1000, {
      mutateArm: (report, { arm }) => {
        if (arm !== "candidate") return;
        const item = report.cases[3];
        Object.assign(item.h5.independentDrain, { elapsedFromEpochMs: 200000, verifiedAtMs: item.epochMs + 200000 });
      } });
    const completionRegressionOutput = path.join(directory, "verified-drain-regression.json");
    const completionRegression = run(["--candidate-policy=final-b2", `--pairs=${completionRegressionPairs}`,
      `--noise-report=${noise}`, `--output=${completionRegressionOutput}`, "--require-performance"]);
    const completionRegressionReport = JSON.parse(await readFile(completionRegressionOutput, "utf8"));
    context.diagnostic(JSON.stringify({ regression: "browser and terminal faster but independently verified completion slower",
      comparatorSha256: completionRegressionReport.comparatorSha256, exit: completionRegression.status,
      performancePassed: completionRegressionReport.performancePassed, baselineVerifiedMs: 180010, candidateVerifiedMs: 200000,
      verifiedCompletionGate: completionRegressionReport.gates.find(gate => gate.name === "burst512"
        && gate.metric === "h5.independentDrain.elapsedFromEpochMs") ?? null }));
    assert.notEqual(completionRegression.status, 0, "Faster browser/terminal must not conceal slower fully verified completion");
    const regressionGate = completionRegressionReport.gates.find(gate => gate.name === "burst512"
      && gate.metric === "h5.independentDrain.elapsedFromEpochMs");
    assert.equal(regressionGate.improvementRequired, true); assert.equal(regressionGate.passed, false);
    assert(completionRegressionReport.gates.filter(gate => gate.name === "burst512" &&
      ["emissionToVisible.p95Ms", "intendedToVisible.p95Ms", "drainThroughTerminalMs"].includes(gate.metric)).every(gate => gate.passed));
    const rate = goodReport.verifiedCompletionRates.find(item => item.name === "burst512");
    assert.equal(rate.samples[0].measuredDeltas, 51200);
    assert.equal(rate.samples[0].baselineDeltasPerSecond, 51200000 / 180010);
    assert.equal(rate.samples[0].candidateDeltasPerSecond, 51200000 / 1010);
    assert(rate.candidateMedianDeltasPerSecond > rate.baselineMedianDeltasPerSecond);
    for (const beyondNoise of [3,4]) {
      const output = path.join(directory, `verified-drain-${beyondNoise}-wins.json`);
      const attempt = run(["--candidate-policy=final-b2", `--pairs=${await manifest(`verified-drain-${beyondNoise}-wins`, 1000, {
        mutateArm: (report, { arm, index }) => {
          if (arm !== "candidate") return;
          const item = report.cases[3], elapsed = index < beyondNoise ? 90000 : 179500;
          Object.assign(item.h5.independentDrain, { elapsedFromEpochMs: elapsed, verifiedAtMs: item.epochMs + elapsed });
        } })}`, `--noise-report=${noise}`, `--output=${output}`, "--require-performance"]);
      assert.equal(attempt.status === 0, beyondNoise === 4, attempt.stderr);
      const compared = JSON.parse(await readFile(output, "utf8"));
      const gate = compared.gates.find(item => item.name === "burst512" && item.metric === "h5.independentDrain.elapsedFromEpochMs");
      assert.equal(gate.noiseExceedingPairedWins, beyondNoise); assert.equal(gate.requiredPairedWins, 4);
      assert.equal(gate.passed, beyondNoise === 4);
    }
    const zeroNoise = path.join(directory, "zero-noise.json");
    const zeroAA = run(["--phase=aa", `--pairs=${await manifest("zero-noise-aa", 180000, { sameRevision: true })}`, `--output=${zeroNoise}`]);
    assert.equal(zeroAA.status, 0, zeroAA.stderr);
    for (const resolvedPairs of [0,3,4]) {
      const output = path.join(directory, `timestamp-gain-${resolvedPairs}.json`);
      const attempt = run(["--candidate-policy=final-b2", `--pairs=${await manifest(`timestamp-gain-${resolvedPairs}`, 1000, {
        mutateArm: (report, { arm, index }) => {
          if (arm !== "candidate") return;
          const item = report.cases[3], gain = resolvedPairs === 0 ? 1 : index < resolvedPairs ? 3 : 2;
          Object.assign(item.h5.independentDrain, { elapsedFromEpochMs: 180010 - gain, verifiedAtMs: item.epochMs + 180010 - gain });
        } })}`, `--noise-report=${zeroNoise}`, `--output=${output}`, "--require-performance"]);
      assert.equal(attempt.status === 0, resolvedPairs === 4, attempt.stderr);
      const gate = JSON.parse(await readFile(output, "utf8")).gates.find(item => item.name === "burst512"
        && item.metric === "h5.independentDrain.elapsedFromEpochMs");
      assert.equal(gate.noiseExceedingPairedWins, resolvedPairs); assert.equal(gate.requiredAbsoluteImprovementAboveMs, 2);
    }
    const cursorCompletionRegression = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression",
      `--pairs=${await manifest("cursor-verified-drain-regression", 180000, { candidateRevision: "B1", mutateArm: (report, { arm }) => {
        if (arm !== "candidate") return;
        const item = report.cases[3]; Object.assign(item.h5.independentDrain, { elapsedFromEpochMs: 200000, verifiedAtMs: item.epochMs + 200000 });
      } })}`, `--noise-report=${noise}`, "--require-performance"]);
    assert.notEqual(cursorCompletionRegression.status, 0, "Cursor nonregression must include fully verified completion");
    const wrongPolicy = run(["--expect=nonregression", "--candidate-policy=cursor-nonregression", `--pairs=${goodPairs}`,
      `--noise-report=${noise}`, "--require-acceptance"]);
    assert.notEqual(wrongPolicy.status, 0); assert.match(wrongPolicy.stderr, /Cursor policy requires B0→B1/);
    const b1Noise = path.join(directory, "aa-b1.json");
    const b1AA = run(["--phase=aa", `--pairs=${await manifest("aa-b1", 181000, { sameRevision: true, baselineRevision: "B1" })}`, `--output=${b1Noise}`]);
    assert.equal(b1AA.status, 0, b1AA.stderr);
    const incremental = run(["--candidate-policy=final-b2", `--pairs=${await manifest("b1-b2", 1000, { baselineRevision: "B1" })}`,
      `--noise-report=${b1Noise}`, ...finalProofArgs, "--require-acceptance"]);
    assert.equal(incremental.status, 0, incremental.stderr);
    const pendingFile = path.join(directory, "pending-h4c.json");
    const pending = run(["--candidate-policy=final-b2", `--pairs=${goodPairs}`, `--noise-report=${noise}`, `--output=${pendingFile}`, "--require-acceptance"]);
    assert.notEqual(pending.status, 0);
    const pendingReport = JSON.parse(await readFile(pendingFile, "utf8"));
    assert.equal(pendingReport.performancePassed, true); assert.equal(pendingReport.acceptancePassed, false);
    const performanceOnly = run(["--candidate-policy=final-b2", `--pairs=${goodPairs}`, `--noise-report=${noise}`, "--require-performance"]);
    assert.equal(performanceOnly.status, 0, performanceOnly.stderr);
    const setRetries = (report, count, code = "provider_transport_failed", observed = true) => {
      const item = report.cases[3], value = item.h5.terminalObservation;
      value.transitions = [...item.runIds.slice(0, observed ? count : 0).map(runId => ({ observedAtMs: value.startedAtMs,
        runId, status: "failed", runtimeMode: "native", nativePhase: "retryable_failure", errorCode: code })),
        ...value.lastStatuses.map(row => ({ observedAtMs: value.assessedAtMs, ...row }))];
      Object.assign(value, { uniqueRetryableRuns: observed ? count : 0, recoveredRuns: observed ? count : 0,
        retryableErrorClasses: observed && count ? { [code]: count } : {} });
      for (let index = 0; index < count; index++) Object.assign(item.recordedFailures.rows[index], {
        recovered_type: "object", recovered_schema: "paperclip.recovered_execution_failure.v1", recovered_error_code: code,
        recovered_observed_at: new Date(item.settledAtMs - 1).toISOString() });
    };
    const retryNoise = path.join(directory, "retry-aa.json");
    const retryAA = run(["--phase=aa", `--pairs=${await manifest("retry-aa", 181000, { sameRevision: true,
      mutateArm: (report, { arm }) => setRetries(report, arm === "candidate" ? 2 : 1) })}`, `--output=${retryNoise}`]);
    assert.equal(retryAA.status, 0, retryAA.stderr);
    const calibrated = JSON.parse(await readFile(retryNoise, "utf8")).retryObservations[3];
    assert.equal(calibrated.rates.find(rate => rate.errorClass === null).aaNoiseEnvelopeAbsolute, .01);
    assert.equal(calibrated.samples[0].baseline.uniqueRetryableRuns, 1);
    assert.equal(calibrated.samples[0].candidate.recoveredRuns, 2);
    const staleCurrent = run(["--candidate-policy=final-b2",
      `--pairs=${await manifest("stale-current-error", 1000, {
        mutateArm: report => setRetries(report, 1),
        mutate: report => Object.assign(report.cases[3].recordedFailures.rows[0], {
          current_has_error: true, current_error_code: "provider_transport_failed" }) })}`,
      `--noise-report=${retryNoise}`, "--require-performance"]);
    assert.notEqual(staleCurrent.status, 0, "An unresolved current error is not recovered merely because status says succeeded");
    assert.match(staleCurrent.stderr, /must clear their current execution error/);
    for (const [name, mutation, expectedPass] of [
      ["retry-at-frozen-noise", (report, { arm }) => setRetries(report, arm === "candidate" ? 2 : 1), true],
      ["one-arm-retry-storm", (report, { arm, index }) => setRetries(report, arm === "candidate" && index === 0 ? 3 : 1), false],
      ["new-retry-class", (report, { arm }) => setRetries(report, 1, arm === "candidate" ? "new_transport_failure" : "provider_transport_failed"), false],
    ]) {
      const output = path.join(directory, `${name}.json`);
      const attempt = run(["--candidate-policy=final-b2", `--pairs=${await manifest(name, 1000, { mutateArm: mutation })}`,
        `--noise-report=${retryNoise}`, `--output=${output}`, "--require-performance"]);
      assert.equal(attempt.status === 0, expectedPass, attempt.stderr);
      const observed = JSON.parse(await readFile(output, "utf8"));
      assert.equal(observed.performancePassed, expectedPass);
      if (name === "one-arm-retry-storm") {
        const gate = observed.retryGates.find(gate => gate.name === "burst512" && gate.errorClass === null);
        assert.equal(gate.medianIncrease, 0); assert.equal(gate.pairedIncreases[0], .02); assert.equal(gate.passed, false);
      }
      if (name === "new-retry-class") assert.ok(observed.retryGates.some(gate => !gate.knownClass && !gate.passed));
    }
    const zeroBaselineRetries = run(["--candidate-policy=final-b2",
      `--pairs=${await manifest("zero-baseline-new-retry", 1000, { mutate: report => setRetries(report, 1) })}`,
      `--noise-report=${noise}`, "--require-performance"]);
    assert.notEqual(zeroBaselineRetries.status, 0, "A zero-retry A/A cannot silently admit a new retry class or rate");
    const earlyFile = path.join(directory, "early-recovery.json");
    const early = run(["--candidate-policy=final-b2",
      `--pairs=${await manifest("early-recovery", 1000, { mutate: report => setRetries(report, 1, "provider_transport_failed", false) })}`,
      `--noise-report=${noise}`, `--output=${earlyFile}`, "--require-performance"]);
    assert.notEqual(early.status, 0, "Recovery before the terminal observation window cannot vanish from failure rates");
    const earlyObservation = JSON.parse(await readFile(earlyFile, "utf8")).retryObservations[3].samples[0].candidate;
    assert.equal(earlyObservation.uniqueRetryableRuns, 0); assert.equal(earlyObservation.uniqueEverFailedRuns, 1);
    assert.equal(earlyObservation.allRecordedRecoveredRuns, 1);
    for (const [name, change, message] of [
      ["h4c-too-early", (_value, owner) => { owner.results[0].startTime = "2026-11-02T00:00:00.000Z"; }, /follow all candidate/],
      ["h4c-wrong-sut", value => { value.sourceRevision = H5_BASELINE_REVISIONS.B0; value.compiledBuildRevision = value.sourceRevision; }, /strictly equal/],
      ["h4c-observation-mode", value => { value.observationMode = H5_MODE; }, /H4e default deadlines/],
      ["old-h4c-proof", value => { value.protocolVersion = "v4-remote-streaming-original-local-stop-clock-stream";
        value.harnessProvenance.sourceRevision = "7d7e7a88d562a95a1d407b76474763b666c181f5"; }, /Old H4c geometry/],
      ["old-h4d-proof", value => { value.protocolVersion = "v4d-independent-agents-original-deadlines"; }, /Old H4c geometry/],
      ["h4e-wrong-harness", value => { value.harnessProvenance.sourceRevision = "d".repeat(40); }, /same frozen harness source/],
      ["h4e-wrong-measurement", value => { value.measurementSha256 = "old-h5a"; }, /same measured harness bytes/],
      ["h4e-shared-agent", value => { value.cases[3].controllerAuthority.rows[1].agent_id = value.cases[3].controllerAuthority.rows[0].agent_id; }, /distinct normal agents/],
      ["h4e-missing-stop-proof", value => { delete value.cases[5].localStopProof; }, /physical Stop/],
      ["h4e-provider-still-alive", value => { value.cases[5].localStopProof.processes.providerAbsent = false; }, /provider remains alive/],
      ["h4e-pending-local-lease", value => { value.cases[5].localStopProof.lease.status = "active"; }, /lease cleanup remains unsettled/],
      ["h4e-wrong-local-lease", value => { value.cases[5].localStopProof.lease.id = value.cases[3].controllerAuthority.rows[0].lease_id; }, /strictly equal/],
      ["h4e-ack-timing-mismatch", value => { value.cases[5].stopAcknowledgedAtMs++; }, /acknowledgement timing boundary/],
      ["h4e-missing-remote-leases", value => { delete value.cases[3].remoteLeases; }, /post-timing lease cleanup proof/],
      ["h4e-pending-remote-lease", value => { value.cases[3].remoteLeases[0].cleanupStatus = "pending"; }, /lease cleanup remains unsettled/],
      ["h4e-wrong-remote-lease", value => { value.cases[3].remoteLeases[0].id = value.cases[5].controllerAuthority.rows[0].lease_id; }, /strictly equal/],
      ["h4e-premature-remote-cleanup-proof", value => { value.cases[3].remoteLeasesCheckedAtMs = value.cases[3].settledAtMs - 1; }, /leases after recorded timing/],
      ["h4e-wrong-authority-company", value => { value.cases[3].controllerAuthority.rows[0].company_id = "00000000-0000-4000-8000-000000099999"; }, /authority company mismatch/],
      ["h4e-wrong-authority-run", value => { value.cases[3].controllerAuthority.rows[0].run_id = value.cases[5].runIds[0]; }, /authority run set mismatch/],
      ["h4e-missing-settlement", value => { delete value.cases[3].terminalObservation; }, /canonical run settlement/],
      ["h4e-missing-recorded-failures", value => { delete value.cases[3].recordedFailures; }, /post-timing recorded failure proof/],
    ]) {
      const report = JSON.parse(await readFile(originalProof, "utf8")), owner = report.suites[0].tests[0],
        value = JSON.parse(Buffer.from(owner.results[0].attachments[0].body, "base64").toString());
      change(value, owner); owner.results[0].attachments[0].body = Buffer.from(JSON.stringify(value)).toString("base64");
      const file = await save(`${name}-playwright.json`, report), sidecar = await inventory(value, file, name), output = path.join(directory, `${name}-result.json`);
      const attempt = run(["--candidate-policy=final-b2", `--pairs=${goodPairs}`, `--noise-report=${noise}`,
        `--original-h4e-proof=${file}`, `--original-h4e-inventory=${sidecar}`, `--output=${output}`, "--require-acceptance"]);
      assert.notEqual(attempt.status, 0, name);
      const rejected = JSON.parse(await readFile(output, "utf8"));
      assert.equal(rejected.performancePassed, true); assert.equal(rejected.acceptancePassed, false);
      assert.match(rejected.originalH4eConfirmation.reason, message);
    }
    const badOutput = path.join(directory, "still-misses.json");
    const bad = run(["--candidate-policy=final-b2", `--pairs=${await manifest("still-misses", 150000)}`,
      `--noise-report=${noise}`, `--output=${badOutput}`, "--require-acceptance"]);
    assert.notEqual(bad.status, 0);
    const rejected = JSON.parse(await readFile(badOutput, "utf8"));
    assert.equal(rejected.acceptancePassed, false);
    assert.equal(rejected.h5Assessments[0].candidateSlaPolicyPassed, false);
    for (const [name, mutate, message] of [
      ["old-h5a-protocol", report => { report.protocolVersion = "v5-complete-observation-original-sla"; }, /strictly equal/],
      ["old-h5b-protocol", report => { report.protocolVersion = "v5b-independent-agents-complete-observation-original-sla"; }, /strictly equal/],
      ["retry-ledger-hidden", report => { setRetries(report, 1); report.cases[3].h5.terminalObservation.uniqueRetryableRuns = 0; }, /Retry ledger/],
      ["missing-state-history", report => { delete report.cases[3].h5.terminalObservation.transitions; }, /state history/],
      ["missing-recorded-failures", report => { delete report.cases[3].recordedFailures; }, /post-timing recorded failure proof/],
      ["wrong-recorded-run", report => { report.cases[3].recordedFailures.rows[0].run_id = report.cases[5].runIds[0]; }, /run set mismatch/],
      ["wrong-recorded-company", report => { report.cases[3].recordedFailures.rows[0].company_id = "wrong"; }, /company mismatch/],
      ["wrong-recovered-schema", report => { setRetries(report, 1); report.cases[3].recordedFailures.rows[0].recovered_schema = "unknown"; }, /strictly equal/],
      ["missing-recorded-code", report => { setRetries(report, 1); report.cases[3].recordedFailures.rows[0].recovered_error_code = null; }, /closed recorded error code/],
      ["premature-recorded-snapshot", report => { report.cases[3].recordedFailures.queryStartedAtMs = report.cases[3].settledAtMs - 1; }, /post-timing failure snapshot/],
      ["unclosed-recorded-snapshot", report => { delete report.cases[3].recordedFailures.connectionClosedAtMs; }, /post-timing failure snapshot/],
      ["stop-recorded-provider-failure", report => { report.cases[5].recordedFailures.rows[0].current_error_code = "provider_transport_failed"; }, /recorded failed run must have recovered/],
      ["censored", report => { report.cases[3].h5.streaming.observation.censored = true; }, /false/],
      ["terminal-failed", report => { report.cases[3].terminalStatuses[99].status = "failed"; }, /successful drainage/],
      ["missing-independent-drain", report => { delete report.cases[3].h5.independentDrain; }, /independentDrain|verifiedAtMs|Cannot read/],
      ["tampered-independent-drain", report => { report.cases[3].h5.independentDrain.elapsedFromEpochMs++; }, /strictly equal/],
      ["result-missing", report => { report.cases[3].durable[99].resultAcceptedEvents = 0; }, /persisted result/],
      ["missing-delta", report => { report.cases[3].durable[99].individualDeltas--; }, /individualDeltas|result.events|512/],
      ["wrong-workload", report => { report.workloadSha256 = "old"; }, /registration changed/],
      ["pw-retry", (_report, owner) => { owner.results[0].retry = 1; }, /Retries/],
      ["pw-error", (_report, owner) => { owner.results[0].errors.push({ message: "unexpected API failure" }); }, /deep-equal/],
      ["wrong-observation-timeout", (_report, owner) => { owner.timeout = 900000; }, /1200000/],
    ]) {
      const result = run(["--candidate-policy=final-b2", `--pairs=${await manifest(name, 1000, { mutate })}`,
        `--noise-report=${noise}`, "--require-acceptance"]);
      assert.notEqual(result.status, 0, name); assert.match(result.stderr, message, name);
    }
    const outer = run(["--candidate-policy=final-b2", `--pairs=${await manifest("outer900", 1000, { duration: 950000 })}`,
      `--noise-report=${noise}`, "--require-acceptance"]);
    assert.notEqual(outer.status, 0, "Observed total duration900 miss cannot qualify final B2");
    const incomplete = JSON.parse(await readFile(await manifest("missing-owner", 1000), "utf8"));
    delete incomplete[0].candidatePlaywrightFile;
    const missing = run(["--candidate-policy=final-b2", `--pairs=${await save("missing-owner-manifest.json", incomplete)}`,
      `--noise-report=${noise}`, "--require-acceptance"]);
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /independent owning Playwright/);
    const global = JSON.parse(await readFile(await manifest("global-error", 1000), "utf8"));
    const globalOwner = JSON.parse(await readFile(global[0].candidatePlaywrightFile, "utf8"));
    globalOwner.errors = [{ message: "global teardown failed" }];
    await writeFile(global[0].candidatePlaywrightFile, JSON.stringify(globalOwner));
    const globalFailed = run(["--candidate-policy=final-b2", `--pairs=${await save("global-error-manifest.json", global)}`,
      `--noise-report=${noise}`, "--require-acceptance"]);
    assert.notEqual(globalFailed.status, 0); assert.match(globalFailed.stderr, /global error/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("browser CLI rejects the three-pairs-above-noise counterexample and ineligible evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-ingestion-gates-"));
  const script = new URL("./compare-native-ingestion-browser.ts", import.meta.url);
  const save = async (name, value) => { const file = path.join(directory, name); await writeFile(file, JSON.stringify(value)); return file; };
  async function manifest(prefix, improvements, sameRevision = false, mutate) {
    const entries = [];
    for (let index = 0; index < 5; index++) {
      const baseline = browserReport("baseline", 1000), candidate = browserReport(sameRevision ? "baseline" : "candidate", 1000 * (1 - improvements[index]));
      if (mutate && index === 0) mutate(candidate);
      entries.push({ baselineFile: await save(`${prefix}-${index}-baseline.json`, baseline),
        candidateFile: await save(`${prefix}-${index}-candidate.json`, candidate) });
    }
    return save(`${prefix}-pairs.json`, entries);
  }
  const run = args => spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  try {
    const noise = path.join(directory, "noise.json");
    const aa = run(["--phase=aa", `--pairs=${await manifest("aa", Array(5).fill(0.10), true)}`, `--output=${noise}`]);
    assert.equal(aa.status, 0, aa.stderr);
    const badOutput = path.join(directory, "three-wins.json");
    const bad = run([`--pairs=${await manifest("three-wins", [0.30, 0.30, 0.30, 0.01, -0.01])}`, `--noise-report=${noise}`, `--output=${badOutput}`, "--require-acceptance"]);
    assert.notEqual(bad.status, 0);
    const result = JSON.parse(await readFile(badOutput, "utf8"));
    assert.equal(result.acceptancePassed, false);
    assert.ok(result.gates.filter(gate => gate.improvementRequired).every(gate => gate.noiseExceedingPairedWins === 3));
    const good = run([`--pairs=${await manifest("four-wins", [0.30, 0.25, 0.20, 0.15, 0.01])}`, `--noise-report=${noise}`, "--require-acceptance"]);
    assert.equal(good.status, 0, good.stderr);
    const wide = run([`--pairs=${await manifest("int64-ordered-receipt", Array(5).fill(0.30), false, report => {
      const stop = report.cases[5];
      stop.controllerAuthority.rows[0].process_identity_seq = "9223372036854775806";
      stop.localStopProof.database.rows[0].process_identity_seq = "9223372036854775806";
      stop.localStopProof.database.rows[0].process_stopped_seq = "9223372036854775807";
    })}`, `--noise-report=${noise}`, "--require-acceptance"]);
    assert.equal(wide.status, 0, wide.stderr);
    for (const [name, change, message] of [
      ["smoke", report => { report.qualificationOnly = true; }, /Smoke cannot qualify/],
      ["source", report => { report.serverArtifact = "source-qualification"; }, /compiled server/],
      ["profile", report => { report.diagnosticOnly = true; }, /Diagnostic profiles/],
      ["profile-ineligible", report => { report.performanceAcceptanceEligible = false; }, /Profile-only evidence/],
      ["missing-retained-prelude", report => { report.cases.find(row => row.prelude).preludeProof.individualDeltas--; }, /stored prelude deltas/],
      ["legacy-protocol", report => { delete report.protocolVersion; }, /independent-agent/],
      ["old-local-protocol", report => { report.protocolVersion = "v2-compact-markers-original-clock-stream"; report.transport = "local"; }, /independent-agent/],
      ["old-remote-protocol", report => { report.protocolVersion = "v3-supported-remote-original-clock-stream"; }, /independent-agent/],
      ["old-h4c-geometry", report => { report.protocolVersion = "v4-remote-streaming-original-local-stop-clock-stream"; }, /independent-agent/],
      ["shared-participant-agent", report => { report.cases[3].controllerAuthority.rows[1].agent_id = report.cases[3].controllerAuthority.rows[0].agent_id; }, /distinct normal agents/],
      ["participant-outside-pool", report => { report.cases[3].controllerAuthority.rows[1].agent_id = "00000000-0000-4000-8000-000000099999"; }, /outside the normal agent pool/],
      ["incomplete-agent-pool", report => { report.remote.agentIds.pop(); }, /Incomplete independent/],
      ["unfinished-agent-setup", report => { report.remote.agentSetup.complete = false; }, /settle successfully/],
      ["rejected-agent-setup", report => { report.remote.agentSetup.attempts[0].status = "rejected"; }, /Rejected agent setup/],
      ["agent-setup-concurrency", report => { report.remote.agentSetup.concurrency = 9; }, /strictly equal/],
      ["agent-setup-overlap", report => { for (const row of report.remote.agentSetup.attempts.slice(0, 9)) { row.startedAtMs = 3; row.settledAtMs = 39; } }, /exceeded the fixed concurrency/],
      ["late-agent-setup", report => { report.remote.agentSetup.settledAtMs = 60; }, /before every case activation/],
      ["wrong-transport", report => { report.transport = "local"; }, /original local Stop transport/],
      ["missing-transport-policy", report => { delete report.transportPolicy; }, /explicit transport/],
      ["fake-remote-stop", report => { report.cases[5].transport = "sandbox-remote"; }, /Wrong per-case transport/],
      ["local-loaded-workload", report => { report.cases[3].transport = "local"; }, /Wrong per-case transport/],
      ["wrong-case-environment", report => { report.cases[5].environmentId = report.remote.environmentId; }, /normal environment/],
      ["missing-local-selection", report => { delete report.local; }, /local Stop runtime provenance/],
      ["shared-control-agent", report => { report.local.controlAgentId = report.remote.agentIds[0]; }, /separate normal control agent/],
      ["changed-local-command", report => { report.local.commandSha256 = "9".repeat(64); }, /Local Stop fixture changed/],
      ["changed-provider-cleanup", report => { report.remote.plugin.assetHashes["lease-cleanup.js"] = "9".repeat(64); }, /Provider cleanup build changed/],
      ["unregistered-resource-budget", report => { report.resourceBudgets.providerReadinessMs = 600000; }, /registered remote setup\/resource budgets/],
      ["missing-normal-remote", report => { delete report.remote; }, /normal remote runtime provenance/],
      ["missing-plugin", report => { delete report.remote.plugin; }, /plugin provenance/],
      ["resolver-override", report => { report.remote.selection = "forced external controller flag"; }, /normal API remote environment selection/],
      ["tls-unverified", report => { report.remote.tls.peerVerification = false; }, /TLS peer verification/],
      ["plaintext-remote", report => { report.remote.runnerPublicUrl = "ws://127.0.0.1:32100"; }, /endpoint must use verified WSS/],
      ["foreign-remote", report => { report.remote.runnerPublicUrl = "wss://example.com:32100"; }, /owned loopback/],
      ["different-provider-artifact", report => { report.remote.provider.nodeSha256 = "9".repeat(64); }, /artifact changed/],
      ["fixed-workload-changed", report => { report.cases[3].runs = 10; }, /Fixed workload changed/],
      ["missing-controller-authority", report => { delete report.cases[3].controllerAuthority; }, /controller authority proof/],
      ["authority-writable", report => { report.cases[3].controllerAuthority.observedReadOnly = "off"; }, /read-only transaction/],
      ["authority-wrong-isolation", report => { report.cases[3].controllerAuthority.observedIsolation = "read committed"; }, /repeatable-read isolation/],
      ["authority-late", report => { report.cases[3].controllerAuthority.checkedAtMs = 1000; }, /before the measured epoch/],
      ["authority-fractional-closed-time", report => { report.cases[3].controllerAuthority.connectionClosedAtMs = 999.5; }, /before the measured epoch/],
      ["authority-missing-run", report => { report.cases[3].controllerAuthority.rows.pop(); }, /Every remote run/],
      ["authority-wrong-run", report => { report.cases[3].controllerAuthority.rows[99].run_id = report.cases[3].controllerAuthority.rows[0].run_id; }, /run set mismatch/],
      ["authority-wrong-company", report => { report.cases[3].controllerAuthority.rows[99].company_id = "other"; }, /company mismatch/],
      ["authority-wrong-environment", report => { report.cases[3].controllerAuthority.rows[99].environment_id = "other"; }, /environment mismatch/],
      ["authority-wrong-provider", report => { report.cases[3].controllerAuthority.rows[99].provider = "fake"; }, /fake-plugin/],
      ["authority-missing-checkpoint", report => { report.cases[3].controllerAuthority.rows[99].checkpoint_part = null; }, /checkpoint header/],
      ["local-wrong-checkpoint-authority", report => { report.cases[5].controllerAuthority.kind = "database-controller-checkpoint"; }, /Wrong checkpoint authority/],
      ["local-fake-database-header", report => { report.cases[5].controllerAuthority.rows[0].checkpoint_part = "header"; }, /host-file authority/],
      ["missing-local-journal", report => { delete report.cases[5].controllerAuthority.localJournal; }, /owned local journal authority/],
      ["local-journal-wrong-run", report => { report.cases[5].controllerAuthority.localJournal.identity.runId = "other"; }, /Local journal identity mismatch/],
      ["local-journal-wrong-workspace", report => { report.cases[5].controllerAuthority.rows[0].admitted_execution_workspace_id = report.remote.environmentId; }, /Local journal identity mismatch/],
      ["local-journal-bookkeeping-alias", report => { report.cases[5].controllerAuthority.localJournal.identity.environmentLeaseId = report.cases[5].controllerAuthority.rows[0].lease_id; }, /Local journal identity mismatch/],
      ["local-missing-admitted-workspace", report => { delete report.cases[5].controllerAuthority.rows[0].admitted_execution_workspace_id; }, /admitted local workspace binding/],
      ["local-journal-wrong-policy", report => { report.cases[5].controllerAuthority.localJournal.checkpointEventPolicy = "control-v1"; }, /original local raw transport/],
      ["missing-wrapper-provenance", report => { delete report.cases[3].providerClocks; }, /wrapper launcher and PID/],
      ["remote-used-local-wrapper", report => { report.cases[3].providerClocks[99].launcher = "host-local"; }, /wrapper launcher/],
      ["local-used-remote-wrapper", report => { report.cases[5].providerClocks[0].launcher = "staged-remote"; }, /wrapper launcher/],
      ["missing-hello-pid", report => { delete report.cases[3].clockEvidence[99].providerPid; }, /hello provider PID/],
      ["missing-local-identity-event", report => { delete report.cases[5].controllerAuthority.rows[0].process_identity; }, /targetKind|local/],
      ["provider-authored-local-identity", report => { report.cases[5].controllerAuthority.rows[0].process_identity_source_event_id = "provider-event"; }, /server-authored/],
      ["missing-local-physical-proof", report => { delete report.cases[5].localStopProof; }, /physical Stop/],
      ["local-provider-still-alive", report => { report.cases[5].localStopProof.processes.providerAbsent = false; }, /remains alive/],
      ["local-group-still-alive", report => { report.cases[5].localStopProof.processes.groupAbsent = false; }, /false.*true|false !== true/],
      ["local-database-ack-missing", report => { report.cases[5].localStopProof.database.rows[0].cancellation_dispatch_state = "pending"; }, /acknowledged/],
      ["local-cleared-identity-no-receipt", report => { delete report.cases[5].localStopProof.database.rows[0].process_stopped_seq; }, /BigInt/],
      ["local-bigint-lexicographic-false-pass", report => {
        report.cases[5].controllerAuthority.rows[0].process_identity_seq = "90071992547409920";
        report.cases[5].localStopProof.database.rows[0].process_identity_seq = "90071992547409920";
        report.cases[5].localStopProof.database.rows[0].process_stopped_seq = "9007199254740993";
      }, /server stop receipt/],
      ["local-provider-stop-receipt", report => { report.cases[5].localStopProof.database.rows[0].process_stopped_source_event_id = "provider"; }, /null/],
      ["local-lease-cleanup-failed", report => { report.cases[5].localStopProof.lease.cleanupStatus = "failed"; }, /Local Stop lease cleanup/],
      ["local-lease-wrong-binding", report => { report.cases[5].localStopProof.lease.heartbeatRunId = "other"; }, /other/],
      ["missing-lease-cleanup", report => { delete report.cases[3].remoteLeases; }, /lease cleanup proof/],
      ["lease-pending", report => { report.cases[3].remoteLeases[99].status = "pending_cleanup"; }, /cleanup remains unsettled/],
      ["lease-wrong-binding", report => { report.cases[3].remoteLeases[99].providerLeaseId = "other"; }, /fake-plugin/],
      ["lease-check-before-timing", report => { report.cases[3].remoteLeasesCheckedAtMs = report.cases[3].settledAtMs - 1; }, /after recorded timing boundaries/],
      ["stop-timing-restamped", report => { report.cases[5].stopAcknowledgedAtMs++; }, /timing boundary changed/],
      ["unqualified-admission", report => { delete report.admissionProtocol; }, /admission protocol/],
      ["old-sequential-admission", report => { report.admissionProtocol = "sequential-provider-and-clock-readiness-before-common-epoch"; }, /admission protocol/],
      ["missing-activation-concurrency", report => { delete report.setupActivationConcurrency; }, /activation concurrency of two/],
      ["excessive-activation-concurrency", report => { report.setupActivationConcurrency = 10; }, /activation concurrency of two/],
      ["serial-activation-concurrency", report => { report.setupActivationConcurrency = 1; }, /activation concurrency of two/],
      ["wrong-case-activation-concurrency", report => { report.cases[3].setupActivationConcurrency = 1; }, /case's qualified setup activation/],
      ["extended-shared-readiness-deadline", report => { report.cases[3].readinessDeadlineMs++; }, /unchanged shared readiness deadline/],
      ["authority-before-all-ready", report => { report.cases[3].controllerAuthority.checkedAtMs = 699; }, /authority after every provider/],
      ["missing-live-provider-get", report => { report.cases[3].participants--; }, /provider GET must remain open/],
      ["missing-activation-record", report => { report.cases[3].activations.pop(); }, /activation timing/],
      ["wrong-activation-task", report => { report.cases[3].activations[99].issueId = "other"; }, /task must match actual controller/],
      ["wrong-activation-token", report => { report.cases[3].activations[99].token = "other"; }, /actual provider clock/],
      ["unfinished-activation", report => { report.cases[3].activations[99].status = "pending"; }, /unfinished setup activation/],
      ["unfinished-wave", report => { report.cases[3].activationWaves[49].statuses = ["rejected"]; }, /failed or unfinished setup wave/],
      ["overlapping-waves", report => { report.cases[3].activationWaves[1].startedAtMs = 110; }, /whole setup wave before/],
      ["oversized-wave", report => { report.cases[3].activationWaves[0].indices.push(3); }, /Wrong setup wave participants/],
      ["late-readiness-observation", report => { report.cases[3].activations[99].readinessObservedAtMs = 1001; }, /pre-epoch activation/],
      ["missing-provider-clock-hello", report => { report.cases[3].clockEvidence[99].hello = false; }, /actual provider needs its clock hello/],
      ["restamped-provider-readiness", report => { report.cases[3].clockEvidence[99].readinessObservedAtMs++; }, /actual clock observations/],
      ["unqualified-readiness-observation", report => { delete report.setupReadinessPollingMs; }, /readiness observation interval/],
      ["unfinished-cleanup", report => { report.cleanup.complete = false; }, /completed fixture cleanup/],
      ["cleanup-error", report => { report.cleanup.errors.push({ step: "restore", message: "timeout" }); }, /cleanup errors/],
      ["missing-paced-gaps", report => { delete report.cases[0].interChunkGaps; }, /inter-chunk paint gaps/],
      ["unmatched-visible-clock", report => { report.cases[0].matchedVisibleClocks--; }, /original provider clock/],
      ["unmatched-durable-clock", report => { report.cases[0].durable[0].matchedSourceClocks--; }, /original provider clock/],
      ["browser-trace", report => { report.browserRecording.trace = "on"; }, /trace capture off/],
      ["browser-video", report => { report.browserRecording.video = "on"; }, /video capture off/],
      ["browser-screencast", report => { report.browserRecording.screencast = true; }, /screencast capture off/],
    ]) {
      const rejected = run([`--pairs=${await manifest(name, Array(5).fill(0.30), false, change)}`, `--noise-report=${noise}`, "--require-acceptance"]);
      assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, message);
    }
    for (const [label, value] of [["null", null], ["missing", undefined], ["invalid", "not-a-sequence"], ["fractional", 1.5]]) {
      for (const field of ["identity", "stopped"]) {
        const rejected = run([`--pairs=${await manifest(`bigint-${field}-${label}`, Array(5).fill(0.30), false, report => {
          const stop = report.cases[5];
          if (field === "identity") {
            stop.controllerAuthority.rows[0].process_identity_seq = value;
            stop.localStopProof.database.rows[0].process_identity_seq = value;
          } else stop.localStopProof.database.rows[0].process_stopped_seq = value;
        })}`, `--noise-report=${noise}`, "--require-acceptance"]);
        assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /BigInt/);
      }
    }
    for (const [name, change, message] of [
      ["old-noise-protocol", report => { report.protocolVersion = "v2-compact-markers-original-clock-stream"; }, /different mixed protocol/],
      ["local-noise-transport", report => { report.transport = "local"; }, /different transport/],
      ["changed-noise-budget", report => { report.resourceBudgets.providerReadinessMs++; }, /budgets changed after A\/A/],
      ["changed-noise-transport-policy", report => { report.transportPolicy.operatorStop = "sandbox-remote"; }, /Transport policy changed after A\/A/],
      ["changed-noise-activation-concurrency", report => { report.setupActivationConcurrency = 10; }, /concurrency changed after A\/A/],
    ]) {
      const changed = JSON.parse(await readFile(noise, "utf8")); change(changed);
      const file = await save(name + ".json", changed);
      const rejected = run([`--pairs=${await manifest(name, Array(5).fill(0.30))}`, `--noise-report=${file}`, "--require-acceptance"]);
      assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, message);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
