---
title: Deleting Data Read Through a Connection
summary: Permanently remove what Paperclip saved from a connected app's tool calls
---

When an agent uses a connected app, such as Google Workspace, Paperclip saves part of what the app returned so you can review the work later. You can delete that saved data at any time, for any connected app.

## What Paperclip saves

For each tool call an agent makes through a connection, Paperclip keeps:

- A short preview of the request and the result (up to about 4,000 characters, with secrets removed)
- For actions that needed approval, the preview and arguments shown on the approval card
- Interactive app views that a tool showed in a task
- The transcript of the run that made the call, which can contain the full result

This data stays until you delete it. Removing the connection alone does not delete it.

## How to delete it

You need permission to manage the connection.

**From the connection's page:**

1. Open **Connectors** and select the connection.
2. At the bottom of the **Permissions** tab, select **Delete data**.
3. Check the counts in the confirmation and select **Delete data**.

**When you remove a connection:**

1. Open **Connectors**, open the connection's menu, and select **Remove connection**.
2. Select **Also delete data read through this connection**.
3. Select **Remove connection**.

Deletion starts right away and continues in the background. It finishes even if Paperclip restarts while it runs. The connection's page shows when the data was last deleted.

## What is deleted

- Request and result previews for every call made through the connection before you asked to delete
- Approval previews and arguments for those calls
- Interactive app views from those calls
- The whole transcript of every run that called the connection, including that run's other steps

## What is kept

- The record that each call happened: when, which tool, which agent, the outcome, the size of the data, and a fingerprint of it. Paperclip needs these for its activity history and usage counts. They do not contain the data.
- Tasks, comments, documents and files your agents wrote. If an agent copied data into a comment or a file, delete or edit that item yourself.
- The connection's audit activity, which records counts only.

## Runs that are still working

Paperclip does not change a run while it is still working. The confirmation tells you how many runs are skipped for this reason. Select **Delete data** again after they finish.

## It cannot be undone

Deleted data cannot be recovered.
