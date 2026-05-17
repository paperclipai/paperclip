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

  it("calls resolve with done and does not offer delegated recovery", () => {
    const onResolve = vi.fn();
    const node = render(
      <IssueRecoveryActionCard action={buildAction()} onResolve={onResolve} />,
    );
    click(node.querySelector("[data-testid='recovery-action-resolve-trigger']"));

    expect(document.body.textContent).toContain("Mark issue done");
    expect(document.body.textContent).not.toContain("Mark blocked");
    expect(document.body.textContent).not.toContain("Delegate follow-up issue");
    click([...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Mark issue done")) ?? null);

    expect(onResolve).toHaveBeenCalledWith("done");
  });

  it("does not offer blocked recovery resolution without a blocker selection flow", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction()} onResolve={() => {}} canFalsePositive />,
    );
    click(node.querySelector("[data-testid='recovery-action-resolve-trigger']"));

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
