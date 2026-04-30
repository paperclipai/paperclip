---
name: outlook
description: >
  Read, draft, send, reply to, and manage emails in Outlook via Microsoft Graph.
  Use when a task requires checking email, responding to messages, drafting
  communications, forwarding, or organising the inbox. Do NOT use for
  non-email operations.
---

# Outlook Skill

You have access to the **Medicodio AI Outlook mailbox** (`karthik.r@medicodio.ai`) via MCP tools.
In future each agent will have their own mailbox — the env var `OUTLOOK_MAILBOX` controls which mailbox is active.

Credentials injected automatically:
- `SHAREPOINT_TENANT_ID`, `SHAREPOINT_CLIENT_ID`, `SHAREPOINT_CLIENT_SECRET` (shared MS Graph app)
- `OUTLOOK_MAILBOX` — mailbox address this agent reads/writes

---

## Available Tools

| Tool | Purpose |
|------|---------|
| `outlook_list_folders` | List all mail folders (Inbox, Sent, Drafts, custom) |
| `outlook_list_emails` | List emails in a folder — newest first |
| `outlook_read_email` | Read full email body + metadata |
| `outlook_search_emails` | Search across all folders by keyword |
| `outlook_mark_read` | Mark email as read |
| `outlook_create_draft` | Create a draft (not sent) |
| `outlook_update_draft` | Edit an existing draft |
| `outlook_send_draft` | Send a saved draft |
| `outlook_send_email` | Compose and send immediately |
| `outlook_reply` | Reply (or reply-all) to an email |
| `outlook_forward` | Forward email to new recipients |
| `outlook_move_email` | Move to a different folder |
| `outlook_delete_email` | Delete permanently |

---

## Usage Patterns

### Check and triage inbox
```
1. outlook_list_emails folder=inbox onlyUnread=true top=20
2. For each important email: outlook_read_email
3. Act: reply / forward / move / create task in Paperclip
4. outlook_mark_read after handling
```

### Draft before sending (recommended for important emails)
```
1. outlook_create_draft subject=... body=... toRecipients=[...]
2. Review draft content
3. outlook_send_draft messageId=...
```

### Reply to a specific email
```
1. outlook_search_emails query="subject keyword"
2. outlook_read_email messageId=...
3. outlook_reply messageId=... body="Your reply"
```

---

## Critical Rules

- **Always draft first** for important or external emails — use `outlook_create_draft` → review → `outlook_send_draft`.
- **Never send without reading** the original email first with `outlook_read_email`.
- **Do not delete** emails unless task explicitly says so.
- **CC relevant agents** when delegating or escalating via email.
- **Log email actions** in the Paperclip issue comment (who you emailed, what about, message ID).
- **`outlook_delete_email` is permanent** — confirm task requires it before using.
