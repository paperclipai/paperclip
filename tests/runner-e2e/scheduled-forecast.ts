import { createHash } from "node:crypto";
import { centsToUsd, unitsToCents, usdToUnits } from "../../packages/shared/src/money.js";
import measurements from "./scheduled-measurements.json" with { type: "json" };
import type { MatrixExecution } from "./types.js";
import type { EvalOperationsManifest } from "./operations.js";

type Sample = (typeof measurements.samples)[number];
const cohortKey = (sample: Sample) => JSON.stringify([sample.definitionHash, sample.model, sample.environmentId,
  sample.runtimeMode, sample.route, sample.priceVersion]);
const usd = (units: bigint) => centsToUsd(unitsToCents(units));
const average = (values: bigint[]) => values.length
  ? (values.reduce((sum, value) => sum + value, 0n) + BigInt(Math.floor(values.length / 2))) / BigInt(values.length) : null;

function statistics(values: bigint[]) {
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    mean: average(sorted),
    median: sorted.length ? average(sorted.length % 2 ? [sorted[middle]!] : [sorted[middle - 1]!, sorted[middle]!]) : null,
    p95: sorted.length >= 20 ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null,
  };
}

function summarize(samples: Sample[]) {
  const cost = statistics(samples.map(sample => usdToUnits(sample.knownModelUsd)));
  const time = statistics(samples.map(sample => BigInt(sample.attemptDurationMs)));
  return {
    samples: cost.count,
    modelUsd: { mean: cost.mean === null ? null : usd(cost.mean), median: cost.median === null ? null : usd(cost.median),
      p95: cost.p95 === null ? null : usd(cost.p95) },
    attemptMs: { mean: time.mean === null ? null : Number(time.mean), median: time.median === null ? null : Number(time.median),
      p95: time.p95 === null ? null : Number(time.p95) },
  };
}

function total(rows: ReturnType<typeof summarize>[]) {
  return {
    modelUsd: rows.length && rows.every(row => row.modelUsd.mean !== null)
      ? usd(rows.reduce((sum, row) => sum + usdToUnits(row.modelUsd.mean!), 0n)) : null,
    summedAttemptMs: rows.length && rows.every(row => row.attemptMs.mean !== null)
      ? rows.reduce((sum, row) => sum + row.attemptMs.mean!, 0) : null,
  };
}

export function scheduledForecast(
  executions: MatrixExecution[], models: EvalOperationsManifest["models"], snapshot = measurements,
) {
  const seen = new Set<string>();
  for (const sample of snapshot.samples) {
    if (seen.has(sample.attemptId)) throw new Error("Duplicate forecast attempt");
    seen.add(sample.attemptId);
    if (!Number.isSafeInteger(sample.attemptDurationMs) || sample.attemptDurationMs < 0 || usdToUnits(sample.knownModelUsd) < 0n
        || !/^[0-9a-f]{40}$/.test(sample.sourceRevision)
        || [sample.definitionHash, sample.resultSha256, sample.ledgerSha256, sample.ledgerFinalHash].some(hash => !/^[0-9a-f]{64}$/.test(hash))) {
      throw new Error("Invalid forecast measurement or provenance");
    }
  }
  if (new Set(executions.map(execution => execution.id)).size !== executions.length) throw new Error("Duplicate forecast execution");
  const cells = executions.map(execution => {
    const retained = snapshot.samples.filter(sample => sample.executionId === execution.id);
    const cohorts = [...new Set(retained.map(cohortKey))].map(key => ({
      key, ...summarize(retained.filter(sample => cohortKey(sample) === key)),
    }));
    const samples = retained.map(sample => {
      const mismatches = [
        sample.definitionHash === execution.suiteDefinitionHash ? null : "definition",
        sample.model === execution.profile.model ? null : "model",
        sample.environmentId === execution.environment.id ? null : "environment",
        sample.runtimeMode === execution.profile.expectedRuntimeMode ? null : "runtime",
        sample.route === "braintrust" ? null : "route",
        models.some(model => model.price.model === sample.model && model.price.version === sample.priceVersion) ? null : "pricing",
      ].filter(value => value !== null);
      return { ...sample, mismatches };
    });
    return { executionId: execution.id, currentDefinitionHash: execution.suiteDefinitionHash,
      historicalSuccessful: summarize(cohorts.length === 1 ? retained : []), historicalCohorts: cohorts,
      compatibleSuccessful: summarize(samples.filter(sample => sample.mismatches.length === 0)), samples };
  });
  return {
    measurementSnapshotSha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    measuredHost: snapshot.host, costStatus: snapshot.costStatus, sampleScope: snapshot.sampleScope,
    historicalSuccessfulSelection: total(cells.map(cell => cell.historicalSuccessful)),
    compatibleSuccessfulSelection: total(cells.map(cell => cell.compatibleSuccessful)),
    hostedModelUsd: null, hostedAttemptMs: null, selectionP95: null,
    cells, limitations: [...snapshot.limitations,
      "Compatibility compares definition, model, environment, runtime, route and price version; source revisions remain explicit",
      "Per-cell P95 uses nearest rank only with at least 20 samples; it is descriptive, not a confidence bound",
      "Summed attempt time is serial attempt work, not campaign wall time, summed agent time or billed runner time",
      "Historical successful samples do not estimate failure frequency; every failure remains in campaign accounting"],
  };
}
