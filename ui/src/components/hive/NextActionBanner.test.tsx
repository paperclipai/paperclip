// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueBlockedInboxAttention, IssueBlockedInboxReason } from "@paperclipai/shared";
import { NextActionBanner } from "./NextActionBanner";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

function makeAttention(
  reason: IssueBlockedInboxReason,
  overrides: Partial<IssueBlockedInboxAttention> = {},
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason,
    severity: "medium",
    stoppedSinceAt: null,
    owner: { type: "user", agentId: null, userId: "u1", label: null },
    action: { label: "Do the thing", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function leafRef(identifier: string, id: string) {
  return {
    id,
    identifier,
    title: `Title ${identifier}`,
    status: "in_review" as const,
    priority: "medium" as const,
    assigneeAgentId: null,
    assigneeUserId: null,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(node));
  return container;
}

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}

describe("NextActionBanner", () => {
  it("renders Review with Accept → Done acting on the leaf issue", () => {
    const onAccept = vi.fn();
    const c = render(
      <NextActionBanner
        attention={makeAttention("in_review_without_action_path", {
          leafIssue: leafRef("HIV-4", "leaf-id"),
          action: { label: "HIV-4 is ready for review", detail: null },
        })}
        currentIssueId="HIV-3-id"
        onAccept={onAccept}
      />,
    );
    expect(c.querySelector("[data-testid='next-action-banner']")?.getAttribute("data-verb")).toBe("review");
    const accept = buttonByText("Accept");
    expect(accept).toBeTruthy();
    accept!.click();
    expect(onAccept).toHaveBeenCalledWith("leaf-id");
  });

  it("renders Approve/Reject for an approval and wires both", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <NextActionBanner
        attention={makeAttention("pending_board_decision", { approvalId: "ap-1" })}
        currentIssueId="i1"
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    buttonByText("Approve")!.click();
    buttonByText("Reject")!.click();
    expect(onApprove).toHaveBeenCalledWith("ap-1");
    expect(onReject).toHaveBeenCalledWith("ap-1");
  });

  it("renders a navigate link for an unblock reason", () => {
    const c = render(
      <NextActionBanner
        attention={makeAttention("blocked_by_unassigned_issue", {
          leafIssue: leafRef("HIV-7", "id7"),
        })}
        currentIssueId="i1"
      />,
    );
    expect(c.getAttribute("data-kind") ?? c.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe(
      "navigate",
    );
    expect([...document.querySelectorAll("a")].some((a) => a.textContent?.includes("HIV-7"))).toBe(true);
  });

  it("renders no action buttons for a waiting reason", () => {
    render(
      <NextActionBanner
        attention={makeAttention("external_owner_action")}
        currentIssueId="i1"
        onAccept={vi.fn()}
      />,
    );
    expect(document.querySelectorAll("button").length).toBe(0);
  });
});
