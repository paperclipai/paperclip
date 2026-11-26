import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildCampaignAccounting } from "./attempt-accounting.js";
import { summarizeWorkerPhaseTiming, workerPhaseTimingText } from "./campaign-timing.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { createWorkerTiming, recoverWorkerTiming, validateWorkerTiming } from "./worker-timing.js";
import type { RunnerE2EResult } from "./types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worker-timing-")); temporary.push(dir);
  const result: RunnerE2EResult = {
    schema: "paperclip.runner-e2e.result/v2", executionId: "timing-case", suiteId: "timing-fixture", attempt: 1,
    accountingIdentity: { campaignId: "timing-campaign", attemptId: "timing-attempt" },
    status: "passed", profileId: "runner-codex", environmentId: "local", caseId: "marker", provider: "codex",
    model: "fixture-model", runtimeMode: "native", startedAt: new Date(1000).toISOString(),
    finishedAt: new Date(1500).toISOString(), durationMs: 500, cleanup: "passed",
  };
  return { file: path.join(dir, "snapshots", "worker-timing.json"), dir, result };
}

async function complete(file: string, result: RunnerE2EResult) {
  const recorder = await createWorkerTiming(file, result, 1000);
  await recorder.enter("execution", 1100);
  await recorder.enter("cleanup", 1300);
  await recorder.enter("feedback", 1350);
  await recorder.enter("cleanup", 1430);
  await recorder.enter("finalization", 1470);
  return recorder.finish(1500);
}

describe("worker phase timing", () => {
  it("retains and validates all phase boundaries, including both cleanup segments", async () => {
    const { file, result } = await fixture(); result.workerTiming = await complete(file, result);
    validateRetainedRunnerResult(result);
    expect(await recoverWorkerTiming(file, result)).toEqual(result.workerTiming);
    const accounting = buildCampaignAccounting({ results: [result], attempts: [result] });
    expect(accounting.attempts[0]?.workerTiming).toEqual(result.workerTiming);
    const summary = summarizeWorkerPhaseTiming([result], accounting);
    expect(summary).toMatchObject({ completeAttempts: 1, partialAttempts: 0, missingAttempts: 0 });
    expect(summary.phases.map(phase => [phase.phase, phase.totalMs])).toEqual([
      ["setup", 100], ["execution", 200], ["feedback", 80], ["cleanup", 90], ["finalization", 30],
    ]);
    expect(workerPhaseTimingText(summary)).toContain("Worker cleanup time: 90ms.");
  });

  it("recovers only completed segments after a real worker process is killed", async () => {
    const { file, result } = await fixture();
    const loader = createRequire(new URL("../../cli/package.json", import.meta.url)).resolve("tsx");
    const module = pathToFileURL(path.join(import.meta.dirname, "worker-timing.ts")).href;
    const program = `import { createWorkerTiming } from ${JSON.stringify(module)};
      const recorder = await createWorkerTiming(${JSON.stringify(file)}, { executionId: "timing-case", attempt: 1 }, 1000);
      await recorder.enter("execution", 1200); process.stdout.write("checkpoint-ready"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker checkpoint was not written")), 10_000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.stdout!.once("data", chunk => {
          clearTimeout(timer); String(chunk).includes("checkpoint-ready") ? resolve() : reject(new Error("Unexpected worker output"));
        });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Worker exited before interruption")); });
      });
      child.kill("SIGKILL"); await closed;
      result.status = "failed"; result.workerTiming = await recoverWorkerTiming(file, result);
      expect(result.workerTiming).toMatchObject({ status: "partial", finishedAt: null,
        segments: [{ phase: "setup", finishedAt: new Date(1200).toISOString() }, { phase: "execution", finishedAt: null }] });
      validateRetainedRunnerResult(result);
      const summary = summarizeWorkerPhaseTiming([result]);
      expect(summary).toMatchObject({ completeAttempts: 0, partialAttempts: 1 });
      expect(summary.phases.every(phase => phase.totalMs === null)).toBe(true);
      expect(workerPhaseTimingText(summary)).toContain("Worker setup time: Unknown (200ms observed).");
      expect(workerPhaseTimingText(summary)).toContain("Worker execution time: Unknown.");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; }
  });

  it("rejects wrong identities, overlapping segments and out-of-window timestamps before reporting", async () => {
    const { file, result } = await fixture(); const receipt = await complete(file, result);
    if (receipt.status === "unavailable") throw new Error("Missing fixture timing");
    const other = structuredClone(receipt); other.executionId = "another-case";
    const overlap = structuredClone(receipt); overlap.segments[1]!.startedAt = new Date(1050).toISOString();
    const future = structuredClone(receipt); future.finishedAt = new Date(1600).toISOString(); future.segments.at(-1)!.finishedAt = future.finishedAt;
    for (const invalid of [other, overlap, future, { ...receipt, extra: "unapproved field" }]) {
      expect(() => validateWorkerTiming(invalid, result)).toThrow("Invalid worker timing");
      expect(() => validateRetainedRunnerResult({ ...result, workerTiming: invalid })).toThrow("result.workerTiming");
    }
  });

  it("bounds recovery reads and refuses symlinks or mismatched attempt files", async () => {
    const { file, dir, result } = await fixture(); await complete(file, result);
    expect(await recoverWorkerTiming(file, { ...result, attempt: 2 })).toMatchObject({ status: "unavailable", reason: "invalid_evidence" });
    const link = path.join(dir, "linked.json"); await symlink(file, link);
    expect(await recoverWorkerTiming(link, result)).toMatchObject({ status: "unavailable", reason: "invalid_evidence" });
    await writeFile(file, " ".repeat(8193));
    expect(await recoverWorkerTiming(file, result)).toMatchObject({ status: "unavailable", reason: "invalid_evidence" });
    expect(await recoverWorkerTiming(path.join(dir, "missing.json"), result)).toBeUndefined();
  });

  it("keeps timing failures from interrupting cleanup or overwriting earlier evidence", async () => {
    const { file, result } = await fixture(); await complete(file, result); const original = await readFile(file, "utf8");
    const recorder = await createWorkerTiming(file, result, 1000);
    await recorder.enter("cleanup", 1100);
    expect(await recorder.finish(1500)).toMatchObject({ status: "unavailable", reason: "write_failed" });
    expect(await readFile(file, "utf8")).toBe(original);
    const clockFile = file + ".clock"; const clock = await createWorkerTiming(clockFile, result, 1000);
    await clock.enter("execution", 900);
    expect(await clock.finish(1500)).toMatchObject({ status: "unavailable", reason: "clock_regression" });
  });

  it("preserves a timing observation through duplicate legacy copies and rejects contradictions", async () => {
    const { file, result } = await fixture(); const measured = { ...result, workerTiming: await complete(file, result) };
    for (const attempts of [[measured, result], [result, measured]]) {
      expect(buildCampaignAccounting({ results: [measured], attempts }).attempts[0]?.workerTiming).toEqual(measured.workerTiming);
    }
    expect(() => buildCampaignAccounting({ results: [measured], attempts: [measured, { ...measured,
      workerTiming: { version: 1, scope: "worker", status: "unavailable", reason: "write_failed" },
    }] })).toThrow("Conflicting timing receipts");
  });
});
