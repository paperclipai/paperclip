// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { InboxIssueMetaLeading } from "./IssueColumns";

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
  act(() => root!.render(element));
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
