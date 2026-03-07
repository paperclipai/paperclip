import { api } from "./client";

/** A single entry (file or directory) returned by the list endpoint. */
export interface FileEntry {
  /** File or directory name (not a full path). */
  name: string;
  /** `"file"` for regular files; `"directory"` for directories. */
  type: "file" | "directory";
  /** Size in bytes for files; `null` for directories. */
  size: number | null;
  /** ISO 8601 last-modified timestamp, or `null` if unavailable. */
  modified: string | null;
}

/** Response shape for the list-directory endpoint. */
export interface DirectoryListing {
  /** The relative path that was listed (as supplied by the caller). */
  path: string;
  /** Directory entries. Not sorted — callers should sort as needed. */
  items: FileEntry[];
}

/** Response shape for the read-file endpoint. */
export interface FileContent {
  /** Relative path of the file within the workspace. */
  path: string;
  /** UTF-8 text content of the file. */
  content: string;
}

/** Response shape for the write-file endpoint. */
export interface WriteResult {
  /** Relative path of the written file. */
  path: string;
  /** Size of the written file in bytes. */
  size: number;
  /** ISO 8601 last-modified timestamp after the write. */
  modified: string;
}

/** Response shape for the rename/move endpoint. */
export interface RenameResult {
  /** Original relative path of the file or directory. */
  oldPath: string;
  /** New relative path of the file or directory. */
  newPath: string;
}

/** Response shape for the git-info endpoint. */
export interface GitInfo {
  /** Current branch name, or `null` if not a git repo. */
  branch: string | null;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean;
}

/** Response shape for the delete endpoint. */
export interface DeleteResult {
  /** Relative path of the deleted file or directory. */
  path: string;
  /** Always `true`; signals a successful deletion. */
  deleted: true;
}

/** Returns the base API path for file operations on a given workspace. */
function filesBasePath(workspaceId: string) {
  return `/workspaces/${encodeURIComponent(workspaceId)}/files`;
}

/**
 * API client for workspace file-system operations.
 *
 * All paths are relative to the workspace root directory on the server.
 */
export const workspaceFilesApi = {
  /** Lists the contents of a directory within the workspace. Defaults to root ("." ). */
  list: (workspaceId: string, path: string = ".") =>
    api.get<DirectoryListing>(
      `${filesBasePath(workspaceId)}?path=${encodeURIComponent(path)}`,
    ),

  /** Reads a file's content as a UTF-8 string. */
  read: (workspaceId: string, path: string) =>
    api.get<FileContent>(
      `${filesBasePath(workspaceId)}/read?path=${encodeURIComponent(path)}`,
    ),

  /** Creates or overwrites a file with the provided text content. */
  write: (workspaceId: string, path: string, content: string) =>
    api.post<WriteResult>(`${filesBasePath(workspaceId)}/write`, {
      path,
      content,
    }),

  /** Creates a directory (and any missing parent directories). Idempotent. */
  mkdir: (workspaceId: string, path: string) =>
    api.post<{ path: string }>(`${filesBasePath(workspaceId)}/mkdir`, { path }),

  /** Deletes a file or directory (directories are deleted recursively). */
  delete: (workspaceId: string, path: string) =>
    api.delete<DeleteResult>(
      `${filesBasePath(workspaceId)}?path=${encodeURIComponent(path)}`,
    ),

  /** Renames or moves a file or directory within the workspace. */
  rename: (workspaceId: string, oldPath: string, newPath: string) =>
    api.post<RenameResult>(`${filesBasePath(workspaceId)}/rename`, {
      oldPath,
      newPath,
    }),

  /** Returns basic git info (branch, dirty status) for the workspace. */
  gitInfo: (workspaceId: string) =>
    api.get<GitInfo>(`${filesBasePath(workspaceId)}/git-info`),

  /** Returns a URL that downloads a single file as an attachment. */
  downloadUrl: (workspaceId: string, filePath: string) =>
    `/api${filesBasePath(workspaceId)}/download?path=${encodeURIComponent(filePath)}`,

  /** Returns a URL that downloads a directory as a ZIP archive. */
  downloadZipUrl: (workspaceId: string, dirPath: string = ".") =>
    `/api${filesBasePath(workspaceId)}/download-zip?path=${encodeURIComponent(dirPath)}`,
};
