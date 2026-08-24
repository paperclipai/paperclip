import { describe, expect, it } from "vitest";

import {
  loadPhase0Fixture,
  validatePhase0Fixture,
} from "./phase0-fixture.js";

describe("Phase 0 fixture validation", () => {
  it("accepts the package-owned fixture", async () => {
    const fixture = await loadPhase0Fixture();

    expect(fixture.run.runId).toBe("run_phase0_0001");
    expect(fixture.events.map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
    expect(fixture.result.status).toBe("succeeded");
  });

  it("rejects a non-contiguous event sequence", () => {
    expect(() =>
      validatePhase0Fixture({
        schemaVersion: "paperclip.runner.phase0.fixture.v1",
        run: {
          runId: "run_phase0_0001",
          sessionId: "session_phase0_0001",
          companyId: "company_phase0",
          issueId: "issue_phase0",
          agentId: "agent_phase0",
        },
        events: [
          {
            eventId: "event_phase0_0001",
            runId: "run_phase0_0001",
            sequence: 2,
            type: "run.started",
          },
          {
            eventId: "event_phase0_0002",
            runId: "run_phase0_0001",
            sequence: 3,
            type: "run.completed",
          },
        ],
        result: {
          runId: "run_phase0_0001",
          status: "succeeded",
          summary: "Standalone Phase 0 fixture accepted.",
        },
      }),
    ).toThrow("events[0].sequence must be 1");
  });
});
