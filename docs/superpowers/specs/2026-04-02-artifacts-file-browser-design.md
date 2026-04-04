# Artifacts & File Browser Design Spec

## Problem

When agents produce files and documents in Paperclip, those outputs are scattered across individual issue conversations. With many issues and agents running, users lose track of what was produced, where it lives, and how to retrieve it. There is no company-wide view of all agent-produced artifacts.

## Solution

A company-wide file browser with a hybrid folder structure: files are auto-organized into project/issue folders by default, with support for custom paths. A new top-level "Artifacts" page in the sidebar gives users a two-panel file explorer with inline previews.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Folder structure | Hybrid (auto + custom) | Auto-organized covers 90% of cases; custom paths handle cross-cutting files |
| Navigation | Top-level sidebar item | Findability is the primary pain point — needs to be front-and-center |
| UI layout | Two-panel + expandable preview | Folder tree left, file list right, click to expand inline preview |
| File types | All (text, code, images, PDFs, HTML) | Agents produce diverse outputs |
| Actors | Both agents and humans | Primarily agent output, but humans can upload/create/organize |
| Native access | "Open in Finder" action | Quick access to files on local disk |

## Data Model

### New table: `artifact_folders`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `companyId` | uuid | FK → companies |
| `parentId` | uuid, nullable | FK → artifact_folders (self-referencing) |
| `name` | text | Folder display name |
| `path` | text | Materialized path, e.g. `/reports/weekly/` |
| `sourceType` | enum, nullable | `"project"` \| `"issue"` \| `"custom"` |
| `sourceId` | uuid, nullable | FK to the project/issue that auto-generated this folder |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

Indexes: `(companyId, path)` unique, `(companyId, parentId)`, `(companyId, sourceType, sourceId)`.

### New table: `artifacts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `companyId` | uuid | FK → companies |
| `folderId` | uuid | FK → artifact_folders |
| `assetId` | uuid | FK → existing assets table (actual file storage) |
| `title` | text | Display name |
| `description` | text, nullable | Optional description |
| `mimeType` | text | Content type |
| `issueId` | uuid, nullable | Back-link to originating issue |
| `createdByAgentId` | uuid, nullable | FK → agents |
| `createdByUserId` | uuid, nullable | FK → users |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

Indexes: `(companyId, folderId)`, `(companyId, issueId)`, `(companyId, createdByAgentId)`.

### Relationship to existing tables

- `artifacts.assetId` → `assets.id` — reuses existing file storage (local disk or S3)
- `artifacts.issueId` → `issues.id` — traceability back to the originating issue
- Existing `issue_attachments` flow triggers auto-creation of artifact entries

## Auto-Organization Logic

When a file is attached to an issue (via existing attachment API or new artifacts API):

1. Look up the issue's project
2. Ensure a folder exists for the project: `/{ProjectName}/` with `sourceType = "project"`
3. Ensure a subfolder exists for the issue: `/{ProjectName}/{IssueTitle}/` with `sourceType = "issue"`
4. Create the artifact entry in that folder
5. If the issue has no project, place in a `/Uncategorized/` folder

Auto-generated folder names are set at creation time from the project/issue title and do not auto-rename if the title changes. Users can rename folders manually.

When a custom path is specified (e.g. `/reports/weekly/summary.md`):

1. Parse the path into folder segments
2. Create any missing folders with `sourceType = "custom"`
3. Create the artifact in the leaf folder

## API Endpoints

### Folders

- `GET /api/companies/:companyId/artifacts/tree` — full folder tree (lightweight: ids, names, paths, child counts)
- `POST /api/companies/:companyId/artifacts/folders` — create folder. Body: `{ parentId?, name }` or `{ path }`
- `PATCH /api/artifacts/folders/:id` — rename or move (change `parentId`, updates materialized `path`)
- `DELETE /api/artifacts/folders/:id` — delete empty folder, or `?recursive=true`

### Artifacts (files)

- `GET /api/companies/:companyId/artifacts` — list/search. Query params: `folderId`, `issueId`, `agentId`, `mimeType`, `search`, `sort`, `limit`, `offset`
- `POST /api/companies/:companyId/artifacts` — upload file (multipart). Body fields: `folderId` or `path`, optional `issueId`, `title`, `description`
- `GET /api/artifacts/:id` — artifact metadata
- `GET /api/artifacts/:id/content` — download/stream file content
- `GET /api/artifacts/:id/local-path` — returns native filesystem path (only for `local_disk` storage provider)
- `PATCH /api/artifacts/:id` — rename, move to different folder, update description
- `DELETE /api/artifacts/:id`

### Backward compatibility

The existing `POST /api/companies/:companyId/issues/:issueId/attachments` endpoint gains a side-effect: it also creates an artifact entry in the auto-organized folder for that issue. No breaking changes to existing API.

## UI Design

### Page location

New top-level sidebar item "Artifacts" (with a file/folder icon), placed after "Issues" in the navigation order.

Route: `/:companyPrefix/artifacts`, `/:companyPrefix/artifacts/:folderId`

### Layout: Two-panel with expandable preview

**Left panel — Folder tree:**
- Collapsible tree view showing all folders
- Auto-generated folders show a subtle badge (project icon, issue icon)
- Right-click context menu: New folder, Rename, Move, Delete
- Drag-and-drop for moving folders (stretch goal)

**Right panel — File list:**
- Shows files in the selected folder
- Columns: name, type icon, size, created by (agent/user avatar), date, linked issue
- Click a file row to expand an inline preview below it
- Sortable columns
- Right-click context menu for file actions

**Expandable preview:**
- Renders below the clicked file row, pushing other rows down
- Markdown: rendered HTML
- Code files: syntax-highlighted
- Images: displayed inline
- PDFs: embedded viewer
- HTML: sandboxed iframe preview
- Other: download prompt with file metadata

**Top toolbar:**
- Search input (searches artifact names and descriptions)
- Filter dropdowns: by agent, by project, by file type, by date range
- View toggle: list view / grid view (grid useful for image-heavy folders)
- "New folder" button
- "Upload" button

### File actions (context menu / action buttons)

- Preview (expand inline)
- Download
- Open in Finder (local_disk only, hidden for S3)
- Copy link
- Move to...
- Rename
- Delete
- View source issue (if linked)

### Folder actions (context menu)

- New subfolder
- Upload file here
- Rename
- Move
- Delete (empty only, or confirm recursive)

## Activity Logging

All mutations log to the existing `activity_log` table:
- `artifact.created`, `artifact.moved`, `artifact.renamed`, `artifact.deleted`
- `artifact_folder.created`, `artifact_folder.moved`, `artifact_folder.renamed`, `artifact_folder.deleted`

## Scope Boundaries

**In scope (V1):**
- Database schema (artifact_folders, artifacts)
- CRUD API endpoints for folders and artifacts
- Auto-organization on issue attachment
- Artifacts sidebar page with two-panel layout
- Inline preview for common file types (markdown, images, code, PDF)
- File actions: download, rename, move, delete, open in Finder, copy link
- Search and filter
- Activity logging

**Out of scope (future):**
- Drag-and-drop file/folder reordering
- Grid view for images
- File versioning / revision history on artifacts
- Collaborative editing
- Agent-to-agent file sharing via artifacts
- Full-text search inside file contents
- Thumbnail generation for images/PDFs
