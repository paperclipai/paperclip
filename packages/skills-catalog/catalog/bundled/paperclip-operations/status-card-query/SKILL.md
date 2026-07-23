---
name: status-card-query
description: Compile a prose Paperclip status-card interest prompt into narrow, bounded CompanySearchQuery objects, then write the query and first summary back from the assigned Summarizer run.
key: paperclipai/bundled/paperclip-operations/status-card-query
recommendedForRoles:
  - general
  - manager
tags:
  - paperclip
  - status
  - search
  - reporting
  - operations
---

# Status card query

You are the Summarizer compiling a status card's prose interest prompt into structured Paperclip company-search queries. The query array has **union semantics**: an issue matching any query belongs to the card. Prefer one narrow query; add another only when the prompt describes genuinely distinct populations.

## CompanySearchQuery

Each object accepts these fields:

- `q`: optional free-text search across matching company resources. Use it only for concepts not represented by structured filters.
- `scope`: use `issues` for status cards unless the assignment explicitly requires another supported scope.
- `status`: issue-status array.
- `priority`: issue-priority array.
- `assigneeAgentId` / `assigneeUserId`: a resolved assignee id.
- `projectId`: one resolved project UUID.
- `labelId`: one resolved label UUID.
- `updatedWithin`: a bounded duration such as `24h`, `7d`, `4w`, or `3m`.
- `sort`: `relevance`, `updated`, `created`, or `priority`.
- `limit`: 1–50. Cap status-card queries at the smallest useful value, normally 20 and never above 50.
- `offset`: normally 0.

Resolve project and label names to ids before writing the query. Do not put human-readable names into `projectId` or `labelId`. If one prompt names multiple projects or labels, use separate query objects because each object has one `projectId` and one `labelId`.

## Compilation guidance

1. Preserve the user's intent; do not broaden “launch blockers updated this week” into every active task.
2. Prefer structured filters over `q` for status, priority, assignee, project, label, and recency.
3. Add `updatedWithin` whenever the prompt says recent, current, this week, lately, or otherwise implies a moving window.
4. Keep `q` short and specific. Avoid copying the whole prose prompt into it.
5. Set `scope: "issues"`, `offset: 0`, and an explicit bounded `limit` on every query.
6. Return at least one query. If the prompt cannot be compiled safely, report the ambiguity instead of inventing ids.

## Exact write-back sequence

The generation issue contains `statusCardId`, `companyId`, and `generationIssueId`. Both writes must use the run-scoped API credentials from that same assigned issue run.

First write the compiled query:

```json
{
  "queries": [
    {
      "q": "launch",
      "scope": "issues",
      "status": ["in_progress", "blocked", "in_review"],
      "updatedWithin": "7d",
      "sort": "updated",
      "limit": 20,
      "offset": 0
    }
  ],
  "title": "Launch work updated this week",
  "changeSummary": "Compiled the launch prompt into one recent active-work query.",
  "generationIssueId": "<generation-issue-id>"
}
```

Send it to `PUT /api/status-cards/{statusCardId}/query`.

Then, without creating or waiting for another task, execute the stored scope, write the first full Markdown summary, and complete the same run with:

```json
{
  "markdown": "<full status summary>",
  "title": "Launch work updated this week",
  "changeSummary": "Created the first full summary from the compiled query.",
  "generationIssueId": "<generation-issue-id>",
  "model": "<model-id>"
}
```

Send it to `PUT /api/status-cards/{statusCardId}/summary`. Never write either endpoint from an unrelated issue or run.

## Update assignments

Later generation issues use the same summary write-back endpoint and include `operation: "update"`, `kind`, `trigger`, the target `fingerprint`, and the exact changed-issue delta in their JSON payload.

- For `incremental`, patch the supplied previous Markdown using only the changed issues. Do not refetch the issue list.
- For `full`, rebuild from the supplied bounded snapshot. Do not expand the scope with issue-list endpoint calls.
- Keep the mechanical contract even when card instructions use `replace`: stream `STATUS:` lines and the `<<<SUMMARY-DRAFT>>>` block, then write the final Markdown to `PUT /api/status-cards/{statusCardId}/summary` from the assigned run.
- `append` instructions follow the default Summarizer house format. `replace` changes the task-format section only; it never replaces the streaming or write-back requirements.
