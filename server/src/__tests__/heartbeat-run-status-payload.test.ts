import { describe, expect, it } from "vitest";
import { buildHeartbeatRunStatusLiveEventPayload } from "../services/heartbeat.js";

function run(status: string, resultJson: Record<string, unknown> | null) {
  return {
    id: "run-1",
    agentId: "agent-1",
    status,
    invocationSource: "automation",
    triggerDetail: "system",
    error: null,
    errorCode: null,
    startedAt: new Date("2026-07-23T12:00:00.000Z"),
    finishedAt: status === "running" ? null : new Date("2026-07-23T12:01:00.000Z"),
    resultJson,
  } as never;
}

describe("buildHeartbeatRunStatusLiveEventPayload", () => {
  it("attaches the canonical final assistant text to terminal status events", () => {
    expect(
      buildHeartbeatRunStatusLiveEventPayload(
        run("succeeded", { summary: "Hello! How can I help?", stdout: "raw logs" }),
      ),
    ).toMatchObject({
      runId: "run-1",
      status: "succeeded",
      finalText: "Hello! How can I help?",
    });
  });

  it("does not expose partial result text on non-terminal status events", () => {
    expect(
      buildHeartbeatRunStatusLiveEventPayload(
        run("running", { summary: "partial output" }),
      ),
    ).toMatchObject({
      status: "running",
      finalText: null,
    });
  });
});
