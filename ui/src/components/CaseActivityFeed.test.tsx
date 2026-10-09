// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseActivityFeed } from "./CaseActivityFeed";
import type { CaseEvent } from "@/api/cases";

function act(callback: () => void) {
  flushSync(callback);
}

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function event(overrides: Partial<CaseEvent>): CaseEvent {
  return {
    id: Math.random().toString(36).slice(2),
    caseId: "case-1",
    kind: "created",
    actorType: "system",
    actorUserId: null,
    actorAgentId: null,
    runId: null,
    payload: {},
    createdAt: "2026-07-07T00:00:00.000Z",
    actorAgentName: null,
    issue: null,
    ...overrides,
  };
}

describe("CaseActivityFeed", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  function render(events: CaseEvent[]) {
    const root = createRoot(container);
    act(() => root.render(<CaseActivityFeed events={events} />));
    return root;
  }

  it("shows the empty state when there are no events", () => {
    const root = render([]);
    expect(container.textContent).toContain("No activity yet");
    act(() => root.unmount());
  });

  it("renders actor name and run→issue attribution", () => {
    const root = render([
      event({
        kind: "document_revised",
        actorType: "agent",
        actorAgentId: "agent-1",
        actorAgentName: "Cases Agent",
        runId: "run-1",
        issue: { id: "i1", identifier: "PAP-42", title: "Source task", status: "in_progress" },
      }),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("document revised");
    expect(text).toContain("Cases Agent");
    expect(text).toContain("via");
    // The issue chip links to the issue detail.
    const issueLink = container.querySelector('a[href="/issues/PAP-42"]');
    expect(issueLink?.textContent).toContain("PAP-42");
    expect(issueLink?.textContent).toContain("Source task");
    act(() => root.unmount());
  });

  it("renders an auto-link event as a system actor with a linked issue", () => {
    const root = render([
      event({
        kind: "issue_linked",
        actorType: "system",
        issue: { id: "i2", identifier: "PAP-9", title: "Auto", status: "todo" },
      }),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("issue linked");
    expect(text).toContain("System");
    expect(text).toContain("issue");
    expect(container.querySelector('a[href="/issues/PAP-9"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("filters rows by kind when a filter chip is toggled", () => {
    const root = render([
      event({ kind: "created" }),
      event({ kind: "status_changed", payload: { previousStatus: "draft", status: "in_review" } }),
    ]);
    // The status-transition detail only appears in the status_changed row.
    expect(container.textContent).toContain("draft → in_review");

    // Open the activity filter dropdown and choose "created"; only created
    // rows remain, so the status-transition detail disappears.
    const filterButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("All activity"),
    );
    expect(filterButton).toBeTruthy();
    act(() => filterButton!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    const createdItem = Array.from(document.body.querySelectorAll('[role="menuitemcheckbox"]')).find(
      (item) => item.textContent === "created",
    );
    expect(createdItem).toBeTruthy();
    act(() => createdItem!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).not.toContain("draft → in_review");
    act(() => root.unmount());
  });
});
