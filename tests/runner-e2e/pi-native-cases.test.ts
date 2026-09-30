import { describe, expect, it } from "vitest";
import { gradePiNativeAnswers, hasFailedPiWrite, hasPiCrossRootDenial, piNativeTasks } from "./pi-native-cases.js";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

describe("Pi native Product qualification", () => {
  it("selects four local and three remote Pi cases without changing the basic extended matrix", () => {
    const suite = runnerSuites.find(row => row.id === "pi-native")!;
    expect(suite.manualOnly).toBe(true); expect(suite.expectedMatrixSize).toBe(7);
    const cells = runnerMatrix.filter(row => row.suite.id === suite.id);
    expect(cells).toHaveLength(7);
    expect(cells.every(row => row.profile.qualificationCandidate === "pi")).toBe(true);
    expect(cells.filter(row => row.environment.id === "local").map(row => [row.task.id, row.task.expectedRunCount])).toEqual([
      ["native-questions", 1], ["agent-files-fresh-run", 2], ["restrictive-denial", 1], ["human-permission-denial", 1],
    ]);
    expect(cells.filter(row => row.environment.id === "daytona").map(row => [row.task.id, row.task.expectedRunCount])).toEqual([
      ["native-questions", 1], ["agent-files-fresh-run", 2], ["human-permission-denial", 1],
    ]);
    expect(cells.reduce((sum, row) => sum + row.task.expectedRunCount, 0)).toBe(9);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(row => row.suite.id === suite.id)).toBe(false);
    expect(runnerMatrix.filter(row => row.suite.id === "extended-harnesses")).toHaveLength(30);
    expect(piNativeTasks[0]!.buildPrompt("fixture")).toContain("paperclip_native_question");
    expect(piNativeTasks[1]!.buildPrompt("fixture")).toContain("AGENT_HOME");
  });

  it("admits explicit local and remote Pi native candidates and discards ambient admission", () => {
    const cell = runnerMatrix.find(row => row.suite.id === "pi-native")!;
    const source = { PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" };
    expect(JSON.parse(buildRunnerE2EProcessEnvironment(source, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent: "pi", model: cell.profile.model }]);
    const remote = runnerMatrix.find(row => row.suite.id === "pi-native" && row.environment.id === "daytona")!;
    expect(JSON.parse(buildRunnerE2EProcessEnvironment(source, [remote]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent: "pi", model: remote.profile.model }]);
    expect(buildRunnerE2EProcessEnvironment(source, []).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    for (const changed of [
      { ...cell, suite: { ...cell.suite, manualOnly: false } },
      { ...cell, suite: { ...cell.suite, id: "implicit" } },
      { ...cell, profile: { ...cell.profile, qualificationCandidate: "copilot" as const } },
    ]) expect(() => buildRunnerE2EProcessEnvironment(source, [changed])).toThrow("explicit provider qualification suite");
  });

  it("grades all four actual typed results and fails missing, stale or invented answers", () => {
    const valid = [{ status: "answered", optionId: "blue" }, { status: "negative_or_cancelled", confirmed: false }, { status: "answered", value: "hidden-name" }, { status: "answered", value: "hidden-draft\nsecond" }];
    expect(gradePiNativeAnswers(valid, "hidden-name", "hidden-draft\nsecond")).toBe(true);
    for (const actual of [undefined, [], valid.slice(0, 3), [...valid, valid[0]], valid.map((row, i) => i === 1 ? { status: "answered", confirmed: true } : row), valid.map((row, i) => i === 2 ? { ...row, value: "guessed-name" } : row), valid.map((row, i) => i === 0 ? { ...row, extra: "invented" } : row)]) {
      expect(gradePiNativeAnswers(actual, "hidden-name", "hidden-draft\nsecond")).toBe(false);
    }
  });

  it("requires exactly one native cross-root policy receipt when public paths are suppressed", () => {
    const event = { eventType: "tool.execution.completed", payload: { prpEvent: { payload: { schema: "paperclip.tool.execution.v1", transport: "builtin", operation: "edit", name: "write", status: "failed", target: null, executionId: "native-1", output: "Pi tool path is outside its assigned workspace and agent files" } } } };
    expect(hasPiCrossRootDenial([event])).toBe(true);
    expect(hasPiCrossRootDenial([event, event])).toBe(false);
    for (const patch of [{ output: "model claims denied" }, { executionId: "" }, { status: "completed" }, { transport: "mcp" }, { target: "other.txt" }]) {
      expect(hasPiCrossRootDenial([{ ...event, payload: { prpEvent: { payload: { ...event.payload.prpEvent.payload, ...patch } } } }])).toBe(false);
    }
  });

  it("requires a correlated failed native edit, never a model claim or an unexecuted intent", () => {
    const event = { eventType: "tool.execution.completed", payload: { prpEvent: { payload: { schema: "paperclip.tool.execution.v1", operation: "edit", status: "failed", name: "write", target: "pi-denied.txt" } } } };
    expect(hasFailedPiWrite([event], "pi-denied.txt")).toBe(true);
    for (const events of [[], [{ eventType: "assistant.message", text: "Write pi-denied.txt failed" }], [{ ...event, eventType: "tool.execution.started" }], [{ ...event, payload: { prpEvent: { payload: { ...event.payload.prpEvent.payload, status: "completed" } } } }]]) expect(hasFailedPiWrite(events, "pi-denied.txt")).toBe(false);
    expect(hasFailedPiWrite([event], "other.txt")).toBe(false);
  });
});
