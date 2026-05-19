import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { DIFFS_TAG_NAME, getSingularPatch } from "@pierre/diffs";
import type { PatchDiffProps } from "@pierre/diffs/react";
import { useFileDiffInstance } from "@pierre/diffs/react";
import { createElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  diffSummary,
  fileName,
  initialExpandedFileSet,
  nextExpandedFileSet,
  statusLabel,
  toFileViewModels,
  type DiffFileViewModel,
  type DiffPatchViewModel,
  type DiffRenderMode,
} from "../diff-model.js";
import type { WorkspaceDiffResponse } from "../contracts.js";

type WorkspaceDiffData = WorkspaceDiffResponse;
type WorkspacePatchDiffOptions = PatchDiffProps<undefined>["options"];
type DiffViewMode = "working-tree" | "head";

type LucideIconProps = { size?: number };

function makeLucideIcon(paths: ReactNode) {
  return function LucideIcon({ size = 16 }: LucideIconProps) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ width: size, height: size, display: "block" }}
      >
        {paths}
      </svg>
    );
  };
}

// Plugin bundles cannot import host-only lucide-react; this mirrors lucide RefreshCw.
const RefreshCwIcon = makeLucideIcon(
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </>,
);

function readInitialView(): DiffViewMode {
  if (typeof window === "undefined") return "working-tree";
  return new URLSearchParams(window.location.search).get("diffView") === "head" ? "head" : "working-tree";
}

function readInitialBaseRef() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("baseRef") ?? "";
}

function buttonClass(active = false) {
  return [
    "inline-flex h-8 items-center justify-center rounded-md border px-2.5 text-xs font-medium transition-colors",
    active
      ? "border-foreground/20 bg-foreground text-background"
      : "border-border bg-background text-muted-foreground hover:text-foreground",
  ].join(" ");
}

function iconButtonClass(active = false) {
  return [
    "inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs transition-colors",
    active
      ? "border-foreground/20 bg-foreground text-background"
      : "border-border bg-background text-muted-foreground hover:text-foreground",
  ].join(" ");
}

function warningText(file: DiffFileViewModel) {
  if (file.binary) return "Binary file";
  if (file.oversized) return "Too large to render";
  if (file.truncated) return "Patch truncated";
  if (file.warnings.length > 0) return file.warnings[0]?.message ?? "Diff warning";
  if (file.patches.every((patch) => !patch.patch)) return "No text patch";
  return null;
}

const PATCH_KIND_LABELS: Record<DiffPatchViewModel["kind"], string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  head: "Head",
  untracked: "Untracked",
};

function patchKindLabel(kind: DiffPatchViewModel["kind"]) {
  return PATCH_KIND_LABELS[kind] ?? "Patch";
}

function patchWarningText(patch: DiffPatchViewModel) {
  if (patch.binary) return "Binary file";
  if (patch.oversized) return "Too large to render";
  if (patch.truncated) return "Patch truncated";
  if (patch.warnings.length > 0) return patch.warnings[0]?.message ?? "Diff warning";
  if (!patch.patch) return "No text patch";
  return null;
}

function FileRow({
  file,
  active,
  expanded,
  onSelect,
  onToggle,
  onCopy,
}: {
  file: DiffFileViewModel;
  active: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const warning = warningText(file);
  const expandLabel = expanded ? "Collapse file" : "Expand file";
  const fileAriaLabel = expanded ? `Collapse ${file.path}` : `Expand ${file.path}`;

  return (
    <div
      className={[
        "group border-b border-border/70 px-3 py-2 last:border-b-0",
        active ? "bg-accent/60" : "bg-background hover:bg-muted/45",
      ].join(" ")}
    >
      <div key="main" className="flex min-w-0 items-start gap-2">
        <button
          key="toggle"
          type="button"
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          onClick={onToggle}
          title={expandLabel}
          aria-label={fileAriaLabel}
        >
          {expanded ? "−" : "+"}
        </button>
        <button
          key="select"
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={onSelect}
        >
          <div key="name" className="truncate text-sm font-medium text-foreground">{fileName(file.path)}</div>
          <div key="path" className="truncate font-mono text-[11px] text-muted-foreground">{file.path}</div>
        </button>
        <button
          key="copy"
          type="button"
          className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
          onClick={onCopy}
          title="Copy path"
          aria-label={`Copy ${file.path}`}
        >
          ⧉
        </button>
      </div>
      <div key="meta" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[11px] text-muted-foreground">
        <span key="status">{statusLabel(file.status)}</span>
        <span key="additions" className="font-mono text-emerald-700 dark:text-emerald-300">{`+${file.additions}`}</span>
        <span key="deletions" className="font-mono text-red-700 dark:text-red-300">{`-${file.deletions}`}</span>
        {warning ? <span key="warning" className="text-amber-700 dark:text-amber-300">{warning}</span> : null}
      </div>
    </div>
  );
}

// The upstream React wrapper emits React 19 key warnings for its internal slot array.
// This mounts the same Diffs custom element through the exported imperative hook.
function WorkspacePatchDiff({
  patch,
  options,
}: {
  patch: string;
  options: WorkspacePatchDiffOptions;
}) {
  const fileDiff = useMemo(() => getSingularPatch(patch), [patch]);
  const { ref } = useFileDiffInstance({
    fileDiff,
    options,
    metrics: undefined,
    lineAnnotations: undefined,
    selectedLines: undefined,
    prerenderedHTML: undefined,
    hasGutterRenderUtility: false,
    hasCustomHeader: false,
    disableWorkerPool: false,
  });

  return createElement(DIFFS_TAG_NAME, { ref });
}

function EmptyState() {
  return (
    <div className="border border-dashed border-border bg-background px-4 py-8 text-center">
      <div className="text-sm font-medium text-foreground">No workspace changes</div>
      <div className="mt-1 text-sm text-muted-foreground">
        The workspace matches its current comparison target.
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="border border-dashed border-border bg-background px-4 py-8 text-center text-sm text-muted-foreground">
      Loading workspace changes…
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="font-medium text-foreground">Unable to load workspace changes.</div>
          <div className="mt-1 text-muted-foreground">
            Retry the request or open the details below for the technical error.
          </div>
        </div>
        <button
          type="button"
          className={buttonClass(false)}
          onClick={onRetry}
          aria-label="Retry loading workspace changes"
        >
          Retry
        </button>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          Troubleshooting details
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
          {message || "No error message was provided."}
        </pre>
      </details>
    </div>
  );
}

function FileDiffPanel({
  file,
  mode,
}: {
  file: DiffFileViewModel;
  mode: DiffRenderMode;
}) {
  const warning = warningText(file);
  if (warning) {
    return (
      <div className="border border-dashed border-border bg-background px-4 py-6 text-sm text-muted-foreground">
        {warning ?? "No renderable patch is available for this file."}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {file.patches.map((patch, index) => {
        const patchWarning = patchWarningText(patch);
        return (
          <div key={`${patch.kind}:${index}`} className="overflow-hidden border border-border bg-background">
            {file.patches.length > 1 ? (
              <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{patchKindLabel(patch.kind)}</span>
                <span className="font-mono text-emerald-700 dark:text-emerald-300">{`+${patch.additions}`}</span>
                <span className="font-mono text-red-700 dark:text-red-300">{`-${patch.deletions}`}</span>
              </div>
            ) : null}
            {patchWarning || !patch.patch ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {patchWarning ?? "No renderable patch is available for this file."}
              </div>
            ) : (
              <WorkspacePatchDiff
                patch={patch.patch}
                options={{
                  diffStyle: mode,
                  overflow: "scroll",
                  disableLineNumbers: false,
                  themeType: "system",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CollapsedFilePanel({
  file,
  onExpand,
}: {
  file: DiffFileViewModel;
  onExpand: () => void;
}) {
  const title = file.longDiff ? "Large diff folded" : "Diff folded";
  const details = file.lineCount > 0
    ? `${file.lineCount.toLocaleString()} lines`
    : statusLabel(file.status);

  return (
    <div className="border border-dashed border-border bg-background px-4 py-5 text-sm text-muted-foreground">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="font-medium text-foreground">{title}</div>
          <div className="mt-1 font-mono text-xs">{details}</div>
        </div>
        <button
          type="button"
          className={buttonClass(false)}
          onClick={onExpand}
          aria-label={`Show diff for ${file.path}`}
        >
          Show file
        </button>
      </div>
    </div>
  );
}

export function ChangesTab({ context }: PluginDetailTabProps) {
  const toast = usePluginToast();
  const [mode, setMode] = useState<DiffRenderMode>("split");
  const [view, setView] = useState<DiffViewMode>(() => readInitialView());
  const [baseRef, setBaseRef] = useState(() => readInitialBaseRef());
  const baseRefTouchedRef = useRef(Boolean(baseRef.trim()));
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const fileSectionRefs = useRef(new Map<string, HTMLElement>());
  const diffScrollRef = useRef<HTMLElement | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);

  const params = useMemo(() => ({
    workspaceId: context.entityId,
    companyId: context.companyId ?? "",
    projectId: context.projectId ?? "",
    entityType: context.entityType,
    view,
    baseRef: baseRef.trim() || null,
    includeUntracked,
  }), [baseRef, context.companyId, context.entityId, context.entityType, context.projectId, includeUntracked, view]);

  const { data, loading, error, refresh } = usePluginData<WorkspaceDiffData>("workspace-diff", params);
  const files = useMemo(() => toFileViewModels(data), [data]);
  const summary = useMemo(() => diffSummary(data), [data]);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const compareLabel = `${data?.baseRef ? `base ${data.baseRef}` : "working tree"}${data?.headSha ? ` · ${data.headSha.slice(0, 12)}` : ""}`;

  const setFileSectionRef = useCallback((filePath: string) => (node: HTMLElement | null) => {
    if (node) fileSectionRefs.current.set(filePath, node);
    else fileSectionRefs.current.delete(filePath);
  }, []);

  const selectFile = useCallback((filePath: string) => {
    setSelectedPath(filePath);
    window.requestAnimationFrame(() => {
      fileSectionRefs.current.get(filePath)?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
  }, []);

  const syncSelectedPathFromScroll = useCallback(() => {
    const container = diffScrollRef.current;
    if (!container || files.length === 0) return;

    const containerTop = container.getBoundingClientRect().top;
    let nextPath = files[0]?.path ?? null;
    for (const file of files) {
      const section = fileSectionRefs.current.get(file.path);
      if (!section) continue;
      const offsetFromScrollTop = section.getBoundingClientRect().top - containerTop;
      if (offsetFromScrollTop <= 48) {
        nextPath = file.path;
      } else {
        break;
      }
    }

    if (nextPath) {
      setSelectedPath((current) => current === nextPath ? current : nextPath);
    }
  }, [files]);

  const handleDiffScroll = useCallback(() => {
    if (scrollSyncFrameRef.current !== null) return;
    scrollSyncFrameRef.current = window.requestAnimationFrame(() => {
      scrollSyncFrameRef.current = null;
      syncSelectedPathFromScroll();
    });
  }, [syncSelectedPathFromScroll]);

  useEffect(() => {
    const defaultBaseRef = data?.defaultBaseRef?.trim();
    if (!defaultBaseRef || baseRef.trim() || baseRefTouchedRef.current) return;
    setBaseRef(defaultBaseRef);
  }, [baseRef, data?.defaultBaseRef]);

  useEffect(() => {
    if (files.length === 0) {
      setExpandedFiles(new Set());
      setSelectedPath(null);
      return;
    }
    setExpandedFiles(initialExpandedFileSet(files));
    setSelectedPath((current) => files.some((file) => file.path === current) ? current : files[0]?.path ?? null);
  }, [files]);

  useEffect(() => {
    return () => {
      if (scrollSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollSyncFrameRef.current);
      }
    };
  }, []);

  const copyPath = async (filePath: string) => {
    try {
      await navigator.clipboard.writeText(filePath);
      toast({ title: "Path copied", body: filePath });
    } catch {
      toast({ title: "Copy failed", body: filePath, tone: "error" });
    }
  };

  return (
    <div className="space-y-3">
      <div key="toolbar" className="flex flex-col gap-3 border-b border-border pb-3 lg:flex-row lg:items-center lg:justify-between">
        <div key="summary" className="min-w-0">
          <div key="summary-line" className="flex flex-wrap items-center gap-2 text-sm">
            <span key="changed" className="font-medium text-foreground">{summary.changedLabel}</span>
            <span key="lines" className="font-mono text-xs text-muted-foreground">{summary.lineLabel}</span>
            {summary.truncated ? (
              <span key="truncated" className="text-xs text-amber-700 dark:text-amber-300">Truncated</span>
            ) : null}
            {summary.warningCount > 0 ? (
              <span key="warnings" className="text-xs text-muted-foreground">{summary.warningCount} warnings</span>
            ) : null}
          </div>
          <div key="compare" className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {compareLabel}
          </div>
        </div>

        <div key="actions" className="flex flex-wrap items-center gap-2">
          <div key="layout" className="inline-flex gap-1" aria-label="Diff layout">
            <button key="split" type="button" className={buttonClass(mode === "split")} onClick={() => setMode("split")}>
              Split
            </button>
            <button key="unified" type="button" className={buttonClass(mode === "unified")} onClick={() => setMode("unified")}>
              Unified
            </button>
          </div>
          <div key="view" className="inline-flex gap-1" aria-label="Diff comparison">
            <button key="working-tree" type="button" className={buttonClass(view === "working-tree")} onClick={() => setView("working-tree")}>
              Working tree
            </button>
            <button key="head" type="button" className={buttonClass(view === "head")} onClick={() => setView("head")}>
              Against ref
            </button>
          </div>
          {view === "head" ? (
            <input
              key="base-ref"
              className="h-8 w-40 rounded-md border border-border bg-background px-2.5 font-mono text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/40"
              value={baseRef}
              onChange={(event) => {
                baseRefTouchedRef.current = true;
                setBaseRef(event.target.value);
              }}
              placeholder="origin/master"
              aria-label="Base ref"
            />
          ) : null}
          {view === "working-tree" ? (
            <button
              key="untracked"
              type="button"
              className={buttonClass(includeUntracked)}
              onClick={() => setIncludeUntracked((value) => !value)}
            >
              {includeUntracked ? "Untracked shown" : "Show untracked"}
            </button>
          ) : null}
          <button
            key="refresh"
            type="button"
            className={iconButtonClass(false)}
            onClick={() => refresh()}
            title="Refresh changes"
            aria-label="Refresh changes"
          >
            <RefreshCwIcon />
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error.message} onRetry={refresh} />
      ) : files.length === 0 ? (
        <EmptyState />
      ) : (
        <div key="content" className="grid gap-3 lg:h-[70vh] lg:min-h-[560px] lg:max-h-[820px] lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside key="files" className="flex min-w-0 flex-col border border-border bg-background lg:h-full lg:overflow-hidden">
            <div key="heading" className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Files
            </div>
            <div key="list" className="max-h-[70vh] overflow-auto lg:max-h-none lg:flex-1">
              {files.map((file, index) => (
                <FileRow
                  key={`${file.path}:${index}`}
                  file={file}
                  active={file.path === selectedFile?.path}
                  expanded={expandedFiles.has(file.path)}
                  onSelect={() => selectFile(file.path)}
                  onToggle={() => setExpandedFiles((current) => nextExpandedFileSet(current, file.path))}
                  onCopy={() => void copyPath(file.path)}
                />
              ))}
            </div>
          </aside>

          <main
            key="diffs"
            ref={diffScrollRef}
            className="max-h-[70vh] min-w-0 space-y-3 overflow-auto lg:h-full lg:max-h-none lg:pr-1"
            onScroll={handleDiffScroll}
          >
            {files
              .map((file, index) => (
                <section
                  key={`${file.path}:${index}`}
                  ref={setFileSectionRef(file.path)}
                  className={file.path === selectedFile?.path ? "scroll-mt-2" : undefined}
                >
                  <div key="header" className="flex min-w-0 items-center justify-between gap-3 border border-b-0 border-border bg-muted/35 px-3 py-2">
                    <div key="left" className="flex min-w-0 items-start gap-2">
                      <button
                        key="collapse"
                        type="button"
                        className="mt-0.5 text-muted-foreground hover:text-foreground"
                        title={expandedFiles.has(file.path) ? "Collapse file" : "Expand file"}
                        aria-label={expandedFiles.has(file.path) ? `Collapse ${file.path}` : `Expand ${file.path}`}
                        onClick={() => setExpandedFiles((current) => nextExpandedFileSet(current, file.path))}
                      >
                        {expandedFiles.has(file.path) ? "−" : "+"}
                      </button>
                      <button
                        key="select"
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => selectFile(file.path)}
                      >
                        <div key="path" className="truncate text-sm font-medium">{file.path}</div>
                        {file.oldPath ? (
                          <div key="old-path" className="truncate font-mono text-[11px] text-muted-foreground">
                            from {file.oldPath}
                          </div>
                        ) : null}
                      </button>
                    </div>
                    <div key="actions" className="flex shrink-0 items-center gap-1">
                      <button
                        key="copy"
                        type="button"
                        className={iconButtonClass(false)}
                        title="Copy path"
                        aria-label={`Copy ${file.path}`}
                        onClick={() => void copyPath(file.path)}
                      >
                        ⧉
                      </button>
                    </div>
                  </div>
                  {expandedFiles.has(file.path) ? (
                    <FileDiffPanel key="diff" file={file} mode={mode} />
                  ) : (
                    <CollapsedFilePanel
                      key="collapsed"
                      file={file}
                      onExpand={() => setExpandedFiles((current) => nextExpandedFileSet(current, file.path))}
                    />
                  )}
                </section>
              ))}
          </main>
        </div>
      )}
    </div>
  );
}
