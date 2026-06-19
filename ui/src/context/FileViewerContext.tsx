import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate, type NavigateOptions } from "@/lib/router";
import type { WorkspaceFileSelector } from "@paperclipai/shared";
import type { ParsedWorkspaceFileRef } from "@/lib/workspace-file-parser";

export interface FileViewerUrlState {
  path: string;
  line: number | null;
  column: number | null;
  workspace: WorkspaceFileSelector;
  projectId: string | null;
  workspaceId: string | null;
}

export interface FileViewerContextValue {
  issueId: string;
  /** Current viewer state derived from the URL, or null if closed. */
  state: FileViewerUrlState | null;
  /** True when the sheet is in browse mode (URL carries `browse=1`). */
  browse: boolean;
  /** The active browse search query (URL `q`), or null. */
  query: string | null;
  browseProjectId: string | null;
  browseWorkspaceId: string | null;
  folderPath: string | null;
  open(
    ref: Pick<ParsedWorkspaceFileRef, "path" | "line" | "column" | "projectId" | "workspaceId"> & {
      workspace?: WorkspaceFileSelector;
    },
    opts?: {
      fromBrowse?: boolean;
      browseState?: Partial<FileViewerBrowseState>;
    },
  ): void;
  /** Open (or stay in) browse mode, optionally seeding the search query. */
  openBrowse(opts?: { q?: string }): void;
  /** Update URL-backed browse state without closing the active preview. */
  updateBrowseState(opts: Partial<FileViewerBrowseState>): void;
  openFolder(
    ref: Pick<ParsedWorkspaceFileRef, "path" | "projectId" | "workspaceId"> & {
      workspace?: WorkspaceFileSelector;
    },
  ): void;
  /** From a file opened via browse, return to the browse list. */
  backToFiles(): void;
  close(): void;
}

const FileViewerContext = createContext<FileViewerContextValue | null>(null);

export const FILE_VIEWER_NAVIGATE_OPTIONS = {
  replace: false,
  preventScrollReset: true,
} satisfies NavigateOptions;

export function readFileViewerStateFromSearch(search: string): FileViewerUrlState | null {
  const params = new URLSearchParams(search);
  const path = params.get("file");
  if (!path) return null;
  const lineRaw = params.get("line");
  const columnRaw = params.get("column");
  const workspaceRaw = params.get("workspace");
  const projectIdRaw = params.get("projectId");
  const workspaceIdRaw = params.get("workspaceId");
  const hasExplicitTarget = Boolean(projectIdRaw && workspaceIdRaw);
  const line = lineRaw ? Number.parseInt(lineRaw, 10) : NaN;
  const column = columnRaw ? Number.parseInt(columnRaw, 10) : NaN;
  const workspace = (workspaceRaw === "execution" || workspaceRaw === "project")
    ? workspaceRaw
    : "auto";
  return {
    path,
    line: Number.isFinite(line) && line > 0 ? line : null,
    column: Number.isFinite(column) && column > 0 ? column : null,
    workspace,
    projectId: hasExplicitTarget ? projectIdRaw : null,
    workspaceId: hasExplicitTarget ? workspaceIdRaw : null,
  };
}

export function writeFileViewerStateToSearch(current: string, next: FileViewerUrlState | null): string {
  const params = new URLSearchParams(current);
  // A direct file open/close is never a browse origin — clear browse params too.
  params.delete("browse");
  params.delete("q");
  params.delete("folder");
  if (!next) {
    params.delete("file");
    params.delete("line");
    params.delete("column");
    params.delete("workspace");
    params.delete("projectId");
    params.delete("workspaceId");
  } else {
    params.set("file", next.path);
    if (next.line !== null) params.set("line", String(next.line));
    else params.delete("line");
    if (next.column !== null) params.set("column", String(next.column));
    else params.delete("column");
    if (next.workspace && next.workspace !== "auto") params.set("workspace", next.workspace);
    else params.delete("workspace");
    if (next.projectId) params.set("projectId", next.projectId);
    else params.delete("projectId");
    if (next.workspaceId) params.set("workspaceId", next.workspaceId);
    else params.delete("workspaceId");
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

export interface FileViewerBrowseState {
  q: string | null;
  folderPath: string | null;
  projectId: string | null;
  workspaceId: string | null;
}

export function readBrowseStateFromSearch(search: string): FileViewerBrowseState | null {
  const params = new URLSearchParams(search);
  if (params.get("browse") !== "1") return null;
  const q = params.get("q");
  const folder = params.get("folder");
  const projectId = params.get("projectId");
  const workspaceId = params.get("workspaceId");
  return {
    q: q && q.length > 0 ? q : null,
    folderPath: folder && folder.length > 0 ? folder : null,
    projectId: projectId || null,
    workspaceId: workspaceId || null,
  };
}

export function writeFolderViewerStateToSearch(
  current: string,
  next: {
    path: string;
    projectId: string | null;
    workspaceId: string | null;
  },
): string {
  const params = new URLSearchParams(current);
  params.delete("file");
  params.delete("line");
  params.delete("column");
  params.delete("workspace");
  params.delete("q");
  params.set("browse", "1");
  params.set("folder", next.path);
  if (next.projectId) params.set("projectId", next.projectId);
  else params.delete("projectId");
  if (next.workspaceId) params.set("workspaceId", next.workspaceId);
  else params.delete("workspaceId");
  const str = params.toString();
  return str ? `?${str}` : "";
}

export function writeBrowseStateToSearch(current: string, next: Partial<FileViewerBrowseState>): string {
  const params = new URLSearchParams(current);
  params.set("browse", "1");
  if ("q" in next) {
    const q = next.q?.trim() ?? "";
    if (q) params.set("q", q);
    else params.delete("q");
  }
  if ("folderPath" in next) {
    const folderPath = next.folderPath?.trim() ?? "";
    if (folderPath) params.set("folder", folderPath);
    else params.delete("folder");
  }
  if ("projectId" in next) {
    if (next.projectId) params.set("projectId", next.projectId);
    else params.delete("projectId");
  }
  if ("workspaceId" in next) {
    if (next.workspaceId) params.set("workspaceId", next.workspaceId);
    else params.delete("workspaceId");
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

interface FileViewerProviderProps {
  issueId: string;
  children: ReactNode;
  enabled?: boolean;
}

export function FileViewerProvider({ issueId, children, enabled = true }: FileViewerProviderProps) {
  if (!enabled) return <>{children}</>;
  return <EnabledFileViewerProvider issueId={issueId}>{children}</EnabledFileViewerProvider>;
}

function EnabledFileViewerProvider({ issueId, children }: Omit<FileViewerProviderProps, "enabled">) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => readFileViewerStateFromSearch(location.search), [location.search]);
  const browseState = useMemo(() => readBrowseStateFromSearch(location.search), [location.search]);

  const navigateSearch = useCallback(
    (nextSearch: string, opts?: Partial<NavigateOptions>) => {
      if (nextSearch === location.search) return;
      navigate(
        { pathname: location.pathname, hash: location.hash, search: nextSearch },
        { ...FILE_VIEWER_NAVIGATE_OPTIONS, ...opts, state: location.state },
      );
    },
    [location.hash, location.pathname, location.state, navigate],
  );

  const open = useCallback<FileViewerContextValue["open"]>(
    (ref, opts) => {
      let nextSearch = writeFileViewerStateToSearch(location.search, {
        path: ref.path,
        line: ref.line ?? null,
        column: ref.column ?? null,
        workspace: ref.workspace ?? "auto",
        projectId: ref.projectId ?? null,
        workspaceId: ref.workspaceId ?? null,
      });
      if (opts?.fromBrowse) {
        const params = new URLSearchParams(nextSearch);
        params.set("browse", "1");
        const previousParams = new URLSearchParams(location.search);
        const prevQ = previousParams.get("q");
        const prevFolder = previousParams.get("folder");
        const nextQ = Object.prototype.hasOwnProperty.call(opts.browseState ?? {}, "q")
          ? opts.browseState?.q
          : prevQ;
        const nextFolder = Object.prototype.hasOwnProperty.call(opts.browseState ?? {}, "folderPath")
          ? opts.browseState?.folderPath
          : prevFolder;
        if (nextQ) params.set("q", nextQ);
        else params.delete("q");
        if (nextFolder) params.set("folder", nextFolder);
        else params.delete("folder");
        nextSearch = params.toString() ? `?${params.toString()}` : "";
      }
      navigateSearch(nextSearch);
    },
    [location.search, navigateSearch],
  );

  const openBrowse = useCallback<FileViewerContextValue["openBrowse"]>(
    (opts) => {
      const params = new URLSearchParams(location.search);
      params.delete("file");
      params.delete("line");
      params.delete("column");
      params.delete("folder");
      params.set("browse", "1");
      if (typeof opts?.q === "string" && opts.q.length > 0) params.set("q", opts.q);
      else params.delete("q");
      navigateSearch(params.toString() ? `?${params.toString()}` : "");
    },
    [location.search, navigateSearch],
  );

  const updateBrowseState = useCallback<FileViewerContextValue["updateBrowseState"]>(
    (opts) => {
      navigateSearch(writeBrowseStateToSearch(location.search, opts), { replace: true });
    },
    [location.search, navigateSearch],
  );

  const openFolder = useCallback<FileViewerContextValue["openFolder"]>(
    (ref) => {
      const nextSearch = writeFolderViewerStateToSearch(location.search, {
        path: ref.path,
        projectId: ref.projectId ?? null,
        workspaceId: ref.workspaceId ?? null,
      });
      navigateSearch(nextSearch);
    },
    [location.search, navigateSearch],
  );

  const backToFiles = useCallback(() => {
    const params = new URLSearchParams(location.search);
    params.delete("file");
    params.delete("line");
    params.delete("column");
    params.delete("workspace");
    params.set("browse", "1");
    navigateSearch(params.toString() ? `?${params.toString()}` : "");
  }, [location.search, navigateSearch]);

  const close = useCallback(() => {
    const params = new URLSearchParams(writeFileViewerStateToSearch(location.search, null).replace(/^\?/, ""));
    params.delete("browse");
    params.delete("q");
    params.delete("folder");
    navigateSearch(params.toString() ? `?${params.toString()}` : "");
  }, [location.search, navigateSearch]);

  const value = useMemo<FileViewerContextValue>(
    () => ({
      issueId,
      state,
      browse: browseState !== null,
      query: browseState?.q ?? null,
      browseProjectId: browseState?.projectId ?? null,
      browseWorkspaceId: browseState?.workspaceId ?? null,
      folderPath: browseState?.folderPath ?? null,
      open,
      openBrowse,
      updateBrowseState,
      openFolder,
      backToFiles,
      close,
    }),
    [issueId, state, browseState, open, openBrowse, updateBrowseState, openFolder, backToFiles, close],
  );

  return <FileViewerContext.Provider value={value}>{children}</FileViewerContext.Provider>;
}

export function useFileViewer(): FileViewerContextValue | null {
  return useContext(FileViewerContext);
}

export function useRequiredFileViewer(): FileViewerContextValue {
  const ctx = useContext(FileViewerContext);
  if (!ctx) {
    throw new Error("useRequiredFileViewer must be used within a FileViewerProvider");
  }
  return ctx;
}
