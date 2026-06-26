# GitHub Review Webhook -> Paperclip

This flow connects GitHub pull request reviews to Paperclip so review feedback can become actionable tasks.

## Expected Flow

1. A human asks the Hermes Agent to implement something.
2. The Hermes Agent analyzes the request and delegates work to one or more capable agents.
3. The agent or agents create a branch, complete the work, and open a pull request.
4. Codex on GitHub (`chatgpt-codex-connector[bot]` or another configured bot) reviews the pull request and writes comments or improvement suggestions.
5. GitHub sends a webhook to Paperclip.
6. Paperclip normalizes the review, applies allowlist/signature/idempotency rules, and creates or updates a task.
7. The responsible agent receives the task and fixes the pull request on the same branch.

## Endpoint

- Local/public URL: `POST /api/github/webhook`
- `Content-Type`: `application/json`
- Signature header: `X-Hub-Signature-256`
- Delivery ID header: `X-GitHub-Delivery`

## Accepted Events

The endpoint processes only these GitHub events:

- `pull_request_review`
- `pull_request_review_comment`
- `issue_comment` when `issue.pull_request` is present

Comments on regular issues are ignored.

## Configuration

These environment variables are read from the Paperclip runtime. Do not hardcode secrets in the codebase.

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_WEBHOOK_COMPANY_ID`
- `GITHUB_WEBHOOK_PROJECT_ID` optional
- `GITHUB_WEBHOOK_ALLOWED_REPOS` optional, comma-separated or newline-separated list
- `GITHUB_WEBHOOK_ALLOWED_ORGS` optional
- `GITHUB_WEBHOOK_ALLOWED_BOT_LOGINS` optional, defaults to `chatgpt-codex-connector[bot]`
- `GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS` optional, defaults to `false`
- `GITHUB_WEBHOOK_CEO_AGENT_ID` optional
- `GITHUB_WEBHOOK_DEFAULT_ASSIGNEE_AGENT_ID` optional
- `GITHUB_WEBHOOK_AGENT_CTO`, `GITHUB_WEBHOOK_AGENT_DEVOPS`, `GITHUB_WEBHOOK_AGENT_QA`, `GITHUB_WEBHOOK_AGENT_UXDESIGNER` optional

## Allowlist and Security

- If `GITHUB_WEBHOOK_ALLOWED_REPOS` or `GITHUB_WEBHOOK_ALLOWED_ORGS` is configured, the webhook only accepts matching repositories.
- The HMAC SHA-256 signature is validated when `GITHUB_WEBHOOK_SECRET` is configured.
- Duplicates are handled by `originKind + originId`, preventing repeated tasks for the same review or comment.
- Human reviews or comments are ignored by default; to accept them, set `GITHUB_WEBHOOK_ALLOW_HUMAN_REVIEWERS=true`.

## Task Created in Paperclip

For each actionable review, Paperclip records:

- repository and URL
- pull request, head/base branches, and SHA
- pull request author
- review/comment author
- review ID, state, and body
- comment, file, and line when applicable
- delivery ID and sender
- acceptance criteria for the fix

If a task already exists for the same review or comment, Paperclip updates the task instead of creating another one.
