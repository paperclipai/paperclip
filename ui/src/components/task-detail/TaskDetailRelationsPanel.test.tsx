// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaskDetailReferencesPanel,
  TaskDetailSubtasksPanel,
  resolveTaskDetailSubtaskState,
} from "./TaskDetailRelationsPanel";

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    state: _state,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: { to: string; children: React.ReactNode; state?: unknown; disableIssueQuicklook?: boolean; issuePrefetch?: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

function createIssue(overrides: Partial<Issue> & Pick<Issue, "id" | "title" | "status">): Issue {
  return {
    companyId: "company-1",
    identifier: `PAP-${overrides.id}`,
    priority: "medium",
    ...overrides,
  } as Issue;
}

describe("task-detail relation panels", () => {
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

  it("puts progress before wholly clickable subtask navigation rows", () => {
    const onAdd = vi.fn();
    flushSync(() => root.render(
      <TaskDetailSubtasksPanel
        items={[
          createIssue({ id: "2", identifier: "PAP-2", title: "Completed setup", status: "done" }),
          createIssue({ id: "3", identifier: "PAP-3", title: "Run verification", status: "in_progress" }),
        ]}
        onAddSubtask={onAdd}
      />,
    ));

    const progress = container.querySelector('[role="progressbar"]');
    const firstLink = container.querySelector('a[href="/issues/PAP-2"]');
    expect(progress).not.toBeNull();
    expect(firstLink).not.toBeNull();
    expect(progress?.getAttribute("aria-valuenow")).toBe("50");
    expect(progress!.compareDocumentPosition(firstLink!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(container.textContent).toContain("Next action");
    expect(container.querySelector('a[href="/issues/PAP-3"]')?.textContent).toContain("Run verification");
    expect(firstLink?.textContent).toContain("Completed setup");
    expect(firstLink?.textContent).toContain("PAP-2");

    flushSync(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("puts a blocked subtask's root blocker before the shared task row", () => {
    const blocked = createIssue({
      id: "12",
      identifier: "PAP-12",
      title: "Ship the integration",
      status: "blocked",
      blockerAttention: {
        state: "needs_attention",
        reason: "attention_required",
        unresolvedBlockerCount: 1,
        coveredBlockerCount: 0,
        stalledBlockerCount: 0,
        attentionBlockerCount: 1,
        sampleBlockerIdentifier: "PAP-11",
        sampleStalledBlockerIdentifier: null,
        terminalBlocker: { id: "11", identifier: "PAP-11", title: "Approve the dependency" },
      },
    });
    flushSync(() => root.render(<TaskDetailSubtasksPanel items={[blocked]} />));

    const rootBlocker = container.querySelector('a[href="/issues/PAP-11"]');
    const blockedSubtask = container.querySelector('a[href="/issues/PAP-12"]');
    expect(rootBlocker?.textContent).toContain("Approve the dependency");
    expect(blockedSubtask?.closest('[data-slot="task-row"]')).not.toBeNull();
    expect(rootBlocker!.compareDocumentPosition(blockedSubtask!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("chooses active work before queued work and does not repeat it in the remaining list", () => {
    const todo = createIssue({ id: "21", title: "Queued follow-up", status: "todo" });
    const active = createIssue({ id: "22", title: "Active verification", status: "in_progress" });
    const done = createIssue({ id: "23", title: "Finished setup", status: "done" });

    const state = resolveTaskDetailSubtaskState([todo, active, done]);
    expect(state.nextAction?.id).toBe("22");
    expect(state.remainingItems.map((item) => item.id)).toEqual(["21", "23"]);
  });

  it("separates outbound references from inbound mentions", () => {
    flushSync(() => root.render(
      <TaskDetailReferencesPanel
        referenced={[{ id: "out", identifier: "PAP-8", title: "Referenced task", status: "todo" }]}
        mentionedIn={[{ id: "in", identifier: "PAP-9", title: "Mentions this task", status: "blocked" }]}
      />,
    ));

    const sections = container.querySelectorAll("section");
    expect(sections[0]?.textContent).toContain("Referenced task");
    expect(sections[0]?.textContent).not.toContain("Mentions this task");
    expect(sections[1]?.textContent).toContain("Mentions this task");
    expect(container.querySelector('a[href="/issues/PAP-9"]')).not.toBeNull();
  });
});
