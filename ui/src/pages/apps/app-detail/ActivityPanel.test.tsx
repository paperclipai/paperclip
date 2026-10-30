import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "@paperclipai/shared";
import { humanizeEvent, isTestEvent, resolveActorLabel } from "./ActivityPanel";

function event(overrides: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    id: "evt-1",
    companyId: "co-1",
    eventType: "call_completed",
    actorType: "agent",
    actorId: null,
    agentId: "agent-1",
    runId: null,
    issueId: null,
    applicationId: null,
    connectionId: "conn-1",
    catalogEntryId: null,
    invocationId: null,
    actionRequestId: null,
    runtimeSlotId: null,
    toolName: "mcp.app-gallery-link-abc:read_values",
    decision: null,
    matchedPolicyIds: [],
    reasonCode: null,
    outcome: "success",
    latencyMs: null,
    requestHash: null,
    requestSummary: null,
    resultHash: null,
    resultSummary: null,
    resultSizeBytes: null,
    redactionPlan: null,
    rateLimitState: null,
    metadata: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-06-18T00:00:00Z"),
    ...overrides,
  } as ToolCallEvent;
}

describe("isTestEvent", () => {
  it("is true only when metadata.source === 'test'", () => {
    expect(isTestEvent(event({ metadata: { source: "test" } }))).toBe(true);
    expect(isTestEvent(event({ metadata: { source: "heartbeat" } }))).toBe(false);
    expect(isTestEvent(event({ metadata: null }))).toBe(false);
  });
});

describe("resolveActorLabel", () => {
  it("prefers the directory display name", () => {
    expect(resolveActorLabel("user-1", new Map([["user-1", "Dotta"]]))).toBe("Dotta");
  });

  it("falls back to 'Board' for the local board principal", () => {
    expect(resolveActorLabel("local-board", new Map())).toBe("Board");
    expect(resolveActorLabel("local-board", undefined)).toBe("Board");
  });

  it("falls back to 'Someone' for an unknown actor", () => {
    expect(resolveActorLabel("user-x", new Map())).toBe("Someone");
    expect(resolveActorLabel(null, new Map())).toBe("Someone");
  });
});

describe("humanizeEvent test-tab attribution", () => {
  it("surfaces '<User> tested as <Agent>' for a successful test call", () => {
    const { primary } = humanizeEvent(
      event({ actorType: "user", actorId: "user-1", metadata: { source: "test" } }),
      "BenchmarkForensics",
      undefined,
      "Dotta",
    );
    expect(primary).toBe("Dotta tested as BenchmarkForensics used Read Values");
  });

  it("renders a real heartbeat call without the tested-as prefix", () => {
    const { primary } = humanizeEvent(event({}), "BenchmarkForensics");
    expect(primary).toBe("BenchmarkForensics used Read Values");
  });

  it("attributes a denied test call to the runner instead of an anonymous block", () => {
    const { primary } = humanizeEvent(
      event({ eventType: "call_denied", outcome: "denied", metadata: { source: "test" } }),
      "BenchmarkForensics",
      undefined,
      "Board",
    );
    expect(primary).toBe("Board tested as BenchmarkForensics - Read Values is turned off");
  });

  it("keeps the anonymous block wording for non-test denied calls", () => {
    const { primary } = humanizeEvent(
      event({ eventType: "call_denied", outcome: "denied" }),
      "BenchmarkForensics",
    );
    expect(primary).toBe("Blocked Read Values - it isn't turned on");
  });
});
