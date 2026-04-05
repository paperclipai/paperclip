---
name: paperclip-approvals
description: Hermes companion skill for approval-aware issue and hire workflows in Paperclip.
required_environment_variables:
  - PAPERCLIP_API_URL
  - PAPERCLIP_COMPANY_ID
  - PAPERCLIP_AGENT_ID
  - PAPERCLIP_API_KEY
  - PAPERCLIP_RUN_ID
---

# paperclip-approvals

Paperclip approvals are first-class workflow objects.

Use these endpoints:
- GET /api/approvals/:approvalId
- GET /api/approvals/:approvalId/comments
- GET /api/approvals/:approvalId/issues
- POST /api/approvals/:approvalId/resubmit
- POST /api/companies/:companyId/agent-hires

Rules:
- Use /agent-hires for new subordinate agents.
- Use `$PAPERCLIP_COMPANY_ID` and `$PAPERCLIP_AGENT_ID` exactly as provided; do not rewrite IDs manually after a shell error.
- When hiring from an assigned issue, include `sourceIssueId: "$PAPERCLIP_TASK_ID"` in the payload so the approval stays linked to the work item.
- Read the approval object, approval comments, and linked issues before continuing an approval wake.
- If an approved hire_agent approval already contains the subordinate you asked for, reuse that existing agent instead of creating another hire for the same source issue.
- Prefer a temporary JSON payload file plus `--data @file` when calling `/agent-hires` or `/resubmit`.
- Use an unquoted heredoc delimiter like `<<JSON` for env-backed payload files so `$PAPERCLIP_*` values expand.
- Before calling `/agent-hires` or `/resubmit`, inspect the payload file and confirm it no longer contains literal `$PAPERCLIP_*` strings.
- Never use `execute_code` for `/agent-hires`, approval comments, or approval resubmits. Use terminal + curl so `PAPERCLIP_*` vars stay resolved.
- Do not use `write_file` for env-backed hire payloads unless you replace every `$PAPERCLIP_*` placeholder with a literal value first.
- Do not assume board approval should be disabled.
- On revision_requested, gather the requested changes and resubmit an updated payload.
- On rejected, stop the blocked plan and summarize the reason clearly.
