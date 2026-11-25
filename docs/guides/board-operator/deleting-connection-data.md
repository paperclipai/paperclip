---
title: Deleting Data Read Through a Connection
summary: Permanently remove what Paperclip saved from a connected app's tool calls
---

When an agent uses a connected app, such as Google Workspace, Paperclip saves part of what the app returned so you can review the work later. You can delete that saved data at any time, for any connected app.

## What Paperclip saves

For each tool call an agent makes through a connection, Paperclip keeps:

- A short preview of the request and the result (up to about 4,000 characters, with secrets removed)
- For actions that needed approval, the preview and arguments shown on the approval card, and the result passed back to the agent
- Interactive app views that a tool showed in a task
- The transcript of the run that made the call, which can contain the full result, and of the run that received an approved action's result

For most apps, this data stays until you delete it, and removing the connection alone does not delete it. Google connections are different: see the next section.

## Google connections: deleted when access ends

When Paperclip's access to a Google account ends, Paperclip deletes what agents read through that Google connection on its own. You do not need to select **Delete data**. This happens when:

- You remove the Google connection.
- Someone revokes a Google identity on the connection, a person's own or the organization's.
- Someone removes Paperclip from their Google account, or Google ends the access, and Paperclip sees this the next time it renews the access.
- The person who connected their Google account leaves the company.
- Paperclip Cloud removes your Paperclip instance.

Deletion starts at once. Runs that are still working keep their data until they finish; Paperclip then deletes it too. While work is still running, Paperclip checks again every few minutes, and every hour after the first day. If a step fails, Paperclip keeps trying until it succeeds, also after a restart. The connection's activity shows when the deletion started and when it finished.

The deletion covers everything listed under "What is deleted" for that connection, for all people who used it. If you connect Google again later, Paperclip saves new data from new calls only. Data that was deleted does not come back. Agents also do not resume the conversations of those runs; their next run starts a new one.

## How to delete it

You need permission to manage the connection.

**From the connection's page:**

1. Open **Connectors** and select the connection.
2. At the bottom of the **Permissions** tab, select **Delete data**.
3. Check the counts in the confirmation and select **Delete data**.

**When you remove a connection:**

1. Open **Connectors**, open the connection's menu, and select **Remove connection**.
2. Select **Also delete data read through this connection**. For a Google connection, this option is not shown, because the data is always deleted.
3. Select **Remove connection**.

For a Google connection that Paperclip set up for you, removing the connection also asks Google to end Paperclip's access to that Google account. The message after removal tells you whether access was ended. If other Paperclip connections still use the same Google account, Google keeps Paperclip's access until you remove those too. If Google could not be reached or did not confirm, the message says so and Paperclip keeps trying in the background, for up to 30 days, even if Paperclip restarts. You do not need to do anything. The connection's activity shows when access was ended, or that Paperclip stopped trying. If Google gave a final answer that Paperclip cannot end the access, the message says so, and you can remove Paperclip from your Google account's [third-party connections](https://myaccount.google.com/connections).

When you delete a company, Paperclip also ends its access at Google for every Google connection Paperclip set up for that company. This continues in the background after the company is gone. Connections that use your own Google OAuth app are removed only in Paperclip.

Deletion starts right away and continues in the background. It finishes even if Paperclip restarts while it runs. If a step fails, for example because file storage is unavailable, Paperclip keeps the request open and tries again until every step succeeds. It reports the deletion as finished only then. The connection's page shows when the data was last deleted.

## What is deleted

- Request and result previews for every call made through the connection before you asked to delete, including the copies in the connection's audit history
- Approval previews, arguments and results for those calls, on the approval card and in what was passed back to the agent
- Interactive app views from those calls
- The whole transcript of every run that called the connection or received an approved action's result, including that run's other steps and its final summary
- Tool results too large to pass to the agent directly, which Paperclip saved as files for those runs
- Error messages the app returned for those calls
- The saved conversation that agents resume in later runs, for the runs whose transcript is deleted. The agent's next run starts a new conversation.

## What is kept

- The record that each call happened: when, which tool, which agent, the outcome, the size of the data, and a fingerprint of it. Paperclip needs these for its activity history and usage counts. They do not contain the data.
- **Anything your agents wrote into tasks: comments, documents and files.** This action does not remove them, even when an agent copied data from the app into them. Delete or edit those items yourself, or delete the task.
- The connection's audit activity, which records counts only.
- Transcripts of later runs that only read the context an interactive app view shared. Paperclip does not record which runs read it. Delete those tasks if you need that text gone.
- Raw provider traces. An administrator must turn them on, and they expire on their own within 24 hours.

## Deleting a task or a company

Deleting a task also deletes this data for the task's runs, from every connected app. Comments, documents and files in the task are deleted with it, including the files in storage. If a run of the task is still working, or an approval for it is still open, Paperclip waits for up to a day and then deletes the data on its own. After a day, it stops waiting and leaves what is still open.

Deleting a company deletes all of its data, including run transcripts and files in storage. Storage clean-up continues in the background after the company is gone, and Paperclip retries it until it succeeds.

## Runs that are still working

Paperclip does not change a run while it is still working. The confirmation tells you how many runs are skipped for this reason. Select **Delete data** again after they finish.

## It cannot be undone

Deleted data cannot be recovered.
