import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Download } from "lucide-react";
import { fileResourcesApi } from "@/api/file-resources";
import { FileViewerBody, FileViewerMetadataRow } from "@/components/FileViewerSheet";
import { Button } from "@/components/ui/button";
import type { FileViewerUrlState } from "@/context/FileViewerContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";
import type { TaskSidePanelTabPayload } from "@/lib/task-side-panel-state";

type WorkspaceFilePayload = Extract<TaskSidePanelTabPayload, { kind: "workspace-file" }>;

export function TaskWorkspaceFilePanel({
  issueId,
  payload,
  onFallbackToProject,
}: {
  issueId: string;
  payload: WorkspaceFilePayload;
  onFallbackToProject?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const state: FileViewerUrlState = {
    path: payload.path,
    workspace: payload.workspace,
    projectId: payload.projectId,
    workspaceId: payload.workspaceId,
    line: payload.line,
    column: payload.column,
  };
  const resourceQuery = useQuery({
    queryKey: queryKeys.issues.fileResource(issueId, state),
    queryFn: () => fileResourcesApi.resolve(issueId, state),
    retry: false,
  });
  const resource = resourceQuery.data;
  const contentQuery = useQuery({
    queryKey: queryKeys.issues.fileResourceContent(issueId, state),
    queryFn: () => fileResourcesApi.content(issueId, state),
    enabled: resource?.capabilities.preview === true,
    retry: false,
  });
  const downloadUrl = resource?.capabilities.download
    ? fileResourcesApi.downloadUrl(issueId, state)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <header className="flex min-w-0 items-start gap-2 border-b border-border bg-card px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium" title={payload.path}>{resource?.title ?? payload.path}</h2>
          <p className="truncate font-mono text-xs text-muted-foreground" title={payload.path}>{payload.path}</p>
          <FileViewerMetadataRow resolvedResource={resource} state={state} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {contentQuery.data ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Copy file contents"
              title={copied ? "Copied" : "Copy file contents"}
              onClick={() => {
                void copyTextToClipboard(contentQuery.data!.content.data).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                });
              }}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            </Button>
          ) : null}
          {downloadUrl ? (
            <Button asChild variant="ghost" size="icon-sm">
              <a href={downloadUrl} download={resource?.title} aria-label="Download file" title="Download file">
                <Download aria-hidden />
              </a>
            </Button>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="sr-only" aria-live="polite">{announcement}</div>
        <FileViewerBody
          resolveQuery={resourceQuery}
          contentQuery={contentQuery}
          elapsedMs={0}
          canPreview={resource?.capabilities.preview ?? false}
          highlightedLine={payload.line}
          onRetry={() => {
            void resourceQuery.refetch();
            if (resource?.capabilities.preview) void contentQuery.refetch();
          }}
          onSetAnnouncement={setAnnouncement}
          onFallbackToProject={onFallbackToProject ?? null}
        />
      </div>
    </div>
  );
}
