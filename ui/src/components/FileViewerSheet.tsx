import { resolveUiMessage, type UiMessageDescriptor } from "@/lib/localized-ui-error";
import { t, useTranslation, i18n, Trans } from "@/i18n";
import { CsvPreview } from "./CsvPreview";
import { isCsvFile } from "@/lib/csv-preview";
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
import { queryViewKind } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  useRequiredFileViewer,
  type FileViewerUrlState,
} from "@/context/FileViewerContext";
import { WorkspaceFileBrowser } from "@/components/WorkspaceFileBrowser";
import { WorkspaceFileMarkdownBody } from "@/components/WorkspaceFileMarkdownBody";
import { HtmlArtifactPreview } from "@/components/HtmlArtifactPreview";
import { FilePreviewModeToggle, type FilePreviewMode } from "@/components/FilePreviewModeToggle";
import { isHtmlPreview } from "@/lib/html-preview";
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
  return { status: 0, code: "", message: t("task-components:somethingWentWrong_0c953ab3") };
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

export function describeDenial(code: string, fallback: string): { title: string; body: string; icon: ReactNode } {
  if (code === "denied_path_segment" || code === "denied_secret") {
    return {
      icon: <Lock aria-hidden="true" className="h-6 w-6 text-amber-500" />,
      title: t("task-components:viewerBlockedForThisFile_2d9ad26c"),
      body: t("final-components-a:thisFileIsNotAvailable_936df1dd"),
    };
  }
  if (code === "outside_workspace") {
    return {
      icon: <Ban aria-hidden="true" className="h-6 w-6 text-red-500" />,
      title: t("task-components:pathIsOutsideTheWorkspace_aa3ce277"),
      body: t("final-components-a:theViewerCanOnlyOpen_370e1f9d"),
    };
  }
  if (code === "workspace_unavailable") {
    return {
      icon: <FolderOpen aria-hidden="true" className="h-6 w-6 text-muted-foreground" />,
      title: t("task-components:workspaceIsNoLongerAvailable_cb2826c6"),
      body: t("final-components-a:theIsolatedWorktreeForThis_f472e174"),
    };
  }
  if (code === "remote_workspace") {
    return {
      icon: <AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />,
      title: t("task-components:remoteWorkspacePreviewNotSupported_118565fc"),
      body: t("final-components-a:thisWorkspaceIsHostedRemotely_8e3144a2"),
    };
  }
  if (code === "too_large") {
    return {
      icon: <AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />,
      title: t("task-components:fileIsTooLargeToPreview_af94fcfb"),
      body: t("final-components-a:thisFileExceedsTheSupported_9cd98d65"),
    };
  }
  if (code === "binary_content" || code === "unsupported_content") {
    return {
      icon: <AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />,
      title: t("task-components:previewNotSupportedForThisFileType_c55ca586"),
      body: t("final-components-a:thisFileDoesNotHave_d3593944"),
    };
  }
  return {
    icon: <Ban aria-hidden="true" className="h-6 w-6 text-red-500" />,
    title: t("task-components:canTPreviewThisFile_31b952ec"),
    body: fallback || t("final-components-a:theViewerWasUnableTo_8782ce81"),
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
  useTranslation("task-components");
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
  useTranslation("task-components");
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
              <span><Trans ns="final-components-a" i18nKey="numeric_6ad57a6b3b13" values={{ line: state.line }} components={{ part2: <>{state.column ? t("task-components:col_0100d697", { value1: state.column }) : ""}</> }} /></span>
            </>
          ) : null}
        </>
      ) : state ? (
        <span className="h-3 w-28 rounded bg-muted animate-pulse" aria-label={t("task-components:loadingFileDetails_768d734a")} />
      ) : null}
    </div>
  );
}

interface FileContentViewerProps {
  content: WorkspaceFileContent;
  highlightedLine: number | null;
  onLoaded?: (summary: UiMessageDescriptor) => void;
  previewMode?: "raw" | "rendered";
  htmlMode?: FilePreviewMode;
}

type MarkdownPreviewMode = "raw" | "rendered";

export function FileContentViewer({ content, highlightedLine, onLoaded, previewMode, htmlMode = "rendered" }: FileContentViewerProps) {
  useTranslation("task-components");
  const { resource } = content;
  const isMarkdown = resource.previewKind === "text" && content.content.encoding === "utf8" && isMarkdownResource(resource);
  const isCsv = resource.previewKind === "text" && content.content.encoding === "utf8" && isCsvFile(resource.displayPath || resource.title, resource.contentType ?? "");
  const [localMode, setMarkdownMode] = useState<MarkdownPreviewMode>("rendered");
  const markdownMode = isMarkdown || isCsv ? (previewMode ?? localMode) : "raw";
  const isHtml = resource.previewKind === "text" && content.content.encoding === "utf8" && isHtmlPreview(resource.contentType, resource.displayPath || resource.title);
  const previewLabel = isCsv ? "CSV" : "Markdown";
  const lines = useMemo(() => {
    if (resource.previewKind === "text") {
      return splitContentIntoLines(content.content.data);
    }
    return null;
  }, [content.content.data, resource.previewKind]);

  const codeScrollRef = useRef<HTMLDivElement>(null);
  const highlightedLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMarkdownMode(isMarkdown || isCsv ? "rendered" : "raw");
  }, [isMarkdown, isCsv, resource.displayPath, resource.title, resource.contentType]);

  useEffect(() => {
    if (!lines) return;
    onLoaded?.({ key: "final-components-a:fileLoadedLines", values: { count: lines.length } });
  }, [lines, onLoaded]);

  useEffect(() => {
    if (markdownMode !== "raw") return;
    if (!highlightedLine || !highlightedLineRef.current) return;
    highlightedLineRef.current.scrollIntoView({ block: "center", behavior: "auto" });
  }, [highlightedLine, markdownMode, htmlMode, previewMode]);

  if (resource.previewKind === "image") {
    const dataUrl = content.content.encoding === "base64"
      ? `data:${resource.contentType ?? "application/octet-stream"};base64,${content.content.data}`
      : null;
    if (!dataUrl) {
      return (
        <FileViewerStateView
          icon={<AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />}
          title={t("task-components:imagePreviewUnavailable_637262a2")}
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
          title={t("task-components:videoPreviewUnavailable_ba6b8bcc")}
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
          aria-label={t("task-components:videoPreview_8afdea00", { value1: resource.title })}
          className="max-h-full max-w-full rounded border border-white/10 bg-black"
        />
      </div>
    );
  }

  if (resource.previewKind === "unsupported" || !lines) {
    return (
      <FileViewerStateView
        icon={<AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-500" />}
        title={t("task-components:previewNotSupportedForThisFileType_c55ca586")}
        body={resource.contentType ? t("final-components-a:contentTypeType_5ea230b1", { type: resource.contentType }) : undefined}
      />
    );
  }

  const gutterWidth = `calc(${Math.max(4, String(lines.length).length)}ch + 2rem)`;

  const rawSourceView = (
    <div
      ref={codeScrollRef}
      role="region"
      aria-label={t("task-components:source_bb4a970a", { value1: resource.title })}
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

  if (isHtml) {
    return (previewMode ?? htmlMode) === "raw" ? rawSourceView : <HtmlArtifactPreview html={content.content.data} title={resource.title} />;
  }

  if (!isMarkdown && !isCsv) {
    return rawSourceView;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {previewMode === undefined && <div className="absolute right-3 top-3 z-20">
        <div
          role="group"
          aria-label={t("task-components:previewMode_756af999", { value1: previewLabel })}
          className="inline-flex rounded-md border border-border bg-background/95 p-0.5 shadow-sm backdrop-blur"
        >
          <Button
            type="button"
            variant={markdownMode === "rendered" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={t("task-components:showRendered_b06aa74c", { value1: previewLabel })}
            title={t("task-components:rendered_ea5c22b2", { value1: previewLabel })}
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
            aria-label={t("task-components:showRaw_bf25ae17", { value1: previewLabel })}
            title={t("task-components:raw_830e0e82", { value1: previewLabel })}
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
      }
      {markdownMode === "raw" ? (
        rawSourceView
      ) : isCsv ? <CsvPreview text={content.content.data} title={resource.title} /> : (
        <div
          role="region"
          aria-label={t("task-components:renderedMarkdown_881d2784", { value1: resource.title })}
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
  useTranslation("task-components");
  if (elapsedMs < 100) {
    return <div className="flex-1" aria-hidden="true" />;
  }
  if (elapsedMs < 400) {
    return (
      <div className="flex-1 space-y-2 p-6" aria-busy="true" aria-live="polite">
        <span className="sr-only">{t("task-components:loadingFilePreview_7b144afc")}</span>
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
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{t("task-components:loadingFilePreview_33454f00")}</div>
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
  useTranslation("task-components");
  const viewer = useRequiredFileViewer();
  const state = typeof stateProp !== "undefined" ? stateProp : viewer.state;
  // Browse mode: no file selected, but the sheet was opened to browse/search.
  const browseMode = state === null && (showPromptWhenEmpty || viewer.browse);
  // True when the current file was reached from the browse list (drill-down).
  const cameFromBrowse = state !== null && viewer.browse;
  const computedOpen =
    typeof openProp === "boolean" ? openProp : state !== null || showPromptWhenEmpty || viewer.browse;

  const [elapsedMs, setElapsedMs] = useState(0);
  const [htmlMode, setHtmlMode] = useState<FilePreviewMode>("rendered");
  useEffect(() => setHtmlMode("rendered"), [state?.path, state?.workspace, state?.workspaceId, state?.projectId]);
  const [copiedField, setCopiedField] = useState<"content" | "link" | null>(null);
  const [copyingField, setCopyingField] = useState<"content" | "link" | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<UiMessageDescriptor | null>(null);
  const [announcement, setAnnouncement] = useState<string | UiMessageDescriptor>("");
  const [fileTreeWidth, setFileTreeWidth] = useState(288);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const resolveQuery = useQuery({
    queryKey: state
      ? queryKeys.issues.fileResource(issueId, state)
      : ["issues", "file-resources", issueId, "resolve", "__closed__"],
    queryFn: () => fileResourcesApi.resolve(issueId, state!),
    enabled: !!state && computedOpen,
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
      setAnnouncement(normalized.message || { key: "final-components-a:unableToLoadFile_98926f2c" });
    }
  }, [resolveQuery.isError, resolveQuery.error]);

  useEffect(() => {
    if (contentQuery.isError) {
      const normalized = normalizeError(contentQuery.error);
      setAnnouncement(normalized.message || { key: "final-components-a:unableToLoadFileContent_e53b6885" });
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

  const showCopyFeedback = useCallback((field: "content" | "link" | null, message: UiMessageDescriptor) => {
    setCopiedField(field);
    setCopyFeedback(message);
    setAnnouncement(message);
    if (copyFeedbackTimerRef.current) window.clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
      setCopyFeedback(null);
      copyFeedbackTimerRef.current = null;
    }, 1800);
  }, []);

  const copyToClipboard = useCallback(async (value: string, field: "content" | "link", message: UiMessageDescriptor) => {
    try {
      setCopyingField(field);
      await copyTextToClipboard(value);
      showCopyFeedback(field, message);
    } catch {
      showCopyFeedback(null, { key: "final-components-a:copyFailed_5b50e7a6" });
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
        showCopyFeedback(null, { key: "final-components-a:fileContentsUnavailable_a3b68b9d" });
        return;
      }
      const message = content.content.encoding === "base64" ? { key: "final-components-a:copiedFileData_62c309f4" } : { key: "task-components:copiedContents_6604ead1" };
      await copyToClipboard(content.content.data, "content", message);
    })();
  }, [canPreview, contentQuery, copyToClipboard, showCopyFeedback, state, i18n.language]);

  const handleCopyLink = useCallback(() => {
    if (typeof window === "undefined") return;
    void copyToClipboard(window.location.href, "link", { key: "final-components-a:copiedLink_93354054" });
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

  const title = state ? basename(state.path) : t("final-components-a:browseWorkspace_c9f08da4");
  const description = state
    ? middleTruncatePath(state.path)
    : t("final-components-a:searchAndPreviewFilesFrom_fc4d8249");
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
                {copyFeedback ? resolveUiMessage(copyFeedback) : ""}
              </span>
              {cameFromBrowse ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => viewer.backToFiles()}
                  className="h-7 gap-1 px-2 text-xs"
                  aria-label={t("task-components:backToFiles_f911e3db")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />{t("task-components:backToFiles_f911e3db")}</Button>
              ) : null}
              {contentQuery.data?.resource.previewKind === "text" && contentQuery.data.content.encoding === "utf8"
                && isHtmlPreview(contentQuery.data.resource.contentType, contentQuery.data.resource.displayPath || contentQuery.data.resource.title) ? (
                  <FilePreviewModeToggle mode={htmlMode} onChange={setHtmlMode} label={t("task-components:htmlView_765d02e6")} />
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
                      aria-label={t("task-components:downloadFile_9de4149f")}
                      title={t("task-components:downloadFile_9de4149f")}
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
                  aria-label={copiedField === "content" ? t("task-components:copiedFileContents_b4dbbc32") : t("task-components:copyFileContents_b3278e5f")}
                  title={copiedField === "content" ? t("task-components:copiedContents_6604ead1") : t("task-components:copyFileContents_b3278e5f")}
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
                  aria-label={copiedField === "link" ? t("task-components:copiedFileViewLink_b2acd575") : t("task-components:copyLinkToThisFileView_ed399e88")}
                  title={copiedField === "link" ? t("task-components:copiedLink_93354054") : t("task-components:copyLink_dbf362d4")}
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
                aria-label={t("task-components:closeFileViewer_ca47c733")}
                title={t("task-components:close_7d9eb7ac")}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <FileViewerMetadataRow resolvedResource={resolvedResource} state={state} />
        </DialogHeader>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div aria-live="polite" className="sr-only">
            {typeof announcement === "string" ? announcement : resolveUiMessage(announcement)}
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
                  active={computedOpen}
                  className="min-h-0 flex-1 p-2"
                />
              </aside>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("task-components:resizeFileTree_8c62ea07")}
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
                  htmlMode={htmlMode}
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
              active={computedOpen}
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
  previewMode?: "raw" | "rendered";
  htmlMode?: FilePreviewMode;
}

export function FileViewerBody({
  resolveQuery,
  contentQuery,
  elapsedMs,
  canPreview,
  highlightedLine,
  onRetry,
  onSetAnnouncement,
  onFallbackToProject,
  previewMode,
  htmlMode,
}: FileViewerBodyProps) {
  useTranslation("task-components");
  const announceLoaded = useCallback((summary: UiMessageDescriptor) => onSetAnnouncement(resolveUiMessage(summary)), [onSetAnnouncement, i18n.language]);
  // Loaded content stays on screen while a refetch fails; a quiet loading
  // view covers an outage before anything has loaded.
  const resolveKind = queryViewKind(resolveQuery);
  if (!resolveQuery.data && (resolveQuery.isFetching || resolveKind === "reconnecting")) {
    return <LoadingView elapsedMs={elapsedMs} />;
  }

  if (resolveKind === "error") {
    const normalized = normalizeError(resolveQuery.error);
    if (normalized.status === 404) {
      return (
        <FileViewerStateView
          icon={<FileSearch aria-hidden="true" className="h-6 w-6 text-muted-foreground" />}
          title={t("task-components:fileNotFound_3521021a")}
          body={t("final-components-a:thatFileWasNotFound_0e7e492c")}
          actions={
            <>
              {onFallbackToProject ? (
                <Button type="button" variant="secondary" size="sm" onClick={onFallbackToProject}>{t("task-components:tryProjectWorkspace_ec57088f")}</Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
                <RefreshCcw aria-hidden="true" className="mr-1 h-3 w-3" />{" "}{t("task-components:retry_942087cc")}</Button>
            </>
          }
        />
      );
    }
    if (normalized.status === 422) {
      return (
        <FileViewerStateView
          icon={<FolderOpen aria-hidden="true" className="h-6 w-6 text-muted-foreground" />}
          title={t("task-components:noWorkspaceAvailable_8621cdb8")}
          body={t("final-components-a:thisIssueDoesNotHave_2cebaed6")}
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
            <RefreshCcw aria-hidden="true" className="mr-1 h-3 w-3" />{" "}{t("task-components:retry_942087cc")}</Button>
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
        title={t("task-components:remoteWorkspacePreviewComingSoon_e823cbb5")}
        body={t("final-components-a:thisWorkspaceIsHostedRemotely_328ae25d")}
      />
    );
  }

  if (!canPreview) {
    const denial = describeDenial(resource.denialReason ?? "", "");
    return <FileViewerStateView icon={denial.icon} title={denial.title} body={denial.body} />;
  }

  const contentKind = queryViewKind(contentQuery);
  if (!contentQuery.data && (contentQuery.isFetching || contentKind === "reconnecting")) {
    return <LoadingView elapsedMs={elapsedMs} />;
  }

  if (contentKind === "error") {
    const normalized = normalizeError(contentQuery.error);
    const denial = describeDenial(normalized.code, normalized.message);
    return (
      <FileViewerStateView
        icon={denial.icon}
        title={denial.title}
        body={denial.body}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCcw aria-hidden="true" className="mr-1 h-3 w-3" />{" "}{t("task-components:retry_942087cc")}</Button>
        }
      />
    );
  }

  if (!contentQuery.data) return null;

  return (
    <FileContentViewer
      content={contentQuery.data}
      highlightedLine={highlightedLine}
      previewMode={previewMode}
      onLoaded={announceLoaded}
      htmlMode={htmlMode}
    />
  );
}
