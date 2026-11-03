import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { noiseExceedingPairedWins } from "./native-ingestion-performance-gates.mjs";

// Each manifest entry points at native-ingestion-evidence JSON attachments
// from two isolated compiled-app runs. Run the variants in alternating order;
// timestamps here are never reconstructed from screenshots or success text.
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const manifestPath = arg("pairs");
assert.ok(manifestPath, "Pass --pairs=<JSON manifest of baselineFile/candidateFile pairs>");
const phase = arg("phase") ?? "compare", expectation = arg("expect") ?? "improvement";
assert.ok(["aa", "compare"].includes(phase));
assert.ok(["improvement", "nonregression"].includes(expectation));
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Array<{ baselineFile: string; candidateFile: string }>;
assert.ok(manifest.length >= 5, "At least five actual paired application runs are required");
const load = async (file: string) => JSON.parse(await readFile(path.resolve(path.dirname(manifestPath), file), "utf8"));
const pairs = await Promise.all(manifest.map(async entry => ({ baseline: await load(entry.baselineFile), candidate: await load(entry.candidateFile) })));
const workloads = [
  { name: "paced", runs: 1, events: 128, intervalMs: 25, prelude: 0, stop: false },
  { name: "burst16", runs: 1, events: 16, intervalMs: 0, prelude: 0, stop: false },
  { name: "burst128", runs: 10, events: 128, intervalMs: 0, prelude: 0, stop: false },
  { name: "burst512", runs: 100, events: 512, intervalMs: 0, prelude: 0, stop: false },
  { name: "existing-history", runs: 10, events: 128, intervalMs: 0, prelude: 1000, stop: false },
  { name: "operator-stop", runs: 1, events: 512, intervalMs: 100, prelude: 0, stop: true },
];
const names = workloads.map(item => item.name);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const first = pairs[0];
const sha256 = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
for (const pair of pairs) for (const arm of ["baseline", "candidate"] as const) {
  const report = pair[arm];
  assert.equal(report.protocolVersion, "v3-supported-remote-original-clock-stream", "Fresh browser acceptance requires the qualified v3 remote clock protocol");
  assert.equal(report.transport, "sandbox-remote", "V3 requires the supported sandbox remote transport");
  assert.deepEqual(report.resourceBudgets, { providerReadinessMs: 300_000, fullInvocationMs: 900_000,
    streamingMs: 120_000, terminalDrainageMs: 180_000, stopAcknowledgementMs: 30_000, remoteLeaseCleanupMs: 30_000 },
  "Keep the prospectively registered remote setup/resource budgets and existing streaming/control timeouts");
  const remote = report.remote;
  assert.equal(remote?.transport, "sandbox-remote", "Missing normal remote runtime provenance");
  assert.equal(remote?.plugin?.pluginKey, "paperclip.fake-sandbox-provider", "Missing normal remote plugin provenance");
  assert.equal(remote?.selection, "Normal plugin install + sandbox environment + agent defaultEnvironmentId; no runtime resolver override",
    "Use normal API remote environment selection");
  assert.ok(uuid(remote.environmentId) && uuid(report.companyId), "Missing actual remote company/environment identity");
  assert.equal(remote.revision, report.sourceRevision);
  assert.equal(remote.buildRevision, report.compiledBuildRevision);
  assert.equal(remote.tls?.peerVerification, true, "Remote TLS peer verification is required");
  assert.equal(typeof remote.runnerPublicUrl, "string", "Missing actual remote WSS endpoint");
  const endpoint = new URL(remote.runnerPublicUrl);
  assert.equal(endpoint.protocol, "wss:", "Actual remote endpoint must use verified WSS");
  assert.equal(endpoint.hostname, "127.0.0.1", "Use the owned loopback remote fixture endpoint");
  assert.ok(Number(endpoint.port) > 0 && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    "Use the recorded owned remote fixture endpoint without overrides");
  for (const value of [remote.tls?.caSha256, remote.tls?.serverCertificateSha256, remote.runner?.sha256,
    remote.provider?.nodeSha256, remote.provider?.wrapperSha256, remote.provider?.fixtureSha256]) {
    assert.ok(sha256(value), "Missing remote TLS, daemon or provider artifact fingerprint");
  }
  assert.equal(remote.provider.fixtureSha256, report.fixtureSha256, "Staged provider fixture changed");
  assert.ok(remote.runner.metadata?.prpTransportModes?.includes("dial_wss"), "Remote daemon must support verified WSS");
  for (const [group, field] of [["runner", "sha256"], ["provider", "nodeSha256"], ["provider", "wrapperSha256"], ["provider", "fixtureSha256"]]) {
    assert.equal(remote[group][field], first.baseline.remote[group][field], "Remote provider/daemon artifact changed across matched samples");
  }
  assert.equal(report.admissionProtocol, "sequential-provider-and-clock-readiness-before-common-epoch", "Use the qualified pre-measurement admission protocol");
  assert.equal(report.setupReadinessPollingMs, 50, "Keep the qualified setup readiness observation interval");
  assert.equal(report.complete, true); assert.equal(report.qualificationOnly, false, "Smoke cannot qualify performance");
  assert.equal(report.cleanup?.complete, true, "Acceptance requires completed fixture cleanup");
  assert.deepEqual(report.cleanup?.errors, [], "Acceptance rejects fixture cleanup errors");
  assert.notEqual(report.diagnosticOnly, true, "Diagnostic profiles cannot qualify unprofiled performance");
  assert.notEqual(report.performanceAcceptanceEligible, false, "Profile-only evidence cannot qualify performance");
  assert.equal(report.browserRecording?.trace, "off", "Acceptance requires browser trace capture off");
  assert.equal(report.browserRecording?.video, "off", "Acceptance requires browser video capture off");
  assert.equal(report.browserRecording?.screencast, false, "Acceptance requires browser screencast capture off");
  assert.equal(report.serverArtifact, "compiled", "Performance acceptance requires the compiled server and shipped UI");
  assert.ok(report.serverEntrySha256 && report.measurementSha256);
  assert.equal(report.compiledBuildRevision, report.sourceRevision, "Compiled build stamp does not match the measured revision");
  assert.ok(Object.keys(report.compiledHotPathHashes ?? {}).length >= 3, "Missing compiled ingestion/runtime fingerprints");
  assert.equal(report.sourceRevision, first[arm].sourceRevision, "Every sample must cover the same revision per arm");
  assert.equal(report.serverEntrySha256, first[arm].serverEntrySha256, "Compiled artifact changed between samples");
  assert.deepEqual(report.compiledHotPathHashes, first[arm].compiledHotPathHashes, "Compiled ingestion/runtime changed between samples");
  assert.equal(report.measurementSha256, first.baseline.measurementSha256, "Fixture/observer protocol changed between runs");
  if (phase === "aa") assert.equal(report.sourceRevision, first.baseline.sourceRevision, "A/A must use one source revision");
  for (const name of names) {
    const result = report.cases.find((item: any) => item.name === name);
    assert.ok(result, `Missing fixed workload ${name}`);
    const fixed = workloads.find(item => item.name === name)!;
    for (const field of ["runs", "events", "intervalMs", "prelude", "stop"] as const) assert.equal(result[field], fixed[field], `Fixed workload changed: ${name}.${field}`);
    assert.equal(result.persistedAfterReload, true);
    assert.equal(result.matchedVisibleClocks, result.visible?.length, "Every observed marker needs its original provider clock");
    assert.ok(result.matchedVisibleClocks >= (result.stop ? 3 : result.events), "Missing foreground render/clock observations");
    if (name === "paced") {
      assert.ok(result.interChunkGaps?.count >= 1, "Paced streaming needs observed inter-chunk paint gaps");
      assert.equal(result.interChunkGaps.paintCount, result.interChunkGaps.count + 1);
    }
    if (result.prelude) {
      assert.equal(result.preludeProof?.individualDeltas, result.prelude, "Existing history requires independently stored prelude deltas");
      assert.equal(result.preludeProof?.uniqueSourceIdentities, result.prelude);
      assert.ok(result.preludeProof?.verifiedAtMs < result.epochMs, "Verify retained prelude before releasing measured emission");
    }
    assert.equal(result.durable.length, result.runs, "Every background run needs independent delta persistence proof");
    assert.equal(result.runIds?.length, result.runs, "Every remote participant needs its actual run identity");
    assert.ok(result.runIds.every(uuid), "Missing actual remote run UUID");
    assert.equal(new Set(result.runIds).size, result.runs, "Duplicate remote run identity");
    assert.deepEqual(result.durable.map((proof: any) => proof.runId).sort(), [...result.runIds].sort(), "Durable proof run set mismatch");
    const authority = result.controllerAuthority;
    assert.equal(authority?.checkedBeforeMeasuredEpoch, true, "Missing remote database controller authority proof");
    assert.equal(authority?.observedReadOnly, "on", "Remote authority proof must observe a read-only transaction");
    assert.equal(authority?.observedIsolation, "repeatable read", "Remote authority proof must observe repeatable-read isolation");
    assert.ok(Number.isSafeInteger(authority?.checkedAtMs) && authority.checkedAtMs > 0
      && Number.isSafeInteger(authority.connectionClosedAtMs) && authority.connectionClosedAtMs > 0
      && authority.checkedAtMs <= authority.connectionClosedAtMs && authority.connectionClosedAtMs < result.epochMs,
    "Close the actual remote authority snapshot before the measured epoch");
    assert.equal(authority.rows?.length, result.runs, "Every remote run needs its controller checkpoint and lease proof");
    assert.deepEqual(authority.rows.map((row: any) => row.run_id).sort(), [...result.runIds].sort(), "Remote authority run set mismatch");
    assert.equal(new Set(authority.rows.map((row: any) => row.issue_id)).size, result.runs, "Duplicate remote issue authority");
    const authorityByRun = new Map<string, any>();
    for (const row of authority.rows) {
      assert.ok(uuid(row.issue_id) && uuid(row.lease_id), "Missing actual remote task/lease UUID");
      assert.equal(row.company_id, report.companyId, "Remote authority company mismatch");
      assert.equal(row.environment_id, remote.environmentId, "Remote authority environment mismatch");
      assert.equal(row.runtime_mode, "native");
      assert.equal(row.provider, "fake-plugin");
      assert.match(row.provider_lease_id, /^fake-plugin:\/\//);
      assert.equal(row.checkpoint_part, "header", "Missing actual database controller checkpoint header");
      assert.ok(Number.isSafeInteger(row.checkpoint_header_bytes) && row.checkpoint_header_bytes > 0);
      authorityByRun.set(row.run_id, row);
    }
    assert.equal(result.remoteLeases?.length, result.runs, "Every remote run needs post-timing lease cleanup proof");
    assert.deepEqual(result.remoteLeases.map((lease: any) => lease.runId).sort(), [...result.runIds].sort(), "Remote cleanup run set mismatch");
    assert.ok(Number.isSafeInteger(result.remoteLeasesCheckedAtMs) && result.remoteLeasesCheckedAtMs >= result.settledAtMs
      && (!result.stop || result.remoteLeasesCheckedAtMs >= result.stopAcknowledgedAtMs), "Verify remote leases after recorded timing boundaries");
    assert.equal(result.settledAtMs, result.epochMs + result.drainThroughTerminalMs, "Terminal timing boundary changed");
    if (result.stop) assert.equal(result.stopAcknowledgedAtMs, result.stopRequestedAtMs + result.stopThroughAcknowledgementMs, "Stop acknowledgement timing boundary changed");
    for (const lease of result.remoteLeases) {
      const row = authorityByRun.get(lease.runId);
      assert.equal(lease.id, row.lease_id); assert.equal(lease.companyId, report.companyId);
      assert.equal(lease.environmentId, remote.environmentId); assert.equal(lease.provider, row.provider);
      assert.equal(lease.providerLeaseId, row.provider_lease_id);
      assert.ok(["released", "expired", "failed"].includes(lease.status) && lease.releasedAt
        && lease.cleanupStatus === "success", "Remote lease cleanup remains unsettled");
      if (lease.terminationReceipt) {
        const receipt = lease.terminationReceipt;
        assert.equal(receipt.schema, "paperclip.remote-termination.v1");
        assert.equal(receipt.companyId, report.companyId); assert.equal(receipt.runId, lease.runId);
        assert.equal(receipt.leaseId, lease.id); assert.equal(receipt.provider, lease.provider);
        assert.equal(receipt.providerLeaseId, lease.providerLeaseId);
        assert.ok(["stopped", "destroyed"].includes(receipt.state), "Invalid recorded remote termination receipt");
      }
    }
    for (const proof of result.durable) {
      assert.equal(proof.ordered, true); assert.equal(proof.uniqueSourceIdentities, proof.individualDeltas);
      assert.equal(proof.matchedSourceClocks, proof.individualDeltas, "Every durable measured delta needs an original provider clock");
      if (!result.stop) assert.equal(proof.individualDeltas, result.events);
    }
    const reference = first.baseline.cases.find((item: any) => item.name === name);
    for (const field of ["runs", "events", "intervalMs", "prelude", "stop"]) assert.equal(result[field], reference[field], `Workload changed: ${name}.${field}`);
  }
}
const metric = (item: any, key: string): number => key.split(".").reduce((value, part) => value[part], item);
const measurements = names.flatMap(name => {
  const observed = first.baseline.cases.find((item: any) => item.name === name);
  const keys = ["firstVisibleAfterEmissionMs", "emissionToVisible.medianMs", "drainThroughTerminalMs",
    ...(name === "paced" ? ["interChunkGaps.maxMs"] : []),
    ...(observed.emissionToVisible.p95Ms === undefined ? [] : ["emissionToVisible.p95Ms", "intendedToVisible.p95Ms"]),
    ...(observed.stop ? ["stopThroughTerminalMs", "stopThroughAcknowledgementMs"] : [])];
  return keys.map(key => {
    const samples = pairs.map(pair => {
      const baseline = metric(pair.baseline.cases.find((item: any) => item.name === name), key);
      const candidate = metric(pair.candidate.cases.find((item: any) => item.name === name), key);
      assert.ok(Number.isFinite(baseline) && baseline > 0 && Number.isFinite(candidate) && candidate >= 0, `Invalid latency ${name}.${key}`);
      return { baseline, candidate, improvementRelative: (baseline - candidate) / baseline };
    });
    return { name, metric: key, baselineMedianMs: median(samples.map(sample => sample.baseline)),
      candidateMedianMs: median(samples.map(sample => sample.candidate)),
      medianPairedImprovementRelative: median(samples.map(sample => sample.improvementRelative)),
      candidateWins: samples.filter(sample => sample.improvementRelative > 0).length,
      aaNoiseEnvelopeRelative: phase === "aa" ? Math.max(...samples.map(sample => Math.abs(sample.improvementRelative))) : undefined,
      samples };
  });
});
const result: Record<string, any> = {
  scope: "Compiled-app deterministic-provider/browser acceptance; live-provider qualification remains separate",
  protocolVersion: first.baseline.protocolVersion, transport: first.baseline.transport,
  resourceBudgets: first.baseline.resourceBudgets,
  phase, expectation, pairCount: pairs.length, baselineRevision: first.baseline.sourceRevision,
  candidateRevision: first.candidate.sourceRevision, measurementSha256: first.baseline.measurementSha256,
  gatesSha256: createHash("sha256").update(await readFile(new URL("./native-ingestion-performance-gates.mjs", import.meta.url))).digest("hex"),
  comparatorSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"), measurements,
  primaryLoadedWorkload: "burst512", complete: true,
};
if (phase === "compare") {
  assert.ok(arg("noise-report"), "Comparison requires its frozen A/A --noise-report");
  const noise = JSON.parse(await readFile(arg("noise-report")!, "utf8"));
  assert.equal(noise.phase, "aa"); assert.equal(noise.complete, true);
  assert.equal(noise.protocolVersion, result.protocolVersion, "Noise report uses a different remote protocol");
  assert.equal(noise.transport, result.transport, "Noise report uses a different transport");
  assert.deepEqual(noise.resourceBudgets, result.resourceBudgets, "Resource budgets changed after A/A calibration");
  assert.equal(noise.baselineRevision, result.baselineRevision); assert.equal(noise.measurementSha256, result.measurementSha256);
  assert.equal(noise.gatesSha256, result.gatesSha256, "Acceptance gates changed after A/A calibration");
  assert.equal(noise.comparatorSha256, result.comparatorSha256, "Comparator changed after A/A calibration");
  assert.ok(noise.pairCount >= 5);
  result.gates = measurements.map(item => {
    const control = noise.measurements.find((entry: any) => entry.name === item.name && entry.metric === item.metric);
    assert.ok(control);
    const improvementRequired = expectation === "improvement" && item.name === "burst512"
      && ["emissionToVisible.p95Ms", "intendedToVisible.p95Ms", "drainThroughTerminalMs"].includes(item.metric);
    const noRegression = -item.medianPairedImprovementRelative <= control.aaNoiseEnvelopeRelative;
    const paired = noiseExceedingPairedWins(item.samples.map(sample => sample.improvementRelative), control.aaNoiseEnvelopeRelative);
    const improvement = paired.pairedWinRequirementPassed
      && item.medianPairedImprovementRelative > control.aaNoiseEnvelopeRelative;
    return { name: item.name, metric: item.metric, improvementRequired, noiseEnvelopeRelative: control.aaNoiseEnvelopeRelative,
      noiseExceedingPairedWins: paired.noiseExceedingPairedWins, requiredPairedWins: paired.requiredPairedWins,
      passed: improvementRequired ? improvement : noRegression };
  });
  result.acceptancePassed = result.gates.every((entry: any) => entry.passed);
}
if (arg("output")) await writeFile(arg("output")!, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes("--require-acceptance")) {
  assert.equal(phase, "compare", "A/A calibrates noise; it is not performance acceptance");
  assert.equal(result.acceptancePassed, true, "Browser performance acceptance failed; retain results and diagnose");
}
