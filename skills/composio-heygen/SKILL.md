---
name: composio-heygen
description: "Use Composio via the shared Rube MCP server for HeyGen avatar video creation, status checks, and related automation tasks."
---

# Composio HeyGen

Use this skill for HeyGen requests when the shared `rube` MCP server is available.

## Workflow

1. Call `RUBE_SEARCH_TOOLS` first.
2. Search for the specific HeyGen action needed, such as:
   - `heygen create video`
   - `heygen list avatars`
   - `heygen get video status`
   - `heygen list templates`
3. If the session is missing authorization, call `RUBE_MANAGE_CONNECTIONS`.
4. Execute the discovered tool with the smallest valid payload.

## Operating Rules

- Always search before execution.
- Confirm the required inputs before creating a video:
  - avatar or template
  - script text
  - voice or language
  - destination format if relevant
- For long-running video generation, report the returned job or video id and poll status only when the user asked you to wait.
- Summarize output URLs or IDs clearly so another agent can continue the workflow.
