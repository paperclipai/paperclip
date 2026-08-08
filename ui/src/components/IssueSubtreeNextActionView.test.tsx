// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IssueStatus,
  IssueSubtreeDiagnosticNode,
  IssueSubtreeDiagnosticsResponse,
} from "@paperclipai/shared";
import { IssueSubtreeNextActionView } from "./IssueSubtreeNextActionView";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(node: ReactNode) {
  flushSync(() => {
    root.render(node);
  });
}

function node(
  overrides: { id: string; identifier: string; status: IssueStatus; depth?: number } & Partial<IssueSubtreeDiagnosticNode>,
): IssueSubtreeDiagnosticNode {
  const { id, identifier, status, depth = 0, ...rest } = overrides;
  return {
    issue: {
      id,
      identifier,
      title: `${identifier} title`,
      status,
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    },
    parentId: null,
    depth,
    diagnosis: null,
    likelyReason: null,
    blockers: [],
    blockerReadiness: null,
    omittedUnauthorizedBlockerCount: null,
    wakeEvents: [],
    wakeRequestCount: 0,
    activityRecordCount: 0,
    truncated: false,
    truncatedSections: { blockers: false, wakeRequests: false, activityRecords: false },
    ...rest,
  };
}

const rootIssueSummary: IssueSubtreeDiagnosticsResponse["issue"] = {
  id: "root",
  identifier: "PAP-1",
  title: "root",
  status: "blocked",
  priority: "medium",
  assigneeAgentId: null,
  assigneeUserId: null,
};

function response(nodes: IssueSubtreeDiagnosticNode[]): IssueSubtreeDiagnosticsResponse {
  return {
    issue: nodes[0]?.issue ?? rootIssueSummary,
    diagnosis: null,
    likelyReason: null,
    nodes,
    edges: [],
    nodeCount: nodes.length,
    omittedUnauthorizedNodeCount: null,
    truncated: false,
    truncatedSections: { nodes: false, depth: false, blockers: false, wakeRequests: false, activityRecords: false },
    caps: {
      maxDepth: 5,
      maxNodes: 50,
      maxBlockersPerNode: 20,
      maxWakeRequestsPerNode: 20,
      maxActivityRecordsPerNode: 20,
      lookbackDays: 14,
    },
  };
}

describe("IssueSubtreeNextActionView", () => {
  it("renders one row per node with a per-node lane and highlights the single actionable leaf", () => {
    render(
      <IssueSubtreeNextActionView
        data={response([
          node({
            id: "root",
            identifier: "PAP-1",
            status: "blocked",
            blockers: [
              {
                id: "leaf",
                identifier: "PAP-2",
                title: "child",
                status: "in_progress",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
                isUnresolved: true,
                isDependencyReady: false,
                isPendingFinalize: false,
                flags: [],
              },
            ],
          }),
          node({
            id: "leaf",
            identifier: "PAP-2",
            status: "in_progress",
            depth: 1,
            parentId: "root",
            wakeEvents: [{
              kind: "wake_request",
              agentId: "agent-1",
              source: "assigned",
              reason: "issue_assigned",
              status: "queued",
              coalescedCount: 0,
              runId: null,
              requestedAt: "2026-08-06T00:00:00.000Z",
              claimedAt: null,
              finishedAt: null,
              failureClass: null,
            }],
            wakeRequestCount: 1,
          }),
        ])}
      />,
    );

    const rows = container.querySelectorAll('[data-testid="issue-subtree-node"]');
    expect(rows).toHaveLength(2);

    // Root is blocked by its child.
    expect(rows[0].getAttribute("data-node-lane")).toBe("blocked_real_work");
    // The unblocked, in-progress child is where work moves — the actionable leaf.
    expect(rows[1].getAttribute("data-actionable-leaf")).toBe("true");
    expect(rows[0].getAttribute("data-actionable-leaf")).toBeNull();
    expect(container.textContent).toContain("Blocked → PAP-2");
    expect(container.textContent).toContain("Act here");
  });

  it("renders nothing when there are no nodes", () => {
    render(<IssueSubtreeNextActionView data={response([])} />);
    expect(container.querySelector('[data-testid="issue-subtree-next-action"]')).toBeNull();
  });
});
