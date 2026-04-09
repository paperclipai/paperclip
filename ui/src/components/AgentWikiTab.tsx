import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type WikiPageInfo } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { PackageFileTree, buildFileTree, collectAllPaths } from "./PackageFileTree";
import { MarkdownBody } from "./MarkdownBody";
import { BookOpen } from "lucide-react";

export function AgentWikiTab({
  agentId,
  companyId,
}: {
  agentId: string;
  companyId: string;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const {
    data: pages,
    isLoading: pagesLoading,
    error: pagesError,
  } = useQuery({
    queryKey: queryKeys.agents.wikiPages(companyId, agentId),
    queryFn: () => agentsApi.wikiPages(companyId, agentId),
  });

  const {
    data: pageContent,
    isLoading: contentLoading,
  } = useQuery({
    queryKey: queryKeys.agents.wikiPage(companyId, agentId, selectedFile ?? ""),
    queryFn: () => agentsApi.wikiReadPage(companyId, agentId, selectedFile!),
    enabled: !!selectedFile,
  });

  if (pagesLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Loading wiki...
      </div>
    );
  }

  if (pagesError) {
    return (
      <p className="text-sm text-destructive py-4">
        Failed to load wiki pages.
      </p>
    );
  }

  if (!pages || pages.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
        <BookOpen className="h-8 w-8" />
        <p className="text-sm">No wiki pages yet. The wiki will be created on the agent's next run.</p>
      </div>
    );
  }

  const fileMap: Record<string, unknown> = {};
  const pageByPath = new Map<string, WikiPageInfo>();
  for (const page of pages) {
    fileMap[page.path] = true;
    pageByPath.set(page.path, page);
  }
  const tree = buildFileTree(fileMap);

  // Auto-expand all directories on first load
  if (expandedDirs.size === 0 && tree.length > 0) {
    const allDirs = collectAllPaths(tree, "dir");
    if (allDirs.size > 0) {
      // Use a microtask to avoid setting state during render
      queueMicrotask(() => setExpandedDirs(allDirs));
    }
  }

  const selectedPageInfo = selectedFile ? pageByPath.get(selectedFile) : null;

  return (
    <div className="flex gap-0 border border-border rounded-lg overflow-hidden" style={{ minHeight: "480px" }}>
      {/* File tree sidebar */}
      <div className="w-64 shrink-0 border-r border-border bg-muted/30 overflow-y-auto">
        <div className="px-3 py-2 border-b border-border">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Wiki Files
          </h3>
        </div>
        <PackageFileTree
          nodes={tree}
          selectedFile={selectedFile}
          expandedDirs={expandedDirs}
          onToggleDir={(dirPath) => {
            setExpandedDirs((prev) => {
              const next = new Set(prev);
              if (next.has(dirPath)) next.delete(dirPath);
              else next.add(dirPath);
              return next;
            });
          }}
          onSelectFile={setSelectedFile}
          showCheckboxes={false}
        />
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {!selectedFile ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <BookOpen className="h-6 w-6" />
            <p className="text-sm">Select a file to view its contents</p>
          </div>
        ) : contentLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Loading...
          </div>
        ) : pageContent ? (
          <div className="p-6">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-border">
              <div>
                <h2 className="text-sm font-medium">{selectedPageInfo?.title ?? selectedFile}</h2>
                <span className="text-xs text-muted-foreground">{selectedFile}</span>
              </div>
              {selectedPageInfo && (
                <span className="text-xs text-muted-foreground">
                  {formatBytes(selectedPageInfo.sizeBytes)} &middot; {formatRelativeTime(selectedPageInfo.updatedAt)}
                </span>
              )}
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownBody>{pageContent.content}</MarkdownBody>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground p-6">Page not found.</p>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
