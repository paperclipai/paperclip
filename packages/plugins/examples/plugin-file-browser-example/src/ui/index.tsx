import type {
  PluginProjectSidebarItemProps,
  PluginDetailTabProps,
  PluginCommentAnnotationProps,
  PluginCommentContextMenuItemProps,
} from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { useMemo, useState, useEffect, useRef, type MouseEvent, type RefObject } from "react";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const PLUGIN_KEY = "paperclip-file-browser-example";
const FILES_TAB_SLOT_ID = "files-tab";

const editorBaseTheme = {
  "&": {
    height: "100%",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily:
      "ui-monospace, SFMono-Regular, SF Mono, Menlo, Monaco, Consolas, Liberation Mono, monospace",
    fontSize: "13px",
    lineHeight: "1.6",
  },
  ".cm-content": {
    padding: "12px 14px 18px",
  },
};

const editorDarkTheme = EditorView.theme({
  ...editorBaseTheme,
  "&": {
    ...editorBaseTheme["&"],
    backgroundColor: "oklch(0.23 0.02 255)",
    color: "oklch(0.93 0.01 255)",
  },
  ".cm-gutters": {
    backgroundColor: "oklch(0.25 0.015 255)",
    color: "oklch(0.74 0.015 255)",
    borderRight: "1px solid oklch(0.34 0.01 255)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "oklch(0.30 0.012 255 / 0.55)",
  },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "oklch(0.42 0.02 255 / 0.45)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "oklch(0.47 0.025 255 / 0.5)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "oklch(0.93 0.01 255)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "oklch(0.37 0.015 255 / 0.5)",
    color: "oklch(0.95 0.01 255)",
    outline: "none",
  },
  ".cm-nonmatchingBracket": {
    color: "oklch(0.70 0.08 24)",
  },
}, { dark: true });

const editorLightTheme = EditorView.theme({
  ...editorBaseTheme,
  "&": {
    ...editorBaseTheme["&"],
    backgroundColor: "color-mix(in oklab, var(--card) 92%, var(--background))",
    color: "var(--foreground)",
  },
  ".cm-content": {
    ...editorBaseTheme[".cm-content"],
    caretColor: "var(--foreground)",
  },
  ".cm-gutters": {
    backgroundColor: "color-mix(in oklab, var(--card) 96%, var(--background))",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklab, var(--accent) 52%, transparent)",
  },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--accent) 72%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--accent) 84%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "color-mix(in oklab, var(--foreground) 88%, transparent)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in oklab, var(--accent) 45%, transparent)",
    color: "var(--foreground)",
    outline: "none",
  },
  ".cm-nonmatchingBracket": {
    color: "var(--destructive)",
  },
});

const editorDarkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "oklch(0.78 0.025 265)" },
  { tag: [tags.name, tags.variableName], color: "oklch(0.88 0.01 255)" },
  { tag: [tags.string, tags.special(tags.string)], color: "oklch(0.80 0.02 170)" },
  { tag: [tags.number, tags.bool, tags.null], color: "oklch(0.79 0.02 95)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "oklch(0.64 0.01 255)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "oklch(0.84 0.018 220)" },
  { tag: [tags.typeName, tags.className], color: "oklch(0.82 0.02 245)" },
  { tag: [tags.operator, tags.punctuation], color: "oklch(0.77 0.01 255)" },
  { tag: [tags.invalid, tags.deleted], color: "oklch(0.70 0.08 24)" },
]);

const editorLightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "oklch(0.45 0.07 270)" },
  { tag: [tags.name, tags.variableName], color: "oklch(0.28 0.01 255)" },
  { tag: [tags.string, tags.special(tags.string)], color: "oklch(0.45 0.06 165)" },
  { tag: [tags.number, tags.bool, tags.null], color: "oklch(0.48 0.08 90)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "oklch(0.53 0.01 255)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "oklch(0.42 0.07 220)" },
  { tag: [tags.typeName, tags.className], color: "oklch(0.40 0.06 245)" },
  { tag: [tags.operator, tags.punctuation], color: "oklch(0.36 0.01 255)" },
  { tag: [tags.invalid, tags.deleted], color: "oklch(0.55 0.16 24)" },
]);

type Workspace = { id: string; projectId: string; name: string; path: string; isPrimary: boolean };
type FileEntry = { name: string; path: string; isDirectory: boolean };
type FileTreeNodeProps = {
  entry: FileEntry;
  companyId: string | null;
  projectId: string;
  workspaceId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth?: number;
};

const PathLikePattern = /[\\/]/;
const WindowsDrivePathPattern = /^[A-Za-z]:[\\/]/;
const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isLikelyPath(pathValue: string): boolean {
  const trimmed = pathValue.trim();
  return PathLikePattern.test(trimmed) || WindowsDrivePathPattern.test(trimmed);
}

function workspaceLabel(workspace: Workspace): string {
  const pathLabel = workspace.path.trim();
  const nameLabel = workspace.name.trim();
  const hasPathLabel = isLikelyPath(pathLabel) && !UuidPattern.test(pathLabel);
  const hasNameLabel = nameLabel.length > 0 && !UuidPattern.test(nameLabel);
  const baseLabel = hasPathLabel ? pathLabel : hasNameLabel ? nameLabel : "";
  if (!baseLabel) {
    return workspace.isPrimary ? "(no workspace path) (primary)" : "(no workspace path)";
  }

  return workspace.isPrimary ? `${baseLabel} (primary)` : baseLabel;
}

function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpointPx : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, [breakpointPx]);

  return isMobile;
}

function useIsDarkMode(): boolean {
  const [isDarkMode, setIsDarkMode] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const update = () => setIsDarkMode(root.classList.contains("dark"));
    update();

    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDarkMode;
}

function useAvailableHeight(
  ref: RefObject<HTMLElement | null>,
  options?: { bottomPadding?: number; minHeight?: number },
): number | null {
  const bottomPadding = options?.bottomPadding ?? 24;
  const minHeight = options?.minHeight ?? 384;
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const update = () => {
      const element = ref.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const nextHeight = Math.max(minHeight, Math.floor(window.innerHeight - rect.top - bottomPadding));
      setHeight(nextHeight);
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => update())
      : null;
    if (observer && ref.current) observer.observe(ref.current);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      observer?.disconnect();
    };
  }, [bottomPadding, minHeight, ref]);

  return height;
}

function FileTreeNode({
  entry,
  companyId,
  projectId,
  workspaceId,
  selectedPath,
  onSelect,
  depth = 0,
}: FileTreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isSelected = selectedPath === entry.path;

  if (entry.isDirectory) {
    return (
      <li>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-none px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent/60"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setIsExpanded((value) => !value)}
          aria-expanded={isExpanded}
        >
          <span className="w-3 text-xs text-muted-foreground">{isExpanded ? "▾" : "▸"}</span>
          <span className="truncate font-medium">{entry.name}</span>
        </button>
        {isExpanded ? (
          <ExpandedDirectoryChildren
            directoryPath={entry.path}
            companyId={companyId}
            projectId={projectId}
            workspaceId={workspaceId}
            selectedPath={selectedPath}
            onSelect={onSelect}
            depth={depth}
          />
        ) : null}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={`block w-full rounded-none px-2 py-1.5 text-left text-sm transition-colors ${
          isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
        onClick={() => onSelect(entry.path)}
      >
        <span className="truncate">{entry.name}</span>
      </button>
    </li>
  );
}

function ExpandedDirectoryChildren({
  directoryPath,
  companyId,
  projectId,
  workspaceId,
  selectedPath,
  onSelect,
  depth,
}: {
  directoryPath: string;
  companyId: string | null;
  projectId: string;
  workspaceId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth: number;
}) {
  const { data: childData } = usePluginData<{ entries: FileEntry[] }>("fileList", {
    companyId,
    projectId,
    workspaceId,
    directoryPath,
  });
  const children = childData?.entries ?? [];

  if (children.length === 0) {
    return null;
  }

  return (
    <ul className="space-y-0.5">
      {children.map((child) => (
        <FileTreeNode
          key={child.path}
          entry={child}
          companyId={companyId}
          projectId={projectId}
          workspaceId={workspaceId}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </ul>
  );
}

/**
 * Project sidebar item: link "Files" that opens the project detail with the Files plugin tab.
 */
export function FilesLink({ context }: PluginProjectSidebarItemProps) {
  const { data: config, loading: configLoading } = usePluginData<PluginConfig>("plugin-config", {});
  const showFilesInSidebar = config?.showFilesInSidebar ?? false;

  if (configLoading || !showFilesInSidebar) {
    return null;
  }

  const projectId = context.entityId;
  const projectRef = (context as PluginProjectSidebarItemProps["context"] & { projectRef?: string | null })
    .projectRef
    ?? projectId;
  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  const tabValue = `plugin:${PLUGIN_KEY}:${FILES_TAB_SLOT_ID}`;
  const href = `${prefix}/projects/${projectRef}?tab=${encodeURIComponent(tabValue)}`;
  const isActive = typeof window !== "undefined" && (() => {
    const pathname = window.location.pathname.replace(/\/+$/, "");
    const segments = pathname.split("/").filter(Boolean);
    const projectsIndex = segments.indexOf("projects");
    const activeProjectRef = projectsIndex >= 0 ? segments[projectsIndex + 1] ?? null : null;
    const activeTab = new URLSearchParams(window.location.search).get("tab");
    if (activeTab !== tabValue) return false;
    if (!activeProjectRef) return false;
    return activeProjectRef === projectId || activeProjectRef === projectRef;
  })();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.altKey
      || event.shiftKey
    ) {
      return;
    }

    event.preventDefault();
    window.history.pushState({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      aria-current={isActive ? "page" : undefined}
      className={`block px-3 py-1 text-[12px] truncate transition-colors ${
        isActive
          ? "bg-accent text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
      }`}
    >
      Files
    </a>
  );
}

/**
 * Project detail tab: workspace selector, file tree, and CodeMirror editor.
 */
export function FilesTab({ context }: PluginDetailTabProps) {
  const companyId = context.companyId;
  const projectId = context.entityId;
  const isMobile = useIsMobile();
  const isDarkMode = useIsDarkMode();
  const panesRef = useRef<HTMLDivElement | null>(null);
  const availableHeight = useAvailableHeight(panesRef, {
    bottomPadding: isMobile ? 16 : 24,
    minHeight: isMobile ? 320 : 420,
  });
  const { data: workspacesData } = usePluginData<Workspace[]>("workspaces", {
    projectId,
    companyId,
  });
  const workspaces = workspacesData ?? [];
  const workspaceSelectKey = workspaces.map((w) => `${w.id}:${workspaceLabel(w)}`).join("|");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const resolvedWorkspaceId = workspaceId ?? workspaces[0]?.id ?? null;
  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === resolvedWorkspaceId) ?? null,
    [workspaces, resolvedWorkspaceId],
  );

  const fileListParams = useMemo(
    () => (selectedWorkspace ? { projectId, companyId, workspaceId: selectedWorkspace.id } : {}),
    [companyId, projectId, selectedWorkspace],
  );
  const { data: fileListData, loading: fileListLoading } = usePluginData<{ entries: FileEntry[] }>(
    "fileList",
    fileListParams,
  );
  const entries = fileListData?.entries ?? [];

  // Track the `?file=` query parameter across navigations (popstate).
  const [urlFilePath, setUrlFilePath] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("file") || null;
  });
  const lastConsumedFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onNav = () => {
      const next = new URLSearchParams(window.location.search).get("file") || null;
      setUrlFilePath(next);
    };
    window.addEventListener("popstate", onNav);
    return () => window.removeEventListener("popstate", onNav);
  }, []);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  useEffect(() => {
    setSelectedPath(null);
    setMobileView("browser");
    lastConsumedFileRef.current = null;
  }, [selectedWorkspace?.id]);

  // When a file path appears (or changes) in the URL and workspace is ready, select it.
  useEffect(() => {
    if (!urlFilePath || !selectedWorkspace) return;
    if (lastConsumedFileRef.current === urlFilePath) return;
    lastConsumedFileRef.current = urlFilePath;
    setSelectedPath(urlFilePath);
    setMobileView("editor");
  }, [urlFilePath, selectedWorkspace]);

  const fileContentParams = useMemo(
    () =>
      selectedPath && selectedWorkspace
        ? { projectId, companyId, workspaceId: selectedWorkspace.id, filePath: selectedPath }
        : null,
    [companyId, projectId, selectedWorkspace, selectedPath],
  );
  const fileContentResult = usePluginData<{ content: string | null; error?: string }>(
    "fileContent",
    fileContentParams ?? {},
  );
  const { data: fileContentData, refresh: refreshFileContent } = fileContentResult;
  const writeFile = usePluginAction("writeFile");
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const loadedContentRef = useRef("");
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"browser" | "editor">("browser");

  useEffect(() => {
    if (!editorRef.current) return;
    const content = fileContentData?.content ?? "";
    loadedContentRef.current = content;
    setIsDirty(false);
    setSaveMessage(null);
    setSaveError(null);
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
    const view = new EditorView({
      doc: content,
      extensions: [
        basicSetup,
        javascript(),
        isDarkMode ? editorDarkTheme : editorLightTheme,
        syntaxHighlighting(isDarkMode ? editorDarkHighlightStyle : editorLightHighlightStyle),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const nextValue = update.state.doc.toString();
          setIsDirty(nextValue !== loadedContentRef.current);
          setSaveMessage(null);
          setSaveError(null);
        }),
      ],
      parent: editorRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [fileContentData?.content, selectedPath, isDarkMode]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }
      if (!selectedWorkspace || !selectedPath || !isDirty || isSaving) {
        return;
      }
      event.preventDefault();
      void handleSave();
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [selectedWorkspace, selectedPath, isDirty, isSaving]);

  async function handleSave() {
    if (!selectedWorkspace || !selectedPath || !viewRef.current) {
      return;
    }
    const content = viewRef.current.state.doc.toString();
    setIsSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await writeFile({
        projectId,
        companyId,
        workspaceId: selectedWorkspace.id,
        filePath: selectedPath,
        content,
      });
      loadedContentRef.current = content;
      setIsDirty(false);
      setSaveMessage("Saved");
      refreshFileContent();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <label className="text-sm font-medium text-muted-foreground">Workspace</label>
        <select
          key={workspaceSelectKey}
          className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={resolvedWorkspaceId ?? ""}
          onChange={(e) => setWorkspaceId(e.target.value || null)}
        >
          {workspaces.map((w) => {
            const label = workspaceLabel(w);
            return (
              <option key={`${w.id}:${label}`} value={w.id} label={label} title={label}>
                {label}
              </option>
            );
          })}
        </select>
      </div>

      <div
        ref={panesRef}
        className="min-h-0"
        style={{
          display: isMobile ? "block" : "grid",
          gap: "1rem",
          gridTemplateColumns: isMobile ? undefined : "320px minmax(0, 1fr)",
          height: availableHeight ? `${availableHeight}px` : undefined,
          minHeight: isMobile ? "20rem" : "26rem",
        }}
      >
        <div
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
          style={{ display: isMobile && mobileView === "editor" ? "none" : "flex" }}
        >
          <div className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
            File Tree
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {selectedWorkspace ? (
              fileListLoading ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">Loading files...</p>
              ) : entries.length > 0 ? (
                <ul className="space-y-0.5">
                  {entries.map((entry) => (
                    <FileTreeNode
                      key={entry.path}
                      entry={entry}
                      companyId={companyId}
                      projectId={projectId}
                      workspaceId={selectedWorkspace.id}
                      selectedPath={selectedPath}
                      onSelect={(path) => {
                        setSelectedPath(path);
                        setMobileView("editor");
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-3 text-sm text-muted-foreground">No files found in this workspace.</p>
              )
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">Select a workspace to browse files.</p>
            )}
          </div>
        </div>
        <div
          className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
          style={{ display: isMobile && mobileView === "browser" ? "none" : "flex" }}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
            <div className="min-w-0">
              <button
                type="button"
                className="mb-2 inline-flex rounded-md border border-input bg-background px-2 py-1 text-xs font-medium text-muted-foreground"
                style={{ display: isMobile ? "inline-flex" : "none" }}
                onClick={() => setMobileView("browser")}
              >
                Back to files
              </button>
              <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Editor</div>
              <div className="truncate text-sm text-foreground">{selectedPath ?? "No file selected"}</div>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!selectedWorkspace || !selectedPath || !isDirty || isSaving}
                onClick={() => void handleSave()}
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          {isDirty || saveMessage || saveError ? (
            <div className="border-b border-border px-4 py-2 text-xs">
              {saveError ? (
                <span className="text-destructive">{saveError}</span>
              ) : saveMessage ? (
                <span className="text-emerald-600">{saveMessage}</span>
              ) : (
                <span className="text-muted-foreground">Unsaved changes</span>
              )}
            </div>
          ) : null}
          {selectedPath && fileContentData?.error && fileContentData.error !== "Missing file context" ? (
            <div className="border-b border-border px-4 py-2 text-xs text-destructive">{fileContentData.error}</div>
          ) : null}
          <div ref={editorRef} className="min-h-0 flex-1 overflow-auto overscroll-contain" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comment Annotation: renders detected file links below each comment
// ---------------------------------------------------------------------------

type PluginConfig = {
  showFilesInSidebar?: boolean;
  commentAnnotationMode: "annotation" | "contextMenu" | "both" | "none";
};

/**
 * Per-comment annotation showing file-path-like links extracted from the
 * comment body. Each link navigates to the project Files tab with the
 * matching path pre-selected.
 *
 * Respects the `commentAnnotationMode` instance config — hidden when mode
 * is `"contextMenu"` or `"none"`.
 */
function buildFileBrowserHref(prefix: string, projectId: string | null, filePath: string): string {
  if (!projectId) return "#";
  const tabValue = `plugin:${PLUGIN_KEY}:${FILES_TAB_SLOT_ID}`;
  return `${prefix}/projects/${projectId}?tab=${encodeURIComponent(tabValue)}&file=${encodeURIComponent(filePath)}`;
}

function navigateToFileBrowser(href: string, event: MouseEvent<HTMLAnchorElement>) {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.altKey
    || event.shiftKey
  ) {
    return;
  }
  event.preventDefault();
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function CommentFileLinks({ context }: PluginCommentAnnotationProps) {
  const { data: config } = usePluginData<PluginConfig>("plugin-config", {});
  const mode = config?.commentAnnotationMode ?? "both";

  const { data } = usePluginData<{ links: string[] }>("comment-file-links", {
    commentId: context.entityId,
    issueId: context.parentEntityId,
    companyId: context.companyId,
  });

  if (mode === "contextMenu" || mode === "none") return null;
  if (!data?.links?.length) return null;

  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  const projectId = context.projectId;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Files:</span>
      {data.links.map((link) => {
        const href = buildFileBrowserHref(prefix, projectId, link);
        return (
          <a
            key={link}
            href={href}
            onClick={(e) => navigateToFileBrowser(href, e)}
            className="inline-flex items-center rounded-md border border-border bg-accent/30 px-1.5 py-0.5 text-xs font-mono text-primary hover:bg-accent/60 hover:underline transition-colors"
            title={`Open ${link} in file browser`}
          >
            {link}
          </a>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comment Context Menu Item: "Open in Files" action per comment
// ---------------------------------------------------------------------------

/**
 * Per-comment context menu item that appears in the comment "more" (⋮) menu.
 * Extracts file paths from the comment body and, if any are found, renders
 * a button to open the first file in the project Files tab.
 *
 * Respects the `commentAnnotationMode` instance config — hidden when mode
 * is `"annotation"` or `"none"`.
 */
export function CommentOpenFiles({ context }: PluginCommentContextMenuItemProps) {
  const { data: config } = usePluginData<PluginConfig>("plugin-config", {});
  const mode = config?.commentAnnotationMode ?? "both";

  const { data } = usePluginData<{ links: string[] }>("comment-file-links", {
    commentId: context.entityId,
    issueId: context.parentEntityId,
    companyId: context.companyId,
  });

  if (mode === "annotation" || mode === "none") return null;
  if (!data?.links?.length) return null;

  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  const projectId = context.projectId;

  return (
    <div>
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Files
      </div>
      {data.links.map((link) => {
        const href = buildFileBrowserHref(prefix, projectId, link);
        const fileName = link.split("/").pop() ?? link;
        return (
          <a
            key={link}
            href={href}
            onClick={(e) => navigateToFileBrowser(href, e)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs text-foreground hover:bg-accent transition-colors"
            title={`Open ${link} in file browser`}
          >
            <span className="truncate font-mono">{fileName}</span>
          </a>
        );
      })}
    </div>
  );
}
