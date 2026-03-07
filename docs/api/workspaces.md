---
title: Workspaces
summary: Create and manage project workspaces for filesystem access, repository linking, and agent working directories
---

A project workspace links a project to a working directory and/or repository. Workspaces serve multiple purposes:

- **File editor** — the workspace's `cwd` field is used as the root directory for the [Workspace Files](/api/workspace-files) API and the board UI file editor.
- **Agent working directory** — agents use the primary workspace to determine their working directory for project-scoped tasks.
- **Repository linking** — workspaces can reference a `repoUrl` and `repoRef` for repository-aware operations.

A workspace must have at least one of `cwd` (local directory) or `repoUrl` (remote repository). Workspaces that only have a `repoUrl` (no `cwd`) cannot be used with the file editor.

## The Workspace Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique workspace identifier |
| `companyId` | string (UUID) | ID of the owning company |
| `projectId` | string (UUID) | ID of the owning project |
| `name` | string | Human-readable display name |
| `cwd` | string \| null | Absolute filesystem path to the workspace directory. Required for file editor access. |
| `repoUrl` | string (URL) \| null | Repository URL (e.g. `https://github.com/org/repo`) |
| `repoRef` | string \| null | Repository branch or ref (e.g. `main`) |
| `metadata` | object \| null | Arbitrary key-value metadata |
| `isPrimary` | boolean | Whether this is the project's primary workspace |
| `createdAt` | string (ISO 8601) | Creation timestamp |
| `updatedAt` | string (ISO 8601) | Last-modified timestamp |

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "companyId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "projectId": "7cb4e6a0-29f9-4e23-b83d-8a3c22ac1b7f",
  "name": "api-service",
  "cwd": "/home/agent/projects/api-service",
  "repoUrl": "https://github.com/org/api-service",
  "repoRef": "main",
  "metadata": null,
  "isPrimary": true,
  "createdAt": "2024-03-01T12:00:00.000Z",
  "updatedAt": "2024-03-01T12:00:00.000Z"
}
```

## Authentication

All endpoints require authentication. The caller must have access to the company that owns the workspace's project.

## Project ID Resolution

The `{projectId}` path segment accepts either a project **UUID** or a human-readable project **shortname** (URL key, e.g. `fusion-studio-product`).

When a non-UUID value is supplied, the server resolves it to a UUID using the following lookup order:

1. **`?companyId=<uuid>` query parameter** — The server resolves the slug within the specified company. The caller must have access to that company (returns `403` otherwise).
2. **Agent actor's company** — When the request is authenticated with an API key, the agent's own company is used automatically. No extra query parameter is needed.

If the shortname matches more than one project within the company, the server returns `409 Conflict`. Use the explicit project UUID to disambiguate.

```
# Using a UUID (no resolution needed)
GET /api/projects/7cb4e6a0-29f9-4e23-b83d-8a3c22ac1b7f/workspaces

# Using a shortname with explicit companyId (board actors / browsers)
GET /api/projects/fusion-studio-product/workspaces?companyId=4a1b2c3d-...

# Using a shortname without companyId (agent API-key actors only)
GET /api/projects/fusion-studio-product/workspaces
```

## List Workspaces

```
GET /api/projects/{projectId}/workspaces
```

Returns all workspaces for a project, ordered by creation time (oldest first).

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `projectId` | UUID or shortname of the project |

**Query Parameters**

| Parameter | Description |
|-----------|-------------|
| `companyId` | *(Optional)* UUID of the company — required when `projectId` is a shortname and the caller is not an API-key agent |

**Response**

```json
[
  {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "companyId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "projectId": "7cb4e6a0-29f9-4e23-b83d-8a3c22ac1b7f",
    "name": "api-service",
    "cwd": "/home/agent/projects/api-service",
    "repoUrl": null,
    "repoRef": null,
    "metadata": null,
    "isPrimary": false,
    "createdAt": "2024-03-01T12:00:00.000Z",
    "updatedAt": "2024-03-01T12:00:00.000Z"
  }
]
```

Returns an empty array `[]` when the project has no workspaces.

**Errors**

| Code | Reason |
|------|--------|
| `403` | Caller does not have access to this project's company |
| `404` | Project not found |
| `409` | Project shortname is ambiguous — use the project UUID |

## Create Workspace

```
POST /api/projects/{projectId}/workspaces
```

Creates a new workspace for the project.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `projectId` | UUID or shortname of the project |

**Query Parameters**

| Parameter | Description |
|-----------|-------------|
| `companyId` | *(Optional)* UUID of the company — required when `projectId` is a shortname and the caller is not an API-key agent |

**Request Body**

```json
{
  "name": "api-service",
  "cwd": "/home/agent/projects/api-service",
  "repoUrl": "https://github.com/org/api-service",
  "repoRef": "main",
  "isPrimary": false
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Display name for the workspace |
| `cwd` | Conditional | Absolute filesystem path. At least one of `cwd` or `repoUrl` must be provided. |
| `repoUrl` | Conditional | Repository URL. At least one of `cwd` or `repoUrl` must be provided. |
| `repoRef` | No | Repository branch or ref |
| `isPrimary` | No | Whether this is the primary workspace (default: `false`) |
| `metadata` | No | Arbitrary key-value metadata |

**Response** — `201 Created`

Returns the created workspace object.

**Errors**

| Code | Reason |
|------|--------|
| `400` | Neither `cwd` nor `repoUrl` provided |
| `403` | Caller does not have access to this project's company |
| `404` | Project not found |
| `409` | Project shortname is ambiguous — use the project UUID |

## Get Workspace

```
GET /api/projects/{projectId}/workspaces/{workspaceId}
```

Returns a single workspace by ID.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `projectId` | UUID or shortname of the project |
| `workspaceId` | ID of the workspace |

**Query Parameters**

| Parameter | Description |
|-----------|-------------|
| `companyId` | *(Optional)* UUID of the company — required when `projectId` is a shortname and the caller is not an API-key agent |

**Response**

Returns the workspace object.

**Errors**

| Code | Reason |
|------|--------|
| `403` | Caller does not have access to this project's company |
| `404` | Project not found |
| `404` | Workspace not found |
| `409` | Project shortname is ambiguous — use the project UUID |

## Update Workspace

```
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
```

Partially updates a workspace. Only the fields provided in the request body are changed.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `projectId` | UUID or shortname of the project |
| `workspaceId` | ID of the workspace |

**Query Parameters**

| Parameter | Description |
|-----------|-------------|
| `companyId` | *(Optional)* UUID of the company — required when `projectId` is a shortname and the caller is not an API-key agent |

**Request Body**

All fields are optional; include only those you want to change.

```json
{
  "name": "api-service-v2",
  "cwd": "/home/agent/projects/api-service-v2"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | New display name |
| `cwd` | string \| null | New filesystem path, or `null` to clear |
| `repoUrl` | string \| null | New repository URL, or `null` to clear |
| `repoRef` | string \| null | New repository ref, or `null` to clear |
| `isPrimary` | boolean | Whether this is the primary workspace |
| `metadata` | object \| null | New metadata, or `null` to clear |

**Response**

Returns the updated workspace object.

**Errors**

| Code | Reason |
|------|--------|
| `403` | Caller does not have access to this project's company |
| `404` | Project not found |
| `404` | Workspace not found |
| `409` | Project shortname is ambiguous — use the project UUID |

## Delete Workspace

```
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```

Permanently deletes a workspace record. This does **not** delete the directory on disk; it only removes the workspace entry from the database.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `projectId` | UUID or shortname of the project |
| `workspaceId` | ID of the workspace |

**Query Parameters**

| Parameter | Description |
|-----------|-------------|
| `companyId` | *(Optional)* UUID of the company — required when `projectId` is a shortname and the caller is not an API-key agent |

**Response**

Returns the deleted workspace object.

**Errors**

| Code | Reason |
|------|--------|
| `403` | Caller does not have access to this project's company |
| `404` | Project not found |
| `404` | Workspace not found |
| `409` | Project shortname is ambiguous — use the project UUID |

## Using Workspaces with the File API

Once you have a workspace with a `cwd` set, use its `id` with the [Workspace Files](/api/workspace-files) API to read and write files within the workspace's `cwd` directory:

```
GET /api/workspaces/{workspaceId}/files?path=src
GET /api/workspaces/{workspaceId}/files/read?path=src/index.ts
POST /api/workspaces/{workspaceId}/files/write
```

Workspaces that only have a `repoUrl` (no `cwd`) cannot be used with the file API — requests will return `404`.

See [Workspace Files](/api/workspace-files) for the full file-operation reference.

## UI: Workspace Detail Tabs

The Paperclip board UI presents workspace details across two tabs:

| Tab | Path | Description |
|-----|------|-------------|
| **Overview** | `/projects/:projectId/workspaces/:workspaceId` | Workspace metadata (name, filesystem path, timestamps) and a split-pane layout: file tree on the left, CodeMirror 6 editor on the right. Supports syntax highlighting, code folding, search/replace, and Ctrl+S save. Only available when the workspace has a `cwd` set. |
| **Git** | `/projects/:projectId/workspaces/:workspaceId/git` | *Coming soon.* Reserved tab for future git management: status, branches, diffs, commit, push, and pull. |

The Git tab is a placeholder that establishes the routing and UX structure for the planned git integration.
