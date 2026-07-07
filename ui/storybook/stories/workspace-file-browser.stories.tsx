import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ResolvedWorkspaceResource,
  WorkspaceFileContent,
  WorkspaceFileListFileItem,
  WorkspaceFileListResponse,
} from "@paperclipai/shared";
import { FileViewerProvider, useRequiredFileViewer } from "@/context/FileViewerContext";
import { FileViewerSheet } from "@/components/FileViewerSheet";
import { IssueWorkspaceCard } from "@/components/IssueWorkspaceCard";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Screenshot-review surface for PAP-10511, rendering the REAL FileViewerSheet /
 * IssueWorkspaceCard (not a static frame) so the captures are visual truth.
 * Stories seed the react-query cache so the components render without a backend.
 * Capture each at desktop + 360px and in both themes via the Storybook theme global.
 */

const ISSUE_ID = "issue-browse-demo";

function listKey(issueId: string) {
  return queryKeys.issues.fileResources(issueId, { workspace: "auto", mode: "changed", q: null, limit: 100, offset: 0 });
}

function item(relativePath: string, minutesAgo: number, overrides: Partial<WorkspaceFileListFileItem> = {}): WorkspaceFileListFileItem {
  return {
    kind: "file",
    provider: "git_worktree",
    title: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    displayPath: relativePath,
    workspaceLabel: "issue execution workspace · PAP-1953",
    workspaceKind: "execution_workspace",
    workspaceId: "ws-1",
    contentType: "text/plain; charset=utf-8",
    byteSize: 2048,
    modifiedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    previewKind: "text",
    capabilities: { preview: true, download: true, listChildren: false },
    ...overrides,
  };
}

const recentList: WorkspaceFileListResponse = {
  kind: "workspace_file_list",
  state: "available",
  workspace: {
    provider: "git_worktree",
    workspaceLabel: "issue execution workspace · PAP-1953",
    workspaceKind: "execution_workspace",
    workspaceId: "ws-1",
  },
  query: { workspace: "auto", mode: "changed", q: null, limit: 100, offset: 0 },
  items: [
    item("ui/src/components/WorkspaceFileBrowser.tsx", 2),
    item("ui/src/components/FileViewerSheet.tsx", 2),
    item("server/src/routes/file-resources.ts", 14),
    item("doc/PRODUCT.md", 60),
    item("packages/shared/src/types/workspace-file-resource.ts", 64),
    item("server/src/services/very/deeply/nested/structure/workspace-file-resources.ts", 180),
  ],
  scannedCount: 412,
  truncated: true,
};

function unavailable(reason: string): WorkspaceFileListResponse {
  return {
    kind: "workspace_file_list",
    state: "unavailable",
    unavailableReason: reason,
    workspace: null,
    query: { workspace: "auto", mode: "changed", q: null, limit: 100, offset: 0 },
    items: [],
    scannedCount: 0,
    truncated: false,
  };
}

const viewedResource: ResolvedWorkspaceResource = {
  kind: "file",
  provider: "git_worktree",
  title: "FileViewerSheet.tsx",
  displayPath: "ui/src/components/FileViewerSheet.tsx",
  workspaceLabel: "issue execution workspace · PAP-1953",
  workspaceKind: "execution_workspace",
  workspaceId: "ws-1",
  contentType: "text/plain; charset=utf-8",
  byteSize: 2048,
  previewKind: "text",
  capabilities: { preview: true, download: false, listChildren: false },
};

const viewedContent: WorkspaceFileContent = {
  resource: viewedResource,
  content: {
    encoding: "utf8",
    data: [
      "export function FileViewerSheet({ issueId, state, open }: FileViewerSheetProps) {",
      "  const viewer = useRequiredFileViewer();",
      "  const browseMode = state === null && (showPromptWhenEmpty || viewer.browse);",
      "  const cameFromBrowse = state !== null && viewer.browse;",
      "  // … single sheet, two modes: browse ⇄ view",
      "  return <Sheet open={open}>…</Sheet>;",
      "}",
    ].join("\n"),
  },
};

function BrowseSheet({ data }: { data: WorkspaceFileListResponse }) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(listKey(ISSUE_ID), data);
  return (
    <FileViewerProvider issueId={ISSUE_ID}>
      <FileViewerSheet issueId={ISSUE_ID} showPromptWhenEmpty />
    </FileViewerProvider>
  );
}

function ViewFromBrowseInner() {
  const viewer = useRequiredFileViewer();
  useEffect(() => {
    viewer.open(
      { path: "ui/src/components/FileViewerSheet.tsx", line: 3, column: null, workspace: "auto" },
      { fromBrowse: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <FileViewerSheet issueId={ISSUE_ID} />;
}

function ViewFromBrowse() {
  const queryClient = useQueryClient();
  queryClient.setQueryData(listKey(ISSUE_ID), recentList);
  queryClient.setQueryData(
    queryKeys.issues.fileResource(ISSUE_ID, {
      path: "ui/src/components/FileViewerSheet.tsx",
      workspace: "auto",
    }),
    viewedResource,
  );
  queryClient.setQueryData(
      queryKeys.issues.fileResourceContent(ISSUE_ID, {
        path: "ui/src/components/FileViewerSheet.tsx",
        workspace: "auto",
      }),
    viewedContent,
  );
  return (
    <FileViewerProvider issueId={ISSUE_ID}>
      <ViewFromBrowseInner />
    </FileViewerProvider>
  );
}

function Placement() {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.instance.experimentalSettings, {
    enableEnvironments: false,
    enableIsolatedWorkspaces: true,
  });
  return (
    <FileViewerProvider issueId={ISSUE_ID}>
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <h3 className="text-sm font-medium text-muted-foreground">Workspace</h3>
        <IssueWorkspaceCard
          issue={{
            companyId: "company-1",
            projectId: "project-1",
            projectWorkspaceId: "pw-1",
            executionWorkspaceId: "ws-1",
            executionWorkspacePreference: "isolated_workspace",
            executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: null },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            currentExecutionWorkspace: {
              id: "ws-1",
              mode: "isolated_workspace",
              status: "active",
              branchName: "PAP-1953-plan-a-file-viewer",
              cwd: "/srv/paperclip/.../worktrees/PAP-1953",
              repoUrl: null,
              projectWorkspaceId: "pw-1",
              name: "PAP-1953",
              config: {},
            } as any,
          }}
          project={{ id: "project-1", executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" } }}
          onUpdate={() => {}}
          onBrowseFiles={() => {}}
          onOpenFileByPath={() => {}}
        />
      </div>
    </FileViewerProvider>
  );
}

const meta: Meta = {
  title: "Issue/Workspace File Browser",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const BrowseRecent: Story = { render: () => <BrowseSheet data={recentList} /> };
export const BrowseNoWorkspace: Story = { render: () => <BrowseSheet data={unavailable("no_workspace")} /> };
export const BrowseRemoteWorkspace: Story = { render: () => <BrowseSheet data={unavailable("remote_workspace")} /> };
export const BrowseCleanedUpWorkspace: Story = { render: () => <BrowseSheet data={unavailable("workspace_unavailable")} /> };
export const ViewModeFromBrowse: Story = { render: () => <ViewFromBrowse /> };
export const CardPlacement: Story = { render: () => <Placement /> };
