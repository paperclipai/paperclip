import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { noiseExceedingPairedWins } from "./native-ingestion-performance-gates.mjs";
import { H5_MODE, H5_PROTOCOL, H4D_PROTOCOL, H5_WORKLOAD_SHA256, H5_BASELINE_REVISIONS, ORIGINAL_BUDGETS,
  assessH5Arm, requireH5Candidate, assertParticipantSetup, assertParticipantTopology } from "../tests/e2e/fixtures/native-ingestion-h5.mjs";
import { validateArmInventory } from "./native-ingestion-h5-inventory.mjs";

// Each manifest entry points at native-ingestion-evidence JSON attachments
// from two isolated compiled-app runs. Run the variants in alternating order;
// timestamps here are never reconstructed from screenshots or success text.
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const manifestPath = arg("pairs");
assert.ok(manifestPath, "Pass --pairs=<JSON manifest of baselineFile/candidateFile pairs>");
const phase = arg("phase") ?? "compare", expectation = arg("expect") ?? "improvement";
const h5 = arg("observation-mode") === H5_MODE;
assert.ok(arg("observation-mode") === undefined || h5, "Unknown observation mode");
const candidatePolicy = arg("candidate-policy");
assert.ok(!arg("original-h4c-proof") && !arg("original-h4c-inventory"), "Old H4c proof arguments cannot confirm the new independent-agent geometry");
assert.ok(["aa", "compare"].includes(phase));
assert.ok(["improvement", "nonregression"].includes(expectation));
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Array<{ baselineFile: string; candidateFile: string;
  baselinePlaywrightFile?: string; candidatePlaywrightFile?: string; baselineInventoryFile?: string; candidateInventoryFile?: string }>;
assert.ok(manifest.length >= 5, "At least five actual paired application runs are required");
if (h5) assert.equal(manifest.length, 5, "H5 requires exactly five prospectively registered pairs");
const load = async (file: string) => JSON.parse(await readFile(path.resolve(path.dirname(manifestPath), file), "utf8"));
async function owningResult(reportPath: string, evidence?: any) {
  const bytes = await readFile(reportPath);
  const report = JSON.parse(bytes.toString("utf8")), tests: any[] = [];
  assert.deepEqual(report.errors ?? [], [], "Owning Playwright report has a global error");
  const visit = (value: any) => {
    if (Array.isArray(value)) for (const child of value) visit(child);
    else if (value && typeof value === "object") {
      if (Array.isArray(value.results) && Object.hasOwn(value, "expectedStatus")) tests.push(value);
      for (const [key, child] of Object.entries(value)) if (key !== "results") visit(child);
    }
  };
  visit(report); assert.equal(tests.length, 1, "One complete owning test is required; no partial selection");
  const test = tests[0]; assert.equal(test.results.length, 1, "No retry or omitted owning attempt");
  assert.equal(test.expectedStatus, "passed");
  const result = test.results[0], attachments = result.attachments.filter((item: any) => item.name === "native-ingestion-evidence");
  assert.ok(result.error === undefined || result.error === null, "Owning Playwright attempt has an error");
  assert.equal(attachments.length, 1, "Owning result must carry this exact evidence attachment");
  const attachment = attachments[0];
  const attached = attachment.body ? JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8"))
    : JSON.parse(await readFile(path.resolve(path.dirname(reportPath), attachment.path), "utf8"));
  if (evidence) assert.deepEqual(attached, evidence, "Playwright result belongs to a different evidence arm");
  return { evidence: attached, owner: { reportFile: reportPath, reportSha256: createHash("sha256").update(bytes).digest("hex"),
    status: result.status, retry: result.retry, errors: result.errors, startedAt: result.startTime,
    durationMs: result.duration, timeoutMs: test.timeout } };
}
async function loadArm(file: string, playwrightFile?: string, inventoryFile?: string) {
  const evidence = await load(file);
  if (!h5) return evidence;
  assert.ok(playwrightFile, "H5 requires each arm's independent owning Playwright JSON report");
  evidence.owningPlaywright = (await owningResult(path.resolve(path.dirname(manifestPath!), playwrightFile), evidence)).owner;
  assert.ok(inventoryFile, "H5 requires each arm's exact full artifact inventory sidecar");
  evidence.armInventory = await validateArmInventory(path.resolve(path.dirname(manifestPath!), inventoryFile),
    { evidence, owningPlaywright: evidence.owningPlaywright });
  return evidence;
}
const pairs = await Promise.all(manifest.map(async entry => ({ baseline: await loadArm(entry.baselineFile, entry.baselinePlaywrightFile, entry.baselineInventoryFile),
  candidate: await loadArm(entry.candidateFile, entry.candidatePlaywrightFile, entry.candidateInventoryFile) })));
const h5Assessments: any[] = [];
if (h5) {
  if (phase === "compare") {
    assert.ok(["final-b2", "cursor-nonregression"].includes(candidatePolicy ?? ""), "H5 requires an explicit candidate SLA policy");
    assert.equal(expectation, candidatePolicy === "cursor-nonregression" ? "nonregression" : "improvement");
  }
  for (const pair of pairs) {
    assert.ok(Object.values(H5_BASELINE_REVISIONS).includes(pair.baseline.sourceRevision), "H5 baseline must use the prospectively frozen B0 or B1 revision");
    const baselineVariant = pair.baseline.sourceRevision === H5_BASELINE_REVISIONS.B0 ? "B0" : "B1";
    assert.equal(pair.baseline.armInventory.variant, baselineVariant, "Baseline inventory role differs from its frozen revision");
    if (phase === "aa") assert.equal(pair.candidate.armInventory.variant, baselineVariant, "A/A must use the same baseline inventory role");
    if (phase === "compare" && candidatePolicy === "cursor-nonregression") {
      assert.equal(pair.baseline.sourceRevision, H5_BASELINE_REVISIONS.B0, "Cursor policy requires B0→B1");
      assert.equal(pair.candidate.sourceRevision, H5_BASELINE_REVISIONS.B1, "Cursor policy requires B0→B1");
      assert.equal(pair.candidate.armInventory.variant, "B1", "Cursor policy cannot stand in for final B2 acceptance");
    } else if (phase === "compare") {
      assert.equal(pair.candidate.armInventory.variant, "B2", "Final policy requires the qualified B2 inventory role");
      assert.ok(!Object.values(H5_BASELINE_REVISIONS).includes(pair.candidate.sourceRevision), "Final B2 must differ from both frozen baselines");
    }
    const baseline = assessH5Arm(pair.baseline, pair.baseline.owningPlaywright);
    const candidate = assessH5Arm(pair.candidate, pair.candidate.owningPlaywright);
    // The only prospectively known baseline workload SLA miss is loaded streaming.
    const allowed = new Set(["burst512:streaming120", "invocation:observed-total-duration900"]);
    for (const miss of baseline.misses) assert.ok(allowed.has(miss), "Unknown baseline deadline failure needs diagnosis");
    if (phase === "aa") for (const miss of candidate.misses) assert.ok(allowed.has(miss), "Unknown A/A deadline failure needs diagnosis");
    let candidateSlaPolicyError;
    if (phase === "compare") {
      try { requireH5Candidate(candidatePolicy, baseline, candidate); }
      catch (error) { candidateSlaPolicyError = error instanceof Error ? error.message : String(error); }
    }
    h5Assessments.push({ baseline, candidate, candidateSlaPolicyError, candidateSlaPolicyPassed: !candidateSlaPolicyError,
      owningPlaywright: { baseline: pair.baseline.owningPlaywright, candidate: pair.candidate.owningPlaywright } });
  }
}
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
function assertCaseAuthority(report: any, result: any) {
  const remote = report.remote, local = report.local;
  const authority = result.controllerAuthority;
  assert.equal(authority?.checkedBeforeMeasuredEpoch, true, "Missing controller authority proof before the measured epoch");
  assert.equal(authority?.kind, result.stop ? "host-file-journal" : "database-controller-checkpoint", "Wrong checkpoint authority for actual transport");
  assert.equal(authority?.observedReadOnly, "on", "Remote authority proof must observe a read-only transaction");
  assert.equal(authority?.observedIsolation, "repeatable read", "Remote authority proof must observe repeatable-read isolation");
  assert.ok(Number.isSafeInteger(authority?.checkedAtMs) && authority.checkedAtMs > 0
    && Number.isSafeInteger(authority.connectionClosedAtMs) && authority.connectionClosedAtMs > 0
    && authority.checkedAtMs <= authority.connectionClosedAtMs && authority.connectionClosedAtMs < result.epochMs,
  "Close the actual remote authority snapshot before the measured epoch");
  assert.equal(authority.rows?.length, result.runs, "Every remote run needs its controller checkpoint and lease proof");
  assertParticipantTopology(report, result);
  assert.deepEqual(authority.rows.map((row: any) => row.run_id).sort(), [...result.runIds].sort(), "Remote authority run set mismatch");
  assert.equal(new Set(authority.rows.map((row: any) => row.issue_id)).size, result.runs, "Duplicate remote issue authority");
  const authorityByRun = new Map<string, any>();
  for (const row of authority.rows) {
    assert.ok(uuid(row.issue_id) && uuid(row.lease_id), "Missing actual task/lease UUID");
    assert.equal(row.company_id, report.companyId, "Remote authority company mismatch");
    assert.equal(row.environment_id, result.environmentId, "Remote authority environment mismatch");
    assert.equal(row.runtime_mode, "native");
    if (!result.stop) {
      assert.ok(remote.agentIds.includes(row.agent_id), "Remote run did not use its normal remote agent");
      assert.equal(row.provider, "fake-plugin");
      assert.match(row.provider_lease_id, /^fake-plugin:\/\//);
      assert.equal(row.checkpoint_part, "header", "Missing actual database controller checkpoint header");
      assert.ok(Number.isSafeInteger(row.checkpoint_header_bytes) && row.checkpoint_header_bytes > 0);
    } else {
      assert.equal(row.agent_id, local.controlAgentId, "Stop did not use its separate local control agent");
      assert.equal(row.provider, "local", "Stop requires its normal local lease");
      assert.equal(row.provider_lease_id, null); assert.equal(row.checkpoint_part, null, "Local Stop must retain host-file authority without a database header");
      assert.ok(BigInt(String(row.process_identity_seq)) > 0n);
      assert.equal(row.process_identity_source_event_id, null, "Local identity must be server-authored");
      assert.equal(row.process_identity?.targetKind, "local");
      assert.equal(row.process_identity?.processPid, row.process_pid);
      assert.equal(row.process_identity?.processGroupId, row.process_group_id);
      assert.equal(row.process_identity?.processStartedAt, row.process_started_at);
      assert.ok(uuid(row.admitted_execution_workspace_id), "Missing actual admitted local workspace binding");
    }
    authorityByRun.set(row.run_id, row);
  }
  return { authority, authorityByRun };
}

function assertCaseSettlement(report: any, result: any, validated = assertCaseAuthority(report, result)) {
  const remote = report.remote, local = report.local;
  const { authority, authorityByRun } = validated;
  if (result.stop) {
    assert.equal(result.stopAcknowledgedAtMs, result.stopRequestedAtMs + result.stopThroughAcknowledgementMs, "Stop acknowledgement timing boundary changed");
    const row = authority.rows[0], journal = authority.localJournal, before = result.localProcesses;
    assert.equal(journal?.schema, "paperclip.runner.durable.control-plane-state.v1", "Missing owned local journal authority");
    assert.ok(sha256(journal.sha256) && journal.bytes > 0 && Number.isSafeInteger(journal.checkedAtMs)
      && journal.checkedAtMs < result.epochMs, "Verify actual local file journal before the measured epoch");
    assert.notEqual(journal.checkpointEventPolicy, "control-v1", "Preserve the original local raw transport recovery policy");
    for (const [field, expected] of [["runId", row.run_id], ["runnerInstanceId", row.runner_instance_id],
      ["normalizedSessionId", row.native_session_id], ["environmentLeaseId", row.admitted_execution_workspace_id]]) assert.equal(journal.identity?.[field], expected, "Local journal identity mismatch");
    assert.ok(before && before.hostname === row.process_identity.hostname && before.runnerPid === row.process_pid
      && before.processGroupId === row.process_group_id && before.providerPid === result.providerClocks[0].providerPid,
    "Local observed process ownership mismatch");
    assert.ok(before.runnerAlive && before.groupAlive && before.providerAlive && Number.isSafeInteger(before.checkedAtMs)
      && before.checkedAtMs < result.epochMs, "Independently observe all owned local processes before emission");
    const stopped = result.localStopProof, database = stopped?.database, after = database?.rows?.[0];
    assert.ok(stopped && Number.isSafeInteger(stopped.checkedAtMs) && stopped.checkedAtMs >= result.stopAcknowledgedAtMs
      && stopped.checkedAtMs >= result.settledAtMs, "Verify local physical Stop after timing boundaries");
    assert.equal(database?.kind, "host-file-journal"); assert.equal(database?.observedReadOnly, "on");
    assert.equal(database?.observedIsolation, "repeatable read"); assert.equal(database?.rows?.length, 1);
    assert.equal(database?.checkedBeforeMeasuredEpoch, false);
    assert.ok(Number.isSafeInteger(database.checkedAtMs) && database.checkedAtMs >= result.stopAcknowledgedAtMs
      && Number.isSafeInteger(database.connectionClosedAtMs) && database.connectionClosedAtMs >= database.checkedAtMs
      && database.connectionClosedAtMs <= stopped.checkedAtMs, "Local stopped database proof predates acknowledgement");
    for (const field of ["run_id", "company_id", "environment_id", "lease_id", "agent_id", "provider", "provider_lease_id",
      "admitted_execution_workspace_id", "process_identity_seq", "process_identity_source_event_id"]) assert.equal(after?.[field], row[field], "Local stopped database identity mismatch");
    assert.equal(after.status, "cancelled"); assert.equal(after.cancellation_dispatch_state, "acknowledged");
    if (!after.process_pid && !after.process_group_id) {
      assert.ok(BigInt(String(after.process_stopped_seq)) > BigInt(String(row.process_identity_seq)), "Cleared local process identity needs its server stop receipt");
      assert.equal(after.process_stopped_source_event_id, null);
      assert.equal(after.process_stopped?.processPid, before.runnerPid);
      assert.equal(after.process_stopped?.processGroupId, before.processGroupId);
      assert.equal(after.process_stopped?.processStartedAt, row.process_identity.processStartedAt);
    } else {
      assert.equal(after.process_pid, before.runnerPid); assert.equal(after.process_group_id, before.processGroupId);
    }
    for (const field of ["runnerPid", "processGroupId", "providerPid", "hostname"]) assert.equal(stopped.processes?.[field], before[field]);
    assert.equal(stopped.processes.runnerAbsent, true); assert.equal(stopped.processes.groupAbsent, true);
    assert.equal(stopped.processes.providerAbsent, true, "Local provider remains alive after Stop");
    const lease = stopped.lease;
    assert.equal(lease?.id, row.lease_id); assert.equal(lease?.companyId, report.companyId);
    assert.equal(lease?.environmentId, local.environmentId); assert.equal(lease?.heartbeatRunId, row.run_id);
    assert.equal(lease?.provider, "local"); assert.equal(lease?.providerLeaseId, null);
    assert.ok(["released", "expired", "failed"].includes(lease.status) && lease.releasedAt
      && lease.cleanupStatus !== "failed", "Local Stop lease cleanup remains unsettled");
    assert.equal(result.remoteLeases, undefined, "Local Stop cannot claim fake remote cleanup");
  } else {
    assert.equal(result.localStopProof, undefined, "Streaming cannot claim a local Stop proof");
    assert.equal(result.remoteLeases?.length, result.runs, "Every remote run needs post-timing lease cleanup proof");
    assert.deepEqual(result.remoteLeases.map((lease: any) => lease.runId).sort(), [...result.runIds].sort(), "Remote cleanup run set mismatch");
    assert.ok(Number.isSafeInteger(result.remoteLeasesCheckedAtMs) && result.remoteLeasesCheckedAtMs >= result.settledAtMs,
      "Verify remote leases after recorded timing boundaries");
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
  }
}


for (const pair of pairs) for (const arm of ["baseline", "candidate"] as const) {
  const report = pair[arm];
  assert.equal(report.protocolVersion, h5 ? H5_PROTOCOL : H4D_PROTOCOL,
    "Fresh browser acceptance requires the independent-agent observation or default-deadline protocol");
  assert.equal(report.transport, "sandbox-remote-with-local-stop", "V4 requires remote streaming and the original local Stop transport");
  assert.deepEqual(report.transportPolicy, { streaming: "sandbox-remote", operatorStop: "local",
    realCloudStop: "Separate required qualification; fake-plugin void receipts grant no remote Stop authority" }, "Missing explicit transport and real cloud Stop qualification policy");
  assert.deepEqual(report.resourceBudgets, { providerReadinessMs: 300_000, fullInvocationMs: 900_000,
    streamingMs: 120_000, terminalDrainageMs: 180_000, stopAcknowledgementMs: 30_000, remoteLeaseCleanupMs: 30_000 },
  "Keep the prospectively registered remote setup/resource budgets and existing streaming/control timeouts");
  const remote = report.remote;
  assert.equal(remote?.transport, "sandbox-remote", "Missing normal remote runtime provenance");
  assert.equal(remote?.plugin?.pluginKey, "paperclip.fake-sandbox-provider", "Missing normal remote plugin provenance");
  assert.equal(remote?.selection, "Normal plugin install + sandbox environment + agent defaultEnvironmentId; no runtime resolver override",
    "Use normal API remote environment selection");
  assert.ok(uuid(remote.environmentId) && uuid(report.companyId), "Missing actual remote company/environment identity");
  assert.ok(remote.agentIds?.length > 0 && remote.agentIds.every(uuid), "Missing actual remote agent selection");
  assert.deepEqual(Object.keys(remote.plugin.assetHashes ?? {}).sort(), ["lease-cleanup.js", "manifest.js", "plugin.js", "worker.js"]);
  for (const [file, hash] of Object.entries(remote.plugin.assetHashes)) {
    assert.ok(sha256(hash), "Missing actual provider plugin build fingerprint");
    assert.equal(hash, first.baseline.remote.plugin.assetHashes[file], "Provider cleanup build changed across matched samples");
  }
  const local = report.local;
  assert.equal(local?.transport, "local", "Missing normal local Stop runtime provenance");
  assert.equal(local?.selection, "Normal local environment + separate control agent defaultEnvironmentId; existing test-only Codex leaf command fixture",
    "Use normal local Stop environment selection");
  assert.ok(uuid(local.environmentId) && uuid(local.controlAgentId) && local.environmentId !== remote.environmentId
    && !remote.agentIds.includes(local.controlAgentId), "Local Stop needs a separate normal control agent and environment");
  for (const field of ["commandSha256", "loaderSha256"]) {
    assert.ok(sha256(local[field]), "Missing original local provider command provenance");
    assert.equal(local[field], first.baseline.local[field], "Local Stop fixture changed across matched samples");
  }
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
  assert.equal(report.admissionProtocol, "two-at-a-time-provider-and-clock-readiness-before-common-epoch", "Use the qualified pre-measurement admission protocol");
  assert.equal(report.setupActivationConcurrency, 2, "Keep the qualified setup activation concurrency of two");
  assert.equal(report.setupReadinessPollingMs, 50, "Keep the qualified setup readiness observation interval");
  assert.equal(report.complete, true); assert.equal(report.qualificationOnly, false, "Smoke cannot qualify performance");
  assertParticipantSetup(report);
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
  if (h5) for (const field of ["manifestFileSha256", "aggregateSha256", "qualifiedReceiptSha256", "inventorySummarySha256", "revision"])
    assert.equal(report.armInventory[field], first[arm].armInventory[field], "Full qualified artifact inventory changed between samples");
  assert.equal(report.measurementSha256, first.baseline.measurementSha256, "Fixture/observer protocol changed between runs");
  assert.match(report.harnessProvenance?.sourceRevision ?? "", /^[a-f0-9]{40}$/, "Missing frozen harness source revision");
  assert.equal(report.harnessProvenance.sourceStatus, "");
  for (const field of ["sourceRevision", "sourceHashes", "driverLockSha256"])
    assert.deepEqual(report.harnessProvenance[field], first.baseline.harnessProvenance[field], "Harness source changed between arms");
  if (phase === "aa") assert.equal(report.sourceRevision, first.baseline.sourceRevision, "A/A must use one source revision");
  for (const name of names) {
    const result = report.cases.find((item: any) => item.name === name);
    assert.ok(result, `Missing fixed workload ${name}`);
    const fixed = workloads.find(item => item.name === name)!;
    for (const field of ["runs", "events", "intervalMs", "prelude", "stop"] as const) assert.equal(result[field], fixed[field], `Fixed workload changed: ${name}.${field}`);
    assert.equal(result.transport, result.stop ? "local" : "sandbox-remote", "Wrong per-case transport; fake-plugin does not qualify remote Stop");
    assert.equal(result.environmentId, result.stop ? local.environmentId : remote.environmentId, "Wrong per-case normal environment");
    assert.equal(result.setupActivationConcurrency, 2, "Keep each case's qualified setup activation concurrency of two");
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
    const { authority, authorityByRun } = assertCaseAuthority(report, result);
    assert.equal(result.providerClocks?.length, result.runs, "Every actual provider needs its wrapper launcher and PID");
    assert.deepEqual(result.providerClocks.map((clock: any) => clock.runId).sort(), [...result.runIds].sort());
    assert.equal(new Set(result.providerClocks.map((clock: any) => clock.providerPid)).size, result.runs);
    for (const clock of result.providerClocks) {
      assert.equal(clock.launcher, result.stop ? "host-local" : "staged-remote", "Actual wrapper launcher does not match transport");
      assert.ok(Number.isSafeInteger(clock.providerPid) && clock.providerPid > 1, "Missing actual provider PID");
      const stream = result.clockEvidence?.find((stream: any) => stream.nonce === clock.nonce);
      assert.equal(stream?.launcher, clock.launcher, "Clock hello launcher proof missing");
      assert.equal(stream?.providerPid, clock.providerPid, "Clock hello provider PID proof missing");
      assert.equal(result.durable.find((proof: any) => proof.runId === clock.runId)?.token, clock.nonce);
    }
    assert.equal(result.participants, result.runs, "Every provider GET must remain open before the common epoch");
    assert.ok(Number.isSafeInteger(result.setupReadinessStartedAtMs) && result.setupReadinessStartedAtMs > 0);
    assert.equal(result.readinessDeadlineMs, result.setupReadinessStartedAtMs + report.resourceBudgets.providerReadinessMs,
      "Keep one unchanged shared readiness deadline");
    assert.ok(Number.isSafeInteger(result.allReadyObservedAtMs) && result.allReadyObservedAtMs >= result.setupReadinessStartedAtMs
      && result.allReadyObservedAtMs <= result.readinessDeadlineMs && result.allReadyObservedAtMs < result.epochMs,
    "All actual providers and clocks must be ready before the epoch and shared deadline");
    assert.ok(authority.checkedAtMs >= result.allReadyObservedAtMs, "Check actual controller authority after every provider is ready");
    assert.equal(result.activations?.length, result.runs, "Every actual participant needs its setup activation timing");
    assert.deepEqual(result.activations.map((entry: any) => entry.index).sort((a: number, b: number) => a - b),
      Array.from({ length: result.runs }, (_, index) => index), "Setup activation indices must cover every participant once");
    const waves = result.activationWaves;
    assert.equal(waves?.length, Math.ceil((result.runs - 1) / 2), "Background setup must use bounded waves of two");
    for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
      const wave = waves[waveIndex], firstIndex = 1 + waveIndex * 2;
      const indices = Array.from({ length: Math.min(2, result.runs - firstIndex) }, (_, offset) => firstIndex + offset);
      assert.equal(wave.index, waveIndex); assert.deepEqual(wave.indices, indices, "Wrong setup wave participants");
      assert.deepEqual(wave.statuses, indices.map(() => "fulfilled"), "A failed or unfinished setup wave cannot qualify");
      assert.ok(Number.isSafeInteger(wave.startedAtMs) && Number.isSafeInteger(wave.settledAtMs)
        && wave.startedAtMs >= (waveIndex ? waves[waveIndex - 1].settledAtMs : result.setupReadinessStartedAtMs)
        && wave.settledAtMs >= wave.startedAtMs && wave.settledAtMs <= result.allReadyObservedAtMs,
      "Finish the whole setup wave before starting the next one");
    }
    for (const activation of result.activations) {
      const row = authority.rows.find((row: any) => row.issue_id === activation.issueId);
      assert.ok(row, "Setup activation task must match actual controller authority");
      const clock = result.providerClocks.find((clock: any) => clock.runId === row.run_id);
      assert.equal(activation.token, clock.nonce, "Setup activation must match its actual provider clock");
      assert.equal(activation.status, "fulfilled", "An unfinished setup activation cannot qualify");
      for (const field of ["startedAtMs", "requestSettledAtMs", "providerReadyAtMs", "clockHelloAtMs", "readinessObservedAtMs", "settledAtMs"]) {
        assert.ok(Number.isSafeInteger(activation[field]) && activation[field] > 0 && activation[field] < result.epochMs,
          "Missing actual pre-epoch activation/readiness timing");
      }
      assert.ok(activation.requestSettledAtMs >= activation.startedAtMs && activation.providerReadyAtMs >= activation.startedAtMs
        && activation.clockHelloAtMs >= activation.startedAtMs
        && activation.readinessObservedAtMs >= Math.max(activation.requestSettledAtMs, activation.providerReadyAtMs, activation.clockHelloAtMs)
        && activation.settledAtMs >= activation.readinessObservedAtMs && activation.settledAtMs <= result.allReadyObservedAtMs,
      "Actual provider GET and hello must precede observed readiness");
      const stream = result.clockEvidence.find((stream: any) => stream.nonce === activation.token);
      assert.equal(stream.hello, true, "Every actual provider needs its clock hello");
      for (const field of ["providerReadyAtMs", "clockHelloAtMs", "readinessObservedAtMs"]) assert.equal(stream[field], activation[field], "Readiness metadata must match actual clock observations");
      if (activation.index === 0) assert.equal(activation.waveIndex, null);
      else {
        const waveIndex = Math.floor((activation.index - 1) / 2), wave = waves[waveIndex];
        assert.equal(activation.waveIndex, waveIndex);
        assert.ok(activation.startedAtMs >= wave.startedAtMs && activation.settledAtMs <= wave.settledAtMs,
          "Keep each activation inside its settled setup wave");
      }
    }
    assert.equal(result.settledAtMs, result.epochMs + result.drainThroughTerminalMs, "Terminal timing boundary changed");
    assertCaseSettlement(report, result, { authority, authorityByRun });
    for (const proof of result.durable) {
      assert.equal(proof.ordered, true); assert.equal(proof.uniqueSourceIdentities, proof.individualDeltas);
      assert.equal(proof.matchedSourceClocks, proof.individualDeltas, "Every durable measured delta needs an original provider clock");
      if (!result.stop) assert.equal(proof.individualDeltas, result.events);
    }
    const reference = first.baseline.cases.find((item: any) => item.name === name);
    for (const field of ["runs", "events", "intervalMs", "prelude", "stop"]) assert.equal(result[field], reference[field], `Workload changed: ${name}.${field}`);
  }
}
let originalH4dConfirmation: Record<string, any> | undefined;
if (h5 && phase === "compare" && candidatePolicy === "final-b2") {
  originalH4dConfirmation = { required: true, passed: false, reason: "Later H4d default-mode full functional proof on the same source and geometry is pending" };
  if (arg("original-h4d-proof")) {
    try {
      assert.ok(arg("original-h4d-inventory"), "H4d original-deadline proof requires its full artifact inventory sidecar");
      const { evidence: proof, owner } = await owningResult(path.resolve(arg("original-h4d-proof")!));
      assert.equal(owner.status, "passed"); assert.equal(owner.retry, 0); assert.deepEqual(owner.errors, []);
      assert.equal(owner.timeoutMs, ORIGINAL_BUDGETS.fullInvocationMs);
      assert.ok(owner.durationMs > 0 && owner.durationMs < ORIGINAL_BUDGETS.fullInvocationMs);
      assert.equal(proof.protocolVersion, H4D_PROTOCOL, "Old H4c geometry cannot confirm H5b");
      assertParticipantSetup(proof);
      assert.deepEqual(proof.agentTopology, first.candidate.agentTopology);
      assert.equal(proof.observationMode, undefined, "Confirmation must use H4d default deadlines");
      assert.equal(proof.harnessProvenance?.sourceRevision, first.candidate.harnessProvenance.sourceRevision, "H4d confirmation must use the same frozen harness source");
      assert.deepEqual(proof.harnessProvenance.sourceHashes, first.candidate.harnessProvenance.sourceHashes);
      assert.equal(proof.harnessProvenance.driverLockSha256, first.candidate.harnessProvenance.driverLockSha256);
      assert.equal(proof.harnessProvenance.sourceStatus, "");
      assert.equal(proof.measurementSha256, first.candidate.measurementSha256, "H4d confirmation must bind the same measured harness bytes");
      assert.deepEqual(proof.resourceBudgets, ORIGINAL_BUDGETS);
      assert.equal(proof.complete, true); assert.equal(proof.qualificationOnly, false); assert.equal(proof.diagnosticOnly, false);
      assert.equal(proof.performanceAcceptanceEligible, true); assert.equal(proof.serverArtifact, "compiled");
      assert.equal(proof.cleanup?.complete, true); assert.deepEqual(proof.cleanup.errors, []);
      assert.deepEqual(proof.browserRecording, first.candidate.browserRecording);
      assert.equal(proof.sourceRevision, first.candidate.sourceRevision); assert.equal(proof.compiledBuildRevision, first.candidate.compiledBuildRevision);
      assert.equal(proof.serverEntrySha256, first.candidate.serverEntrySha256);
      assert.deepEqual(proof.compiledHotPathHashes, first.candidate.compiledHotPathHashes);
      assert.equal(proof.transport, first.candidate.transport); assert.deepEqual(proof.transportPolicy, first.candidate.transportPolicy);
      assert.deepEqual(proof.cases.map((item: any) => item.name), names, "Original confirmation must include all six workloads");
      for (const fixed of workloads) {
        const item = proof.cases.find((item: any) => item.name === fixed.name);
        assertCaseSettlement(proof, item);
        for (const field of ["runs", "events", "intervalMs", "prelude", "stop"] as const) assert.equal(item[field], fixed[field]);
        assert.equal(item.persistedAfterReload, true); assert.equal(item.durable.length, fixed.runs);
        assert.equal(item.matchedVisibleClocks, item.visible.length);
        assert.ok(item.visible.length >= (fixed.stop ? 3 : fixed.events));
        assert.equal(item.runIds.length, fixed.runs); assert.equal(new Set(item.runIds).size, fixed.runs);
        for (const row of item.durable) {
          assert.equal(row.ordered, true); assert.equal(row.uniqueSourceIdentities, row.individualDeltas);
          assert.equal(row.matchedSourceClocks, row.individualDeltas);
          if (!fixed.stop) assert.equal(row.individualDeltas, fixed.events);
        }
      }
      const latestCandidateEnd = Math.max(...pairs.map(pair => Date.parse(pair.candidate.owningPlaywright.startedAt) + pair.candidate.owningPlaywright.durationMs));
      assert.ok(Date.parse(owner.startedAt) > latestCandidateEnd, "Original confirmation must follow all candidate arms");
      assert.ok(pairs.every(pair => proof.companyId !== pair.baseline.companyId && proof.companyId !== pair.candidate.companyId), "Original confirmation needs a fresh disposable company/database");
      const inventory = await validateArmInventory(path.resolve(arg("original-h4d-inventory")!), { evidence: proof, owningPlaywright: owner });
      for (const field of ["manifestFileSha256", "aggregateSha256", "qualifiedReceiptSha256", "inventorySummarySha256", "revision"] as const)
        assert.equal(inventory[field], first.candidate.armInventory[field], "Original confirmation used a different full qualified artifact inventory");
      originalH4dConfirmation = { required: true, passed: true, owner, inventory, sourceRevision: proof.sourceRevision };
    } catch (error) {
      originalH4dConfirmation.reason = error instanceof Error ? error.message : String(error);
    }
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
  scope: "Compiled-app streaming with100 independent normal agents and the original local Stop workload; real cloud Stop is separately required",
  agentTopology: first.baseline.agentTopology,
  transportPolicy: first.baseline.transportPolicy, additionalRealCloudStopQualificationRequired: true,
  admissionProtocol: first.baseline.admissionProtocol, setupActivationConcurrency: first.baseline.setupActivationConcurrency,
  protocolVersion: first.baseline.protocolVersion, transport: first.baseline.transport,
  resourceBudgets: first.baseline.resourceBudgets,
  phase, expectation, pairCount: pairs.length, baselineRevision: first.baseline.sourceRevision,
  candidateRevision: first.candidate.sourceRevision, measurementSha256: first.baseline.measurementSha256,
  gatesSha256: createHash("sha256").update(await readFile(new URL("./native-ingestion-performance-gates.mjs", import.meta.url))).digest("hex"),
  comparatorSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"), measurements,
  primaryLoadedWorkload: "burst512", complete: true,
  ...(h5 ? { observationMode: H5_MODE, workloadSha256: H5_WORKLOAD_SHA256, candidatePolicy, h5Assessments,
    artifactInventories: { baseline: first.baseline.armInventory, candidate: first.candidate.armInventory }, originalH4dConfirmation,
    originalProtocolAcceptance: "Baseline SLA misses are retained; H5b complete observation is not an original-deadline PASS",
    finalH4dFunctionalPassRequired: candidatePolicy === "final-b2" } : {}),
};
if (phase === "compare") {
  assert.ok(arg("noise-report"), "Comparison requires its frozen A/A --noise-report");
  const noise = JSON.parse(await readFile(arg("noise-report")!, "utf8"));
  assert.equal(noise.phase, "aa"); assert.equal(noise.complete, true);
  if (h5) {
    assert.equal(noise.observationMode, H5_MODE); assert.equal(noise.workloadSha256, H5_WORKLOAD_SHA256);
    assert.equal(noise.h5Assessments?.length, 5, "Fresh complete H5 A/A outcomes are required");
    for (const field of ["manifestFileSha256", "aggregateSha256", "qualifiedReceiptSha256", "inventorySummarySha256", "revision"])
      assert.equal(noise.artifactInventories?.baseline?.[field], result.artifactInventories.baseline[field], "Baseline inventory changed after H5 A/A");
  }
  assert.equal(noise.protocolVersion, result.protocolVersion, "Noise report uses a different mixed protocol");
  assert.equal(noise.transport, result.transport, "Noise report uses a different transport");
  assert.deepEqual(noise.transportPolicy, result.transportPolicy, "Transport policy changed after A/A calibration");
  assert.equal(noise.admissionProtocol, result.admissionProtocol, "Admission protocol changed after A/A calibration");
  assert.equal(noise.setupActivationConcurrency, result.setupActivationConcurrency, "Setup activation concurrency changed after A/A calibration");
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
  result.performancePassed = result.gates.every((entry: any) => entry.passed)
    && (!h5 || h5Assessments.every(entry => entry.candidateSlaPolicyPassed));
  result.acceptancePassed = result.performancePassed && (!originalH4dConfirmation || originalH4dConfirmation.passed);
}
if (arg("output")) await writeFile(arg("output")!, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes("--require-performance")) {
  assert.equal(h5, true, "H5b performance-only gating is explicit; default H4d keeps original deadlines");
  assert.equal(phase, "compare");
  assert.equal(result.performancePassed, true, "H5 performance/SLA gates failed; retain results and diagnose");
}
if (process.argv.includes("--require-acceptance")) {
  assert.equal(phase, "compare", "A/A calibrates noise; it is not performance acceptance");
  assert.equal(result.acceptancePassed, true, "Browser performance acceptance failed; retain results and diagnose");
}
