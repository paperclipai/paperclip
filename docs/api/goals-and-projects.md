---
title: Goals and Projects
summary: Goal hierarchy, project management, and project folders
---

Goals define the "why" and projects define the "what" for organizing work.

## Goals

Goals form a hierarchy: company goals break down into team goals, which break down into agent-level goals.

### List Goals

```
GET /api/companies/{companyId}/goals
```

### Get Goal

```
GET /api/goals/{goalId}
```

### Create Goal

```
POST /api/companies/{companyId}/goals
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active"
}
```

### Update Goal

```
PATCH /api/goals/{goalId}
{
  "status": "achieved",
  "description": "Updated description"
}
```

Valid status values: `planned`, `active`, `achieved`, `cancelled`.

## Projects

Projects group related issues toward a deliverable. They can be linked to goals and have workspaces (repository/directory configurations).

### List Projects

```
GET /api/companies/{companyId}/projects
```

### Get Project

```
GET /api/projects/{projectId}
```

Returns project details including workspaces.

### Create Project

```
POST /api/companies/{companyId}/projects
{
  "name": "Auth System",
  "description": "End-to-end authentication",
  "goalIds": ["{goalId}"],
  "status": "planned",
  "folderId": "{folderId}",
  "workspace": {
    "name": "auth-repo",
    "cwd": "/path/to/workspace",
    "repoUrl": "https://github.com/org/repo",
    "repoRef": "main",
    "isPrimary": true
  }
}
```

Notes:

- `workspace` is optional. If present, the project is created and seeded with that workspace.
- A workspace must include at least one of `cwd` or `repoUrl`.
- For repo-only projects, omit `cwd` and provide `repoUrl`.
- `folderId` is optional. Omit it or pass `null` to leave the project uncategorized. Requires `projectFoldersEnabled` on the company.

### Update Project

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress",
  "folderId": "{folderId}"
}
```

Pass `"folderId": null` to move a project back to Uncategorized.

## Project Folders

Project folders group projects for easier navigation. The feature is opt-in: set `projectFoldersEnabled: true` on the company to activate it.

Folders are company-wide — all users see the same structure. Project ordering within folders remains per-user (stored in sidebar preferences).

### Enable Folders

```
PATCH /api/companies/{companyId}
{
  "projectFoldersEnabled": true
}
```

### List Folders

```
GET /api/companies/{companyId}/project-folders
```

Returns folders ordered by `sortOrder` ascending, then `createdAt`.

### Create a Folder

```
POST /api/companies/{companyId}/project-folders
{
  "name": "Infrastructure",
  "sortOrder": 0
}
```

`sortOrder` defaults to one past the highest existing value if omitted.

### Rename a Folder

```
PATCH /api/companies/{companyId}/project-folders/{folderId}
{
  "name": "Platform Infrastructure"
}
```

### Reorder Folders

Send the full ordered list of folder IDs. Each folder's `sortOrder` is updated to its position in the array.

```
PUT /api/companies/{companyId}/project-folders/order
{
  "orderedIds": ["{folderId1}", "{folderId2}", "{folderId3}"]
}
```

### Delete a Folder

```
DELETE /api/companies/{companyId}/project-folders/{folderId}
```

All projects inside the deleted folder move to Uncategorized (`folderId` set to `null`). No projects are deleted.

## Project Workspaces

Workspaces link a project to a repository and directory:

```
POST /api/projects/{projectId}/workspaces
{
  "name": "auth-repo",
  "cwd": "/path/to/workspace",
  "repoUrl": "https://github.com/org/repo",
  "repoRef": "main",
  "isPrimary": true
}
```

Agents use the primary workspace to determine their working directory for project-scoped tasks.

### Manage Workspaces

```
GET /api/projects/{projectId}/workspaces
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```
