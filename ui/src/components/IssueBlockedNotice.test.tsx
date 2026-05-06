// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueBlockedNotice } from "./IssueBlockedNotice";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe("IssueBlockedNotice", () => {
  it("renders a successful-run next-step notice without requiring blockers", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="in_progress"
        blockers={[]}
        agentName="CodexCoder"
        successfulRunHandoff={{
          state: "required",
          required: true,
          sourceRunId: "12345678-aaaa-bbbb-cccc-123456789abc",
          correctiveRunId: null,
          assigneeAgentId: "agent-1",
          detectedProgressSummary: "Updated the plan and left follow-up work.",
          createdAt: "2026-05-01T00:00:00.000Z",
        }}
      />,
    );

    expect(node.textContent).toContain("This issue still needs a next step.");
    expect(node.textContent).toContain("Corrective wake queued for CodexCoder");
    expect(node.textContent).toContain("Detected progress: Updated the plan");
    expect(node.textContent).not.toContain("Work on this issue is blocked until");
    expect(node.querySelector('[data-successful-run-handoff="required"]')).not.toBeNull();
  });

  it("does not render when the issue is done even if a stale handoff state is required", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="done"
        blockers={[]}
        agentName="CodexCoder"
        successfulRunHandoff={{
          state: "required",
          required: true,
          sourceRunId: "12345678-aaaa-bbbb-cccc-123456789abc",
          correctiveRunId: null,
          assigneeAgentId: "agent-1",
          detectedProgressSummary: "Updated the plan and left follow-up work.",
          createdAt: "2026-05-01T00:00:00.000Z",
        }}
      />,
    );

    expect(node.textContent).toBe("");
  });

  it("does not render when the issue is cancelled even if blockers remain", () => {
    const node = render(
      <IssueBlockedNotice
        issueStatus="cancelled"
        blockers={[
          {
            id: "blocker-1",
            identifier: "PAP-123",
            title: "Blocker",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(node.textContent).toBe("");
  });
});
