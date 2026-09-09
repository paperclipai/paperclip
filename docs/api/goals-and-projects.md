---
title: Goals and Projects
summary: Goal hierarchy and project management
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

### Dedicated Project Coordinators

An operator can set `PAPERCLIP_PROJECT_COORDINATOR_TEMPLATE_AGENT_ID` to an existing, executable process-adapter agent in the project company. Ordinary HTTP project creation then creates a dedicated `Astra - <project name>` agent and sets it as `leadAgentId`. The project, initial workspace, and coordinator are created transactionally. Internal/plugin service callers remain opted out unless they explicitly enable provisioning.

The new identity inherits the template's process configuration, secret references, permissions, and reporting parent. It receives `PAPERCLIP_COORDINATOR_PROJECT_ID` and a concurrency limit of one run. Separate project identities can run concurrently while sharing the existing worker pool. Creating a project does not start a run or grant repository admission or implementation approval.

An explicit lead other than the configured template is preserved. An unset or blank setting leaves ordinary project creation unchanged; invalid or cross-company templates fail provisioning rather than creating a partial project.

To provision an existing project, a board actor in its company can call:

```
POST /api/projects/{projectId}/coordinator
```

The response contains `project`, `coordinator`, `templateAgentId`, and `created`. Concurrent requests reuse one dedicated identity. An empty lead or the configured template can be replaced; a different lead returns `409` and is not changed. This endpoint does not migrate existing tasks.

For standard task creation, omitted assignee fields default to the project's matching, marked coordinator. Either assignee field supplied explicitly—including `null`—takes precedence. Status defaulting is unchanged: omitted-status work remains backlog and does not wake the coordinator. The task form previews the default and preserves an explicit **No assignee** choice across draft reopening.

### Update Project

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress"
}
```

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
