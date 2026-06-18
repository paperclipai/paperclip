// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, ToolCallEvent } from "@paperclipai/shared";
import { ActivityPanel } from "./ActivityPanel";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

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

const agents: Agent[] = [{ id: "agent-1", name: "BenchmarkForensics" } as Agent];

let container: HTMLDivElement | null = null;

afterEach(() => {
  container?.remove();
  container = null;
});

function renderPanel(props: Parameters<typeof ActivityPanel>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ActivityPanel {...props} />));
  return container.textContent ?? "";
}

describe("ActivityPanel render", () => {
  const base = {
    lifecycleEvents: [],
    issues: {},
    actionRequests: {},
    loading: false,
    agents,
    connectionId: "conn-1",
    appName: "Google Sheets",
  };

  it("renders 'tested as' attribution for a Test-tab call", () => {
    const text = renderPanel({
      ...base,
      events: [event({ actorType: "user", actorId: "user-1", metadata: { source: "test" } })],
      userLabelById: new Map([["user-1", "Dotta"]]),
    });
    expect(text).toContain("Dotta tested as BenchmarkForensics used Read Values");
  });

  it("renders a real heartbeat call without the prefix", () => {
    const text = renderPanel({ ...base, events: [event({})] });
    expect(text).toContain("BenchmarkForensics used Read Values");
    expect(text).not.toContain("tested as");
  });
});
