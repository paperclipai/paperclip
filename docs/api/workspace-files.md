---
title: Workspace Files
summary: Browse and manage files within a workspace directory
---

The workspace file API lets you list, read, write, rename, and delete files within a workspace's directory. All paths are relative to the workspace root, which is the `cwd` field of the workspace. Requests that would escape the workspace root are rejected.

Workspace IDs are returned by the [Workspaces](/api/workspaces) endpoints. Create a workspace first, then use its `id` here to read and write files within its `cwd` directory.

> **Note:** The workspace must have a `cwd` (local directory path) set. Workspaces that only have a `repoUrl` without a `cwd` cannot be used with the file API — requests will return `404`.

## Authentication

All endpoints require authentication. The caller must have access to the company that owns the workspace's project.

## List Directory Contents

```
GET /api/workspaces/{workspaceId}/files?path={relativePath}
```

Returns the contents of a directory within the workspace.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `workspaceId` | ID of the workspace |

**Query Parameters**

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `path` | No | `.` (workspace root) | Relative path to the directory |

**Response**

```json
{
  "path": "src",
  "items": [
    {
      "name": "index.ts",
      "type": "file",
      "size": 1024,
      "modified": "2024-01-15T10:30:00.000Z"
    },
    {
      "name": "components",
      "type": "directory",
      "size": null,
      "modified": "2024-01-14T08:00:00.000Z"
    }
  ]
}
```

- `type` is either `"file"` or `"directory"`
- `size` is in bytes for files, `null` for directories
- `modified` is an ISO 8601 timestamp

**Errors**

| Code | Reason |
|------|--------|
| `400` | Path is outside workspace root |
| `400` | Path is not a directory |
| `404` | Workspace not found |
| `404` | Path does not exist |

## Read File

```
GET /api/workspaces/{workspaceId}/files/read?path={relativePath}
```

Returns the text content of a file as a UTF-8 string.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `workspaceId` | ID of the workspace |

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Relative path to the file |

**Response**

```json
{
  "path": "src/index.ts",
  "content": "export default function main() { ... }"
}
```

Note: Files are read as UTF-8 text. Binary files (images, compiled assets, etc.) should not be read with this endpoint.

**Errors**

| Code | Reason |
|------|--------|
| `400` | `path` query parameter not provided |
| `400` | Path is outside workspace root |
| `400` | Path is not a file |
| `404` | Workspace not found |
| `404` | File does not exist |

## Write File

```
POST /api/workspaces/{workspaceId}/files/write
```

Creates or overwrites a file with text content. Parent directories are created automatically if they do not exist.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `workspaceId` | ID of the workspace |

**Request Body**

```json
{
  "path": "src/utils/helper.ts",
  "content": "export function helper() { ... }"
}
```

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `path` | Yes | string | Relative path to the file |
| `content` | Yes | string | Text content to write. Must be a string. Pass an empty string `""` to create or truncate a file. |

**Response**

```json
{
  "path": "src/utils/helper.ts",
  "size": 512,
  "modified": "2024-01-15T10:35:00.000Z"
}
```

**Errors**

| Code | Reason |
|------|--------|
| `400` | `path` or `content` missing from request body |
| `400` | `content` is not a string |
| `400` | Path is outside workspace root |
| `404` | Workspace not found |

## Create Directory

```
POST /api/workspaces/{workspaceId}/files/mkdir
```

Creates a directory. Intermediate directories are created automatically (equivalent to `mkdir -p`). Succeeds silently if the directory already exists.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `workspaceId` | ID of the workspace |

**Request Body**

```json
{
  "path": "src/utils/helpers"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | Relative path of the directory to create |

**Response**

```json
{
  "path": "src/utils/helpers"
}
```

**Errors**

| Code | Reason |
|------|--------|
| `400` | `path` missing from request body |
| `400` | Path is outside workspace root |
| `404` | Workspace not found |

## Delete File or Directory

```
DELETE /api/workspaces/{workspaceId}/files?path={relativePath}
```

Deletes a file or directory. Directory deletion is recursive — all contents are removed.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `workspaceId` | ID of the workspace |

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Relative path to the file or directory |

**Response**

```json
{
  "path": "src/old-file.ts",
  "deleted": true
}
```

**Errors**

| Code | Reason |
|------|--------|
| `400` | `path` query parameter not provided |
| `400` | Path is outside workspace root |
| `404` | Workspace not found |
| `404` | Path does not exist |

## Rename or Move

```
POST /api/workspaces/{workspaceId}/files/rename
```

Renames or moves a file or directory. The destination's parent directory is created automatically if it does not exist. If a file already exists at `newPath`, it will be overwritten.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `workspaceId` | ID of the workspace |

**Request Body**

```json
{
  "oldPath": "src/old-name.ts",
  "newPath": "src/new-name.ts"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `oldPath` | Yes | Relative path of the source file or directory |
| `newPath` | Yes | Relative path of the destination |

**Response**

```json
{
  "oldPath": "src/old-name.ts",
  "newPath": "src/new-name.ts"
}
```

**Errors**

| Code | Reason |
|------|--------|
| `400` | `oldPath` or `newPath` missing from request body |
| `400` | Either path is outside workspace root |
| `404` | Workspace not found |
| `404` | Source path does not exist |

## UI: File Editor

The Paperclip board UI integrates a [CodeMirror 6](https://codemirror.net/) editor in the Workspace Detail page (Overview tab). When a user selects a file in the file tree, the UI calls the **Read File** endpoint and loads the content into the editor. When the user saves (via the Save button or **Ctrl+S** / **Cmd+S**), the UI calls the **Write File** endpoint with the updated buffer.

### Editor Features

| Feature | Behaviour |
|---------|-----------|
| Syntax highlighting | Detected automatically from the file extension (JS/TS/JSX/TSX, HTML, CSS/SCSS/Sass/Less, JSON, Markdown, Python) |
| Line numbers | Always shown |
| Code folding | Available via gutter arrows and keyboard shortcuts |
| Search / Replace | **Ctrl+F** / **Cmd+F** opens an inline search panel |
| Save shortcut | **Ctrl+S** / **Cmd+S** submits the current buffer to the Write File endpoint |
| Unsaved indicator | A "Unsaved changes" badge appears in the toolbar whenever the buffer differs from the last-loaded content |
| Read-only mode | Automatically activated for files larger than 500 KB; a warning banner is shown |
| Binary / very large files | Files detected as binary (null bytes or >10% non-printable characters) or larger than 1 MB are not displayed in the editor; a fallback message is shown instead |

### File Size Behaviour

| File size | Editor behaviour |
|-----------|-----------------|
| < 500 KB | Normal editable mode |
| 500 KB – 1 MB | Read-only mode with a size warning banner |
| > 1 MB | Fallback UI ("Binary or very large file") — no editor shown |

## UI: File Tree CRUD Operations

The file tree sidebar (left panel of the Workspace Detail page) supports full CRUD operations for files and folders, all triggered from the UI without leaving the page.

### Create File

1. Click the **New File** button (file-plus icon) in the file tree header.
2. A modal dialog opens prompting for a file name.
3. Enter the name (e.g. `index.ts`) and click **Create** or press **Enter**.
4. The UI calls the **Write File** endpoint with an empty `content` string to create the file.
5. On success: the file tree refreshes, a success toast notification appears, and the new file opens automatically in the editor.
6. On error: an error message is shown inside the dialog and an error toast appears.

### Create Folder

1. Click the **New Folder** button (folder-plus icon) in the file tree header.
2. A modal dialog opens prompting for a folder name.
3. Enter the name (e.g. `components`) and click **Create** or press **Enter**.
4. The UI calls the **Create Directory** endpoint.
5. On success: the file tree refreshes and a success toast appears.
6. On error: an error message is shown inside the dialog and an error toast appears.

### Rename

1. Hover over a file or folder row to reveal the **⋯** action menu.
2. Click **Rename** to switch the row label to an inline text input.
3. Edit the name and press **Enter** to confirm, or **Escape** to cancel.
4. The UI calls the **Rename or Move** endpoint with the same parent directory and the new name.
5. On success: the file tree refreshes and a success toast appears.
6. On error: an error toast appears and the inline input is dismissed.

> **Note:** Renaming always keeps the item in the same directory. To move a file to a different directory, use the API directly.

### Delete

1. Hover over a file or folder row to reveal the **⋯** action menu.
2. Click **Delete** to open a confirmation dialog.
3. The dialog names the item and warns that directory deletion removes all contents.
4. Click **Delete** in the dialog to confirm. A spinner replaces the button while the request is in flight.
5. The UI calls the **Delete File or Directory** endpoint.
6. On success: the dialog closes, the file tree refreshes, and a success toast appears.
7. On error: an error toast appears; the dialog closes (the item remains).

### Toast Notifications

All file tree operations display a toast notification in the bottom-right corner of the screen:

| Operation | Success toast | Error toast |
|-----------|--------------|-------------|
| Create file | "File created" + filename | "Failed to create file" |
| Create folder | "Folder created" + folder name | "Failed to create folder" |
| Rename file | "File renamed" | "Failed to rename file" |
| Rename folder | "Folder renamed" | "Failed to rename folder" |
| Delete file | "File deleted" + filename | "Failed to delete file" |
| Delete folder | "Folder deleted" + folder name | "Failed to delete folder" |
| Save file (editor) | "File saved" + path | "Failed to save file" |

Toasts dismiss automatically after a few seconds. Identical toasts emitted within a short window are deduplicated (only one toast is shown).

### File Tree Refresh

After each successful CRUD operation the UI invalidates only the React Query cache entry for the **immediate parent directory** of the affected item. This means:

- Only the changed directory listing is re-fetched from the server.
- Sibling directories and unrelated paths are not re-fetched.
- The editor content for open files is not affected by tree operations.

## Security

All paths are validated before any filesystem operation is performed:

- **Directory traversal prevention** — any path that resolves outside the workspace root (e.g. using `../` sequences or absolute paths such as `/etc/passwd`) is rejected with `400 Bad Request`.
- **Workspace root protection** — operations that target the workspace root directory itself (e.g. `path=.`) are rejected with `400 Bad Request` on all mutating endpoints (write, mkdir, delete, rename). Listing the root directory via `GET /files` without a `path` parameter (or with `path=.`) is still permitted.
- **No symlink escape** — path resolution uses `path.resolve`, which follows the POSIX lexical resolution rules. Symbolic links that point outside the workspace root are not blocked by this check; avoid untrusted symlinks in workspace directories.

## Limitations

- **Text only** — the read and write endpoints operate on UTF-8 text. Binary files (images, compiled assets, archives) should not be accessed through these endpoints.
- **No streaming** — file content is returned inline in the JSON response body; very large files may impact response size.
- **Recursive delete** — directory deletion via `DELETE` is irreversible and removes all contents.
