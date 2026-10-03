import { describe, expect, it } from "vitest";
import { heartbeatRunEvents } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  agentActivityRunEventCondition,
  isAgentActivityRunEventType,
} from "../services/run-event-activity.ts";
import { buildRunEventRuntimeProgress } from "../services/heartbeat.ts";
import { classifyRunLiveness } from "../services/run-liveness.ts";

const SANDBOX_EVENT_TYPES = [
  "sandbox.network.proxy.started",
  "sandbox.network.proxy.stopped",
  "sandbox.network.decision",
  "sandbox.network.tunnel.closed",
] as const;

/** Mirrors the SQL `count(*) filter (where …)` over one run's events, from the same predicate. */
function countAgentActivityEvents(eventTypes: readonly string[]): number {
  return eventTypes.filter((eventType) => isAgentActivityRunEventType(eventType))
    .length;
}

const succeededRun = {
  runStatus: "succeeded",
  issue: {
    status: "in_progress",
    title: "Modernize the ingest pipeline",
    description: "Move the legacy importer behind a repository seam.",
  },
  resultJson: null,
  stdoutExcerpt: null,
  stderrExcerpt: null,
  error: null,
  errorCode: null,
  continuationAttempt: 0,
};

describe("agent-activity run event predicate", () => {
  it("does not treat a host-authored sandbox egress record as agent activity", () => {
    for (const eventType of SANDBOX_EVENT_TYPES) {
      expect(isAgentActivityRunEventType(eventType)).toBe(false);
    }
  });

  it("keeps excluding host bookkeeping and keeps counting real agent events", () => {
    for (const eventType of ["lifecycle", "adapter.invoke", "error"]) {
      expect(isAgentActivityRunEventType(eventType)).toBe(false);
    }
    for (const eventType of ["tool.use", "assistant.message.delta", "output"]) {
      expect(isAgentActivityRunEventType(eventType)).toBe(true);
    }
  });

  it("excludes a future sandbox.network.* event kind without editing a list", () => {
    expect(isAgentActivityRunEventType("sandbox.network.tunnel.opened")).toBe(
      false,
    );
  });

  it("generates SQL from the same constants, so the database cannot disagree", () => {
    const query = new PgDialect().sqlToQuery(
      agentActivityRunEventCondition(heartbeatRunEvents.eventType),
    );

    expect(query.sql).toContain("not like");
    expect(query.params).toContain("sandbox.network.%");
    for (const bookkeeping of ["lifecycle", "adapter.invoke", "error"]) {
      expect(query.params).toContain(bookkeeping);
    }
  });
});

describe("run liveness evidence from sandbox egress events", () => {
  // TEA-189 F1. The proxy brackets every confined run with started/stopped, so before this predicate
  // a run that did nothing else held two "tool/action events" and classified `advanced` with the
  // operator-facing reason "Run produced concrete action evidence: 2 tool/action event(s)".
  it("classifies a run whose only events are proxy lifecycle as empty_response", () => {
    const classification = classifyRunLiveness({
      ...succeededRun,
      evidence: {
        toolOrActionEventsCreated: countAgentActivityEvents([
          "sandbox.network.proxy.started",
          "sandbox.network.proxy.stopped",
        ]),
        latestEvidenceAt: new Date("2026-09-27T17:00:00.000Z"),
      },
    });

    expect(classification.livenessState).toBe("empty_response");
  });

  it("does not let a denied egress decision manufacture action evidence", () => {
    const classification = classifyRunLiveness({
      ...succeededRun,
      evidence: {
        toolOrActionEventsCreated: countAgentActivityEvents([
          "sandbox.network.proxy.started",
          ...Array.from({ length: 40 }, () => "sandbox.network.decision"),
          "sandbox.network.proxy.stopped",
        ]),
        latestEvidenceAt: new Date("2026-09-27T17:00:00.000Z"),
      },
    });

    expect(classification.livenessState).toBe("empty_response");
  });

  it("still classifies a real tool event as advanced", () => {
    const classification = classifyRunLiveness({
      ...succeededRun,
      evidence: {
        toolOrActionEventsCreated: countAgentActivityEvents([
          "sandbox.network.proxy.started",
          "tool.use",
        ]),
        latestEvidenceAt: new Date("2026-09-27T17:00:00.000Z"),
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });
});

describe("live runtime progress from sandbox egress events", () => {
  const at = new Date("2026-09-27T17:00:00.000Z");

  // TEA-189 F2. Every one of these replaced `message`, `currentToolName` and `lastAssistantSnippet`
  // and published, once per egress decision with no throttle.
  it("does not displace the live progress line", () => {
    for (const eventType of SANDBOX_EVENT_TYPES) {
      expect(
        buildRunEventRuntimeProgress({
          eventType,
          message: "sandbox egress deny blocked.example:443 (not_allowlisted)",
          payload: { event: eventType, decision: "deny" },
          at,
        }),
      ).toBeNull();
    }
  });

  it("still reports a real agent event and an error", () => {
    expect(
      buildRunEventRuntimeProgress({
        eventType: "tool.use",
        message: "Reading src/index.ts",
        payload: { tool_name: "Read" },
        at,
      }),
    ).not.toBeNull();
    expect(
      buildRunEventRuntimeProgress({
        eventType: "error",
        message: "Adapter exited with code 1",
        payload: null,
        at,
      }),
    ).not.toBeNull();
  });
});
