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
  return { protocolVersion: "v2-compact-markers-original-clock-stream", admissionProtocol: "sequential-provider-and-clock-readiness-before-common-epoch", complete: true, cleanup: { complete: true, errors: [] }, qualificationOnly: false, diagnosticOnly: false, performanceAcceptanceEligible: true, browserRecording: { trace: "off", video: "off", screencast: false },
    sourceRevision: revision, compiledBuildRevision: revision, serverArtifact: "compiled", serverEntrySha256: `${revision}-compiled`,
    measurementSha256: "synthetic-fixed-fixture", compiledHotPathHashes: { append: "append", port: "port", runtime: "runtime" },
    cases: workloads.map(workload => ({ ...workload, stop: Boolean(workload.stop), persistedAfterReload: true,
      epochMs: 1000, preludeProof: workload.prelude ? { individualDeltas: workload.prelude, uniqueSourceIdentities: workload.prelude, verifiedAtMs: 999 } : undefined,
      visible: Array(workload.stop ? 3 : workload.events).fill({}), matchedVisibleClocks: workload.stop ? 3 : workload.events,
      firstVisibleAfterEmissionMs: latency, emissionToVisible: { medianMs: latency, p95Ms: latency },
      intendedToVisible: { p95Ms: latency }, drainThroughTerminalMs: latency,
      stopThroughTerminalMs: latency, stopThroughAcknowledgementMs: latency,
      durable: Array.from({ length: workload.runs }, (_, index) => ({ token: String(index), ordered: true,
        uniqueSourceIdentities: workload.events, individualDeltas: workload.events, matchedSourceClocks: workload.events })),
    })) };
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
    for (const [name, change, message] of [
      ["smoke", report => { report.qualificationOnly = true; }, /Smoke cannot qualify/],
      ["source", report => { report.serverArtifact = "source-qualification"; }, /compiled server/],
      ["profile", report => { report.diagnosticOnly = true; }, /Diagnostic profiles/],
      ["profile-ineligible", report => { report.performanceAcceptanceEligible = false; }, /Profile-only evidence/],
      ["missing-retained-prelude", report => { report.cases.find(row => row.prelude).preludeProof.individualDeltas--; }, /stored prelude deltas/],
      ["legacy-protocol", report => { delete report.protocolVersion; }, /v2 clock protocol/],
      ["unqualified-admission", report => { delete report.admissionProtocol; }, /admission protocol/],
      ["unfinished-cleanup", report => { report.cleanup.complete = false; }, /completed fixture cleanup/],
      ["cleanup-error", report => { report.cleanup.errors.push({ step: "restore", message: "timeout" }); }, /cleanup errors/],
      ["unmatched-visible-clock", report => { report.cases[0].matchedVisibleClocks--; }, /original provider clock/],
      ["unmatched-durable-clock", report => { report.cases[0].durable[0].matchedSourceClocks--; }, /original provider clock/],
      ["browser-trace", report => { report.browserRecording.trace = "on"; }, /trace capture off/],
      ["browser-video", report => { report.browserRecording.video = "on"; }, /video capture off/],
      ["browser-screencast", report => { report.browserRecording.screencast = true; }, /screencast capture off/],
    ]) {
      const rejected = run([`--pairs=${await manifest(name, Array(5).fill(0.30), false, change)}`, `--noise-report=${noise}`, "--require-acceptance"]);
      assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, message);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
