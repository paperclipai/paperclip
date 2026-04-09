// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineRunVariablesDialog } from "./RoutineRunVariablesDialog";

let issueWorkspaceDraftCalls = 0;

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: true })),
  },
}));

vi.mock("./IssueWorkspaceCard", async () => {
  const React = await import("react");

  return {
    IssueWorkspaceCard: ({
      onDraftChange,
    }: {
      onDraftChange?: (data: Record<string, unknown>, meta: { canSave: boolean }) => void;
    }) => {
      React.useEffect(() => {
        issueWorkspaceDraftCalls += 1;
        if (issueWorkspaceDraftCalls > 20) {
          throw new Error("IssueWorkspaceCard onDraftChange looped");
        }
        onDraftChange?.({
          executionWorkspaceId: null,
          executionWorkspacePreference: "shared_workspace",
          executionWorkspaceSettings: { mode: "shared_workspace" },
        }, { canSave: true });
      }, [onDraftChange]);

      return <div data-testid="workspace-card">Workspace card</div>;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createProject(): Project {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "workspace-project",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Workspace project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#22c55e",
    env: null,
    pauseReason: null,
    pausedAt: null,
    archivedAt: null,
    executionWorkspacePolicy: {
      enabled: true,
      defaultMode: "shared_workspace",
      allowIssueOverride: true,
    },
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/paperclip/project-1",
      effectiveLocalFolder: "/tmp/paperclip/project-1",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    updatedAt: new Date("2026-04-02T00:00:00.000Z"),
  };
}

describe("RoutineRunVariablesDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    issueWorkspaceDraftCalls = 0;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("does not loop when the workspace card reports the same draft repeatedly", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RoutineRunVariablesDialog
            open
            onOpenChange={() => {}}
            companyId="company-1"
            project={createProject()}
            variables={[]}
            isPending={false}
            onSubmit={() => {}}
          />
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(issueWorkspaceDraftCalls).toBeLessThanOrEqual(2);
    expect(document.body.textContent).toContain("Run routine");

    await act(async () => {
      root.unmount();
    });
  });
});
