---
name: paperclip-api
description: Hermes companion skill for Paperclip control-plane API calls and auth header discipline.
required_environment_variables:
  - PAPERCLIP_API_URL
  - PAPERCLIP_COMPANY_ID
  - PAPERCLIP_AGENT_ID
  - PAPERCLIP_API_KEY
  - PAPERCLIP_RUN_ID
---

# paperclip-api

Use this skill whenever you need to call the Paperclip API from Hermes.

Rules:
- Always use terminal + curl for Paperclip API calls.
- Paperclip API mutations are terminal-only. Never use `execute_code` or `write_file` to `POST` or `PATCH` Paperclip issues, approvals, or hire payloads.
- PAPERCLIP_API_URL already includes /api. Append paths directly.
- Always send Authorization: Bearer $PAPERCLIP_API_KEY.
- Always send X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on POST and PATCH calls.
- Prefer $PAPERCLIP_API_URL, $PAPERCLIP_COMPANY_ID, $PAPERCLIP_AGENT_ID, and $PAPERCLIP_TASK_ID over hand-copying UUIDs.
- For JSON writes, prefer writing a payload file and using `--data @file` instead of inline JSON.
- If the payload includes `$PAPERCLIP_*` placeholders, create it from the terminal so the shell expands them before the request.
- Do not use `execute_code` for Paperclip API calls. In Hermes tool sandboxes, `PAPERCLIP_*` vars can resolve as missing or `None`.
- Avoid `write_file` for env-backed Paperclip payloads unless the required `PAPERCLIP_*` vars are definitely available in that execution environment.
- Prefer reading the live object first before mutating it.
- When mutating issues or approvals, leave a short operator-visible comment when it helps explain what happened.
- Create new issues with `POST /api/companies/:companyId/issues`, not `POST /api/issues`.
- For issue creation, use the field name `description` for instructions. Do not send `body` unless you know the server accepts it as an alias.
- When delegating from an assigned issue, set `parentId` to `$PAPERCLIP_TASK_ID`.
- If the delegated issue should stay in the same checkout or worktree, set `inheritExecutionWorkspaceFromIssueId` to `$PAPERCLIP_TASK_ID`.
