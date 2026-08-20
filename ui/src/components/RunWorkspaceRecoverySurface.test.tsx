// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun, Issue, IssueRecoveryAction } from "@paperclipai/shared";
import { RunWorkspaceRecoverySurface } from "./RunWorkspaceRecoverySurface";
import { ToastProvider } from "../context/ToastContext";

const navigateMock = vi.hoisted(() => vi.fn());
const issueGetMock = vi.hoisted(() => vi.fn());
const issueCreateMock = vi.hoisted(() => vi.fn());
const resolveRecoveryMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn());
const boardAccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: issueGetMock,
    create: issueCreateMock,
    resolveRecoveryAction: resolveRecoveryMock,
  },
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    reconcile: reconcileMock,
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: boardAccessMock,
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// flushSync-based sync `act` shim (matches the repo pattern in IssueRecoveryActionCard.test.tsx).
function act(callback: () => void): void {
  flushSync(callback);
}

// Resolve pending mocked-promise micro/macrotasks, then flush the React state updates react-query
// queued, repeating so chained query → render → dependent-render settles fully.
async function flush() {
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 4; j += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    act(() => {});
  }
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

function buildRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-aaaa1111",
    companyId: "company-1",
    agentId: "agent-1",
    status: "failed",
    errorCode: "workspace_validation_failed",
    contextSnapshot: { issueId: "issue-1" },
    resultJson: null,
    contextSnapshotJson: null,
    ...overrides,
  } as unknown as HeartbeatRun;
}

function buildRecoveryAction(): IssueRecoveryAction {
  return {
    id: "action-1",
    companyId: "company-1",
    sourceIssueId: "issue-1",
    recoveryIssueId: null,
    kind: "workspace_validation",
    status: "active",
    ownerType: "board",
    ownerAgentId: null,
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "workspace_validation_failed",
    fingerprint: "fp",
    evidence: {
      workspaceValidation: {
        reason: "git_worktree_branch_incoherence",
        expectedBranch: "PAP-1405-recorded",
        actualBranch: "live-branch",
        cleanliness: "dirty",
        statusEntryCount: 2,
        dirtyPathSample: ["a.ts"],
        sourceIdentifier: "PAP-1405",
        persistedExecutionWorkspaceId: "ws-1",
        provenance: {
          expectedHeadSha: "aaaa1111bbbb",
          actualHeadSha: "cccc2222dddd",
          ancestryVerdict: "diverged",
          plainLanguageReason: "Recorded branch is not an ancestor of the live branch.",
        },
      },
    },
    nextAction: "Repair the workspace.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: null,
    lastAttemptAt: null,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function buildIssue(action: IssueRecoveryAction | null): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1405",
    companyId: "company-1",
    title: "Do the thing",
    description: "body",
    priority: "medium",
    projectId: null,
    parentId: null,
    assigneeAgentId: null,
    executionWorkspaceId: "ws-1",
    activeRecoveryAction: action,
  } as unknown as Issue;
}

async function renderSurface(run: HeartbeatRun) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <RunWorkspaceRecoverySurface run={run} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  // Let the issue + board-access queries settle and commit.
  await flush();
  return container!;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("RunWorkspaceRecoverySurface", () => {
  it("renders nothing for a run that is not a workspace-validation failure", async () => {
    issueGetMock.mockResolvedValue(buildIssue(buildRecoveryAction()));
    boardAccessMock.mockResolvedValue(undefined);
    const node = await renderSurface(buildRun({ errorCode: "process_lost" }));
    expect(node.querySelector("[data-testid='run-workspace-recovery-surface']")).toBeNull();
    expect(issueGetMock).not.toHaveBeenCalled();
  });

  it("renders nothing when the source issue has no workspace_validation recovery action", async () => {
    issueGetMock.mockResolvedValue(buildIssue(null));
    boardAccessMock.mockResolvedValue(undefined);
    const node = await renderSurface(buildRun());
    expect(node.querySelector("[data-testid='run-workspace-recovery-surface']")).toBeNull();
  });

  it("renders the compact recovery card and repair action for a dirty divergence", async () => {
    issueGetMock.mockResolvedValue(buildIssue(buildRecoveryAction()));
    boardAccessMock.mockResolvedValue({ source: "local_implicit", companyIds: ["company-1"] });
    const node = await renderSurface(buildRun());
    expect(node.querySelector("[data-testid='run-workspace-recovery-surface']")).not.toBeNull();
    expect(node.querySelector("[data-testid='recovery-divergence-diagnosis']")).not.toBeNull();
    expect(node.querySelector("[data-testid='recovery-action-repair-trigger']")).not.toBeNull();
    // Compact: metadata rows dropped.
    expect(node.textContent).not.toContain("Repair the workspace.");
  });

  it("wires the repair confirm to reconcile in quarantine_restore mode against the pinned workspace", async () => {
    issueGetMock.mockResolvedValue(buildIssue(buildRecoveryAction()));
    boardAccessMock.mockResolvedValue({ source: "local_implicit", companyIds: ["company-1"] });
    reconcileMock.mockResolvedValue({ id: "ws-1" });
    const node = await renderSurface(buildRun());
    click(node.querySelector("[data-testid='recovery-action-repair-trigger']"));
    click(document.body.querySelector("[data-testid='recovery-action-repair-confirm']"));
    await flush();
    expect(reconcileMock).toHaveBeenCalledWith("ws-1", { mode: "quarantine_restore" });
  });

  // --- PAP-13568 Phase 4b: clean-divergence "Restore recorded branch" + run-evidence fallback ---

  function cleanDivergenceEvidence(overrides: Record<string, unknown> = {}) {
    return {
      reason: "git_worktree_branch_incoherence",
      expectedBranch: "PAP-12915-recorded",
      actualBranch: "fix/stable-dry-run-notes-gate",
      cleanliness: "clean",
      statusEntryCount: 0,
      dirtyPathSample: [],
      sourceIdentifier: "PAP-13359",
      persistedExecutionWorkspaceId: "ws-1",
      provenance: {
        expectedHeadSha: "aaaa1111bbbb",
        actualHeadSha: "cccc2222dddd",
        ancestryVerdict: "diverged",
        aheadCount: 6,
        behindCount: 59,
        plainLanguageReason:
          "This agent couldn't start because its workspace was left on a different branch.",
        parkedByIdentifier: "PAP-13359",
        parkedByRunId: "2ef32c67ffff",
      },
      ...overrides,
    };
  }

  it("offers the restore CTA (not the dirty repair) for a clean divergence recovery action", async () => {
    const action = buildRecoveryAction();
    action.evidence = { workspaceValidation: cleanDivergenceEvidence() };
    issueGetMock.mockResolvedValue(buildIssue(action));
    boardAccessMock.mockResolvedValue({ source: "local_implicit", companyIds: ["company-1"] });
    const node = await renderSurface(buildRun());
    expect(node.querySelector("[data-testid='recovery-action-restore-trigger']")).not.toBeNull();
    // A clean divergence quarantines nothing, so the dirty repair action is absent.
    expect(node.querySelector("[data-testid='recovery-action-repair-trigger']")).toBeNull();
    // Ahead/behind + parked-by provenance render.
    expect(node.querySelector("[data-testid='recovery-ahead-count']")?.textContent).toContain("6");
    expect(node.querySelector("[data-testid='recovery-behind-count']")?.textContent).toContain("59");
    expect(node.querySelector("[data-testid='recovery-parked-by']")?.textContent).toContain("PAP-13359");
  });

  it("wires the restore confirm to reconcile in restore mode against the pinned workspace", async () => {
    const action = buildRecoveryAction();
    action.evidence = { workspaceValidation: cleanDivergenceEvidence() };
    issueGetMock.mockResolvedValue(buildIssue(action));
    boardAccessMock.mockResolvedValue({ source: "local_implicit", companyIds: ["company-1"] });
    reconcileMock.mockResolvedValue({ id: "ws-1" });
    const node = await renderSurface(buildRun());
    click(node.querySelector("[data-testid='recovery-action-restore-trigger']"));
    click(document.body.querySelector("[data-testid='recovery-action-restore-confirm']"));
    await flush();
    expect(reconcileMock).toHaveBeenCalledWith("ws-1", { mode: "restore" });
  });

  it("renders a fallback diagnosis card from run evidence when there is no recovery action", async () => {
    // Source issue is blocked / pending-interaction, so no recovery action was promoted (L3), but the
    // run stamped branch-incoherence evidence on resultJson.
    issueGetMock.mockResolvedValue(buildIssue(null));
    boardAccessMock.mockResolvedValue({ source: "local_implicit", companyIds: ["company-1"] });
    const node = await renderSurface(
      buildRun({ resultJson: { workspaceValidation: cleanDivergenceEvidence() } }),
    );
    const surface = node.querySelector("[data-testid='run-workspace-recovery-surface']");
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute("data-fallback")).toBe("true");
    expect(node.querySelector("[data-testid='recovery-divergence-diagnosis']")).not.toBeNull();
    expect(node.querySelector("[data-testid='recovery-action-restore-trigger']")).not.toBeNull();
    // No persisted action to resolve → the resolve menu is intentionally absent on the fallback.
    expect(node.querySelector("[data-testid='recovery-action-resolve-trigger']")).toBeNull();
  });

  it("wires the fallback restore confirm to reconcile using the evidence workspace id", async () => {
    issueGetMock.mockResolvedValue(buildIssue(null));
    boardAccessMock.mockResolvedValue({ source: "local_implicit", companyIds: ["company-1"] });
    reconcileMock.mockResolvedValue({ id: "ws-1" });
    const node = await renderSurface(
      buildRun({ resultJson: { workspaceValidation: cleanDivergenceEvidence() } }),
    );
    click(node.querySelector("[data-testid='recovery-action-restore-trigger']"));
    click(document.body.querySelector("[data-testid='recovery-action-restore-confirm']"));
    await flush();
    expect(reconcileMock).toHaveBeenCalledWith("ws-1", { mode: "restore" });
  });

  it("renders nothing when a failed run has neither a recovery action nor branch-incoherence evidence", async () => {
    issueGetMock.mockResolvedValue(buildIssue(null));
    boardAccessMock.mockResolvedValue(undefined);
    const node = await renderSurface(
      buildRun({ resultJson: { workspaceValidation: { reason: "workspace_not_reusable" } } }),
    );
    expect(node.querySelector("[data-testid='run-workspace-recovery-surface']")).toBeNull();
  });
});
