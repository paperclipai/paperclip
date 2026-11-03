// Shared by the real owner-path harness and compiled-browser comparator.
export const SERVICE_REPEATABILITY_LIMITS = Object.freeze({
  maximumPairedRelativeDifference: 0.20,
  maximumMedianArmDrift: 0.10,
});

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export function noiseExceedingPairedWins(improvements, noiseEnvelopeRelative) {
  if (!Number.isFinite(noiseEnvelopeRelative) || noiseEnvelopeRelative < 0
    || improvements.length < 5 || !improvements.every(Number.isFinite)) {
    throw new Error("Finite noise and at least five paired improvements are required");
  }
  const requiredPairedWins = Math.ceil(improvements.length * 0.8);
  const count = improvements.filter(value => value > noiseEnvelopeRelative).length;
  return { noiseExceedingPairedWins: count, requiredPairedWins,
    pairedWinRequirementPassed: count >= requiredPairedWins };
}

export function evaluateServiceRepeatability(report) {
  const failures = [];
  if (report.phase !== "aa") failures.push("Only A/A calibrates repeatability");
  if (report.incomplete !== false || report.cleanupComplete !== true) failures.push("Evidence and resource cleanup must be complete");
  const workload = report.workload ?? {};
  if (workload.quick !== false) failures.push("Smoke cannot qualify repeatability");
  if (!Number.isInteger(workload.pairs) || workload.pairs < 5) failures.push("At least five alternating pairs are required");
  if (workload.events !== 32 || workload.groups !== 16) failures.push("The frozen 16 groups of 32 events are required");
  const histories = [1000, 10000, 100000], scenarios = ["ordered", "replay", "late-gap", "warm-suffix"];
  if (!histories.every(value => workload.histories?.includes(value))
    || !scenarios.every(value => workload.scenarios?.includes(value))) failures.push("The full fixed workload matrix is required");
  const cases = [];
  for (const history of histories) for (const scenario of scenarios) {
    const rows = (report.results ?? []).filter(item => item.history === history && item.scenario === scenario);
    const row = rows[0], baseline = row?.baseline?.samples, repeat = row?.candidate?.samples;
    if (rows.length !== 1 || !Array.isArray(baseline) || !Array.isArray(repeat)
      || baseline.length !== workload.pairs || repeat.length !== workload.pairs
      || ![...baseline, ...repeat].every(item => Number.isFinite(item.elapsedMs) && item.elapsedMs > 0)) {
      failures.push(`Missing or invalid paired samples: ${history}/${scenario}`); continue;
    }
    if (scenario === "late-gap") continue;
    const maximumPairedRelativeDifference = Math.max(...baseline.map((sample, index) => Math.abs(repeat[index].elapsedMs - sample.elapsedMs) / sample.elapsedMs));
    const baselineMedian = median(baseline.map(item => item.elapsedMs));
    const medianArmDrift = Math.abs(median(repeat.map(item => item.elapsedMs)) - baselineMedian) / baselineMedian;
    cases.push({ history, scenario, maximumPairedRelativeDifference, medianArmDrift,
      passed: maximumPairedRelativeDifference <= SERVICE_REPEATABILITY_LIMITS.maximumPairedRelativeDifference
        && medianArmDrift <= SERVICE_REPEATABILITY_LIMITS.maximumMedianArmDrift });
  }
  return { limits: SERVICE_REPEATABILITY_LIMITS, eligible: failures.length === 0,
    eligibilityFailures: failures, cases, passed: failures.length === 0 && cases.length === 9 && cases.every(item => item.passed),
    excluded: "Late-gap single-operation latency is structural-only; its complete paired evidence is still required" };
}
