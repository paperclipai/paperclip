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
const names = ["paced", "burst16", "burst128", "burst512", "existing-history", "operator-stop"];
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const first = pairs[0];
for (const pair of pairs) for (const arm of ["baseline", "candidate"] as const) {
  const report = pair[arm];
  assert.equal(report.protocolVersion, "v2-compact-markers-original-clock-stream", "Fresh browser acceptance requires the qualified v2 clock protocol");
  assert.equal(report.admissionProtocol, "sequential-provider-and-clock-readiness-before-common-epoch", "Use the qualified pre-measurement admission protocol");
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
