import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Lock,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import {
  libraryApi,
  type LibraryEntry,
  type LibraryFileEvent,
  type LibraryContributor,
  type LibraryFileMeta,
} from "../api/library";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LibrarySettingsButton } from "../components/LibrarySettings";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
    case "mdx":
      return FileText;
    case "json":
    case "yaml":
    case "yml":
      return FileJson;
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "sh":
    case "bash":
    case "go":
    case "rs":
      return FileCode2;
    default:
      return File;
  }
}

function isMarkdown(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "mdx";
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

function visibilityIcon(visibility: string) {
  switch (visibility) {
    case "private":
      return Lock;
    case "project":
      return EyeOff;
    case "company":
      return Globe;
    default:
      return Eye;
  }
}

/* ------------------------------------------------------------------ */
/*  Tree Node                                                          */
/* ------------------------------------------------------------------ */

interface TreeNodeProps {
  entry: LibraryEntry;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  onToggleDir: (dirPath: string) => void;
  onSelectFile: (filePath: string) => void;
  childEntries: Map<string, LibraryEntry[]>;
}

function TreeNode({
  entry,
  depth,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelectFile,
  childEntries,
}: TreeNodeProps) {
  const isDir = entry.kind === "directory";
  const isExpanded = expandedDirs.has(entry.path);
  const isSelected = selectedPath === entry.path;
  const Icon = isDir ? (isExpanded ? FolderOpen : Folder) : fileIcon(entry.name);
  const children = childEntries.get(entry.path) ?? [];

  return (
    <div>
      <button
        onClick={() => (isDir ? onToggleDir(entry.path) : onSelectFile(entry.path))}
        className={cn(
          "flex items-center gap-1.5 w-full text-left px-2 py-1.5 text-[13px] hover:bg-accent/50 transition-colors group",
          isSelected && "bg-accent text-accent-foreground font-medium",
        )}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        {isDir ? (
          isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            isDir ? "text-blue-500" : "text-muted-foreground",
          )}
        />
        <span className="truncate flex-1">{entry.name}</span>
        {entry.meta?.visibility && entry.meta.visibility !== "company" && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <span className="shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                {entry.meta.visibility === "private" ? (
                  <Lock className="h-3 w-3 text-amber-500" />
                ) : (
                  <EyeOff className="h-3 w-3 text-blue-400" />
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {entry.meta.visibility}
            </TooltipContent>
          </Tooltip>
        )}
      </button>

      {isDir && isExpanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              childEntries={childEntries}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  File Metadata Bar                                                  */
/* ------------------------------------------------------------------ */

function FileMetaBar({
  meta,
  contributors,
}: {
  meta: LibraryFileMeta;
  contributors: LibraryContributor[];
}) {
  const VisIcon = visibilityIcon(meta.visibility);
  return (
    <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border bg-muted/10 text-xs text-muted-foreground">
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1">
            <VisIcon className="h-3 w-3" />
            {meta.visibility}
          </span>
        </TooltipTrigger>
        <TooltipContent className="text-xs">Visibility: {meta.visibility}</TooltipContent>
      </Tooltip>

      <span className="flex items-center gap-1">
        <Clock className="h-3 w-3" />
        Created {formatRelative(meta.createdAt)}
      </span>

      {contributors.length > 0 && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {contributors.length} contributor{contributors.length !== 1 ? "s" : ""}
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            {contributors.map((c) => c.agentName ?? c.agentId ?? "Unknown").join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Event History                                                      */
/* ------------------------------------------------------------------ */

function EventHistory({ events }: { events: LibraryFileEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="border-t border-border">
      <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider bg-muted/20">
        History
      </div>
      <div className="divide-y divide-border">
        {events.slice(0, 10).map((event) => (
          <div key={event.id} className="px-4 py-2 text-xs flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium",
                event.action === "created"
                  ? "bg-green-500/10 text-green-600"
                  : event.action === "modified"
                    ? "bg-blue-500/10 text-blue-600"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {event.action}
            </span>
            <span className="text-foreground font-medium">
              {event.agentName ?? event.userId ?? "Unknown"}
            </span>
            {event.changeSummary && (
              <span className="text-muted-foreground truncate flex-1">
                — {event.changeSummary}
              </span>
            )}
            <span className="text-muted-foreground shrink-0 ml-auto">
              {formatRelative(event.createdAt)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  File Viewer                                                        */
/* ------------------------------------------------------------------ */

function FileViewer({
  companyId,
  filePath,
}: {
  companyId: string;
  filePath: string;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.library.file(companyId, filePath),
    queryFn: () => libraryApi.file(companyId, filePath),
    enabled: !!filePath,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading file...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load file"}
      </div>
    );
  }

  if (!data) return null;

  if (data.error || data.content === null) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          <p className="font-medium">{data.name}</p>
          <p className="mt-1">{data.error ?? "Binary file — cannot display"}</p>
          <p className="mt-1 text-xs">{formatBytes(data.size)}</p>
        </div>
      </div>
    );
  }

  const name = data.name;

  return (
    <div className="h-full flex flex-col">
      {/* File header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{name}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatBytes(data.size)}
          </span>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {formatDate(data.modifiedAt)}
        </span>
      </div>

      {/* Metadata bar */}
      {data.meta && (
        <FileMetaBar
          meta={data.meta}
          contributors={data.contributors ?? []}
        />
      )}

      {/* File content */}
      <ScrollArea className="flex-1 min-h-0">
        {isMarkdown(name) ? (
          <div className="p-6 max-w-none">
            <MarkdownBody>{data.content}</MarkdownBody>
          </div>
        ) : (
          <pre className="p-6 text-[13px] leading-relaxed font-mono whitespace-pre-wrap break-words text-foreground">
            {data.content}
          </pre>
        )}
      </ScrollArea>

      {/* Event history */}
      {data.events && data.events.length > 0 && (
        <EventHistory events={data.events} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Library Page                                                  */
/* ------------------------------------------------------------------ */

export function Library() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Library" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchContent, setSearchContent] = useState(false);

  const dirPaths = useMemo(() => ["", ...Array.from(expandedDirs)], [expandedDirs]);

  const treeQueries = useQueries({
    queries: dirPaths.map((dirPath) => ({
      queryKey: queryKeys.library.tree(selectedCompanyId!, dirPath),
      queryFn: () => libraryApi.tree(selectedCompanyId!, dirPath),
      enabled: !!selectedCompanyId,
    })),
  });

  const { data: searchResults } = useQuery({
    queryKey: queryKeys.library.search(selectedCompanyId!, searchQuery + (searchContent ? ":content" : "")),
    queryFn: () => libraryApi.search(selectedCompanyId!, searchQuery, searchContent),
    enabled: !!selectedCompanyId && searchQuery.length >= 2,
  });

  const scanMutation = useMutation({
    mutationFn: () => libraryApi.scan(selectedCompanyId!),
    onSuccess: (data) => {
      pushToast({ title: "Library scanned", body: `${data.registered} files registered`, tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["library", selectedCompanyId] });
    },
    onError: () => {
      pushToast({ title: "Scan failed", body: "Could not scan library", tone: "error" });
    },
  });

  const childEntries = useMemo(() => {
    const map = new Map<string, LibraryEntry[]>();
    for (let i = 0; i < dirPaths.length; i++) {
      const data = treeQueries[i]?.data;
      if (data) {
        map.set(dirPaths[i], data.entries);
      }
    }
    return map;
  }, [dirPaths, treeQueries]);

  const rootEntries = childEntries.get("") ?? [];
  const rootLoading = treeQueries[0]?.isLoading ?? true;
  const rootError = treeQueries[0]?.error;

  const toggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        for (const p of next) {
          if (p === dirPath || p.startsWith(dirPath + "/")) {
            next.delete(p);
          }
        }
      } else {
        next.add(dirPath);
      }
      return next;
    });
  }, []);

  const handleSearch = useCallback(() => {
    setSearchQuery(searchInput.trim());
  }, [searchInput]);

  if (!selectedCompanyId) return null;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Documents, reports, and files created by your agents.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LibrarySettingsButton />
          <Button
            variant="outline"
            size="sm"
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", scanMutation.isPending && "animate-spin")} />
            Scan
          </Button>
        </div>
      </div>

      {/* Two-pane content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left pane: File tree */}
      <div className="w-72 shrink-0 border-r border-border flex flex-col bg-background">
        {/* Search */}
        <div className="px-2 py-2 border-b border-border shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSearch();
            }}
            className="flex gap-1"
          >
            <Input
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                if (!e.target.value.trim()) setSearchQuery("");
              }}
              placeholder="Search files..."
              className="h-7 text-xs"
            />
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
          </form>
          <label className="flex items-center gap-1.5 mt-1.5 px-1 text-[11px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={searchContent}
              onChange={(e) => setSearchContent(e.target.checked)}
              className="rounded border-border"
            />
            Search inside files
          </label>
        </div>

        {/* Tree / Search results */}
        <ScrollArea className="flex-1 min-h-0">
          {searchQuery && searchResults ? (
            <div className="py-1">
              <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                {searchResults.results.length} result{searchResults.results.length !== 1 ? "s" : ""}
              </div>
              {searchResults.results.map((entry) => {
                const Icon = entry.kind === "directory" ? Folder : fileIcon(entry.name);
                return (
                  <button
                    key={entry.path}
                    onClick={() => {
                      if (entry.kind === "file") {
                        setSelectedFile(entry.path);
                        setSearchQuery("");
                        setSearchInput("");
                      }
                    }}
                    className="flex items-center gap-1.5 w-full text-left px-3 py-1.5 text-[13px] hover:bg-accent/50 transition-colors"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{entry.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {entry.path}
                      </div>
                      {entry.matchContext && (
                        <div className="text-[11px] text-muted-foreground/70 truncate mt-0.5 italic">
                          {entry.matchContext}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
              {searchResults.results.length === 0 && (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  No files found
                </div>
              )}
            </div>
          ) : rootLoading ? (
            <div className="p-3">
              <PageSkeleton variant="list" />
            </div>
          ) : rootError ? (
            <div className="p-3 text-sm text-destructive">
              {rootError instanceof Error ? rootError.message : "Failed to load library"}
            </div>
          ) : rootEntries.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <Folder className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Library is empty</p>
              <p className="text-xs text-muted-foreground mt-1">
                Files created by agents will appear here
              </p>
            </div>
          ) : (
            <div className="py-1">
              {rootEntries.map((entry) => (
                <TreeNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  selectedPath={selectedFile}
                  expandedDirs={expandedDirs}
                  onToggleDir={toggleDir}
                  onSelectFile={setSelectedFile}
                  childEntries={childEntries}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right pane: File reader */}
      <div className="flex-1 min-w-0 bg-background">
        {selectedFile ? (
          <FileViewer companyId={selectedCompanyId} filePath={selectedFile} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <BookOpen className="h-12 w-12 text-muted-foreground/20 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">
              Select a file to view
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Browse the file tree on the left to view documents, reports, and files created by your agents.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
            >
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", scanMutation.isPending && "animate-spin")} />
              Scan Library
            </Button>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
