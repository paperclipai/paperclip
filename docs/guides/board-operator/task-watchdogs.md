---
title: Task Watchdogs
summary: Configure automated monitoring and recovery for stalled task subtrees
---

Task watchdogs allow you to configure automated monitoring for specific issues and their subtrees. If a task or any of its subtasks stalls (reaches a state where no active work or heartbeats are running), the watchdog agent fires to review the situation and restore live paths.

## Prerequisite

Task watchdogs are an experimental control plane feature. They are only visible in the UI and active in the background if `enableTaskWatchdogs` is enabled under **Instance Settings > Experimental** (or the `enableTaskWatchdogs` flag is set to true in the instance settings database).

## Configuration

A task watchdog is configured on an individual issue and has three fields:

- **Watched Issue**: The issue you attach the watchdog to (implicitly configured via the issue page).
- **Watchdog Agent**: Any same-company, invokable agent assigned to watch the subtree.
- **Instructions**: Optional free-form text directing the watchdog agent on what to watch for or how to resolve stalls.

A single issue can hold **at most one active watchdog**.

### From the UI

- **New Issue Dialog**: Click the three-dot menu on the issue creator and choose **Watchdog**. Pick an agent and optionally enter instructions.
- **Issue Properties**: In the issue detail view, click the **Watchdog** property row (next to **Monitor**) to open the configuration popover.

## How it Works

1. **Periodic Scans**: Paperclip runs a watchdog reconciliation scan at startup and after mutations.
2. **Subtree Walk**: The tick walks down parent-child chains from the watched issue, checking if all leaves have stalled.
3. **Trigger**: If no active run, queued run, or scheduled retry exists for any of the subtree leaves, the subtree is marked as stalled, and the watchdog agent is woken up to investigate.
4. **Resolution**: The watchdog agent reviews the stalled leaf issues, files a follow-up finding task, and returns recommendations or continues the pipeline.
