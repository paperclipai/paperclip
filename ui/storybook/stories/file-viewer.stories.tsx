import { useLayoutEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type {
  ResolvedWorkspaceResource,
  WorkspaceFileContent,
  WorkspaceFileSelector,
} from "@paperclipai/shared";
import { FileViewerProvider } from "@/context/FileViewerContext";
import { FileViewerSheet } from "@/components/FileViewerSheet";
import { queryKeys } from "@/lib/queryKeys";

const ISSUE_ID = "issue-storybook-file-viewer";

const SAMPLE_CODE = `import { useMemo } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface FileViewerSheetProps {
  issueId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Renders a right-side sheet that previews a workspace file.
 * The viewer is URL-addressable via ?file=&line=&column=&workspace=.
 */
export function FileViewerSheet({
  issueId,
  open,
  onOpenChange,
}: FileViewerSheetProps) {
  const isOpen = typeof open === "boolean" ? open : true;

  const classes = useMemo(
    () =>
      cn(
        "flex h-full w-full flex-col gap-0 p-0",
        "sm:max-w-[min(900px,90vw)]",
      ),
    [],
  );

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={classes}>
        {/* header, metadata chips, content region */}
        <p>Workspace file contents would render here.</p>
      </SheetContent>
    </Sheet>
  );
}
`;

function buildResource(
  overrides: Partial<ResolvedWorkspaceResource> = {},
): ResolvedWorkspaceResource {
  return {
    kind: "file",
    provider: "git_worktree",
    title: "FileViewerSheet.tsx",
    displayPath: "ui/src/components/FileViewerSheet.tsx",
    workspaceLabel: "PAP-1953 isolated worktree",
    workspaceKind: "execution_workspace",
    workspaceId: "ws-exec-pap-1953",
    contentType: "text/tsx",
    byteSize: SAMPLE_CODE.length,
    previewKind: "text",
    denialReason: null,
    capabilities: { preview: true, download: false, listChildren: false },
    ...overrides,
  };
}

function buildContent(
  resource: ResolvedWorkspaceResource,
  data = SAMPLE_CODE,
): WorkspaceFileContent {
  return {
    resource,
    content: { encoding: "utf8", data },
  };
}

function StoryFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl space-y-4 p-6 text-sm">
        <div className="space-y-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Host issue page (preview)
          </div>
          <h1 className="text-xl font-semibold">
            PAP-1963 — Phase 4: UX visual review file viewer implementation
          </h1>
          <p className="text-muted-foreground">
            This frame represents the underlying issue detail page so the sheet
            overlay can be evaluated in context.
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/40 p-4 text-xs text-muted-foreground">
          The workspace file viewer opens as a right-side sheet, pushing a URL
          entry. Use browser back to close.
        </div>
      </div>
      {children}
    </div>
  );
}

interface HydratorProps {
  seed?: (client: ReturnType<typeof useQueryClient>) => void;
  stubFetch?: () => (() => void);
  children: ReactNode;
}

function FileViewerHydrator({ seed, stubFetch, children }: HydratorProps) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    seed?.(queryClient);
    return true;
  });

  useLayoutEffect(() => {
    if (!stubFetch) return;
    const teardown = stubFetch();
    return () => teardown();
  }, [stubFetch]);

  return ready ? <>{children}</> : null;
}

type ViewerRenderProps = {
  path: string;
  line?: number | null;
  column?: number | null;
  workspace?: WorkspaceFileSelector;
  showPromptWhenEmpty?: boolean;
};

function FileViewerShell({
  path,
  line = null,
  column = null,
  workspace = "auto",
  showPromptWhenEmpty = false,
  seed,
  stubFetch,
}: ViewerRenderProps & Omit<HydratorProps, "children">) {
  return (
    <FileViewerProvider issueId={ISSUE_ID}>
      <FileViewerHydrator seed={seed} stubFetch={stubFetch}>
        <StoryFrame>
          <FileViewerSheet
            issueId={ISSUE_ID}
            state={
              showPromptWhenEmpty
                ? null
                : { path, line, column, workspace, projectId: null, workspaceId: null }
            }
            showPromptWhenEmpty={showPromptWhenEmpty}
            open
          />
        </StoryFrame>
      </FileViewerHydrator>
    </FileViewerProvider>
  );
}

function seedContent(
  queryClient: ReturnType<typeof useQueryClient>,
  path: string,
  workspace: WorkspaceFileSelector,
  resource: ResolvedWorkspaceResource,
  content: WorkspaceFileContent | null,
) {
  queryClient.setQueryData(
    queryKeys.issues.fileResource(ISSUE_ID, { path, workspace }),
    resource,
  );
  if (content) {
    queryClient.setQueryData(
      queryKeys.issues.fileResourceContent(ISSUE_ID, { path, workspace }),
      content,
    );
  }
}

function buildFetchStub(
  resolver: (url: URL) => Response | Promise<Response> | null,
) {
  return () => {
    if (typeof window === "undefined") return () => undefined;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(rawUrl, window.location.origin);
      const maybe = resolver(url);
      if (maybe) return maybe;
      return originalFetch(input, init);
    };
    return () => {
      window.fetch = originalFetch;
    };
  };
}

const meta: Meta = {
  title: "Components/File Viewer Sheet",
  component: FileViewerSheet,
  parameters: {
    layout: "fullscreen",
    a11y: { test: "todo" },
  },
};

export default meta;

type Story = StoryObj;

export const TextContentWithHighlightedLine: Story = {
  name: "Text content — highlighted line",
  render: () => {
    const resource = buildResource();
    const content = buildContent(resource);
    return (
      <FileViewerShell
        path="ui/src/components/FileViewerSheet.tsx"
        line={17}
        column={3}
        workspace="execution"
        seed={(client) =>
          seedContent(
            client,
            "ui/src/components/FileViewerSheet.tsx",
            "execution",
            resource,
            content,
          )
        }
      />
    );
  },
};

export const TextContentLongPathTruncation: Story = {
  name: "Text content — very long path",
  render: () => {
    const longPath =
      "packages/backend/src/features/workspaces/resolvers/resolve-workspace-file-resource-from-issue-context.ts";
    const resource = buildResource({
      title: "resolve-workspace-file-resource-from-issue-context.ts",
      displayPath: longPath,
    });
    const content = buildContent(resource, SAMPLE_CODE);
    return (
      <FileViewerShell
        path={longPath}
        line={42}
        workspace="auto"
        seed={(client) =>
          seedContent(client, longPath, "auto", resource, content)
        }
      />
    );
  },
};

export const OpenFilePrompt: Story = {
  name: "Open file prompt (no selection)",
  render: () => (
    <FileViewerShell
      path=""
      workspace="auto"
      showPromptWhenEmpty
    />
  ),
};

export const LoadingSpinner: Story = {
  name: "Loading — 400ms+ spinner",
  render: () => {
    return (
      <FileViewerShell
        path="ui/src/components/FileViewerSheet.tsx"
        workspace="auto"
        stubFetch={buildFetchStub((url) => {
          if (url.pathname.includes("/file-resources/")) {
            return new Promise<Response>(() => {
              /* never resolves — freezes query in pending */
            });
          }
          return null;
        })}
      />
    );
  },
};

export const ErrorNotFoundWithFallback: Story = {
  name: "Error — file not found (project fallback)",
  render: () => (
    <FileViewerShell
      path="missing/area/not-found.tsx"
      workspace="execution"
      stubFetch={buildFetchStub((url) => {
        if (url.pathname.includes("/file-resources/resolve")) {
          return Response.json(
            { error: "No file exists at that path.", code: "not_found" },
            { status: 404 },
          );
        }
        return null;
      })}
    />
  ),
};

export const ErrorNoWorkspace: Story = {
  name: "Error — no workspace",
  render: () => (
    <FileViewerShell
      path="ui/src/components/FileViewerSheet.tsx"
      workspace="auto"
      stubFetch={buildFetchStub((url) => {
        if (url.pathname.includes("/file-resources/resolve")) {
          return Response.json(
            {
              error: "This issue has no project or execution workspace.",
              code: "no_workspace",
            },
            { status: 422 },
          );
        }
        return null;
      })}
    />
  ),
};

export const ErrorOutsideWorkspace: Story = {
  name: "Error — path outside workspace",
  render: () => (
    <FileViewerShell
      path="../../../etc/passwd"
      workspace="auto"
      stubFetch={buildFetchStub((url) => {
        if (url.pathname.includes("/file-resources/resolve")) {
          return Response.json(
            {
              error: "Path escapes workspace root.",
              code: "outside_workspace_root",
            },
            { status: 400 },
          );
        }
        return null;
      })}
    />
  ),
};

export const ErrorDeniedSensitive: Story = {
  name: "Error — denied by policy",
  render: () => (
    <FileViewerShell
      path=".env.production"
      workspace="auto"
      stubFetch={buildFetchStub((url) => {
        if (url.pathname.includes("/file-resources/resolve")) {
          return Response.json(
            {
              error: "Blocked by workspace file policy.",
              code: "denied_by_policy_sensitive",
            },
            { status: 403 },
          );
        }
        return null;
      })}
    />
  ),
};

export const RemoteWorkspace: Story = {
  name: "Remote workspace (preview unsupported)",
  render: () => {
    const resource = buildResource({
      kind: "remote_resource",
      provider: "remote_managed",
      workspaceLabel: "Cloud worker (remote)",
      workspaceKind: "execution_workspace",
      previewKind: "unsupported",
      capabilities: { preview: false, download: false, listChildren: false },
    });
    return (
      <FileViewerShell
        path="ui/src/components/FileViewerSheet.tsx"
        workspace="auto"
        seed={(client) =>
          seedContent(
            client,
            "ui/src/components/FileViewerSheet.tsx",
            "auto",
            resource,
            null,
          )
        }
      />
    );
  },
};

export const WorkspaceArchived: Story = {
  name: "Workspace archived / cleaned up",
  render: () => (
    <FileViewerShell
      path="ui/src/components/FileViewerSheet.tsx"
      workspace="execution"
      stubFetch={buildFetchStub((url) => {
        if (url.pathname.includes("/file-resources/resolve")) {
          return Response.json(
            {
              error: "This worktree has been cleaned up.",
              code: "workspace_archived",
            },
            { status: 410 },
          );
        }
        return null;
      })}
    />
  ),
};

export const BinaryUnsupported: Story = {
  name: "Binary / unsupported file type",
  render: () => {
    const resource = buildResource({
      title: "logo.woff2",
      displayPath: "ui/public/fonts/logo.woff2",
      contentType: "font/woff2",
      previewKind: "unsupported",
      capabilities: { preview: false, download: false, listChildren: false },
      denialReason: "binary_unsupported",
    });
    return (
      <FileViewerShell
        path="ui/public/fonts/logo.woff2"
        workspace="auto"
        seed={(client) =>
          seedContent(
            client,
            "ui/public/fonts/logo.woff2",
            "auto",
            resource,
            null,
          )
        }
      />
    );
  },
};

export const TooLargeToPreview: Story = {
  name: "Too large to preview",
  render: () => {
    const resource = buildResource({
      title: "dataset.csv",
      displayPath: "data/exports/dataset.csv",
      contentType: "text/csv",
      byteSize: 48_000_000,
      previewKind: "unsupported",
      capabilities: { preview: false, download: false, listChildren: false },
      denialReason: "too_large",
    });
    return (
      <FileViewerShell
        path="data/exports/dataset.csv"
        workspace="auto"
        seed={(client) =>
          seedContent(client, "data/exports/dataset.csv", "auto", resource, null)
        }
      />
    );
  },
};

export const MobileView: Story = {
  name: "Mobile — 390×844 highlighted line",
  parameters: {
    viewport: {
      defaultViewport: "mobile",
    },
  },
  render: () => {
    const resource = buildResource();
    const content = buildContent(resource);
    return (
      <FileViewerShell
        path="ui/src/components/FileViewerSheet.tsx"
        line={17}
        column={3}
        workspace="execution"
        seed={(client) =>
          seedContent(
            client,
            "ui/src/components/FileViewerSheet.tsx",
            "execution",
            resource,
            content,
          )
        }
      />
    );
  },
};
