// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalDeliveryInteraction, Issue, IssueDocument } from "@paperclipai/shared";
import { IssueMissionControlPanel } from "./IssueMissionControlPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).IS_REACT_ACT_ENVIRONMENT = true;
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Mission Control smoke",
    description: null,
    status: "in_review",
    priority: "high",
    assigneeAgentId: "worker-agent",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    identifier: "PAP-1",
    issueNumber: 1,
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: {
      mode: "normal",
      commentRequired: true,
      stages: [],
      monitor: null,
      missionControl: {
        enabled: true,
        riskClass: "high",
      },
      finalDelivery: {
        enabled: true,
        destination: {
          platform: "telegram",
          chatId: "-100123",
          threadId: "103",
        },
      },
    },
    executionState: {
      status: "in_review",
      currentStageId: null,
      currentStageType: "review",
      lastDecisionOutcome: "submitted",
      lastDecisionAt: new Date("2026-05-13T12:00:00.000Z"),
    },
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-13T11:00:00.000Z"),
    updatedAt: new Date("2026-05-13T12:00:00.000Z"),
    labels: [],
    labelIds: [],
    ancestors: [],
    documentSummaries: [],
    ...overrides,
  } as Issue;
}

function createDocument(key: string, overrides: Partial<IssueDocument> = {}): IssueDocument {
  const now = new Date("2026-05-13T12:00:00.000Z");
  return {
    id: `doc-${key}`,
    companyId: "company-1",
    issueId: "issue-1",
    key,
    title: key,
    format: "markdown",
    latestRevisionId: `rev-${key}`,
    latestRevisionNumber: 1,
    createdByAgentId: "validator-agent",
    createdByUserId: null,
    updatedByAgentId: "validator-agent",
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    body: "ok",
    ...overrides,
  };
}

function createFinalDelivery(overrides: Partial<FinalDeliveryInteraction> = {}): FinalDeliveryInteraction {
  return {
    id: "delivery-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "final_delivery",
    idempotencyKey: "final:issue-1",
    sourceCommentId: null,
    sourceRunId: null,
    title: "Telegram final summary",
    summary: "Delivered through native final_delivery worker.",
    status: "accepted",
    continuationPolicy: "none",
    createdByAgentId: "lead-agent",
    createdByUserId: null,
    createdByRunId: "run-1",
    actorAgentId: "lead-agent",
    actorUserId: null,
    createdAt: new Date("2026-05-13T12:01:00.000Z"),
    updatedAt: new Date("2026-05-13T12:02:00.000Z"),
    resolvedAt: new Date("2026-05-13T12:02:00.000Z"),
    payload: {
      version: 1,
      destination: {
        platform: "telegram",
        chatId: "-100123",
        threadId: "103",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Mission Control smoke",
      },
      message: {
        format: "markdown",
        body: "done",
      },
      artifacts: [
        {
          id: "artifact-1",
          type: "document",
          title: "Final report",
          isPrimary: true,
        },
      ],
      queuedAt: "2026-05-13T12:01:00.000Z",
    },
    result: {
      version: 1,
      outcome: "delivered",
      deliveredAt: "2026-05-13T12:02:00.000Z",
      externalMessageId: "910",
      attemptCount: 1,
      error: `to${"ken=synthetic-placeholder"} should be redacted`,
    },
    ...overrides,
  } as FinalDeliveryInteraction;
}

describe("IssueMissionControlPanel", () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  afterEach(() => {
    if (reactRoot) {
      act(() => reactRoot.unmount());
    }
    container?.remove();
  });

  it("renders Mission Control gates, required docs, and redacted final delivery history", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    reactRoot = createRoot(container);

    act(() => {
      reactRoot.render(
        <IssueMissionControlPanel
          issue={createIssue()}
          documents={[
            createDocument("validation-contract"),
            createDocument("worker-handoff"),
          ]}
          interactions={[createFinalDelivery()]}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Mission Control");
    expect(text).toContain("Gate: blocked");
    expect(text).toContain("Required documents missing");
    expect(text).toContain("validation-contract: present");
    expect(text).toContain("orchestration-contract: missing");
    expect(text).toContain("validator-report: missing");
    expect(text).toContain("Telegram · chat -100123 · thread 103");
    expect(text).toContain("delivered");
    expect(text).toContain("external 910");
    expect(text).toContain("artifacts 1");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("synthetic-placeholder");
  });

  it("stays hidden when neither Mission Control nor final delivery is configured", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    reactRoot = createRoot(container);

    act(() => {
      reactRoot.render(
        <IssueMissionControlPanel
          issue={createIssue({ executionPolicy: null, executionState: null })}
          documents={[]}
          interactions={[]}
        />,
      );
    });

    expect(container.textContent).toBe("");
  });
});
