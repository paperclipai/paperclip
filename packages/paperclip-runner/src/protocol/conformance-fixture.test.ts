import { describe, expect, it } from "vitest";

import {
  loadConformanceFixture,
  validateConformanceFixture,
} from "./conformance-fixture.js";

describe("Conformance fixture validation", () => {
  it("accepts the package-owned fixture", async () => {
    const fixture = await loadConformanceFixture();

    expect(fixture.run.runId).toBe("run_conformance_0001");
    expect(fixture.events.map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
    expect(fixture.result.status).toBe("succeeded");
  });

  it("rejects a non-contiguous event sequence", () => {
    expect(() =>
      validateConformanceFixture({
        schemaVersion: "paperclip.runner.conformance.fixture.v1",
        run: {
          runId: "run_conformance_0001",
          sessionId: "session_conformance_0001",
          companyId: "company_conformance",
          issueId: "issue_conformance",
          agentId: "agent_conformance",
        },
        events: [
          {
            eventId: "event_conformance_0001",
            runId: "run_conformance_0001",
            sequence: 2,
            type: "run.started",
          },
          {
            eventId: "event_conformance_0002",
            runId: "run_conformance_0001",
            sequence: 3,
            type: "run.completed",
          },
        ],
        result: {
          runId: "run_conformance_0001",
          status: "succeeded",
          summary: "Standalone Conformance fixture accepted.",
        },
      }),
    ).toThrow("events[0].sequence must be 1");
  });
});
