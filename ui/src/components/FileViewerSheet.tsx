import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  Cloud,
  Copy,
  Download,
  Eye,
  FileCode2,
  FileSearch,
  FolderOpen,
  FolderSearch,
  Link2,
  Loader2,
  Lock,
  RefreshCcw,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fileResourcesApi } from "@/api/file-resources";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import {
  useRequiredFileViewer,
  type FileViewerUrlState,
} from "@/context/FileViewerContext";
import { WorkspaceFileBrowser } from "@/components/WorkspaceFileBrowser";
import { WorkspaceFileMarkdownBody } from "@/components/WorkspaceFileMarkdownBody";
import type {
  ResolvedWorkspaceResource,
  WorkspaceFileContent,
  WorkspaceFileSelector,
} from "@paperclipai/shared";

const FILE_VIEWER_LABELLED_BY_ID = "paperclip-file-viewer-title";
const FILE_VIEWER_DESCRIBED_BY_ID = "paperclip-file-viewer-description";
const MIN_FILE_TREE_WIDTH = 220;
const MAX_FILE_TREE_WIDTH = 520;

interface FileViewerErrorShape {
  status: number;
  code: string;
  message: string;
}

function normalizeError(error: unknown): FileViewerErrorShape {
  if (error instanceof ApiError) {
    const body = (error.body ?? null) as { error?: string; code?: string } | null;
    const code = typeof body?.code === "string" ? body.code : "";
    return {
      status: error.status,
      code,
      message: typeof body?.error === "string" ? body.error : error.message,
    };
  }
  if (error instanceof Error) {
    return { status: 0, code: "", message: error.message };
  }
  return { status: 0, code: "", message: "Something went wrong." };
}

function formatBytes(size: number | null | undefined): string | null {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function splitContentIntoLines(data: string): string[] {
  if (data === "") return [""];
  const normalized = data.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length > 0 ? lines : [""];
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

function middleTruncatePath(path: string, maxLen = 80): string {
  if (path.length <= maxLen) return path;
  const head = path.slice(0, Math.floor(maxLen / 2) - 1);
  const tail = path.slice(path.length - (maxLen - head.length - 1));
  return `${head}…${tail}`;
}

function isMarkdownResource(resource: ResolvedWorkspaceResource): boolean {
  const contentType = resource.contentType?.toLowerCase() ?? "";
  if (contentType.includes("markdown")) return true;
  const path = (resource.displayPath || resource.title).toLowerCase();
  return /\.(md|markdown|mdown|mkdn|mkd)$/.test(path);
}

async function copyTextWithFallback(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    const success = document.execCommand("copy");
    if (!success) throw new Error("execCommand copy failed");
  } finally {
    document.body.removeChild(textarea);
  }
}

export function describeDenial(code: string, fallback: string): { title: string; body: string; icon: ReactNode } {
  const lower = code.toLowerCase();
  if (lower.includes("policy") || lower.includes("denied") || lower.includes("sensitive")) {
    return {
      icon: <Lock aria-hidden="true" className="h-6 w-6 text-amber-500" />,
      title: "Viewer blocked for this file",
      body: "This file is not available through the viewer because it may contain sensitive data.",
    };
  }
  if (lower.includes("outside") || lower.includes("traversal")) {
    return {
      icon: <Ban aria-hidden="true" className="h-6 w-6 text-red-500" />,
      title: "Path is outside the workspace",
      body: "The viewer can only open files that live under the issue's workspace.",
    };
  }
  if (lower.includes("archive") || lower.includes("cleaned")) {
    return {
      icon: <FolderOpen aria-hidden="true" className="h-6 w-6 text-muted-foreground" />,
      title: "Workspace is no longer available",
      body: "The isolated worktree for this issue has been cleaned up, so files cannot be previewed.",
    };
  }
  if (lower.includes("remote")) {
    return {
      icon: <AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />,
      title: "Remote workspace preview not supported",
      body: "This workspace is hosted remotely and is not available for inline preview yet.",
    };
  }
  if (lower.includes("too_large") || lower.includes("size")) {
    return {
      icon: <AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />,
      title: "File is too large to preview",
      body: "This file exceeds the supported preview size.",
    };
  }
  if (lower.includes("binary") || lower.includes("unsupported")) {
    return {
      icon: <AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />,
      title: "Preview not supported for this file type",
      body: "This file does not have a text, image, or video preview available.",
    };
  }
  return {
    icon: <Ban aria-hidden="true" className="h-6 w-6 text-red-500" />,
    title: "Can't preview this file",
    body: fallback || "The viewer was unable to load this file.",
  };
}

function FileViewerStateView({
  icon,
  title,
  body,
  secondary,
  actions,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  secondary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 p-6 text-sm">
      <div className="flex items-start gap-3">
        {icon}
        <div className="flex-1 space-y-1">
          <p className="font-medium text-foreground">{title}</p>
          {body ? <p className="text-muted-foreground">{body}</p> : null}
          {secondary}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function FileViewerMetadataRow({
  resolvedResource,
  state,
}: {
  resolvedResource?: ResolvedWorkspaceResource;
  state: FileViewerUrlState | null;
}) {
  return (
    <div className="flex min-h-(--sz-18px) flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {resolvedResource ? (
        <>
          {resolvedResource.previewKind ? <span className="capitalize">{resolvedResource.previewKind}</span> : null}
          {formatBytes(resolvedResource.byteSize) ? (
            <>
              <span aria-hidden="true" className="opacity-50">·</span>
              <span>{formatBytes(resolvedResource.byteSize)}</span>
            </>
          ) : null}
          {state?.line ? (
            <>
              <span aria-hidden="true" className="opacity-50">·</span>
              <span>
                Line {state.line}
                {state.column ? `, Col ${state.column}` : ""}
              </span>
            </>
          ) : null}
        </>
      ) : state ? (
        <span className="h-3 w-28 rounded bg-muted animate-pulse" aria-label="Loading file details" />
      ) : null}
    </div>
  );
}

interface FileContentViewerProps {
  content: WorkspaceFileContent;
  highlightedLine: number | null;
  onLoaded?: (summary: string) => void;
}

type MarkdownPreviewMode = "raw" | "rendered";

export function FileContentViewer({ content, highlightedLine, onLoaded }: FileContentViewerProps) {
  const { resource } = content;
  const isMarkdown = resource.previewKind === "text" && content.content.encoding === "utf8" && isMarkdownResource(resource);
  const [markdownMode, setMarkdownMode] = useState<MarkdownPreviewMode>("rendered");
  const lines = useMemo(() => {
    if (resource.previewKind === "text") {
      return splitContentIntoLines(content.content.data);
    }
    return null;
  }, [content.content.data, resource.previewKind]);

  const codeScrollRef = useRef<HTMLDivElement>(null);
  const highlightedLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMarkdownMode(isMarkdown ? "rendered" : "raw");
  }, [isMarkdown, resource.displayPath, resource.title, resource.contentType]);

  useEffect(() => {
    if (!lines) return;
    onLoaded?.(`File loaded, ${lines.length} ${lines.length === 1 ? "line" : "lines"}.`);
  }, [lines, onLoaded]);

  useEffect(() => {
    if (markdownMode !== "raw") return;
    if (!highlightedLine || !highlightedLineRef.current) return;
    highlightedLineRef.current.scrollIntoView({ block: "center", behavior: "auto" });
  }, [highlightedLine, markdownMode]);

  if (resource.previewKind === "image") {
    const dataUrl = content.content.encoding === "base64"
      ? `data:${resource.contentType ?? "application/octet-stream"};base64,${content.content.data}`
      : null;
    if (!dataUrl) {
      return (
        <FileViewerStateView
          icon={<AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />}
          title="Image preview unavailable"
        />
      );
    }
    return (
      <div className="flex items-center justify-center overflow-auto bg-muted/40 p-4">
        <img
          src={dataUrl}
          alt={resource.title}
          className="max-h-full max-w-full rounded border border-border object-contain"
        />
      </div>
    );
  }

  if (resource.previewKind === "video") {
    const dataUrl = content.content.encoding === "base64"
      ? `data:${resource.contentType ?? "application/octet-stream"};base64,${content.content.data}`
      : null;
    if (!dataUrl) {
      return (
        <FileViewerStateView
          icon={<AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />}
          title="Video preview unavailable"
        />
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center overflow-auto bg-black p-4">
        <video
          src={dataUrl}
          controls
          preload="metadata"
          playsInline
          aria-label={`Video preview: ${resource.title}`}
          className="max-h-full max-w-full rounded border border-white/10 bg-black"
        />
      </div>
    );
  }

  if (resource.previewKind === "unsupported" || !lines) {
    return (
      <FileViewerStateView
        icon={<AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />}
        title="Preview not supported for this file type"
        body={resource.contentType ? `Content type: ${resource.contentType}` : undefined}
      />
    );
  }

  const gutterWidth = `calc(${Math.max(4, String(lines.length).length)}ch + 2rem)`;

  const rawSourceView = (
    <div
      ref={codeScrollRef}
      role="region"
      aria-label={`${resource.title} source`}
      tabIndex={0}
      className="paperclip-file-viewer-code flex-1 overflow-auto bg-(--code-bg-resolved) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <pre className="m-0 font-mono text-xs leading-5">
        {lines.map((lineText, index) => {
          const lineNumber = index + 1;
          const isHighlighted = lineNumber === highlightedLine;
          return (
            <div
              key={lineNumber}
              ref={isHighlighted ? highlightedLineRef : undefined}
              data-line-number={lineNumber}
              className={cn(
                "grid grid-cols-(--gtc-5)",
                // Batch 4 resolved the former half-migrated var(--x, fallback)
                // pattern here into --code-highlight-bg-resolved (see
                // ui/src/index.css MISC token block + TOKEN-AUDIT.md Batch 4 log).
                isHighlighted && "bg-(--code-highlight-bg-resolved)",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "sticky left-0 z-10 shrink-0 select-none pl-3 pr-4 text-right text-(--code-gutter-fg-resolved) opacity-70",
                  "bg-(--code-bg-resolved)",
                  isHighlighted &&
                    "opacity-100 bg-(--code-highlight-bg-resolved) border-l-2 border-(--code-highlight-border-resolved)",
                )}
                style={{ width: gutterWidth, minWidth: gutterWidth }}
              >
                {lineNumber}
              </span>
              <code className="min-w-0 whitespace-pre-wrap break-words pr-4">{lineText.length === 0 ? "​" : lineText}</code>
            </div>
          );
        })}
      </pre>
    </div>
  );

  if (!isMarkdown) {
    return rawSourceView;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="absolute right-3 top-3 z-20">
        <div
          role="group"
          aria-label="Markdown preview mode"
          className="inline-flex rounded-md border border-border bg-background/95 p-0.5 shadow-sm backdrop-blur"
        >
          <Button
            type="button"
            variant={markdownMode === "rendered" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Show rendered Markdown"
            title="Rendered Markdown"
            aria-pressed={markdownMode === "rendered"}
            onClick={() => setMarkdownMode("rendered")}
            className={cn(
              "h-7 w-7 rounded-sm",
              markdownMode !== "rendered" && "text-muted-foreground hover:text-foreground",
            )}
          >
            <Eye aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant={markdownMode === "raw" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Show raw Markdown"
            title="Raw Markdown"
            aria-pressed={markdownMode === "raw"}
            onClick={() => setMarkdownMode("raw")}
            className={cn(
              "h-7 w-7 rounded-sm",
              markdownMode !== "raw" && "text-muted-foreground hover:text-foreground",
            )}
          >
            <FileCode2 aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {markdownMode === "raw" ? (
        rawSourceView
      ) : (
        <div
          role="region"
          aria-label={`${resource.title} rendered Markdown`}
          tabIndex={0}
          className="flex-1 overflow-auto bg-background p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <WorkspaceFileMarkdownBody softBreaks={false}>
            {content.content.data}
          </WorkspaceFileMarkdownBody>
        </div>
      )}
    </div>
  );
}

function LoadingView({ elapsedMs }: { elapsedMs: number }) {
  if (elapsedMs < 100) {
    return <div className="flex-1" aria-hidden="true" />;
  }
  if (elapsedMs < 400) {
    return (
      <div className="flex-1 space-y-2 p-6" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading file preview</span>
        {Array.from({ length: 10 }).map((_, index) => (
          <div key={index} className="h-3 rounded bg-muted animate-pulse" style={{ width: `${90 - index * 6}%` }} />
        ))}
      </div>
    );
  }
  return (
    <div
      className="flex flex-1 flex-col items-start justify-start gap-3 p-6 text-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        Loading file preview...
      </div>
    </div>
  );
}

interface FileViewerSheetProps {
  issueId: string;
  companyId?: string | null;
  /** When not provided, the sheet defaults to the context state. */
  state?: FileViewerUrlState | null;
  /** When true, renders the "Open file" prompt when no file is selected but sheet is open. */
  showPromptWhenEmpty?: boolean;
  /** Whether the sheet is open. Defaults to `state !== null`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function FileViewerSheet({
  issueId,
  companyId,
  state: stateProp,
  showPromptWhenEmpty = false,
  open: openProp,
  onOpenChange,
}: FileViewerSheetProps) {
  const viewer = useRequiredFileViewer();
  const state = typeof stateProp !== "undefined" ? stateProp : viewer.state;
  // Browse mode: no file selected, but the sheet was opened to browse/search.
  const browseMode = state === null && (showPromptWhenEmpty || viewer.browse);
  // True when the current file was reached from the browse list (drill-down).
  const cameFromBrowse = state !== null && viewer.browse;
  const computedOpen =
    typeof openProp === "boolean" ? openProp : state !== null || showPromptWhenEmpty || viewer.browse;

  const [elapsedMs, setElapsedMs] = useState(0);
  const [copiedField, setCopiedField] = useState<"content" | "link" | null>(null);
  const [copyingField, setCopyingField] = useState<"content" | "link" | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [announcement, setAnnouncement] = useState<string>("");
  const [fileTreeWidth, setFileTreeWidth] = useState(288);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const resolveQuery = useQuery({
    queryKey: state
      ? queryKeys.issues.fileResource(issueId, state)
      : ["issues", "file-resources", issueId, "resolve", "__closed__"],
    queryFn: () => fileResourcesApi.resolve(issueId, state!),
    enabled: !!state && computedOpen,
    retry: false,
    staleTime: 30_000,
  });

  const resolvedResource: ResolvedWorkspaceResource | undefined = resolveQuery.data;
  const canPreview = resolvedResource?.capabilities.preview ?? false;
  const downloadUrl = state && resolvedResource?.capabilities.download
    ? fileResourcesApi.downloadUrl(issueId, state)
    : null;

  const contentQuery = useQuery({
    queryKey: state
      ? queryKeys.issues.fileResourceContent(issueId, state)
      : ["issues", "file-resources", issueId, "content", "__closed__"],
    queryFn: () => fileResourcesApi.content(issueId, state!),
    enabled: !!state && computedOpen && canPreview,
    retry: false,
    staleTime: 30_000,
  });

  // `elapsedMs` only drives the progressive loading skeleton (see LoadingView).
  // Run the 75ms ticker *only* while a preview is still loading — leaving it
  // running after content arrives would re-render the whole sheet ~13x/second,
  // which forces the markdown body to re-render and discards scroll position
  // and text selection, producing visible flashing (PAP-10767).
  const isLoadingPreview =
    (resolveQuery.isFetching && !resolveQuery.data) ||
    (canPreview && contentQuery.isFetching && !contentQuery.data);

  useEffect(() => {
    if (!state) {
      setElapsedMs(0);
      return;
    }
    if (!isLoadingPreview) return;
    const now = Date.now();
    setElapsedMs(0);
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - now);
    }, 75);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.path, state?.workspace, state?.projectId, state?.workspaceId, isLoadingPreview]);

  useEffect(() => {
    if (resolveQuery.isError) {
      const normalized = normalizeError(resolveQuery.error);
      setAnnouncement(normalized.message || "Unable to load file.");
    }
  }, [resolveQuery.isError, resolveQuery.error]);

  useEffect(() => {
    if (contentQuery.isError) {
      const normalized = normalizeError(contentQuery.error);
      setAnnouncement(normalized.message || "Unable to load file content.");
    }
  }, [contentQuery.isError, contentQuery.error]);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current) window.clearTimeout(copyFeedbackTimerRef.current);
    resizeCleanupRef.current?.();
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (onOpenChange) {
        onOpenChange(next);
        return;
      }
      if (!next) viewer.close();
    },
    [onOpenChange, viewer],
  );

  const handleBrowseOpen = useCallback(
    (ref: {
      path: string;
      workspace: WorkspaceFileSelector;
      line?: number | null;
      column?: number | null;
      projectId?: string | null;
      workspaceId?: string | null;
      browseFolderPath?: string | null;
      browseQuery?: string | null;
    }) => {
      viewer.open(
        {
          path: ref.path,
          line: ref.line ?? null,
          column: ref.column ?? null,
          workspace: ref.workspace,
          projectId: ref.projectId ?? null,
          workspaceId: ref.workspaceId ?? null,
        },
        {
          fromBrowse: true,
          browseState: {
            folderPath: ref.browseFolderPath ?? null,
            q: ref.browseQuery ?? null,
          },
        },
      );
    },
    [viewer],
  );

  const handleBrowseStateChange = useCallback(
    (next: {
      q: string | null;
      folderPath: string | null;
      projectId: string | null;
      workspaceId: string | null;
    }) => {
      viewer.updateBrowseState(next);
    },
    [viewer],
  );

  const showCopyFeedback = useCallback((field: "content" | "link" | null, message: string) => {
    setCopiedField(field);
    setCopyFeedback(message);
    setAnnouncement(message);
    if (copyFeedbackTimerRef.current) window.clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
      setCopyFeedback("");
      copyFeedbackTimerRef.current = null;
    }, 1800);
  }, []);

  const copyToClipboard = useCallback(async (value: string, field: "content" | "link", message: string) => {
    try {
      setCopyingField(field);
      await copyTextWithFallback(value);
      showCopyFeedback(field, message);
    } catch {
      showCopyFeedback(null, "Copy failed");
    } finally {
      setCopyingField((current) => (current === field ? null : current));
    }
  }, [showCopyFeedback]);

  const handleCopyContent = useCallback(() => {
    if (!state) return;
    void (async () => {
      let content = contentQuery.data;
      if (!content && canPreview) {
        const result = await contentQuery.refetch();
        content = result.data;
      }
      if (!content) {
        showCopyFeedback(null, "File contents unavailable");
        return;
      }
      const message = content.content.encoding === "base64" ? "Copied file data" : "Copied contents";
      await copyToClipboard(content.content.data, "content", message);
    })();
  }, [canPreview, contentQuery, copyToClipboard, showCopyFeedback, state]);

  const handleCopyLink = useCallback(() => {
    if (typeof window === "undefined") return;
    void copyToClipboard(window.location.href, "link", "Copied link");
  }, [copyToClipboard]);

  const handleRetry = useCallback(() => {
    void resolveQuery.refetch();
    if (canPreview) void contentQuery.refetch();
  }, [canPreview, contentQuery, resolveQuery]);

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = fileTreeWidth;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.min(
        MAX_FILE_TREE_WIDTH,
        Math.max(MIN_FILE_TREE_WIDTH, startWidth + moveEvent.clientX - startX),
      );
      setFileTreeWidth(nextWidth);
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", cleanup, { once: true });
  }, [fileTreeWidth]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setFileTreeWidth((current) => {
      const delta = event.key === "ArrowLeft" ? -24 : 24;
      return Math.min(MAX_FILE_TREE_WIDTH, Math.max(MIN_FILE_TREE_WIDTH, current + delta));
    });
  }, []);

  const title = state ? basename(state.path) : "Browse workspace";
  const description = state
    ? middleTruncatePath(state.path)
    : "Search and preview files from this issue's workspace.";
  const showDescription = state ? description !== title : true;

  return (
    <Dialog open={computedOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex h-(--sz-calc-3) w-(--sz-calc-4) max-w-(--sz-calc-5) flex-col gap-0 overflow-hidden p-0 sm:w-(--sz-94vw) sm:max-w-(--sz-1280px)"
        aria-labelledby={FILE_VIEWER_LABELLED_BY_ID}
        aria-describedby={FILE_VIEWER_DESCRIBED_BY_ID}
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          // From a file reached via browse, Esc returns to the list; a second Esc closes.
          if (cameFromBrowse) {
            event.preventDefault();
            viewer.backToFiles();
          }
        }}
      >
        <DialogHeader className="border-b border-border gap-1 p-3">
          <div className="grid min-w-0 grid-cols-(--gtc-6) items-start gap-2">
            {browseMode ? (
              <FolderSearch aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <FileCode2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <DialogTitle id={FILE_VIEWER_LABELLED_BY_ID} className="truncate text-sm leading-5">
                {title}
              </DialogTitle>
              <DialogDescription
                id={FILE_VIEWER_DESCRIBED_BY_ID}
                className={cn(
                  "truncate font-mono text-xs",
                  !showDescription && "sr-only",
                )}
                title={state?.path}
              >
                {description}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1 self-start">
              <span className="hidden min-w-28 text-right text-xs text-muted-foreground sm:inline" role="status" aria-live="polite">
                {copyFeedback}
              </span>
              {cameFromBrowse ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => viewer.backToFiles()}
                  className="h-7 gap-1 px-2 text-xs"
                  aria-label="Back to files"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to files
                </Button>
              ) : null}
              {state ? (
                downloadUrl ? (
                  <Button
                    asChild
                    variant="ghost"
                    size="icon-sm"
                    className="h-7 w-7"
                  >
                    <a
                      href={downloadUrl}
                      download={resolvedResource?.title ?? basename(state.path)}
                      aria-label="Download file"
                      title="Download file"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  </Button>
                ) : null
              ) : null}
              {state ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleCopyContent}
                  aria-label={copiedField === "content" ? "Copied file contents" : "Copy file contents"}
                  title={copiedField === "content" ? "Copied contents" : "Copy file contents"}
                  className="h-7 w-7"
                >
                  {copyingField === "content" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : copiedField === "content" ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              ) : null}
              {state ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleCopyLink}
                  aria-label={copiedField === "link" ? "Copied file view link" : "Copy link to this file view"}
                  title={copiedField === "link" ? "Copied link" : "Copy link"}
                  className="h-7 w-7"
                >
                  {copyingField === "link" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : copiedField === "link" ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Link2 className="h-4 w-4" />
                  )}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => handleOpenChange(false)}
                className="h-7 w-7"
                aria-label="Close file viewer"
                title="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <FileViewerMetadataRow resolvedResource={resolvedResource} state={state} />
        </DialogHeader>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div aria-live="polite" className="sr-only">
            {announcement}
          </div>
          {state ? (
            <div className="flex min-h-0 flex-1 gap-3 bg-muted/30 p-3">
              <aside
                className="hidden min-h-0 shrink-0 overflow-hidden sm:flex"
                style={{ width: fileTreeWidth }}
              >
                <WorkspaceFileBrowser
                  key={`${state.projectId ?? ""}:${state.workspaceId ?? ""}`}
                  issueId={issueId}
                  companyId={companyId}
                  onOpen={handleBrowseOpen}
                  onBrowseStateChange={cameFromBrowse ? handleBrowseStateChange : undefined}
                  initialQuery={cameFromBrowse ? viewer.query : null}
                  initialFolderPath={cameFromBrowse ? viewer.folderPath : undefined}
                  initialProjectId={state.projectId ?? (cameFromBrowse ? viewer.browseProjectId : null)}
                  initialWorkspaceId={state.workspaceId ?? (cameFromBrowse ? viewer.browseWorkspaceId : null)}
                  autoFocusSearch={false}
                  compact
                  selectedPath={state.path}
                  selectedProjectId={state.projectId}
                  selectedWorkspaceId={state.workspaceId}
                  className="min-h-0 flex-1 p-2"
                />
              </aside>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize file tree"
                aria-valuemin={MIN_FILE_TREE_WIDTH}
                aria-valuemax={MAX_FILE_TREE_WIDTH}
                aria-valuenow={fileTreeWidth}
                tabIndex={0}
                onPointerDown={handleResizeStart}
                onKeyDown={handleResizeKeyDown}
                className="hidden w-1 shrink-0 cursor-col-resize rounded-full bg-border transition-colors hover:bg-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
              />
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <FileViewerBody
                  resolveQuery={resolveQuery}
                  contentQuery={contentQuery}
                  elapsedMs={elapsedMs}
                  canPreview={canPreview}
                  highlightedLine={state.line ?? null}
                  onRetry={handleRetry}
                  onSetAnnouncement={setAnnouncement}
                  onFallbackToProject={
                    state.workspace !== "project" && !state.projectId && !state.workspaceId
                      ? () =>
                          viewer.open({
                            path: state.path,
                            line: state.line,
                            column: state.column,
                            workspace: "project",
                            projectId: null,
                            workspaceId: null,
                          })
                      : null
                  }
                />
              </div>
            </div>
          ) : browseMode ? (
            <WorkspaceFileBrowser
              issueId={issueId}
              companyId={companyId}
              onOpen={handleBrowseOpen}
              onBrowseStateChange={handleBrowseStateChange}
              initialQuery={viewer.query}
              initialFolderPath={viewer.folderPath}
              initialProjectId={viewer.browseProjectId}
              initialWorkspaceId={viewer.browseWorkspaceId}
              className="min-h-0 flex-1 p-4"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface FileViewerBodyProps {
  resolveQuery: UseQueryResult<ResolvedWorkspaceResource, unknown>;
  contentQuery: UseQueryResult<WorkspaceFileContent, unknown>;
  elapsedMs: number;
  canPreview: boolean;
  highlightedLine: number | null;
  onRetry: () => void;
  onSetAnnouncement: (message: string) => void;
  onFallbackToProject: null | (() => void);
}

function FileViewerBody({
  resolveQuery,
  contentQuery,
  elapsedMs,
  canPreview,
  highlightedLine,
  onRetry,
  onSetAnnouncement,
  onFallbackToProject,
}: FileViewerBodyProps) {
  if (resolveQuery.isFetching && !resolveQuery.data) {
    return <LoadingView elapsedMs={elapsedMs} />;
  }

  if (resolveQuery.isError) {
    const normalized = normalizeError(resolveQuery.error);
    if (normalized.status === 404) {
      return (
        <FileViewerStateView
          icon={<FileSearch aria-hidden="true" className="h-6 w-6 text-muted-foreground" />}
          title="File not found"
          body="That file was not found in the active workspace."
          actions={
            <>
              {onFallbackToProject ? (
                <Button type="button" variant="secondary" size="sm" onClick={onFallbackToProject}>
                  Try project workspace
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
                <RefreshCcw aria-hidden="true" className="mr-1 h-3 w-3" /> Retry
              </Button>
            </>
          }
        />
      );
    }
    if (normalized.status === 422) {
      return (
        <FileViewerStateView
          icon={<FolderOpen aria-hidden="true" className="h-6 w-6 text-muted-foreground" />}
          title="No workspace available"
          body="This issue does not have a workspace that supports preview yet."
        />
      );
    }
    const denial = describeDenial(normalized.code, normalized.message);
    return (
      <FileViewerStateView
        icon={denial.icon}
        title={denial.title}
        body={denial.body}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCcw aria-hidden="true" className="mr-1 h-3 w-3" /> Retry
          </Button>
        }
      />
    );
  }

  const resource = resolveQuery.data;
  if (!resource) return null;

  if (resource.kind === "remote_resource") {
    return (
      <FileViewerStateView
        icon={<Cloud aria-hidden="true" className="h-6 w-6 text-muted-foreground" />}
        title="Remote workspace preview coming soon"
        body="This workspace is hosted remotely; inline previews are not supported yet."
      />
    );
  }

  if (!canPreview) {
    const denial = describeDenial(resource.denialReason ?? "", "");
    return <FileViewerStateView icon={denial.icon} title={denial.title} body={denial.body} />;
  }

  if (contentQuery.isFetching && !contentQuery.data) {
    return <LoadingView elapsedMs={elapsedMs} />;
  }

  if (contentQuery.isError) {
    const normalized = normalizeError(contentQuery.error);
    const denial = describeDenial(normalized.code, normalized.message);
    return (
      <FileViewerStateView
        icon={denial.icon}
        title={denial.title}
        body={denial.body}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCcw aria-hidden="true" className="mr-1 h-3 w-3" /> Retry
          </Button>
        }
      />
    );
  }

  if (!contentQuery.data) return null;

  return (
    <FileContentViewer
      content={contentQuery.data}
      highlightedLine={highlightedLine}
      onLoaded={onSetAnnouncement}
    />
  );
}
