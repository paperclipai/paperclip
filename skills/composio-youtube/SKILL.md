---
name: composio-youtube
description: "Use Composio via the shared Rube MCP server for YouTube uploads, metadata updates, and channel inspection when the user requests YouTube work."
---

# Composio YouTube

Use this skill for YouTube requests when the shared `rube` MCP server is available.

## Workflow

1. Call `RUBE_SEARCH_TOOLS` first.
2. Search for the specific YouTube action needed, such as:
   - `youtube upload video`
   - `youtube update video metadata`
   - `youtube list videos`
   - `youtube channel info`
3. If the session is not connected, call `RUBE_MANAGE_CONNECTIONS`.
4. Execute only the discovered action required for the request.

## Operating Rules

- Always search before execution.
- Before uploading, confirm the file source, title, description, privacy status, and target channel.
- If multiple YouTube accounts are connected, state which account you will use before upload or update.
- Prefer returning the uploaded video id, URL, and final privacy status in the summary.
