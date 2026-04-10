---
name: composio-gmail
description: "Use Composio via the shared Rube MCP server to search Gmail, read messages, draft email, and send email when the user wants Gmail actions."
---

# Composio Gmail

Use this skill for Gmail tasks when the shared `rube` MCP server is available.

## Workflow

1. Call `RUBE_SEARCH_TOOLS` first.
2. Search for the exact Gmail action the user asked for, such as:
   - `gmail search messages`
   - `gmail get message`
   - `gmail create draft`
   - `gmail send email`
   - `gmail list labels`
3. If the user has not connected Gmail yet, call `RUBE_MANAGE_CONNECTIONS` and guide them through the authorization flow.
4. Once the correct tool is discovered, execute only the minimum Gmail action needed for the request.

## Operating Rules

- Always search before execution. Do not guess Composio action names.
- Prefer the Gmail account already selected in the current Composio session.
- If multiple Gmail accounts are available, state which account you intend to use before sending, drafting, or modifying email.
- For destructive or user-visible actions like sending mail, confirm subject, recipients, and body from the user request before execution.
- Return the important result details, not the raw full tool payload.

## Typical Searches

- `gmail search unread inbox`
- `gmail read latest thread`
- `gmail create draft`
- `gmail send email`
- `gmail label message`
