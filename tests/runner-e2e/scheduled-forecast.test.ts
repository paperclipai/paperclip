import { expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { scheduledForecast } from "./scheduled-forecast.js";
import { scheduledSelection } from "./scheduled-operations.js";
import measurements from "./scheduled-measurements.json" with { type: "json" };
import prices from "./scheduled-prices.json" with { type: "json" };
import type { EvalOperationsManifest } from "./operations.js";

const models = prices.models as EvalOperationsManifest["models"];
const selected = (cadence: "daily" | "weekly") => runnerMatrix.filter(cell => scheduledSelection(cadence).includes(cell.id));

it.each([
  ["daily", "0.428650100", 107286], ["weekly", "0.793676500", 158093],
] as const)("retains exact historical %s measurements without inventing tail estimates", (cadence, modelUsd, summedAttemptMs) => {
  const forecast = scheduledForecast(selected(cadence), models);
  expect(forecast.historicalSuccessfulSelection).toEqual({ modelUsd, summedAttemptMs });
  expect(forecast.measurementSnapshotSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(forecast).toMatchObject({ hostedModelUsd: null, hostedAttemptMs: null, selectionP95: null, costStatus: "estimated" });
  expect(forecast.historicalHostedSelection).toEqual(cadence === "daily" ? { modelUsd, summedAttemptMs } : { modelUsd: null, summedAttemptMs: null });
  expect(forecast.compatibleSuccessfulSelection).toEqual({ modelUsd: null, summedAttemptMs: null });
  for (const cell of forecast.cells) {
    expect(cell.historicalSuccessful.samples).toBe(1);
    expect(cell.historicalSuccessful.modelUsd.p95).toBeNull();
    expect(cell.historicalSuccessful.attemptMs.p95).toBeNull();
    expect(cell.samples[0]!.resultSha256).toMatch(/^[0-9a-f]{64}$/);
  }
});

it("does not treat the older feedback definition as a current measurement", () => {
  const forecast = scheduledForecast(selected("daily"), models);
  const feedback = forecast.cells.find(cell => cell.executionId.startsWith("feedback-"))!;
  expect(feedback.samples[0]!.mismatches).toContain("definition");
  expect(feedback.compatibleSuccessful.samples).toBe(0);
  expect(forecast.compatibleSuccessfulSelection).toEqual({ modelUsd: null, summedAttemptMs: null });
});

it.each(["definitionHash", "model", "environmentId", "runtimeMode", "route", "priceVersion"] as const)("excludes incompatible %s samples without dropping their evidence", field => {
  const snapshot = structuredClone(measurements);
  const cell = selected("daily").find(cell => cell.id.startsWith("core-"))!;
  const sample = snapshot.samples.find(sample => sample.executionId === cell.id)!;
  sample[field] = field === "definitionHash" ? "a".repeat(64) : "different";
  const forecast = scheduledForecast([cell], models, snapshot);
  expect(forecast.cells[0]!.compatibleSuccessful.samples).toBe(0);
  expect(forecast.cells[0]!.samples).toHaveLength(1);
  expect(forecast.compatibleSuccessfulSelection.modelUsd).toBeNull();
});

it("keeps missing cells and empty selections unknown", () => {
  const snapshot = structuredClone(measurements);
  snapshot.samples = [];
  expect(scheduledForecast(selected("daily"), models, snapshot).historicalSuccessfulSelection)
    .toEqual({ modelUsd: null, summedAttemptMs: null });
  expect(scheduledForecast([], models).compatibleSuccessfulSelection)
    .toEqual({ modelUsd: null, summedAttemptMs: null });
});

it("computes distributions within one cohort and does not sum P95s", () => {
  const snapshot = structuredClone(measurements);
  const cell = selected("daily").find(cell => cell.id.startsWith("core-"))!;
  const sample = snapshot.samples.find(sample => sample.executionId === cell.id)!;
  snapshot.samples = Array.from({ length: 20 }, (_, index) => ({ ...sample, attemptId: `attempt-${index}`,
    knownModelUsd: String(index + 1), attemptDurationMs: (index + 1) * 1000 }));
  const forecast = scheduledForecast([cell], models, snapshot);
  expect(forecast.cells[0]!.compatibleSuccessful).toEqual({ samples: 20,
    modelUsd: { mean: "10.500000000", median: "10.500000000", p95: "19.000000000" },
    attemptMs: { mean: 10500, median: 10500, p95: 19000 } });
  expect(forecast.selectionP95).toBeNull();
  snapshot.samples.push({ ...sample, attemptId: "other-cohort", definitionHash: "a".repeat(64) });
  const mixed = scheduledForecast([cell], models, snapshot);
  expect(mixed.cells[0]!.historicalCohorts).toHaveLength(2);
  expect(mixed.historicalSuccessfulSelection.modelUsd).toBeNull();
  expect(mixed.cells[0]!.compatibleSuccessful.samples).toBe(20);
});

it("rejects duplicate artifacts and invalid measurement provenance", () => {
  const snapshot = structuredClone(measurements);
  snapshot.samples.push(snapshot.samples[0]!);
  expect(() => scheduledForecast(selected("daily"), models, snapshot)).toThrow("Duplicate forecast attempt");
  snapshot.samples.pop();
  snapshot.samples[0]!.resultSha256 = "missing";
  expect(() => scheduledForecast(selected("daily"), models, snapshot)).toThrow("provenance");
});

it("preserves nanodollar costs and genuine measured zero", () => {
  const snapshot = structuredClone(measurements);
  const cell = selected("daily").find(cell => cell.id.startsWith("core-"))!;
  const sample = snapshot.samples.find(sample => sample.executionId === cell.id)!;
  snapshot.samples = [{ ...sample, knownModelUsd: "0.000000001", attemptDurationMs: 0 }];
  expect(scheduledForecast([cell], models, snapshot).compatibleSuccessfulSelection)
    .toEqual({ modelUsd: "0.000000001", summedAttemptMs: 0 });
  snapshot.samples[0]!.knownModelUsd = "0";
  expect(scheduledForecast([cell], models, snapshot).compatibleSuccessfulSelection.modelUsd).toBe("0.000000000");
});

it("keeps hosts separate and requires hosted evidence for the whole selection", () => {
  const snapshot = structuredClone(measurements);
  const cell = selected("daily").find(cell => cell.id.startsWith("core-"))!;
  const sample = snapshot.samples.find(sample => sample.executionId === cell.id)!;
  snapshot.samples = [sample, { ...sample, attemptId: "different-host", measurementHost: "local-docker-linux-arm64" }];
  const forecast = scheduledForecast([cell], models, snapshot);
  expect(forecast.cells[0]!.historicalCohorts).toHaveLength(2);
  expect(forecast.cells[0]!.compatibleSuccessful.samples).toBe(0);
  expect(forecast.cells[0]!.samples).toHaveLength(2);
  expect(forecast.hostedModelUsd).toBe(sample.knownModelUsd);
  expect(scheduledForecast(selected("weekly"), models).hostedModelUsd).toBeNull();
});

it("uses current hosted totals only when every selected definition matches", () => {
  const snapshot = structuredClone(measurements);
  for (const cell of selected("daily")) snapshot.samples.find(sample => sample.executionId === cell.id)!.definitionHash = cell.suiteDefinitionHash;
  const forecast = scheduledForecast(selected("daily"), models, snapshot);
  expect(forecast.hostedModelUsd).toBe("0.428650100");
  expect(forecast.hostedAttemptMs).toBe(107286);
});

it.each([
  { measurementHost: undefined }, { measurementHost: "" },
  { finalModelRequests: 0 }, { finalModelRequests: 1.5 },
])("rejects invalid host or final-receipt provenance %j", patch => {
  const snapshot = structuredClone(measurements);
  Object.assign(snapshot.samples[0]!, patch);
  expect(() => scheduledForecast(selected("daily"), models, snapshot)).toThrow("provenance");
});
