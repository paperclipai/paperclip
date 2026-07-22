// @vitest-environment jsdom

import { act as reactAct, type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionCard, type DecisionIssueRef } from "./DecisionCard";
import type { Decision, DecisionEffectExecution } from "../api/decisions";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  if (typeof reactAct === "function") {
    await reactAct(callback);
    return;
  }
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useCaseHref: () => () => "#",
}));

const ISSUES: Record<string, DecisionIssueRef> = {
  "issue-origin": { id: "issue-origin", identifier: "PAP-123", title: "Gardener sweep", href: "/PAP/issues/PAP-123", status: "in_progress" },
  "issue-target": { id: "issue-target", identifier: "PAP-456", title: "Stale epic", href: "/PAP/issues/PAP-456", status: "backlog" },
  "issue-new": { id: "issue-new", identifier: "PAP-999", title: "Follow-up", href: "/PAP/issues/PAP-999", status: "todo" },
};
const resolveIssue = (id: string): DecisionIssueRef | null => ISSUES[id] ?? null;

function mkDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "decision-1",
    companyId: "c1",
    bundleId: null,
    originAgentId: "agent-gardener",
    originIssueId: "issue-origin",
    originRunId: "run-1",
    ruleKey: "stale-epic",
    title: "Stale epic PAP-456",
    body: "No activity for three weeks.",
    options: [
      { id: "comment", label: "Comment and snooze", effects: [{ type: "comment_on_issue", targetIssueId: "issue-target", staleness: "lenient", bodyMarkdown: "nudge" }] },
    ],
    inputs: null,
    status: "open",
    executionStatus: null,
    chosenOptionId: null,
    inputValues: null,
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: "2026-07-29T12:00:00Z",
    idempotencyKey: null,
    targetSnapshots: { "issue-target": { status: "backlog", assigneeAgentId: null, assigneeUserId: null, updatedAt: "2026-07-01T09:00:00Z", childCount: 2 } },
    continuationPolicy: "none",
    metadata: {},
    createdAt: "2026-07-22T09:00:00Z",
    updatedAt: "2026-07-22T09:00:00Z",
    ...overrides,
  };
}

function exec(overrides: Partial<DecisionEffectExecution>): DecisionEffectExecution {
  return {
    id: `exec-${overrides.effectIndex ?? 0}`,
    decisionId: "decision-1",
    effectIndex: 0,
    effectType: "comment_on_issue",
    targetIssueId: "issue-target",
    status: "executed",
    result: {},
    error: null,
    activityLogId: null,
    executedAt: "2026-07-22T10:00:00Z",
    ...overrides,
  };
}

function render(props: Partial<ComponentProps<typeof DecisionCard>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <DecisionCard decision={mkDecision()} resolveIssue={resolveIssue} originAgentName="Gardener" originIssue={ISSUES["issue-origin"]} {...props} />
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  return container!;
}

function clickButtonWithText(el: HTMLElement, text: string) {
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button with text "${text}"`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return button;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("DecisionCard", () => {
  it("renders a pending decision with provenance, effect summary and dismiss", () => {
    const el = render({});
    expect(el.textContent).toContain("Pending");
    expect(el.textContent).toContain("Gardener");
    expect(el.textContent).toContain("PAP-123");
    expect(el.textContent).toContain("Comment on PAP-456");
    expect([...el.querySelectorAll("button")].some((b) => b.textContent?.includes("Dismiss"))).toBe(true);
  });

  it("fires onDecide with the chosen option id", () => {
    const onDecide = vi.fn();
    const el = render({ onDecide });
    clickButtonWithText(el, "Comment and snooze");
    expect(onDecide).toHaveBeenCalledWith("comment", expect.any(Object));
  });

  it("fires onDismiss from the always-present zero-effect dismiss", () => {
    const onDismiss = vi.fn();
    const el = render({ onDismiss });
    clickButtonWithText(el, "Dismiss");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("warns and disables strict options when a target is stale", () => {
    const el = render({
      targetChanged: { "issue-target": true },
      decision: mkDecision({
        options: [
          { id: "strict", label: "Cancel it", effects: [{ type: "update_issue_status", targetIssueId: "issue-target", staleness: "strict", status: "cancelled" }] },
          { id: "lenient", label: "Just comment", effects: [{ type: "comment_on_issue", targetIssueId: "issue-target", staleness: "lenient", bodyMarkdown: "hi" }] },
        ],
      }),
    });
    expect(el.textContent).toContain("changed since this was proposed");
    expect(el.textContent).toContain("Blocked · stale");
    const strict = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Cancel it"));
    expect(strict?.disabled).toBe(true);
  });

  it("gates a cancel_issue_tree option behind a type-to-confirm step", () => {
    const onDecide = vi.fn();
    const el = render({
      onDecide,
      cancelTreePreview: () => [ISSUES["issue-target"]!],
      decision: mkDecision({
        options: [
          { id: "cancel", label: "Cancel the tree", style: "destructive", effects: [{ type: "cancel_issue_tree", targetIssueId: "issue-target", staleness: "strict", reasonComment: "stale" }] },
        ],
      }),
    });
    expect(el.textContent).toContain("Destructive");
    // First click opens the confirm gate rather than deciding.
    clickButtonWithText(el, "Cancel the tree");
    expect(onDecide).not.toHaveBeenCalled();
    expect(el.textContent).toContain("to confirm");
    const confirm = [...el.querySelectorAll("button")].find((b) => b.textContent?.match(/Cancel \d+ issue/));
    expect(confirm?.disabled).toBe(true);
  });

  it("renders decided result rows with entity links", () => {
    const el = render({
      decision: mkDecision({ status: "decided", executionStatus: "succeeded", chosenOptionId: "create" }),
      executions: [
        exec({ effectIndex: 0, effectType: "create_issue", status: "executed", result: { issueId: "issue-new" } }),
        exec({ effectIndex: 1, effectType: "update_issue_status", status: "executed", result: { issueId: "issue-target", status: "done" } }),
      ],
    });
    expect(el.textContent).toContain("Decided");
    expect(el.textContent).toContain("Created PAP-999");
    expect(el.textContent).toContain("Set PAP-456 to done");
    expect([...el.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/PAP/issues/PAP-999")).toBe(true);
    // No option buttons on a terminal decision.
    expect([...el.querySelectorAll("button")].length).toBe(0);
  });

  it("surfaces failure cause and the fail-closed / re-propose guidance on partial", () => {
    const el = render({
      decision: mkDecision({ status: "decided", executionStatus: "partial", chosenOptionId: "create" }),
      executions: [
        exec({ effectIndex: 0, effectType: "comment_on_issue", status: "executed" }),
        exec({ effectIndex: 1, effectType: "update_issue_status", status: "failed", error: "deny_decision_intersection" }),
      ],
    });
    expect(el.textContent).toContain("Partial");
    expect(el.textContent).toContain("permission boundary");
    expect(el.textContent).toContain("re-propose");
  });

  it("marks skipped effects as target-changed on a failed decision", () => {
    const el = render({
      decision: mkDecision({ status: "decided", executionStatus: "failed", chosenOptionId: "cancel" }),
      executions: [exec({ effectIndex: 0, effectType: "cancel_issue_tree", status: "skipped", error: "target_changed" })],
    });
    expect(el.textContent).toContain("Failed");
    expect(el.textContent).toContain("target changed since proposal");
  });

  it("renders expired and dismissed terminal states", () => {
    const expired = render({ decision: mkDecision({ status: "expired", metadata: { expiredReason: "ttl" } }) });
    expect(expired.textContent).toContain("Expired");
    expect(expired.textContent).toContain("window closed");
    act(() => root?.unmount());
    container?.remove();

    const dismissed = render({ decision: mkDecision({ status: "decided", executionStatus: "succeeded", chosenOptionId: "dismissed", metadata: { dismissed: true } }), executions: [] });
    expect(dismissed.textContent).toContain("Dismissed");
    expect(dismissed.textContent).toContain("no effects were run");
  });
});
