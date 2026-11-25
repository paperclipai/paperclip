import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { contentionChecks, l1Workload, L1_CHUNKS, type ContentionEvidence, type ContentionRun } from "./contention.js";
import type { OracleArtifacts } from "./types.js";

const goodRun = (extra: Partial<ContentionRun> = {}): ContentionRun => ({ id: "r1", status: "succeeded", errorCode: null, error: null,
  logEvents: 120, logBytes: 900_000, receipts: 14, duplicateReceipts: [], terminalReceipt: true, nativeProducer: true, costAccounted: true,
  recordedCostCents: 12.5, costEventCents: 12.5, ...extra });
const evidence = (runs: ContentionRun[], extra: Partial<ContentionEvidence> = {}): ContentionEvidence => ({ runs,
  companyCostEventCents: 12.5, summary: { spendCents: 12.5, pendingRunCount: 0 }, error: null, ...extra });
const failing = (result: ReturnType<typeof contentionChecks>) => result.filter(check => !check.ok).map(check => check.name);

describe("L1 contention oracle", () => {
  it("passes settled accounting", () => {
    expect(failing(contentionChecks(evidence([goodRun()])))).toEqual([]);
  });

  it("fails the #20385 shape: a commit stall that left the terminal receipt uncommitted", () => {
    const stalled = goodRun({ id: "r2", status: "failed", errorCode: "native_event_replay_conflict", terminalReceipt: false, costAccounted: false,
      error: "native_event_replay_conflict: runner_event_commit_stalled: runner events kept failing to commit without progress (last cause: Error at source seq 9)" });
    expect(failing(contentionChecks(evidence([goodRun(), stalled])))).toEqual(["no_event_commit_stall", "finished_runs_accounted"]);
    expect(failing(contentionChecks(evidence([goodRun({ terminalReceipt: false })])))).toEqual(["terminal_receipts_committed"]);
  });

  it("fails duplicated receipts and spend that does not add up", () => {
    expect(failing(contentionChecks(evidence([goodRun({ duplicateReceipts: ["s:evt-3"] })])))).toEqual(["usage_receipts_committed_once"]);
    expect(failing(contentionChecks(evidence([goodRun({ costEventCents: 25 })])))).toEqual(["run_spend_matches_cost_events"]);
    expect(failing(contentionChecks(evidence([goodRun()], { summary: { spendCents: 12.5, pendingRunCount: 1 } })))).toEqual(["company_spend_settled"]);
  });

  it("fails a task that did not produce the contention it tests", () => {
    expect(failing(contentionChecks(evidence([goodRun({ logEvents: 5, receipts: 2 })])))).toEqual(["contention_produced"]);
    expect(failing(contentionChecks(undefined))).toEqual(["contention_evidence_collected"]);
  });

  it("grades the brief and the accounting together", () => {
    const nonce = "abcd1234";
    const brief = [...Array.from({ length: L1_CHUNKS }, (_, index) => `- L1-${nonce}-c${index + 1}-END`), `L1-${nonce}-DONE`].join("\n");
    const artifacts: OracleArtifacts = { issueStatus: "done", documents: { brief }, agentComments: [], files: {}, commands: {}, workspacePath: null,
      contention: evidence([goodRun()]) };
    expect(l1Workload.grade(nonce, artifacts).verdict).toBe("pass");
    const missing = { ...artifacts, documents: { brief: brief.replace(`L1-${nonce}-c3-END`, "") } };
    expect(l1Workload.grade(nonce, missing).checks.find(check => check.name === "brief_has_every_chunk_end")?.ok).toBe(false);
    expect(l1Workload.description(nonce)).toContain(`seq -f "L1-${nonce}-c1 row`);
  });

  it("parses --db-pressure and keeps L1 out of the default workloads", () => {
    const parsed = parseCommand(["--workloads", "L1", "--db-pressure", "4", "--seed", "1"]);
    expect(parsed.mode === "wave" && parsed.options.dbPressure).toBe(4);
    const defaults = parseCommand(["--seed", "1"]);
    expect(defaults.mode === "wave" && defaults.options.workloads.includes("L1")).toBe(false);
    expect(() => parseCommand(["--db-pressure", "9"])).toThrow(/between 1 and 8/);
  });
});
