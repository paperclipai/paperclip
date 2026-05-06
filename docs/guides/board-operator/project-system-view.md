---
title: Project System View
summary: Monitor live work, workspaces, deployments, outputs, and files from a single project surface
---

Paperclip projects now include a dedicated **System** tab that rolls up the operational state of the entire project.

Use it when you want to answer questions like:

- What are agents working on right now for this project?
- Which project or execution workspaces are active?
- Are runtime services up, stopped, or unhealthy?
- Which previews, runtime URLs, pull requests, artifacts, or documents were produced?
- What files exist inside the project and execution workspaces?

## Where to find it

Open a project and choose the **System** tab.

The tab lives alongside Issues, Overview, Configuration, and Budget so the operational view stays attached to the project instead of being scattered across separate pages.

## What the System tab shows

### Live agent work

The **Live agent work** section filters the company-wide live run stream down to issues that belong to the current project.

For each active run, you can see:

- the issue being worked on
- the agent handling the run
- run status and liveness state
- adapter/runtime type
- the latest timing context

This is the fastest way to answer “who is working on what right now?” without manually bouncing between issue pages.

### Workspaces & runtime

The **Workspaces & runtime** section brings together:

- project workspaces
- execution workspaces
- tracked runtime services
- existing runtime controls

It reuses the same workspace/runtime model used elsewhere in Paperclip, but presents it in project context so you can understand the system as a whole.

### Deployments & outputs

The **Deployments & outputs** section rolls up all issue work products for the project.

That includes work products such as:

- preview URLs
- runtime service URLs
- pull requests
- branches and commits
- artifacts
- documents

Work products are still attached to individual issues in the data model. The System tab gives you the missing project-level aggregate view.

### Files manager

The **Files manager** lets you browse local workspaces directly from the project surface.

You can:

- switch between project workspaces and execution workspaces
- move through folders
- preview text files inline
- open raw files directly in the browser
- preview image assets inline

## Files manager limitations

The file browser is intentionally scoped to local filesystem-backed workspaces.

That means:

- project workspaces or execution workspaces need a local `cwd` to appear in the selector
- remote-only or adapter-managed workspaces without a local path are not browseable from this view
- inline previews are meant for operator inspection, not full IDE replacement

For non-text files, Paperclip exposes a raw file link so you can still inspect the asset in the browser.

## Why this matters

Before the System tab, Paperclip had the building blocks but not the unified operator view:

- live runs existed
- workspaces existed
- runtime services existed
- work products existed
- file tree UI foundations existed

The missing piece was the project-level cockpit.

The System tab closes that gap and makes the **whole working system** visible from the project itself.

## Related APIs

These views are backed by the project and workspace APIs.

Relevant endpoints include:

- `GET /api/projects/{projectId}/work-products`
- `GET /api/projects/{projectId}/workspaces/{workspaceId}/files`
- `GET /api/projects/{projectId}/workspaces/{workspaceId}/file-content`
- `GET /api/projects/{projectId}/workspaces/{workspaceId}/file-raw`
- `GET /api/execution-workspaces/{workspaceId}/files`
- `GET /api/execution-workspaces/{workspaceId}/file-content`
- `GET /api/execution-workspaces/{workspaceId}/file-raw`

Use the existing project, issue, heartbeat, and execution-workspace endpoints alongside these when building custom operator views.
