# GitHub Review Webhook -> Paperclip

This flow connects GitHub pull request reviews to Paperclip so Codex feedback can drive a review/fix loop. It does not merge pull requests.

## Expected Flow

1. A human asks the Hermes Agent to implement or adjust something.
2. The Hermes Agent hands the work to Paperclip.
3. Paperclip creates a branch, implements the change, commits, pushes, and opens a pull request.
4. Codex on GitHub (`chatgpt-codex-connector[bot]` or another configured bot) reviews the pull request and writes comments or improvement suggestions.
5. GitHub sends a webhook to Paperclip.
6. Paperclip normalizes the review and applies allowlist/signature/idempotency rules.
7. If the Codex review asks for a fix, correction, improvement, test, or follow-up, Paperclip creates or updates a task for the responsible agent to fix the same PR branch.
8. The loop repeats from the next Codex review until Codex does not request any fix, correction, or improvement.
9. When Codex does not request changes, Paperclip returns `completed`; Hermes reports that the review/fix loop is complete and translates the Codex message to Brazilian Portuguese for the human.

Paperclip and Hermes must not merge automatically as part of this webhook flow. Merge remains a separate human/maintainer decision.

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

When a Codex review has no requested fixes or improvements, the webhook response is `kind: "completed"` and no Paperclip task is created for that review.
