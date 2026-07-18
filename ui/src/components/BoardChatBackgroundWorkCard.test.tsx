// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChatBackgroundWorkCard } from "./BoardChatBackgroundWorkCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("./IssueLinkQuicklook", () => ({
  IssueLinkQuicklook: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

describe("BoardChatBackgroundWorkCard", () => {
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
    vi.clearAllMocks();
  });

  it("renders working background task copy without blocked-task language", () => {
    flushSync(() => {
      root.render(
        <BoardChatBackgroundWorkCard
          childrenIssues={[
            {
              id: "issue-child",
              identifier: "PAP-2",
              title: "Implement OAuth",
              status: "in_progress",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("Working on this in the background");
    expect(container.textContent).toContain("I'll let you know here when it's done.");
    expect(container.textContent).toContain("PAP-2");
    expect(container.textContent).toContain("Working");
    expect(container.textContent).not.toContain("blocked");
  });

  it("uses done and needs-input chip copy for completed and review children", () => {
    flushSync(() => {
      root.render(
        <BoardChatBackgroundWorkCard
          childrenIssues={[
            {
              id: "issue-done",
              identifier: "PAP-3",
              title: "Ship report",
              status: "done",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
            {
              id: "issue-review",
              identifier: "PAP-4",
              title: "Pick deployment",
              status: "in_review",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("I'll let you know here as each piece finishes.");
    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("Needs your input");
    expect(container.textContent).toContain("Review the question ->");
  });

  it("switches helper copy when all background work is done", () => {
    flushSync(() => {
      root.render(
        <BoardChatBackgroundWorkCard
          childrenIssues={[
            {
              id: "issue-done",
              identifier: "PAP-3",
              title: "Ship report",
              status: "done",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("All set. Tap a task to see what shipped.");
  });
});
