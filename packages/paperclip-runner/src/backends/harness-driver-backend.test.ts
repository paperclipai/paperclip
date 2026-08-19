import { describe, expect, it } from "vitest";

import type { HarnessDriver, HarnessSession, PersistedHarnessSession } from "../contracts/harness-driver.js";
import type { PrpEvent, PrpStructuredRunResult } from "../protocol/replay-contract.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Backend adapter completed.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
    remainingWork: [],
  },
  evidence: [],
  verification: [{ commandOrCheck: "fake", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

function prpEvent(sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `fake:${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: "fake",
    sourceKind: "runner",
    runId: "run-1",
    normalizedSessionId: "session-1",
    turnId: "turn-1",
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: `2026-08-09T00:00:0${sourceSeq}.000Z`,
    payload,
  };
}

class FakeHarnessSession implements HarnessSession {
  ids() { return { driverSessionId: "driver-1", providerSessionId: "provider-1" }; }
  async *events() {
    yield prpEvent(1, "run.result.proposed", result);
    yield prpEvent(2, "turn.completed", { status: "completed" });
  }
  async startTurn() { return { turnId: "turn-1" }; }
  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: "fake",
      driverSessionId: "driver-1",
      providerSessionId: "provider-1",
      semanticResult: { result, fingerprint: "fingerprint", turnId: "turn-1" },
      lastSourceSequence: 2,
    };
  }
  async close() {}
}

const driver: HarnessDriver = {
  async descriptor() {
    return {
      kind: "fake",
      displayName: "Fake harness",
      version: "1",
      capabilities: {
        resume: false,
        typedEvents: true,
        steering: false,
        interruption: false,
        structuredResult: true,
      },
    };
  },
  async openSession() { return new FakeHarnessSession(); },
};

describe("HarnessDriverBackend", () => {
  it("normalizes harness events, result, terminal, and snapshot", async () => {
    const backend = new HarnessDriverBackend(driver);
    const session = await backend.openSession({
      identity: { runId: "run-1", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
      workingDirectory: "/workspace",
    });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(events).toHaveLength(2);
    await expect(session.result()).resolves.toMatchObject({ result, turnId: "turn-1", terminal: { runTerminalState: "succeeded" } });
    await expect(session.snapshot()).resolves.toMatchObject({ sessionId: "driver-1", providerSessionId: "provider-1" });
  });
});
