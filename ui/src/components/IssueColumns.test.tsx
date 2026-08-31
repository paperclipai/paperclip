// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { InboxIssueMetaLeading, InboxIssueTrailingColumns } from "./IssueColumns";
import { TooltipProvider } from "@/components/ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void): void {
  flushSync(callback);
}

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-id",
    identifier: "PAP-1",
    status: "in_progress",
    blockerAttention: false,
    ...overrides,
  } as unknown as Issue;
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function renderLeading(element: React.ReactElement): string {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<TooltipProvider>{element}</TooltipProvider>));
  return container.textContent ?? "";
}

describe("InboxIssueMetaLeading live state", () => {
  it("shows the own Live chip for a running issue and never the subtree chip", () => {
    const text = renderLeading(
      <InboxIssueMetaLeading
        issue={makeIssue({ id: "child", identifier: "PAP-2", status: "in_progress" })}
        isLive
        subtreeLiveCount={3}
      />,
    );
    expect(text).toContain("Live");
    expect(text).not.toContain("live below");
  });

  it("shows the distinct subtree chip for a done parent with live descendants", () => {
    const text = renderLeading(
      <InboxIssueMetaLeading
        issue={makeIssue({ id: "parent", identifier: "PAP-1", status: "done" })}
        isLive={false}
        subtreeLiveCount={2}
      />,
    );
    // The done parent must NOT borrow the running child's "Live" chip.
    expect(text).toContain("2 live below");
    expect(text).not.toMatch(/(^|[^a-z])Live([^a-z]|$)/);
  });

  it("can suppress the subtree chip when the status glyph already carries descendant liveness", () => {
    const text = renderLeading(
      <InboxIssueMetaLeading
        issue={makeIssue({ id: "parent", identifier: "PAP-1", status: "blocked" })}
        isLive={false}
        subtreeLiveCount={2}
        showSubtreeLiveChip={false}
      />,
    );
    expect(text).not.toContain("live below");
  });

  it("renders no live treatment when the issue and its subtree are idle", () => {
    const text = renderLeading(
      <InboxIssueMetaLeading
        issue={makeIssue({ id: "idle", identifier: "PAP-3", status: "done" })}
        isLive={false}
        subtreeLiveCount={0}
      />,
    );
    expect(text).not.toContain("Live");
    expect(text).not.toContain("live below");
  });
});

describe("InboxIssueTrailingColumns attribution", () => {
  it("renders a kicked off by column for agent creators with square identity", () => {
    const text = renderLeading(
      <InboxIssueTrailingColumns
        issue={makeIssue({
          createdByAgentId: "agent-1",
          createdByUserId: null,
          updatedAt: new Date("2026-04-06T12:00:00.000Z"),
        })}
        columns={["kickedOffBy"]}
        projectName={null}
        projectColor={null}
        workspaceName={null}
        assigneeName={null}
        creatorAgentName="CodexCoder"
        currentUserId="user-1"
        parentIdentifier={null}
        parentTitle={null}
      />,
    );

    expect(text).toContain("CodexCoder");
    expect(container?.querySelector('[data-shape="square"]')).not.toBeNull();
  });

  it("renders a kicked off by column for user creators", () => {
    const text = renderLeading(
      <InboxIssueTrailingColumns
        issue={makeIssue({
          createdByAgentId: null,
          createdByUserId: "user-1",
          updatedAt: new Date("2026-04-06T12:00:00.000Z"),
        })}
        columns={["kickedOffBy"]}
        projectName={null}
        projectColor={null}
        workspaceName={null}
        assigneeName={null}
        creatorUserName="Riley Board"
        currentUserId="user-1"
        parentIdentifier={null}
        parentTitle={null}
      />,
    );

    expect(text).toContain("Riley Board");
    expect(container?.querySelector('[data-shape="circle"]')).not.toBeNull();
  });

  it("attributes an agent-created issue to the transitive responsible user (circle, not agent square)", () => {
    const text = renderLeading(
      <InboxIssueTrailingColumns
        issue={makeIssue({
          createdByAgentId: "agent-1",
          createdByUserId: null,
          responsibleUserId: "user-2",
          updatedAt: new Date("2026-04-06T12:00:00.000Z"),
        })}
        columns={["kickedOffBy"]}
        projectName={null}
        projectColor={null}
        workspaceName={null}
        assigneeName={null}
        creatorAgentName="CodexCoder"
        creatorUserName="Morgan Product"
        viaAgentName="CodexCoder"
        currentUserId="user-1"
        parentIdentifier={null}
        parentTitle={null}
      />,
    );

    // The responsible user wins over the creating agent.
    expect(text).toContain("Morgan Product");
    expect(container?.querySelector('[data-shape="circle"]')).not.toBeNull();
    expect(container?.querySelector('[data-shape="square"]')).toBeNull();
  });

  it("surfaces the responsible user for a routine execution with no creator", () => {
    const text = renderLeading(
      <InboxIssueTrailingColumns
        issue={makeIssue({
          createdByAgentId: null,
          createdByUserId: null,
          responsibleUserId: "user-2",
          updatedAt: new Date("2026-04-06T12:00:00.000Z"),
        })}
        columns={["kickedOffBy"]}
        projectName={null}
        projectColor={null}
        workspaceName={null}
        assigneeName={null}
        creatorUserName="Morgan Product"
        currentUserId="user-1"
        parentIdentifier={null}
        parentTitle={null}
      />,
    );

    expect(text).toContain("Morgan Product");
    expect(text).not.toContain("Unknown");
  });
});
