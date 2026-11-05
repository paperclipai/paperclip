---
name: garden-inbox
description: Scan a Paperclip user's Mine inbox, classify reversible archive candidates, request checkbox confirmation, and archive only accepted selections. Use when asked to garden, clean up, prune, or tidy a Paperclip inbox without changing issues, branches, or workspaces.
---

# Garden Inbox

Use the bundled script for every stage. Keep the workflow strictly ordered: `scan` → `confirm` → `apply`.

## Safety contract

- Treat `scan` as read-only. It may read inbox, workspace, close-readiness, and local Git metadata only.
- Treat `confirm` as a confirmation-card write only. It must not archive inbox entries or mutate issue fields, branches, or workspaces.
- Run `apply` only after a resolved `request_checkbox_confirmation` interaction. It archives only accepted option IDs that also occur in the originating `candidates.json`.
- Remember that inbox archive state is per-user presentation state. It is reversible and does not change the underlying issue.
- Never substitute issue status changes, branch deletion, workspace cleanup, or issue deletion for inbox archiving.

## Inputs

Require `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`. The script strips a trailing `/api` from the URL. It resolves the target user from the run JWT payload's `responsible_user_id`; use `--user-id <uuid>` only for an explicit target override.

Use a run-owned output directory when available:

```bash
RUN_DIR="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_TASK_SCRATCH_DIR:-.}}/garden-inbox"
mkdir -p "$RUN_DIR"
```

## 1. Scan

```bash
node .agents/skills/garden-inbox/scripts/garden-inbox.mjs scan \
  --output-dir "$RUN_DIR" \
  --stale-days 60
```

Inspect `garden-inbox-report.md` and `candidates.json`. The report groups every inbox row into exactly one bucket:

The scan reads Mine separately for each included issue status so the endpoint's global 500-row cap does not silently omit older rows. If any single-status query reaches that cap, both outputs mark coverage as possibly truncated; do not treat that scan as complete.

- A: merged/archived workspace and all linked work terminal; selected by default.
- B: terminal or workspace-gone work idle beyond the threshold; selected by default.
- C: stale work with commits ahead of base; never selected by default.
- D: keep; never offered for archiving.

Do not manually promote bucket D entries into the candidate file.

## 2. Confirm

Post checkbox interactions on the driving issue:

```bash
node .agents/skills/garden-inbox/scripts/garden-inbox.mjs confirm \
  --issue-id "$PAPERCLIP_TASK_ID" \
  --candidates "$RUN_DIR/candidates.json"
```

The script posts sequential cards when a scan has more than 200 candidates. Re-running `confirm` with the same scan file is idempotent. Leave the driving issue in the waiting posture required by the surrounding Paperclip heartbeat workflow.

When a candidate was declined by the user in an earlier pass, pass `--unselect <issueId>` (repeatable) so it starts unchecked and its description notes the earlier decline. Never re-offer previously declined items as default-checked.

For development or payload review, suppress the POST:

```bash
node .agents/skills/garden-inbox/scripts/garden-inbox.mjs confirm \
  --issue-id "$PAPERCLIP_TASK_ID" \
  --candidates "$RUN_DIR/candidates.json" \
  --dry-run
```

## 3. Apply accepted selections

After an interaction-resolution wake, take the resolved interaction ID from the wake payload and run:

```bash
node .agents/skills/garden-inbox/scripts/garden-inbox.mjs apply \
  --issue-id "$PAPERCLIP_TASK_ID" \
  --interaction-id "$INTERACTION_ID" \
  --candidates "$RUN_DIR/candidates.json"
```

On rejection, expiry, or an accepted empty selection, the script archives nothing. Apply preserves the scan file's target user, including an explicit `--user-id` override. Its summary includes the API undo path and target-user body for every archived row.

Test `apply` without API writes by supplying a saved interaction response:

```bash
node .agents/skills/garden-inbox/scripts/garden-inbox.mjs apply \
  --issue-id "$PAPERCLIP_TASK_ID" \
  --interaction-file resolved-interaction.json \
  --candidates "$RUN_DIR/candidates.json" \
  --dry-run
```

## Verify the bundled logic

Run the zero-dependency Node tests after changing classification or selection safety:

```bash
node --test .agents/skills/garden-inbox/scripts/garden-inbox.test.mjs
```
