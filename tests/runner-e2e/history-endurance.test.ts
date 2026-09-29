import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { historyEnduranceTasks, enduranceMarker, enduranceOutput } from "./history-endurance-cases.js";
import { gradeHistoryEndurance, retainedHistoryReadFailure, type HistoryEnduranceRound } from "./history-endurance-scoring.js";
import { runnerMatrix, suiteDefinitionHash } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { summarizeProviderTraceInspection } from "./history-provider-trace.js";

function sample() {
  const nonce = "fixture";
  const body = (round: number) => {
    const output = enduranceOutput(nonce, round);
    const hash = createHash("sha256").update(output).digest("hex");
    return { runId: `run-${round}`, bodyId: hash, sha256: hash, byteLength: Buffer.byteLength(output), browserDownload: true as const, stream: { byteLength: Buffer.byteLength(output), sha256: hash, executionId: `exec-${round}` } };
  };
  const observations: HistoryEnduranceRound[] = Array.from({ length: 3 }, (_, round) => ({
    round, submittedAt: 1000 + round * 30_000, finishedAt: 2000 + round * 30_000,
    issueId: "issue", issueStatus: "done",
    run: { id: `run-${round}`, status: "succeeded", runtimeMode: "native", sessionIdBefore: round ? "session" : null, sessionIdAfter: "session" },
    document: { key: "history-ledger", latestRevisionId: `revision-${round}`,
      body: Array.from({ length: round + 1 }, (_, n) => enduranceMarker(nonce, n)).join("\n") },
    documentCount: 1, pendingInteractions: 0, childCount: 0, restarted: round > 0,
    restartMode: round === 0 ? null : round === 1 ? "graceful" : "hard",
    output: body(round), originalOutput: body(0),
  }));
  return { nonce, rounds: 3, intervalMs: 30_000, restartEvery: 1, observations, logReadFailures: [] as Array<{ runId: string; status: number }> };
}
describe("history endurance qualification", () => {
  it("summarizes provider traces without retaining parsed payloads and caps frame headers", () => {
    const inspection = {
      trace: { status: "incomplete", reason: "trace_terminal_ack_missing", frameCount: 2_005, byteCount: 900_000,
        digest: `sha256:${"a".repeat(64)}`, rawBase64: "secret-trace-material" },
      entries: Array.from({ length: 2_005 }, (_, index) => ({
        kind: "frame", frameId: index + 1, direction: "provider_to_client", timestamp: "2026-09-29T12:00:00.000Z",
        debugChannel: "rust_native", debugSequence: index + 1, byteLength: 200, digest: `sha256:${"b".repeat(64)}`,
        rawBase64: "c2VjcmV0LXJhdy1ieXRlcw==",
        parsed: { method: index >= 2_001 ? ["turn/start", "turn/steer", "turn/interrupt", "turn/failed"][index - 2_001] : index === 0 ? "turn/start" : "untrusted/custom-method", type: "response", id: index + 1, result: "private provider payload" },
      })),
    };
    const summary = summarizeProviderTraceInspection({ httpStatus: 200, inspection });
    expect(summary).toMatchObject({ capture: "captured", status: "incomplete", frameCount: 2_005, omittedFrameCount: 5, truncated: true });
    expect((summary.frames as unknown[])).toHaveLength(2_000);
    expect(JSON.stringify(summary)).toContain("turn/failed");
    expect(JSON.stringify(summary)).toContain("turn/start");
    expect(JSON.stringify(summary)).toContain("turn/steer");
    expect(JSON.stringify(summary)).toContain("turn/interrupt");
    expect(JSON.stringify(summary)).not.toContain("untrusted/custom-method");
    expect(JSON.stringify(summary)).not.toContain("private provider payload");
    expect(JSON.stringify(summary)).not.toContain("secret-trace-material");
    expect(JSON.stringify(summary)).not.toContain("rawBase64");
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(1024 * 1024);
    expect((summary.frames as Array<Record<string, unknown>>)[0]).toHaveProperty("jsonRpcId", 6);
    expect((summary.frames as Array<Record<string, unknown>>)[0]).toHaveProperty("frameId", 6);
    expect(summarizeProviderTraceInspection({ httpStatus: 200, inspection: {
      trace: { status: "incomplete", reason: "provider supplied secret text", frameCount: 0, byteCount: 0, digest: null }, entries: [],
    } })).toMatchObject({ reason: "redacted" });
  });

  it("marks missing and unavailable trace evidence explicitly", () => {
    expect(summarizeProviderTraceInspection({ httpStatus: 200, inspection: { trace: null, entries: [] } }))
      .toMatchObject({ capture: "missing", frameCount: 0, omittedFrameCount: 0, truncated: false });
    expect(summarizeProviderTraceInspection({ httpStatus: 404 }))
      .toEqual({ capture: "unavailable", httpStatus: 404 });
    expect(summarizeProviderTraceInspection({ httpStatus: 200, inspection: null }))
      .toEqual({ capture: "unavailable", reason: "invalid_inspection_response" });
  });

  it("distinguishes unavailable retained history from a new run without its first log", () => {
    const runId = "00000000-0000-0000-0000-000000000001";
    const url = `http://127.0.0.1/api/heartbeat-runs/${runId}/log?cursor=0`;
    expect(retainedHistoryReadFailure(url, 404, new Set())).toBeNull();
    for (const status of [404, 429, 500]) expect(retainedHistoryReadFailure(url, status, new Set([runId]))).toEqual({ runId, status });
    expect(retainedHistoryReadFailure(url, 200, new Set([runId]))).toBeNull();
    expect(retainedHistoryReadFailure(url.replace("/log?", "/events?"), 500, new Set([runId]))).toBeNull();
  });
  it("accepts exact real-boundary evidence", () => {
    expect(gradeHistoryEndurance(sample()).every(check => check.passed)).toBe(true);
  });
  it.each([
    ["missing round", (input: ReturnType<typeof sample>) => { input.observations.pop(); }],
    ["lost old reference", (input: ReturnType<typeof sample>) => { input.observations[2]!.document.body = enduranceMarker(input.nonce, 2); }],
    ["duplicated reference", (input: ReturnType<typeof sample>) => { input.observations[2]!.document.body += `\n${enduranceMarker(input.nonce, 1)}`; }],
    ["truncated original output", (input: ReturnType<typeof sample>) => { input.observations[2]!.originalOutput.byteLength--; }],
    ["missing streamed output", (input: ReturnType<typeof sample>) => { delete input.observations[0]!.output.stream; }],
    ["truncated streamed output", (input: ReturnType<typeof sample>) => { input.observations[0]!.output.stream!.byteLength--; }],
    ["new provider session", (input: ReturnType<typeof sample>) => { input.observations[1]!.run.sessionIdAfter = "replacement"; }],
    ["unperformed restart", (input: ReturnType<typeof sample>) => { input.observations[1]!.restarted = false; }],
    ["unperformed hard restart", (input: ReturnType<typeof sample>) => { input.observations[2]!.restartMode = "graceful"; }],
    ["shortened duration", (input: ReturnType<typeof sample>) => { input.observations[1]!.submittedAt--; }],
    ["same run reused", (input: ReturnType<typeof sample>) => { input.observations[1]!.run.id = "run-0"; }],
    ["old run log failed", (input: ReturnType<typeof sample>) => { input.logReadFailures.push({ runId: "run-0", status: 500 }); }],
  ] as const)("rejects %s", (_name, mutate) => {
    const input = sample(); mutate(input);
    expect(gradeHistoryEndurance(input).some(check => !check.passed)).toBe(true);
  });
  it("keeps paid multi-day work explicit, finite, and without automatic retries", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "history-endurance");
    expect(cells).toHaveLength(3);
    expect(historyEnduranceTasks.map(task => task.expectedRunCount)).toEqual([3, 2, 73]);
    expect(cells.every(cell => cell.task.automaticRetry === false && cell.suite.manualOnly)).toBe(true);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(cell => cell.suite.id === "history-endurance")).toBe(false);
    const long = cells.find(cell => cell.task.id === "72h")!;
    const schedule = long.task.historyEndurance!;
    expect((schedule.rounds - 1) * schedule.intervalMs).toBe(72 * 60 * 60_000);
    expect(suiteDefinitionHash({ ...long.suite, tasks: [{ ...long.task, historyEndurance: { ...schedule, intervalMs: 1 } }] }))
      .not.toBe(suiteDefinitionHash({ ...long.suite, tasks: [long.task] }));
  });
});
