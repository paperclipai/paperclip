---
name: paperclip-runtime
description: Hermes companion skill for interpreting Paperclip wake context, task IDs, comment wakes, and approval wakes.
required_environment_variables:
  - PAPERCLIP_API_URL
  - PAPERCLIP_COMPANY_ID
  - PAPERCLIP_AGENT_ID
  - PAPERCLIP_API_KEY
  - PAPERCLIP_RUN_ID
---

# paperclip-runtime

Environment variables commonly injected by the Hermes Paperclip adapter:
- PAPERCLIP_API_URL
- PAPERCLIP_COMPANY_ID
- PAPERCLIP_AGENT_ID
- PAPERCLIP_RUN_ID
- PAPERCLIP_TASK_ID
- PAPERCLIP_WAKE_REASON
- PAPERCLIP_WAKE_COMMENT_ID
- PAPERCLIP_APPROVAL_ID
- PAPERCLIP_APPROVAL_STATUS
- PAPERCLIP_LINKED_ISSUE_IDS
- PAPERCLIP_CHILD_ISSUE_ID
- PAPERCLIP_CHILD_ISSUE_IDENTIFIER
- PAPERCLIP_CHILD_ISSUE_TITLE
- PAPERCLIP_CHILD_ISSUE_STATUS
- PAPERCLIP_WORKSPACE_CWD
- PAPERCLIP_WORKSPACE_ID
- PAPERCLIP_WORKSPACE_REPO_URL
- PAPERCLIP_WORKSPACE_REPO_REF

Rules:
- Treat wakeReason as high-priority operator context.
- Reuse the injected $PAPERCLIP_* env vars in commands instead of retyping UUIDs from the prompt.
- If approval fields are present, inspect the approval before acting.
- If taskId is present, act on that issue before scanning for unrelated work.
- Shell env vars inside file paths do not expand in `write_file`, `read_file`, or `patch`; expand them in the terminal first or replace them with a literal path before using file tools.
- If the task requires multiple issue comments, POST each comment before reusing or overwriting its payload file.
- Do not overwrite `/tmp/paperclip-issue-comment.json` until the current comment has been sent successfully.
- Paperclip API mutations are terminal-only. Do not use `execute_code` for issue comments, status updates, approvals, or hire requests.
- In Hermes tool sandboxes, `execute_code` can see `PAPERCLIP_*` vars as missing or `None`; if that happens, redo the call from the terminal tool with curl.
- If the issue or plan says a comment, file, payload, or token must be exact or verbatim, treat that as a byte-for-byte requirement and verify it before completion.
- If a loaded skill has generic example wording that conflicts with the task, the task-specific requirement wins.
- Loaded skills help with execution, but they do not replace the required Paperclip issue comment and status update steps.
- If a skill tells you to "report", "wait", ask for feedback, or say "Ready for feedback", translate that into the required Paperclip issue comment and continue unless the assigned issue explicitly tells you to stop or you hit a real blocker.
- If the assigned issue explicitly says to wait for board approval, revision feedback, or another reviewer decision after submitting a request, post the required progress comment but do not mark the issue done until that follow-up wake arrives.
- Do not say that you posted a Paperclip comment or marked an issue done until the corresponding API call actually succeeded and you verified the result.
