import { expect, it } from "vitest";
import { historyToolEvent, validActiveHistoryRestart, type ActiveHistoryRestart } from "./history-active-restart.js";
import { endurancePrompt, historyEnduranceTasks } from "./history-endurance-cases.js";

it("requires an exact running process event from the requested run", () => {
  const event = { runId: "run", sourceKind: "runner", sourceInstanceId: "runner", normalizedSessionId: "session",
    sourceEventId: "event", sourceSeq: 1, payload: { schema: "paperclip.tool.execution.v1", transport: "process", executionId: "exec", name: "sleep 45" } };
  expect(historyToolEvent({ payload: { prpEvent: event } }, "run")).toEqual(event);
  for (const bad of [{ ...event, runId: "other" }, { ...event, sourceKind: "provider" }, { ...event, sourceSeq: 0 },
    { ...event, payload: { ...event.payload, transport: "dynamic" } }]) expect(historyToolEvent({ payload: { prpEvent: bad } }, "run")).toBeNull();
});

it("rejects a crash that did not precede completion of the same tool and run", () => {
  const good: ActiveHistoryRestart = { runId: "run", executionId: "exec", sourceInstanceId: "runner", normalizedSessionId: "session",
    startedEventId: "start", startedSeq: 1, startedAt: 1000, restartStartedAt: 2000, restartFinishedAt: 3000,
    completedEventId: "finish", completedSeq: 2, completedAt: 4000, exitCode: 0 };
  expect(validActiveHistoryRestart(good, "run")).toBe(true);
  for (const bad of [undefined, { ...good, runId: "other" }, { ...good, completedAt: 1999 }, { ...good, exitCode: 1 },
    { ...good, completedEventId: "start" }, { ...good, completedSeq: 1 }, { ...good, startedAt: NaN }, { ...good, completedEventId: undefined }]) {
    expect(validActiveHistoryRestart(bad, "run")).toBe(false);
  }
  expect(endurancePrompt("nonce", 0, true)).toContain("sleep 45;");
  expect(endurancePrompt("nonce", 0)).not.toContain("sleep 45;");
  expect(historyEnduranceTasks.find(task => task.id === "active-restart")?.historyEndurance?.activeRestartRound).toBe(0);
});
