# Imported Workspaces 2026-05-02

## Purpose

This note records the local `paperclip-company` workspace imported during the Codex project portfolio cleanup.
The raw workspace is preserved locally for review, but it is not a Paperclip source-of-truth artifact.

## Imported Workspace

| Source folder | New path | Git policy | Reason |
|---|---|---|---|
| `/Users/kevin/codex/projects/paperclip-company` | `bootstrap/imported_projects/2026-05-02/paperclip-company` | ignored through `bootstrap/imported_projects/` | Contains role workspaces, inbox/notes/outputs, and `.omx` runtime state. |

## Promotion Rule

Do not commit the raw imported workspace.
Review only these human-authored surfaces for possible promotion:

- `*/notes/`
- `*/inbox/`
- `*/outputs/`

Exclude these from promotion unless a separate cleanup task rewrites them into a clean template:

- `.omx/`
- runtime logs
- session state
- tool-specific transient metadata

If useful patterns emerge, rewrite them into a clean tracked template such as `bootstrap/content-marketing-company/` instead of copying the raw workspace.

## Verification

- `git status --short` should not show `bootstrap/imported_projects/`.
- Any future promoted template should be reviewed as a normal Paperclip feature or bootstrap data change.
