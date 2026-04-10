---
name: composio-tiktok
description: "Use Composio via the shared Rube MCP server for TikTok account operations, publishing flows, and account inspection when the user requests TikTok work."
---

# Composio TikTok

Use this skill for TikTok work when the shared `rube` MCP server is available.

## Workflow

1. Call `RUBE_SEARCH_TOOLS` first.
2. Search for the exact TikTok action needed, such as:
   - `tiktok create post`
   - `tiktok upload media`
   - `tiktok get account info`
   - `tiktok list posts`
3. If no authorized TikTok account is connected, call `RUBE_MANAGE_CONNECTIONS`.
4. Execute the discovered tool only after you have the exact media, caption, and publish intent.

## Operating Rules

- Always search before execution.
- Treat publishing as a governed action: confirm media, caption, account, and whether the user wants draft vs publish if both exist.
- If the Composio session exposes multiple connected TikTok accounts, state which one you will use before posting.
- If the tool returns moderation or policy fields, surface them in the result instead of hiding them.
