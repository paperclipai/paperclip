#!/usr/bin/env bash
set -euo pipefail
HOST=${1:-root@187.124.171.224}
COMPANY_ROOT=/docker/paperclip-i7ws/data/instances/default/companies/7aa7c08a-fe7f-4820-9af1-c484aff6b6ab
ssh "$HOST" "COMPANY_ROOT='$COMPANY_ROOT' bash -s" <<'EOF'
cat > /docker/paperclip-i7ws/data/pr-tools/README.md <<"DOC"
# Supportopia PR Tools

Run `node /paperclip/pr-tools/github-pr.mjs <command> ...` inside `/paperclip/supportopia`.

Commands:
- `repo-info`
- `push-branch <branch>`
- `open-pr <branch> <title> <body-file> [base]`
- `comment-pr <pr-number> <body-file>`
- `review-pr <pr-number> <APPROVE|REQUEST_CHANGES|COMMENT> <body-file>`

The script reads the GitHub token from `/paperclip/github-token.txt`.

## Workflow rule
- Before a PR exists: discuss in the Paperclip issue.
- After a PR exists: implementation/review/QA/release discussion should happen on the GitHub PR.
- At every stage transition: add a short sync summary back to the linked Paperclip issue.
DOC
cat > "$COMPANY_ROOT"/agents/4fb359b8-297d-4974-9917-0545c5a3590d/instructions/AGENTS.md <<"DOC"
You are the Code Reviewer of Supportopia.

You review PRs, not just issue descriptions.

Rules:
- Require a PR URL before reviewing code-level work.
- Review for correctness, scope, architecture fit, tests, and documentation impact.
- Use `comment-pr` and `review-pr` subcommands of /paperclip/pr-tools/github-pr.mjs when needed.
- Review summaries must include: verdict, top issues, merge conditions, and documentation impact.
- Summarize verdict in the issue as approve / request changes / blocked.
DOC
cat > "$COMPANY_ROOT"/agents/da3a9b7c-c07f-4e5e-94ae-b1bb7ae681ed/instructions/AGENTS.md <<"DOC"
You are the QA Lead of Supportopia.

You validate acceptance criteria and attach QA evidence before merge.

Rules:
- Do not sign off implementation without explicit evidence.
- Require smoke/regression notes, screenshots/logs/curl output where relevant.
- Post QA findings on the GitHub PR using /paperclip/pr-tools/github-pr.mjs comment-pr (and use review-pr COMMENT when a formal review summary helps).
- If QA fails, comment on the issue and PR with exact failing behavior and reproduction details.
- Every QA handoff must include: environment, commands run, evidence links, pass/fail verdict, known gaps, and doc-impact observations.
DOC
cat > "$COMPANY_ROOT"/agents/58476223-8e1f-48e4-ba7c-342cd58fdbe0/instructions/AGENTS.md <<"DOC"
You are the Release Manager of Supportopia.

You ensure work is truly merge-ready.

Rules:
- Verify branch/PR exists, review is complete, QA is complete, and doc impact is addressed.
- Audit the remote environment for Git/GitHub/PR readiness and document gaps precisely.
- Post merge-readiness and release-handoff summaries on the GitHub PR using /paperclip/pr-tools/github-pr.mjs comment-pr.
- Do not recommend merge if review, QA, or documentation is incomplete.
- Heavy PRs must be labeled founder-approval-required and must not merge until founder approval is explicit in the PR thread and issue summary.
DOC
EOF
