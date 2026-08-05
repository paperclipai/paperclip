// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { WatchdogEscalationCard } from "./WatchdogEscalationCard";

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

function makeIssue(escalated = true): Issue {
  return {
    id: "issue-plan",
    identifier: "PAP-15023",
    title: "Status-cards plan",
    blockedInboxAttention: {
      state: "needs_attention",
      leafIssue: { id: "leaf", identifier: "PAP-15099", title: "SecurityEngineer re-review", status: "blocked", assigneeAgentId: null, assigneeUserId: null },
    },
    watchdog: {
      watchdogAgentId: "agent-wd",
      restorationFingerprint: "a8f7fingerprint",
      restorationAttemptCount: 3,
      restorationEscalatedAt: escalated ? new Date() : null,
      restorationAttempts: [
        { attempt: 1, fingerprint: "a8f7fingerprint", runId: "run-aaaa1111", mutations: [{ type: "add_comment", issueId: "leaf" }], completedAt: "2026-05-09T20:36:00.000Z" },
        { attempt: 2, fingerprint: "a8f7fingerprint", runId: "run-bbbb2222", mutations: [{ type: "update_issue", issueId: "leaf", update: { status: "todo" } }], completedAt: "2026-05-09T20:45:00.000Z" },
        { attempt: 3, fingerprint: "a8f7fingerprint", runId: "run-cccc3333", mutations: [], completedAt: "2026-05-09T20:51:00.000Z" },
      ],
    },
  } as unknown as Issue;
}

describe("WatchdogEscalationCard", () => {
  it("renders nothing when the watchdog is not escalated", () => {
    act(() => root!.render(<WatchdogEscalationCard issue={makeIssue(false)} />));
    expect(container!.querySelector('[data-testid="watchdog-escalation-card"]')).toBeNull();
  });

  it("renders the escalation header, dead-end leaf, and every attempt", () => {
    act(() => root!.render(<WatchdogEscalationCard issue={makeIssue()} watchdogAgentName="task-watchdog" />));
    const card = container!.querySelector('[data-testid="watchdog-escalation-card"]');
    expect(card).not.toBeNull();
    expect(container!.textContent).toContain("automatic recovery is exhausted");
    expect(container!.textContent).toContain("3 of 3 restoration attempts");
    expect(container!.textContent).toContain("PAP-15099");
    expect(container!.textContent).toContain("unchanged across all 3 attempts");
    const attempts = container!.querySelectorAll('[data-testid="watchdog-escalation-attempts"] > li');
    expect(attempts).toHaveLength(3);
  });

  it("fires reopen and reassign handlers", () => {
    const onReopenDeadEnd = vi.fn();
    const onReassign = vi.fn();
    act(() =>
      root!.render(
        <WatchdogEscalationCard issue={makeIssue()} onReopenDeadEnd={onReopenDeadEnd} onReassign={onReassign} />,
      ),
    );
    const reopen = container!.querySelector('[data-testid="watchdog-escalation-reopen"]') as HTMLButtonElement;
    const reassign = container!.querySelector('[data-testid="watchdog-escalation-reassign"]') as HTMLButtonElement;
    act(() => reopen.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => reassign.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onReopenDeadEnd).toHaveBeenCalledTimes(1);
    expect(onReassign).toHaveBeenCalledTimes(1);
  });

  it("renders the Dismiss trigger only when a dismiss handler is provided", () => {
    act(() => root!.render(<WatchdogEscalationCard issue={makeIssue()} />));
    expect(container!.querySelector('[data-testid="watchdog-escalation-dismiss-trigger"]')).toBeNull();
    act(() => root!.render(<WatchdogEscalationCard issue={makeIssue()} onDismiss={vi.fn()} />));
    expect(container!.querySelector('[data-testid="watchdog-escalation-dismiss-trigger"]')).not.toBeNull();
  });
});
