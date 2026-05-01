---
title: Project Folders
summary: Organise projects into named folders for easier navigation
---

Project folders let you group related projects together so the sidebar and the Projects page stay scannable as your company grows. Folders are **company-wide** — every user sees the same folder structure.

The feature is **off by default**. Enable it per-company when you need it.

## Enabling Folders

Go to **Company Settings → Projects** and toggle **Enable project folders** on. The sidebar and Projects page immediately switch to folder view. Turning it off restores the flat list; no data is lost.

## Creating a Folder

**From the Projects page:**

1. Click **New folder** (next to Add Project) in the top-right.
2. An inline input appears — type a name and press **Enter** to save, **Escape** to cancel.

**From the sidebar:**

1. Hover over the **Projects** section header.
2. Click the folder-plus icon (next to the `+` project button).
3. Type a name and press **Enter**.

## Adding Projects to a Folder

### Drag and drop

On the **Projects page**, drag any project row and drop it onto a folder header. The folder highlights while a compatible project is dragged over it. Drop to reassign.

In the **sidebar**, the same drag-to-folder behaviour applies within the folder-mode DnD context.

### At project creation

When folders are enabled, the **New Project** dialog includes an optional **Folder** picker chip in the property row at the bottom. Select a folder before clicking Create, or leave it unset — the project goes to **Uncategorized**.

### Via the API

Pass `folderId` when creating or updating a project:

```
PATCH /api/projects/{projectId}
{
  "folderId": "{folderId}"
}
```

Set `folderId` to `null` to move a project back to Uncategorized.

## Uncategorized Projects

Projects without a folder appear in an **Uncategorized** group. In the sidebar, Uncategorized only shows when there are actually unfiled projects. On the Projects page, it always appears at the bottom of the list so there is always a visible drop target.

## Renaming a Folder

Hover a folder header and click the **⋯** button that appears, then choose **Rename**. The folder name becomes an inline input. Press **Enter** to save or **Escape** to cancel.

## Deleting a Folder

Hover a folder header, click **⋯**, then choose **Delete folder**. The folder is removed immediately. All projects that were inside it move to **Uncategorized** — no projects are deleted.

## Reordering Folders

Folders are ordered by `sortOrder`. The API exposes a bulk reorder endpoint:

```
PUT /api/companies/{companyId}/project-folders/order
{
  "orderedIds": ["{folderId1}", "{folderId2}", "{folderId3}"]
}
```

Drag-to-reorder between folders in the UI is a planned improvement.

## Notes

- Folders are scoped to a single company; different companies maintain independent folder structures.
- Project ordering within folders uses the same per-user preference as the flat list — each user can sort projects their own way inside a folder.
- Archiving a project does not affect its folder assignment; archived projects are simply hidden from the lists.
