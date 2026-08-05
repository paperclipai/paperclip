// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { NeedsAttentionBanner } from "./NeedsAttentionBanner";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function makeIssue(overrides: Partial<Issue> = {}, attentionOverrides = {}): Issue {
  return {
    id: "issue-self",
    identifier: "PAP-200",
    title: "Self task",
    status: "in_progress",
    ancestors: [
      { id: "issue-root", identifier: "PAP-100", title: "Root task" },
      { id: "issue-parent", identifier: "PAP-150", title: "Parent task" },
    ],
    blockerAttention: {
      state: "needs_attention",
      sampleBlockerIdentifier: "PAP-300",
    },
    blockedInboxAttention: {
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_chain_stalled",
      severity: "high",
      stoppedSinceAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      owner: { type: "agent", agentId: "agent-1", userId: null, label: "Coder" },
      action: { label: "Reopen the dead end", detail: "The leaf stopped with no owner." },
      sourceIssue: null,
      leafIssue: {
        id: "issue-leaf",
        identifier: "PAP-300",
        title: "Dead end leaf",
        status: "cancelled",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      recoveryIssue: null,
      approvalId: null,
      interactionId: null,
      sampleIssueIdentifier: "PAP-300",
      redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
      ...attentionOverrides,
    },
    ...overrides,
  } as unknown as Issue;
}

describe("NeedsAttentionBanner", () => {
  it("renders nothing when state is not needs_attention", () => {
    const issue = makeIssue({}, { state: "external_wait" });
    act(() => root!.render(<NeedsAttentionBanner issue={issue} />));
    expect(container!.querySelector('[role="note"]')).toBeNull();
    expect(container!.textContent).toBe("");
  });

  it("renders the banner, dead-end leaf identifier, and breadcrumb when needs_attention", () => {
    const issue = makeIssue();
    act(() => root!.render(<NeedsAttentionBanner issue={issue} />));

    const banner = container!.querySelector('[role="note"]');
    expect(banner).not.toBeNull();
    expect(container!.textContent).toContain("This chain is stalled and needs attention");

    const breadcrumb = container!.querySelector('[data-testid="needs-attention-breadcrumb"]');
    expect(breadcrumb).not.toBeNull();
    // root -> parent -> self chips.
    expect(breadcrumb!.textContent).toContain("PAP-100");
    expect(breadcrumb!.textContent).toContain("PAP-150");
    expect(breadcrumb!.textContent).toContain("PAP-200");

    // Dead-end badge names the leaf.
    const deadEnd = container!.querySelector('[data-testid="dead-end-badge"]');
    expect(deadEnd).not.toBeNull();
    expect(deadEnd!.textContent).toContain("PAP-300");
    expect(deadEnd!.textContent).toContain("dead end");
  });

  it("uses the danger tone (AlertCircle) when the owner is unrouted", () => {
    const issue = makeIssue({}, { owner: { type: "unknown", agentId: null, userId: null, label: null } });
    act(() => root!.render(<NeedsAttentionBanner issue={issue} />));
    // InlineBanner renders the lucide AlertCircle icon for tone="danger".
    expect(container!.querySelector("svg.lucide-circle-alert, svg.lucide-alert-circle")).not.toBeNull();
    expect(container!.textContent).toContain("no routable owner");
  });

  it("uses the warning tone (AlertTriangle) when the owner is routable", () => {
    const issue = makeIssue();
    act(() => root!.render(<NeedsAttentionBanner issue={issue} />));
    expect(
      container!.querySelector("svg.lucide-triangle-alert, svg.lucide-alert-triangle"),
    ).not.toBeNull();
  });

  it("calls onReopenDeadEnd when the reopen button is clicked", () => {
    const onReopenDeadEnd = vi.fn();
    const issue = makeIssue();
    act(() => root!.render(<NeedsAttentionBanner issue={issue} onReopenDeadEnd={onReopenDeadEnd} />));

    const reopen = Array.from(container!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reopen dead end"),
    );
    expect(reopen).toBeDefined();
    act(() => {
      reopen!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onReopenDeadEnd).toHaveBeenCalledTimes(1);
  });
});
