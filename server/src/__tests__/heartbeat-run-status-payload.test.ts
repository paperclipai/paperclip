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
    contextSnapshot: { source: "native_status_decision" },
    startedAt: new Date("2026-07-23T12:00:00.000Z"),
    finishedAt:
      status === "running" ? null : new Date("2026-07-23T12:01:00.000Z"),
    resultJson,
  };
}

describe("buildHeartbeatRunStatusLiveEventPayload", () => {
  it("identifies the task after its live-run cache entry has disappeared", () => {
    expect(buildHeartbeatRunStatusLiveEventPayload({
      ...run("cancelled", null), contextSnapshot: { issueId: "task-1" },
    }).issueId).toBe("task-1");
  });
  it("attaches the canonical final assistant text to terminal status events", () => {
    expect(
      buildHeartbeatRunStatusLiveEventPayload(
        run("succeeded", {
          summary: "Hello! How can I help?",
          stdout: "raw logs",
        }),
      ),
    ).toMatchObject({
      runId: "run-1",
      status: "succeeded",
      contextSource: "native_status_decision",
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

  it.each([undefined, null, "", "   ", 7, {}])(
    "does not invent a source for missing or invalid persisted context: %j",
    (source) => {
      expect(
        buildHeartbeatRunStatusLiveEventPayload({
          ...run("succeeded", { summary: "Accepted response" }),
          contextSnapshot: { source },
        }).contextSource,
      ).toBeNull();
    },
  );

  it("preserves a trimmed source without exposing the rest of the context", () => {
    const payload = buildHeartbeatRunStatusLiveEventPayload({
      ...run("running", null),
      contextSnapshot: { source: " chat:slack ", privateContext: "not-public" },
    });
    expect(payload.contextSource).toBe("chat:slack");
    expect(payload).not.toHaveProperty("contextSnapshot");
    expect(JSON.stringify(payload)).not.toContain("not-public");
  });

  it("keeps thin dispatch projections compatible without inventing a source", () => {
    const { contextSnapshot: _contextSnapshot, ...projection } = run(
      "failed",
      null,
    );
    expect(
      buildHeartbeatRunStatusLiveEventPayload(projection).contextSource,
    ).toBeNull();
  });
});
