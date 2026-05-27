// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, IssueRecoveryAction } from "@paperclipai/shared";
import { IssueRecoveryActionCard, deriveRecoveryCardState } from "./IssueRecoveryActionCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        "component.issueRecoveryActionCard.stateLabels.needed": "RECOVERY NEEDED",
        "component.issueRecoveryActionCard.stateLabels.inProgress": "RECOVERY IN PROGRESS",
        "component.issueRecoveryActionCard.stateLabels.observing": "OBSERVING ACTIVE RUN",
        "component.issueRecoveryActionCard.stateLabels.escalated": "RECOVERY ESCALATED",
        "component.issueRecoveryActionCard.stateLabels.resolved": "RECOVERY RESOLVED",
        "component.issueRecoveryActionCard.kindLabels.missingDisposition": "Missing Disposition",
        "component.issueRecoveryActionCard.kindLabels.strandedAssignedIssue": "Stranded Issue",
        "component.issueRecoveryActionCard.kindLabels.activeRunWatchdog": "Active Watchdog",
        "component.issueRecoveryActionCard.kindLabels.issueGraphLiveness": "Graph Liveness",
        "component.issueRecoveryActionCard.headlines.missingDisposition": "This issue's run finished, but no next step was chosen.",
        "component.issueRecoveryActionCard.headlines.strandedAssignedIssue": "Paperclip retried this issue's last run and it still has no live execution path.",
        "component.issueRecoveryActionCard.headlines.activeRunWatchdog": "The active run has been silent. Recovery is observing without interrupting it.",
        "component.issueRecoveryActionCard.headlines.issueGraphLiveness": "Paperclip detected this issue lost a live action path. A recovery owner needs to act.",
        "component.issueRecoveryActionCard.headlines.resolvedOutcome": "Recovery resolved as {{outcome}}.",
        "component.issueRecoveryActionCard.outcomeLabels.restored": "restored",
        "component.issueRecoveryActionCard.outcomeLabels.delegated": "delegated to follow-up",
        "component.issueRecoveryActionCard.outcomeLabels.falsePositive": "false positive",
        "component.issueRecoveryActionCard.outcomeLabels.blocked": "blocked",
        "component.issueRecoveryActionCard.outcomeLabels.escalated": "escalated",
        "component.issueRecoveryActionCard.outcomeLabels.cancelled": "cancelled",
        "component.issueRecoveryActionCard.wakePolicy.correctiveWakeQueued": "Corrective wake queued",
        "component.issueRecoveryActionCard.wakePolicy.escalatedToBoard": "Escalated to board",
        "component.issueRecoveryActionCard.wakePolicy.manual": "Manual",
        "component.issueRecoveryActionCard.wakePolicy.monitorScheduled": "Monitor scheduled",
        "component.issueRecoveryActionCard.wakePolicy.monitorScheduledWithInterval": "Monitor scheduled · {{interval}}",
        "component.issueRecoveryActionCard.timeFormat.inMinutes": "in {{min}}m",
        "component.issueRecoveryActionCard.timeFormat.minutesAgo": "{{min}}m ago",
        "component.issueRecoveryActionCard.runChip": "run {{short}}",
        "component.issueRecoveryActionCard.resolveButton": "Resolve…",
        "component.issueRecoveryActionCard.resolvePopoverTitle": "Resolve recovery",
        "component.issueRecoveryActionCard.resolveOptions.tryAgain.label": "Try again",
        "component.issueRecoveryActionCard.resolveOptions.tryAgain.description": "Dismiss recovery and return the source issue to todo.",
        "component.issueRecoveryActionCard.resolveOptions.markDone.label": "Mark issue done",
        "component.issueRecoveryActionCard.resolveOptions.markDone.description": "Restore by recording the requested work as complete.",
        "component.issueRecoveryActionCard.resolveOptions.sendForReview.label": "Send for review",
        "component.issueRecoveryActionCard.resolveOptions.sendForReview.description": "Hand off to a reviewer with a real review path.",
        "component.issueRecoveryActionCard.resolveOptions.falsePositiveDone.label": "False positive, done",
        "component.issueRecoveryActionCard.resolveOptions.falsePositiveDone.description": "Dismiss recovery and mark the source issue complete.",
        "component.issueRecoveryActionCard.resolveOptions.falsePositiveReview.label": "False positive, review",
        "component.issueRecoveryActionCard.resolveOptions.falsePositiveReview.description": "Dismiss recovery and send the source issue for review.",
        "component.issueRecoveryActionCard.attemptLabel": "attempt {{current}} of {{max}}",
        "component.issueRecoveryActionCard.timeoutLabel": "Times out {{time}}",
        "component.issueRecoveryActionCard.resolvedLabel": "Resolved as {{outcome}}",
        "component.issueRecoveryActionCard.resolvedTimeSeparator": " · ",
        "component.issueRecoveryActionCard.footerMessages.observing": "Recovery is observing without interrupting the live run.",
        "component.issueRecoveryActionCard.footerMessages.staysOpen": "The card stays open until an explicit decision is recorded.",
        "component.issueRecoveryActionCard.recovery": "Recovery:",
        "component.issueRecoveryActionCard.user": "user {{id}}",
        "component.issueRecoveryActionCard.unassigned": "unassigned — pick one to wake them",
        "component.issueRecoveryActionCard.returnsTo": "→ Returns to:",
        "common.board": "Board",
        "common.system": "System",
      };
      let result = translations[key] ?? key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          result = result.replace(`{{${k}}}`, String(v));
        });
      }
      return result;
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const ownerAgent: Agent = {
  id: "11111111-1111-1111-1111-111111111111",
  companyId: "company-1",
  name: "ClaudeCoder",
  role: "engineer",
  status: "idle",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  permissions: {},
  urlKey: "claudecoder",
} as unknown as Agent;

const returnAgent: Agent = {
  ...ownerAgent,
  id: "22222222-2222-2222-2222-222222222222",
  name: "CodexCoder",
  urlKey: "codexcoder",
} as Agent;

function buildAction(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    companyId: "company-1",
    sourceIssueId: "00000000-0000-0000-0000-0000000000ff",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: ownerAgent.id,
    ownerUserId: null,
    previousOwnerAgentId: returnAgent.id,
    returnOwnerAgentId: returnAgent.id,
    cause: "missing_disposition",
    fingerprint: "fp",
    evidence: {
      summary: "Run finished but no disposition was chosen.",
      sourceRunId: "7accd7a4-c9ca-4db2-9233-3228a037cc09",
    },
    nextAction: "Choose and record a valid issue disposition.",
    wakePolicy: { type: "wake_owner" },
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: null,
    lastAttemptAt: "2026-05-09T19:30:00.000Z",
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-05-09T19:30:00.000Z",
    updatedAt: "2026-05-09T19:30:00.000Z",
    ...overrides,
  };
}

describe("deriveRecoveryCardState", () => {
  it("maps active missing_disposition to needed", () => {
    expect(deriveRecoveryCardState(buildAction())).toBe("needed");
  });

  it("maps active_run_watchdog to observe_only", () => {
    expect(deriveRecoveryCardState(buildAction({ kind: "active_run_watchdog" }))).toBe("observe_only");
  });

  it("maps escalated status to escalated", () => {
    expect(deriveRecoveryCardState(buildAction({ status: "escalated" }))).toBe("escalated");
  });

  it("maps resolved/cancelled to resolved", () => {
    expect(deriveRecoveryCardState(buildAction({ status: "resolved" }))).toBe("resolved");
    expect(deriveRecoveryCardState(buildAction({ status: "cancelled" }))).toBe("resolved");
  });
});

describe("IssueRecoveryActionCard", () => {
  it("renders required fields and an aria-label naming the state", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildAction()}
        agentMap={new Map([
          [ownerAgent.id, ownerAgent],
          [returnAgent.id, returnAgent],
        ])}
        onResolve={() => {}}
      />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("aria-label")).toBe("Recovery action: needed");
    expect(node.textContent).toContain("RECOVERY NEEDED");
    expect(node.textContent).toContain("Missing Disposition");
    expect(node.textContent).not.toContain("missing_disposition");
    expect(node.textContent).toContain("This issue's run finished, but no next step was chosen.");
    expect(node.textContent).toContain("ClaudeCoder");
    expect(node.textContent).toContain("CodexCoder");
    expect(node.textContent).toContain("Choose and record a valid issue disposition.");
    expect(node.textContent).toContain("Corrective wake queued");
  });

  it("falls back to em dash when wake policy is absent", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction({ wakePolicy: null })} />,
    );
    expect(node.textContent).toContain("—");
  });

  it("renders observe_only tone for active_run_watchdog", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction({ kind: "active_run_watchdog" })} />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("aria-label")).toBe("Recovery action: observing active run");
    expect(node.textContent).toContain("OBSERVING ACTIVE RUN");
  });

  it("renders the resolved label and outcome when resolved", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction({ status: "resolved", outcome: "restored", resolvedAt: "2026-05-09T19:35:00.000Z" })} />,
    );
    expect(node.textContent).toContain("RECOVERY RESOLVED");
    expect(node.textContent).toContain("Resolved as restored");
  });

  it("calls resolve with todo and does not offer delegated recovery", () => {
    const onResolve = vi.fn();
    const node = render(
      <IssueRecoveryActionCard action={buildAction()} onResolve={onResolve} />,
    );
    click(node.querySelector("[data-testid='recovery-action-resolve-trigger']"));

    expect(document.body.textContent).toContain("Try again");
    expect(document.body.textContent).toContain("Mark issue done");
    expect(document.body.textContent).not.toContain("Mark blocked");
    expect(document.body.textContent).not.toContain("Delegate follow-up issue");
    click([...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Try again")) ?? null);

    expect(onResolve).toHaveBeenCalledWith("todo");
  });

  it("does not offer blocked recovery resolution without a blocker selection flow", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction()} onResolve={() => {}} canFalsePositive />,
    );
    click(node.querySelector("[data-testid='recovery-action-resolve-trigger']"));

    expect(document.body.textContent).toContain("Try again");
    expect(document.body.textContent).toContain("Mark issue done");
    expect(document.body.textContent).toContain("Send for review");
    expect(document.body.textContent).toContain("False positive, done");
    expect(document.body.textContent).toContain("False positive, review");
    expect(document.body.textContent).not.toContain("Mark blocked");
  });

  it("hides false-positive options unless canFalsePositive is set", () => {
    const first = render(
      <IssueRecoveryActionCard action={buildAction()} onResolve={() => {}} />,
    );
    click(first.querySelector("[data-testid='recovery-action-resolve-trigger']"));
    expect(document.body.textContent).not.toContain("False positive");

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;

    const onResolve = vi.fn();
    const second = render(
      <IssueRecoveryActionCard action={buildAction()} onResolve={onResolve} canFalsePositive />,
    );
    click(second.querySelector("[data-testid='recovery-action-resolve-trigger']"));
    expect(document.body.textContent).toContain("False positive, done");
    expect(document.body.textContent).toContain("False positive, review");
    click([...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("False positive, done")) ?? null);
    expect(onResolve).toHaveBeenCalledWith("false_positive_done");
  });
});
