// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { IssueDocument } from "@paperclipai/shared";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueContinuationHandoff } from "./IssueContinuationHandoff";

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createHandoffDocument(): IssueDocument {
  return {
    id: "document-handoff",
    companyId: "company-1",
    issueId: "issue-1",
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: "Continuation Summary",
    format: "markdown",
    body: "# Handoff\n\nResume from the activity tab.",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-04-19T12:00:00.000Z"),
    updatedAt: new Date("2026-04-19T12:05:00.000Z"),
  };
}

describe("IssueContinuationHandoff", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    container.remove();
  });

  it("renders compact metadata by default with copy access", async () => {
    const root = createRoot(container);
    const handoff = createHandoffDocument();

    await act(async () => {
      root.render(<IssueContinuationHandoff document={handoff} />);
    });

    expect(container.textContent).toContain("Continuation Summary");
    expect(container.textContent).toContain("handoff");
    expect(container.textContent).not.toContain("Resume from the activity tab.");

    const copyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Copy"));
    expect(copyButton).toBeTruthy();

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(handoff.body);
    expect(container.textContent).toContain("Copied");

    await act(async () => {
      root.unmount();
    });
  });

  it("expands and anchors the handoff body when focused from a document deep link", async () => {
    const root = createRoot(container);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    await act(async () => {
      root.render(<IssueContinuationHandoff document={createHandoffDocument()} focusSignal={1} />);
    });

    expect(container.querySelector(`#document-${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`)).toBeTruthy();
    expect(container.textContent).toContain("Resume from the activity tab.");
    expect(scrollIntoView).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});
