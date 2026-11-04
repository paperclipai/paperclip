import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
function browserReport(revision, latency) {
  const companyId = "00000000-0000-4000-8000-000000000001", environmentId = "00000000-0000-4000-8000-000000000002";
  const localEnvironmentId = "00000000-0000-4000-8000-000000000003", controlAgentId = "00000000-0000-4000-8000-000000000004";
  const remoteAgentId = "00000000-0000-4000-8000-000000000005";
  const id = (kind, caseIndex, index) => `00000000-0000-4000-8000-${(kind * 100000 + caseIndex * 1000 + index).toString(16).padStart(12, "0")}`;
  const transportPolicy = { streaming: "sandbox-remote", operatorStop: "local",
    realCloudStop: "Separate required qualification; fake-plugin void receipts grant no remote Stop authority" };
  return { protocolVersion: "v4-remote-streaming-original-local-stop-clock-stream", transport: "sandbox-remote-with-local-stop", transportPolicy, companyId,
    resourceBudgets: { providerReadinessMs: 300000, fullInvocationMs: 900000, streamingMs: 120000,
      terminalDrainageMs: 180000, stopAcknowledgementMs: 30000, remoteLeaseCleanupMs: 30000 },
    local: { transport: "local", environmentId: localEnvironmentId, controlAgentId,
      selection: "Normal local environment + separate control agent defaultEnvironmentId; existing test-only Codex leaf command fixture",
      commandSha256: "6".repeat(64), loaderSha256: "7".repeat(64) },
    remote: { transport: "sandbox-remote", revision, buildRevision: revision, environmentId, agentIds: [remoteAgentId],
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
        agent_id: stop ? controlAgentId : remoteAgentId,
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
        settledAtMs: 1000 + latency, stopRequestedAtMs: stop ? 1000 : undefined,
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
          uniqueSourceIdentities: stop ? 3 : workload.events, individualDeltas: stop ? 3 : workload.events, matchedSourceClocks: stop ? 3 : workload.events })),
      };
    }) };
}

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
  const run = args => spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8" });
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
      ["legacy-protocol", report => { delete report.protocolVersion; }, /v4 mixed clock protocol/],
      ["old-local-protocol", report => { report.protocolVersion = "v2-compact-markers-original-clock-stream"; report.transport = "local"; }, /v4 mixed clock protocol/],
      ["old-remote-protocol", report => { report.protocolVersion = "v3-supported-remote-original-clock-stream"; }, /v4 mixed clock protocol/],
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
