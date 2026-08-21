// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, IssueRecoveryAction } from "@paperclipai/shared";
import { IssueRecoveryActionCard, deriveRecoveryCardState } from "./IssueRecoveryActionCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  const maybePromise = result as unknown as PromiseLike<unknown>;
  if (result && typeof maybePromise.then === "function") {
    throw new TypeError("This test act shim only supports synchronous callbacks.");
  }
  return result as T;
}

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
  it("renders state and kind attributes with owner names and the recorded next action", () => {
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
    expect(section).not.toBeNull();
    expect(section?.getAttribute("data-recovery-state")).toBe("needed");
    expect(section?.getAttribute("data-recovery-kind")).toBe("missing_disposition");
    expect(node.textContent).toContain("RECOVERY NEEDED");
    expect(node.textContent).toContain("Missing Disposition");
    expect(node.textContent).toContain(
      "This task's run finished, but no next step was chosen. Choose what happens next — try the task again, mark it done, or send it for review.",
    );
    expect(node.textContent).toContain("An agent will be asked to choose the next step");
    expect(node.textContent).toContain("ClaudeCoder");
    expect(node.textContent).toContain("CodexCoder");
    expect(node.textContent).toContain("Choose and record a valid issue disposition.");
  });

  it("renders observe_only tone for active_run_watchdog", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction({ kind: "active_run_watchdog" })} />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-state")).toBe("observe_only");
    expect(node.textContent).toContain("OBSERVING ACTIVE RUN");
    expect(node.textContent).toContain(
      "The active run has been silent. Recovery is observing without interrupting it.",
    );
  });

  it("explains issue_graph_liveness in plain language", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildAction({ kind: "issue_graph_liveness", cause: "issue_graph_liveness" })}
      />,
    );
    expect(node.textContent).toContain("Task Needs Next Step");
    expect(node.textContent).toContain(
      "Paperclip could not find a clear next step for this open task. Choose whether to continue work, send it for review, mark it done, or record what is blocking it.",
    );
  });

  it("falls back to an em dash when no evidence summary is available", () => {
    const node = render(<IssueRecoveryActionCard action={buildAction({ evidence: {} })} />);
    expect(node.textContent).toContain("—");
  });

  it("renders workspace_validation with its kind attribute and the recorded next action", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildAction({
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          nextAction:
            "Repair the source issue workspace link, project workspace cwd, or git checkout before resuming adapter execution.",
          wakePolicy: { type: "manual_repair_required" },
          evidence: {
            recoveryCause: "workspace_validation_failed",
            latestRunErrorCode: "workspace_validation_failed",
          },
        })}
      />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-kind")).toBe("workspace_validation");
    expect(node.textContent).toContain("Workspace Validation");
    expect(node.textContent).toContain(
      "Paperclip stopped this run because the task's git workspace could not be validated.",
    );
    expect(node.textContent).toContain("Repair the source issue workspace link");
  });

  it("renders a human evidence summary as prose, not a mono log line", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildAction({
          kind: "stranded_assigned_issue",
          cause: "stranded_assigned_issue",
          evidence: {
            summary: "Unmanaged background task stopped; no durable live path.",
            latestRunStatus: "failed",
            latestRunErrorCode: "unmanaged_background_task_stopped",
            sourceRunId: "7accd7a4-c9ca-4db2-9233-3228a037cc09",
          },
        })}
      />,
    );
    const summary = Array.from(node.querySelectorAll("span")).find((el) =>
      el.textContent === "Unmanaged background task stopped; no durable live path.",
    );
    expect(summary).toBeTruthy();
    expect(summary?.className).toContain("text-xs");
    expect(summary?.className).not.toContain("font-mono");
    expect(node.textContent).toContain(
      "To get it moving, choose what happens next — try the task again, mark it done, or send it for review.",
    );
  });

  it("keeps code-shaped evidence (error code, no summary) in the mono treatment", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildAction({
          kind: "workspace_validation",
          cause: "workspace_validation_failed",
          evidence: {
            latestRunErrorCode: "workspace_validation_failed",
          },
        })}
      />,
    );
    const code = Array.from(node.querySelectorAll("span")).find((el) =>
      el.textContent === "workspace_validation_failed",
    );
    expect(code).toBeTruthy();
    expect(code?.className).toContain("font-mono");
  });

  it("renders the resolved state and outcome when resolved", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction({ status: "resolved", outcome: "restored", resolvedAt: "2026-05-09T19:35:00.000Z" })} />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-state")).toBe("resolved");
    expect(node.textContent).toContain("RECOVERY RESOLVED");
    expect(node.textContent).toContain("Recovery resolved as restored.");
    expect(node.textContent).toContain("Resolved as restored");
  });

  it("calls resolve with todo and does not offer delegated recovery", () => {
    const onResolve = vi.fn();
    const node = render(
      <IssueRecoveryActionCard action={buildAction()} onResolve={onResolve} />,
    );
    click(node.querySelector("[data-testid='recovery-action-resolve-trigger']"));

    expect(document.body.textContent).toContain("Try again");
    expect(document.body.textContent).toContain("Mark task done");
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
    expect(document.body.textContent).toContain("Mark task done");
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

function buildWorkspaceValidationAction(
  overrides: {
    action?: Partial<IssueRecoveryAction>;
    provenance?: Record<string, unknown>;
    workspaceValidation?: Record<string, unknown>;
  } = {},
): IssueRecoveryAction {
  const provenance = {
    expectedHeadSha: "aaaaaaaaaaaa11112222",
    actualHeadSha: "bbbbbbbbbbbb33334444",
    ancestryVerdict: "diverged",
    plainLanguageReason:
      'The recorded branch "PAP-522-recorded" is not an ancestor of the checked-out branch "nleach/PAP-1405-live", so Paperclip cannot prove a forward-only reconciliation.',
    ...overrides.provenance,
  };
  return buildAction({
    kind: "workspace_validation",
    cause: "workspace_validation_failed",
    evidence: {
      workspaceValidation: {
        reason: "git_worktree_branch_incoherence",
        expectedBranch: "PAP-522-recorded",
        actualBranch: "nleach/PAP-1405-live",
        cleanliness: "clean",
        provenance,
        ...overrides.workspaceValidation,
      },
    },
    ...overrides.action,
  });
}

describe("IssueRecoveryActionCard workspace_validation divergence", () => {
  it("renders the divergence diagnosis with branches, shas, verdict and plain-language reason", () => {
    const node = render(<IssueRecoveryActionCard action={buildWorkspaceValidationAction()} />);
    const diagnosis = node.querySelector("[data-testid='recovery-divergence-diagnosis']");
    expect(diagnosis).not.toBeNull();
    const text = diagnosis?.textContent ?? "";
    expect(text).toContain("Divergence diagnosis");
    expect(text).toContain("Expected · recorded");
    expect(text).toContain("Live · checked out");
    expect(text).toContain("PAP-522-recorded");
    expect(text).toContain("nleach/PAP-1405-live");
    // shortened shas (10 chars)
    expect(text).toContain("aaaaaaaaaa");
    expect(text).toContain("bbbbbbbbbb");
    expect(text).toContain("cannot prove a forward-only reconciliation");
    expect(node.querySelector("[data-testid='recovery-ancestry-verdict']")).not.toBeNull();
  });

  it("labels each ancestry verdict", () => {
    const diverged = render(<IssueRecoveryActionCard action={buildWorkspaceValidationAction()} />);
    expect(diverged.querySelector("[data-testid='recovery-ancestry-verdict']")?.textContent).toBe("Diverged");

    const ancestor = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction({ provenance: { ancestryVerdict: "ancestor" } })}
      />,
    );
    expect(ancestor.querySelector("[data-testid='recovery-ancestry-verdict']")?.textContent).toBe("Forward-only");

    const unknown = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction({ provenance: { ancestryVerdict: "unknown" } })}
      />,
    );
    expect(unknown.querySelector("[data-testid='recovery-ancestry-verdict']")?.textContent).toBe("Ancestry unknown");
  });

  it("does not render a divergence diagnosis for non-incoherence workspace failures", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction({
          workspaceValidation: { reason: "workspace_link_missing", provenance: undefined },
        })}
      />,
    );
    expect(node.querySelector("[data-testid='recovery-divergence-diagnosis']")).toBeNull();
  });

  it("offers the re-issue action and passes the live branch as the base ref", () => {
    const onReissueIsolated = vi.fn();
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction()}
        onReissueIsolated={onReissueIsolated}
      />,
    );
    click(node.querySelector("[data-testid='recovery-action-reissue-trigger']"));
    click(document.body.querySelector("[data-testid='recovery-action-reissue-confirm']"));
    expect(onReissueIsolated).toHaveBeenCalledWith({
      baseRef: "nleach/PAP-1405-live",
      liveBranch: "nleach/PAP-1405-live",
      liveHeadSha: "bbbbbbbbbbbb33334444",
      expectedBranch: "PAP-522-recorded",
    });
  });

  it("falls back to the live HEAD sha as base ref when the branch is detached", () => {
    const onReissueIsolated = vi.fn();
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction({ workspaceValidation: { actualBranch: null } })}
        onReissueIsolated={onReissueIsolated}
      />,
    );
    click(node.querySelector("[data-testid='recovery-action-reissue-trigger']"));
    click(document.body.querySelector("[data-testid='recovery-action-reissue-confirm']"));
    expect(onReissueIsolated).toHaveBeenCalledWith(
      expect.objectContaining({ baseRef: "bbbbbbbbbbbb33334444", liveBranch: null }),
    );
  });

  it("does not offer the re-issue action for non-workspace kinds", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction()} onReissueIsolated={() => {}} />,
    );
    expect(node.querySelector("[data-testid='recovery-action-reissue-trigger']")).toBeNull();
  });

  it("disables the re-issue action while a re-issue is pending", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction()}
        onReissueIsolated={() => {}}
        reissuePending
      />,
    );
    const trigger = node.querySelector<HTMLButtonElement>("[data-testid='recovery-action-reissue-trigger']");
    expect(trigger?.disabled).toBe(true);
  });
});

function setTextareaValue(element: HTMLTextAreaElement | null, value: string) {
  if (!element) throw new Error("Expected a textarea to exist");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("IssueRecoveryActionCard W7 reconcile actions", () => {
  it("offers 'Reconcile forward & continue' only for an ancestor verdict and calls the handler", () => {
    const onReconcileForward = vi.fn();
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction({ provenance: { ancestryVerdict: "ancestor" } })}
        onReconcileForward={onReconcileForward}
      />,
    );
    const button = node.querySelector("[data-testid='recovery-action-reconcile-forward']");
    expect(button).not.toBeNull();
    click(button);
    expect(onReconcileForward).toHaveBeenCalledTimes(1);
  });

  it("hides 'Reconcile forward & continue' when the verdict is not an ancestor", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction({ provenance: { ancestryVerdict: "diverged" } })}
        onReconcileForward={() => {}}
      />,
    );
    expect(node.querySelector("[data-testid='recovery-action-reconcile-forward']")).toBeNull();
  });

  it("disables reconcile-forward while a reconcile is pending", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction({ provenance: { ancestryVerdict: "ancestor" } })}
        onReconcileForward={() => {}}
        reconcilePending
      />,
    );
    const button = node.querySelector<HTMLButtonElement>("[data-testid='recovery-action-reconcile-forward']");
    expect(button?.disabled).toBe(true);
  });

  it("never renders the break-glass action for a non-permitted operator", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction()}
        onBreakGlassOverride={() => {}}
        canBreakGlass={false}
      />,
    );
    expect(node.querySelector("[data-testid='recovery-action-breakglass-trigger']")).toBeNull();
  });

  it("break-glass restates the divergence and gates the override behind a required reason", () => {
    const onBreakGlassOverride = vi.fn();
    const node = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction()}
        onBreakGlassOverride={onBreakGlassOverride}
        canBreakGlass
      />,
    );
    click(node.querySelector("[data-testid='recovery-action-breakglass-trigger']"));

    // The confirm step restates the divergence: both branches and both short SHAs.
    const restated = document.body.querySelector("[data-testid='recovery-breakglass-restated-divergence']");
    const restatedText = restated?.textContent ?? "";
    expect(restatedText).toContain("PAP-522-recorded");
    expect(restatedText).toContain("nleach/PAP-1405-live");
    expect(restatedText).toContain("aaaaaaaaaa");
    expect(restatedText).toContain("bbbbbbbbbb");

    // The override is disabled until a non-empty reason is recorded.
    const confirm = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='recovery-action-breakglass-confirm']",
    );
    expect(confirm?.disabled).toBe(true);
    click(confirm);
    expect(onBreakGlassOverride).not.toHaveBeenCalled();

    // Whitespace-only reason does not enable it.
    setTextareaValue(
      document.body.querySelector<HTMLTextAreaElement>("[data-testid='recovery-breakglass-reason']"),
      "   ",
    );
    expect(
      document.body.querySelector<HTMLButtonElement>("[data-testid='recovery-action-breakglass-confirm']")?.disabled,
    ).toBe(true);

    // A real reason enables the override and is passed (trimmed) to the handler.
    setTextareaValue(
      document.body.querySelector<HTMLTextAreaElement>("[data-testid='recovery-breakglass-reason']"),
      "  Verified live branch is safe to adopt.  ",
    );
    const enabledConfirm = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='recovery-action-breakglass-confirm']",
    );
    expect(enabledConfirm?.disabled).toBe(false);
    click(enabledConfirm);
    expect(onBreakGlassOverride).toHaveBeenCalledWith("Verified live branch is safe to adopt.");
  });

  it("does not offer reconcile actions for non-workspace recovery kinds", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildAction()}
        onReconcileForward={() => {}}
        onBreakGlassOverride={() => {}}
        canBreakGlass
      />,
    );
    expect(node.querySelector("[data-testid='recovery-action-reconcile-forward']")).toBeNull();
    expect(node.querySelector("[data-testid='recovery-action-breakglass-trigger']")).toBeNull();
  });
});

function buildDirtyDivergenceAction(
  overrides: {
    action?: Partial<IssueRecoveryAction>;
    provenance?: Record<string, unknown>;
    workspaceValidation?: Record<string, unknown>;
  } = {},
): IssueRecoveryAction {
  return buildWorkspaceValidationAction({
    ...overrides,
    workspaceValidation: {
      cleanliness: "dirty",
      statusEntryCount: 3,
      dirtyPathSample: ["src/app.ts", "README.md"],
      sourceIdentifier: "PAP-1405",
      ...overrides.workspaceValidation,
    },
  });
}

describe("IssueRecoveryActionCard repair workspace (quarantine_restore)", () => {
  it("offers the repair action only for a dirty divergence", () => {
    const cleanNode = render(
      <IssueRecoveryActionCard
        action={buildWorkspaceValidationAction({ workspaceValidation: { cleanliness: "clean" } })}
        onQuarantineRestore={() => {}}
      />,
    );
    expect(cleanNode.querySelector("[data-testid='recovery-action-repair-trigger']")).toBeNull();

    const dirtyNode = render(
      <IssueRecoveryActionCard action={buildDirtyDivergenceAction()} onQuarantineRestore={() => {}} />,
    );
    expect(dirtyNode.querySelector("[data-testid='recovery-action-repair-trigger']")).not.toBeNull();
  });

  it("does not offer the repair action without a handler or for non-workspace kinds", () => {
    const noHandler = render(<IssueRecoveryActionCard action={buildDirtyDivergenceAction()} />);
    expect(noHandler.querySelector("[data-testid='recovery-action-repair-trigger']")).toBeNull();

    const nonWorkspace = render(
      <IssueRecoveryActionCard action={buildAction()} onQuarantineRestore={() => {}} />,
    );
    expect(nonWorkspace.querySelector("[data-testid='recovery-action-repair-trigger']")).toBeNull();
  });

  it("confirm popover restates the dirty count, live branch, rescue branch and recorded branch, then fires the handler", () => {
    const onQuarantineRestore = vi.fn();
    const node = render(
      <IssueRecoveryActionCard
        action={buildDirtyDivergenceAction()}
        onQuarantineRestore={onQuarantineRestore}
      />,
    );
    click(node.querySelector("[data-testid='recovery-action-repair-trigger']"));
    const restated = document.body.querySelector("[data-testid='recovery-repair-restated']");
    const text = restated?.textContent ?? "";
    expect(
      document.body.querySelector("[data-testid='recovery-repair-dirty-count']")?.textContent,
    ).toBe("3 uncommitted changes");
    // live branch is named in the restated summary, left untouched
    expect(text).toContain("nleach/PAP-1405-live");
    expect(text).toContain("(left untouched)");
    // rescue branch preview mirrors the server naming (prefix + timestamp marker)
    expect(
      document.body.querySelector("[data-testid='recovery-repair-rescue-branch']")?.textContent,
    ).toContain("paperclip/rescue/PAP-1405/");
    // recorded branch to be restored
    expect(text).toContain("PAP-522-recorded");

    // No reason field is present — the operation is lossless.
    expect(document.body.querySelector("textarea")).toBeNull();

    click(document.body.querySelector("[data-testid='recovery-action-repair-confirm']"));
    expect(onQuarantineRestore).toHaveBeenCalledTimes(1);
  });

  it("singularizes a one-file dirty count", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildDirtyDivergenceAction({ workspaceValidation: { statusEntryCount: 1 } })}
        onQuarantineRestore={() => {}}
      />,
    );
    click(node.querySelector("[data-testid='recovery-action-repair-trigger']"));
    expect(
      document.body.querySelector("[data-testid='recovery-repair-dirty-count']")?.textContent,
    ).toBe("1 uncommitted change");
  });

  it("disables the repair trigger while a quarantine-restore is pending", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildDirtyDivergenceAction()}
        onQuarantineRestore={() => {}}
        quarantineRestorePending
      />,
    );
    expect(
      node.querySelector<HTMLButtonElement>("[data-testid='recovery-action-repair-trigger']")?.disabled,
    ).toBe(true);
  });

  it("in the contended case disables repair, explains the claimant, and recommends re-issue", () => {
    const onQuarantineRestore = vi.fn();
    const node = render(
      <IssueRecoveryActionCard
        action={buildDirtyDivergenceAction({
          workspaceValidation: {
            contention: {
              claimedByWorkspaceId: "ws-99",
              claimedByIssueId: "issue-99",
              claimedByIssueIdentifier: "PAP-9001",
              activeRun: { id: "run-9001", status: "running", issueId: "issue-99", issueIdentifier: "PAP-9001" },
            },
          },
        })}
        onQuarantineRestore={onQuarantineRestore}
        onReissueIsolated={() => {}}
      />,
    );
    // Diagnosis gains a claimant line naming the claiming issue.
    const notice = node.querySelector("[data-testid='recovery-contention-notice']");
    expect(notice?.textContent).toContain("Worktree claimed by");
    expect(notice?.textContent).toContain("PAP-9001");
    expect(notice?.textContent).toContain("(active run)");

    // The repair control is present but disabled, with the claimant as the explanation.
    const disabled = node.querySelector("[data-testid='recovery-action-repair-disabled']");
    expect(disabled).not.toBeNull();
    const trigger = disabled?.querySelector<HTMLButtonElement>(
      "[data-testid='recovery-action-repair-trigger']",
    );
    expect(trigger?.disabled).toBe(true);
    expect(disabled?.textContent).toContain(
      "Held by PAP-9001 — re-issue on an isolated workspace instead.",
    );
    // Clicking the disabled control never fires the repair.
    click(trigger ?? null);
    expect(onQuarantineRestore).not.toHaveBeenCalled();

    // Re-issue is surfaced as the recommended action.
    expect(node.querySelector("[data-testid='recovery-reissue-recommended']")).not.toBeNull();
    expect(
      node
        .querySelector("[data-testid='recovery-action-reissue-trigger']")
        ?.getAttribute("data-recommended"),
    ).toBe("true");
  });

  it("compact variant drops the metadata table but keeps the diagnosis and repair action", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildDirtyDivergenceAction()}
        onQuarantineRestore={() => {}}
        variant="compact"
      />,
    );
    // Metadata rows (e.g. the Owner/Next action table) are dropped in compact mode.
    expect(node.textContent).not.toContain("Choose and record a valid issue disposition.");
    // The divergence diagnosis and repair action still render.
    expect(node.querySelector("[data-testid='recovery-divergence-diagnosis']")).not.toBeNull();
    expect(node.querySelector("[data-testid='recovery-action-repair-trigger']")).not.toBeNull();
  });
});

describe("IssueRecoveryActionCard owner-sticky retry lineage", () => {
  const NOW = new Date("2026-08-18T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function at(offsetMs: number) {
    return new Date(NOW.getTime() + offsetMs).toISOString();
  }

  const bothAgents = new Map([
    [ownerAgent.id, ownerAgent],
    [returnAgent.id, returnAgent],
  ]);

  /** Phase 1 — the original owner (CodexCoder) is retrying itself. */
  function buildSourceLaneAction(overrides: Partial<IssueRecoveryAction> = {}) {
    return buildAction({
      kind: "deliberate_wait_without_target",
      cause: "deliberate_wait_without_target",
      ownerAgentId: returnAgent.id,
      previousOwnerAgentId: returnAgent.id,
      returnOwnerAgentId: returnAgent.id,
      nextAction:
        "The original owner must replace the parked summary with a terminal, live, blocked, monitored, or typed waiting disposition.",
      wakePolicy: {
        type: "bounded_owner_disposition_repair",
        retryAgentId: returnAgent.id,
        attempt: 2,
        maxAttempts: 5,
        baseBackoffMs: 60_000,
        jitterMs: 3_000,
        retryAt: at(3 * 60_000),
        scheduledRunId: "00000000-0000-0000-0000-0000000000b1",
      },
      attemptCount: 2,
      maxAttempts: 5,
      timeoutAt: at(3 * 60_000),
      ...overrides,
    });
  }

  /** Phase 2 — a manager (ClaudeCoder) repairs the path; CodexCoder keeps the task. */
  function buildRecoveryLaneAction(overrides: Partial<IssueRecoveryAction> = {}) {
    return buildSourceLaneAction({
      ownerAgentId: ownerAgent.id,
      nextAction:
        "Repair the source issue disposition or request an explicit reassignment decision without taking source ownership.",
      evidence: {
        summary: "Run finished but no disposition was chosen.",
        sourceAttemptCount: 5,
        sourceMaxAttempts: 5,
      },
      wakePolicy: {
        type: "bounded_recovery_owner",
        ownerAgentId: ownerAgent.id,
        attempt: 1,
        maxAttempts: 3,
        retryAt: at(60_000),
        scheduledRunId: "00000000-0000-0000-0000-0000000000b2",
        preservesSourceAssignee: true,
      },
      attemptCount: 1,
      maxAttempts: 3,
      timeoutAt: at(60_000),
      ...overrides,
    });
  }

  it("stays quiet and names the retry lane while the original owner is being retried", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildSourceLaneAction()} agentMap={bothAgents} />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-state")).toBe("in_progress");
    expect(section?.getAttribute("data-recovery-kind")).toBe("deliberate_wait_without_target");
    expect(section?.getAttribute("data-recovery-lane")).toBe("source_owner");
    expect(node.textContent).toContain("RECOVERY IN PROGRESS");
    expect(node.textContent).not.toContain("RECOVERY NEEDED");
    expect(node.textContent).toContain("Wait Without A Target");
    expect(node.textContent).toContain("The task stays with its owner, and no action is needed yet.");
    expect(node.textContent).toContain("Paperclip is retrying the original owner");
  });

  it("shows the five-attempt budget and the next due time", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildSourceLaneAction()} agentMap={bothAgents} />,
    );
    const progress = node.querySelector("[data-testid='recovery-retry-progress']");
    expect(progress).not.toBeNull();
    expect(progress?.getAttribute("data-recovery-lane")).toBe("source_owner");
    expect(progress?.getAttribute("data-recovery-attempt")).toBe("2");
    expect(progress?.getAttribute("data-recovery-max-attempts")).toBe("5");
    expect(progress?.textContent).toContain("Attempt 2 of 5");
    expect(node.querySelector("[data-testid='recovery-next-retry']")?.textContent).toBe(
      "Next try in 3m",
    );
  });

  it("keeps the source owner and the recovery owner as separate roles", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildRecoveryLaneAction()} agentMap={bothAgents} />,
    );
    const sourceOwner = node.querySelector("[data-testid='recovery-source-owner']");
    const recoveryOwner = node.querySelector("[data-testid='recovery-recovery-owner']");
    // CodexCoder is the original owner and keeps the deliverable.
    expect(sourceOwner?.textContent).toContain("CodexCoder");
    expect(sourceOwner?.textContent).toContain("keeps this task");
    // ClaudeCoder only repairs the path.
    expect(recoveryOwner?.textContent).toContain("ClaudeCoder");
    expect(recoveryOwner?.textContent).toContain("repairs the next step only");
    expect(recoveryOwner?.textContent).not.toContain("CodexCoder");
    expect(node.textContent).toContain(
      "the task itself still belongs to its original owner",
    );
  });

  it("labels the source lane as the owner retrying itself", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildSourceLaneAction()} agentMap={bothAgents} />,
    );
    expect(
      node.querySelector("[data-testid='recovery-recovery-owner']")?.textContent,
    ).toContain("Original owner — retrying itself");
  });

  it("reports the spent source attempts once the manager lane opens", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildRecoveryLaneAction()} agentMap={bothAgents} />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-lane")).toBe("recovery_owner");
    expect(section?.getAttribute("data-recovery-state")).toBe("in_progress");
    expect(
      node.querySelector("[data-testid='recovery-source-attempts']")?.textContent,
    ).toContain("The original owner used 5 of 5 automatic attempts.");
    expect(
      node.querySelector("[data-testid='recovery-retry-progress']")?.textContent,
    ).toContain("Attempt 1 of 3");
  });

  it("warns strongly only once the automatic path is exhausted", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildSourceLaneAction({
          wakePolicy: {
            type: "bounded_owner_disposition_repair",
            retryAgentId: returnAgent.id,
            attempt: 5,
            maxAttempts: 5,
            retryAt: at(-60_000),
          },
          attemptCount: 5,
        })}
        agentMap={bothAgents}
      />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-state")).toBe("needed");
    expect(node.textContent).toContain("RECOVERY NEEDED");
    expect(node.textContent).toContain("has used every automatic repair attempt");
    expect(node.querySelector("[data-testid='recovery-next-retry']")?.textContent).toBe(
      "Automatic retries used up",
    );
    // The follow-up line must not keep promising a retry that will never run, and the
    // generic timeout chip must not reintroduce a stale due time next to it.
    expect(node.textContent).toContain("Automatic retries are finished — a decision is needed");
    expect(node.textContent).not.toContain("Paperclip is retrying the original owner");
    expect(node.textContent).not.toContain("Times out");
  });

  it("warns strongly when the stored retry came due and never ran", () => {
    // PAP-17561: this exact shape rendered "Recovery in progress · Attempt 1 of 5 · Next try
    // 5m ago" — a calm card over a lane nothing was working on.
    const node = render(
      <IssueRecoveryActionCard
        action={buildSourceLaneAction({
          wakePolicy: {
            type: "bounded_owner_disposition_repair",
            retryAgentId: returnAgent.id,
            attempt: 1,
            maxAttempts: 5,
            retryAt: at(-5 * 60_000),
            scheduledRunId: "00000000-0000-0000-0000-0000000000b2",
          },
          attemptCount: 1,
          timeoutAt: at(-5 * 60_000),
        })}
        agentMap={bothAgents}
      />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-state")).toBe("needed");
    expect(node.textContent).toContain("RECOVERY NEEDED");
    expect(node.textContent).not.toContain("RECOVERY IN PROGRESS");
    const retry = node.querySelector("[data-testid='recovery-next-retry']");
    expect(retry?.textContent).toBe("Retry missed 5m ago");
    expect(retry?.getAttribute("data-recovery-retry-expired")).toBe("true");
    // Nothing may still read as an upcoming attempt or as needing no action.
    expect(node.textContent).not.toContain("Next try");
    expect(node.textContent).not.toContain("no action is needed yet");
    expect(node.textContent).toContain("came due and did not run");
    expect(node.textContent).toContain("The scheduled retry did not run");
    // The repair lane still must not move the deliverable off its original owner.
    expect(node.querySelector("[data-testid='recovery-source-owner']")?.textContent).toContain(
      "keeps this task",
    );
  });

  it("stays quiet when the overdue attempt is a verified live run", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildSourceLaneAction({
          wakePolicy: {
            type: "bounded_owner_disposition_repair",
            retryAgentId: returnAgent.id,
            attempt: 2,
            maxAttempts: 5,
            retryAt: at(-5 * 60_000),
            scheduledRunId: "00000000-0000-0000-0000-0000000000b2",
          },
          timeoutAt: at(-5 * 60_000),
        })}
        agentMap={bothAgents}
        scheduledRetry={{
          runId: "00000000-0000-0000-0000-0000000000b2",
          status: "running",
          agentId: returnAgent.id,
          agentName: returnAgent.name,
          retryOfRunId: null,
          scheduledRetryAt: at(-5 * 60_000),
          scheduledRetryAttempt: 2,
          scheduledRetryReason: null,
        }}
      />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-state")).toBe("in_progress");
    expect(node.querySelector("[data-testid='recovery-next-retry']")?.textContent).toBe(
      "Attempt running now",
    );
    expect(node.textContent).not.toContain("Retry missed");
  });

  it("keeps timing in the retry-progress row only while a lane is live", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildSourceLaneAction()} agentMap={bothAgents} />,
    );
    expect(node.textContent).toContain("Paperclip is retrying the original owner");
    expect(node.textContent).not.toContain("Times out");
  });

  it("shows the board escalation without implying the board owns the task", () => {
    const node = render(
      <IssueRecoveryActionCard
        action={buildSourceLaneAction({
          status: "escalated",
          ownerType: "board",
          ownerAgentId: null,
          evidence: { sourceAttemptCount: 5, sourceMaxAttempts: 5 },
          wakePolicy: {
            type: "board_escalation",
            reason: "recovery_owner_retry_exhausted",
            attempt: 3,
            maxAttempts: 3,
            preservesSourceAssignee: true,
          },
          attemptCount: 3,
          maxAttempts: 3,
          timeoutAt: null,
        })}
        agentMap={bothAgents}
      />,
    );
    const section = node.querySelector("section[aria-label]");
    expect(section?.getAttribute("data-recovery-state")).toBe("escalated");
    expect(section?.getAttribute("data-recovery-lane")).toBe("board");
    expect(node.textContent).toContain("Automatic recovery is exhausted");
    const recoveryOwner = node.querySelector("[data-testid='recovery-recovery-owner']");
    expect(recoveryOwner?.textContent).toContain("Board");
    expect(recoveryOwner?.textContent).toContain("decides the next step only");
    expect(
      node.querySelector("[data-testid='recovery-source-owner']")?.textContent,
    ).toContain("CodexCoder");
  });

  it("leaves kinds without a bounded lineage on the original single owner row", () => {
    const node = render(
      <IssueRecoveryActionCard action={buildAction()} agentMap={bothAgents} />,
    );
    expect(node.querySelector("section[aria-label]")?.getAttribute("data-recovery-lane")).toBeNull();
    expect(node.querySelector("[data-testid='recovery-retry-progress']")).toBeNull();
    expect(node.querySelector("[data-testid='recovery-source-owner']")).toBeNull();
    expect(node.textContent).toContain("→ Returns to:");
  });
});
