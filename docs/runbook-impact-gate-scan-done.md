# Runbook: Impact Gate Scan-Done

## Overview

The Impact Gate Scan-Done workflow audits fix/bug issues in `done` status for
Impact Gate coverage. It runs every 5 minutes and can also be triggered
manually.

The scan:
1. Fetches all `done` issues from Paperclip (optionally filtered by `days-back`).
2. Identifies fix/bug issues (label + title heuristics).
3. Checks each issue's comments for an Impact Gate result header
   (`## Impact Gate: PASS|FAIL|BYPASSED|ERROR|SKIPPED` at the start of a line).
4. Reports gated vs ungated counts with a per-issue breakdown.
5. On non-zero ungated count, creates a `medium`-priority alert issue assigned
   to the CTO listing the ungated issues.
6. Optionally runs **retroactive gating** on ungated issues
   (`--retroactive` flag), which invokes the full Impact Gate worker to test
   and transition each ungated issue.

## Architecture

```
Paperclip API          Scan-Done Runner           Impact Gate Worker
     │                        │                          │
     │───done issues─────────>│                          │
     │<──comments checked────│                          │
     │                        │                          │
     │───(if retroactive)─────│──invoke process_issue───>│
     │                        │                          │
     │<──alert issue created──│(if ungated_count > 0)    │
```

### Output schema (JSON summary)

```json
{
  "worker": "impact-gate-scan-done",
  "dry_run": false,
  "retroactive": false,
  "timestamp": "2026-05-12T06:00:00+00:00",
  "total_done_fix_issues": 42,
  "gated": {"pass": 30, "fail": 5, "bypassed": 3, "error": 1, "skipped": 0},
  "ungated_count": 3,
  "ungated_issues": [
    {"id": "<uuid>", "identifier": "BTCAAAAA-NNN", "title": "..."}
  ],
  "gated_issues": [
    {"identifier": "BTCAAAAA-NNN", "gate_status": "PASS|FAIL|BYPASSED|ERROR|SKIPPED"}
  ]
}
```

Gate status detection relies on a regex matching the markdown header produced
by the Impact Gate worker's comment builders
(`## Impact Gate: PASS|FAIL|BYPASSED|ERROR|SKIPPED` at the start of a line).

## CLI Usage

### Full scan (default)

```bash
cd /path/to/repo
PYTHONPATH=src python scripts/scan_fix_issues_done.py
```

### Dry run — log results, no comments or transitions

```bash
PYTHONPATH=src python scripts/scan_fix_issues_done.py --dry-run
```

### JSON summary (for downstream automation)

```bash
PYTHONPATH=src python scripts/scan_fix_issues_done.py --json-summary
```

### Pretty-printed output

```bash
PYTHONPATH=src python scripts/scan_fix_issues_done.py --output pretty
```

### Retroactive gating

```bash
PYTHONPATH=src python scripts/scan_fix_issues_done.py --retroactive
```

### Recent issues only

```bash
PYTHONPATH=src python scripts/scan_fix_issues_done.py --days-back 7
```

### Flags

| Flag | Description |
|---|---|
| `--dry-run` | Log results, do not post comments or run retroactive gates |
| `--retroactive` | Run the full Impact Gate on ungated issues |
| `--days-back <N>` | Only scan issues completed within the last N days |
| `--output json\|pretty` | Output format (default: pretty) |
| `--json-summary` | Output structured JSON summary to stdout (overrides `--output`) |

### Alert script

The alert is typically called by the CI workflow when the scan exits non-zero:

```bash
python scripts/scan_done_alert.py --scan-output /tmp/scan-output.json
python scripts/scan_done_alert.py --scan-output /tmp/scan-output.json --dry-run
```

The `--dry-run` flag is optional — if omitted, the alert script respects the
`dry_run` field in the scan JSON output.

## CI/CD Pipeline

Workflow: `.github/workflows/impact-gate-scan-done.yml`

### Triggers

| Trigger | Schedule / Event |
|---|---|
| `schedule` | Every 5 minutes (`*/5 * * * *`) |
| `workflow_dispatch` | Manual trigger with optional `days_back`, `dry_run`, `retroactive` |

### Concurrency

Group: `impact-gate-scan-done` — `cancel-in-progress: false` ensures runs queue.

### Step sequence

1. **Checkout** the repository.
2. **Set up Python** 3.12.
3. **Install dependencies** from `requirements.txt`.
4. **Install system dependencies** — Qt headless libs for Impact Gate tests.
5. **Create data directory** (`mkdir -p data`).
6. **Run scan** — invokes `scripts/scan_fix_issues_done.py` with `--json-summary`
   and optional `--dry-run` / `--retroactive` / `--days-back` flags.
   Output is written to `/tmp/scan-output.json` and the step exits with the
   scan's exit code (0 = no ungated, 1 = ungated found).
7. **Upload scan output artifact** — preserves `/tmp/scan-output.json` as a
   workflow artifact (retention: 30 days) for post-hoc analysis.
8. **Write step summary** — renders a markdown table with gated/ungated counts
   to the workflow run page (`$GITHUB_STEP_SUMMARY`) for at-a-glance results.
9. **Create alert on ungated issues** — runs only on failure (ungated found).
   Calls `scripts/scan_done_alert.py --scan-output /tmp/scan-output.json` to
   create a `medium`-priority issue assigned to the CTO.

### Environment Variables

| Variable | Source | Purpose |
|---|---|---|
| `PAPERCLIP_API_URL` | Secret | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | Secret | API authentication |
| `PAPERCLIP_COMPANY_ID` | Secret | Company/org ID |
| `QT_QPA_PLATFORM` | `offscreen` | Qt headless mode for impact gate tests |
| `PYTHONPATH` | `src` | Python module resolution |

## Alert Escalation

When the scan finds ungated issues, the alert script creates a Paperclip issue
with:

- **Title**: `Impact Gate Scan-Done Alert — YYYY-MM-DD (N ungated)`
- **Priority**: `medium`
- **Labels**: `impact-gate-alert`
- **Assignee**: CTO agent
- **Body**: Markdown table of ungated issues with identifiers and titles, plus
  next-steps instructions.

The CTO reviews each ungated issue and either:
1. Re-runs the workflow with `retroactive=true` to retroactively gate.
2. Manually bypasses the gate by adding the `impact-gate-bypass` label.

After all ungated issues are resolved, the next daily scan will report 0
ungated and exit zero (no alert generated).

## Local Development

### Setup

```bash
cd /path/to/repo
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### Run tests

```bash
# All impact gate tests
python -m pytest tests/test_impact_gate/ -v

# Scan-done specific tests
python -m pytest tests/test_impact_gate/test_scan_done.py -v
python -m pytest tests/test_impact_gate/test_scan_done_alert.py -v

# With coverage
python -m pytest tests/test_impact_gate/ \
  --cov=scripts/scan_fix_issues_done.py --cov-report=term-missing
```

### Dry-run test

```bash
PYTHONPATH=src python scripts/scan_fix_issues_done.py --dry-run
```

### Verify alert creation

```bash
PYTHONPATH=src python scripts/scan_done_alert.py \
  --scan-output /tmp/scan-output.json --dry-run
```

## Fix Issue Detection

The scan identifies fix/bug issues using the helper `_is_fix_issue()`:

1. **Label match**: case-insensitive check for labels named `fix`, `bug`,
   `bugfix`, `regression`, or `hotfix`.
2. **Title fallback**: if no matching label, scans the title for keywords
   `fix`, `bug`, `regression`, or `hotfix` (case-insensitive).

This matches the same heuristics used by the Blast Radius and Impact Gate
workers.

## Gate Status Detection

The scan parses each issue's comment thread looking for the regex:

```
^## Impact Gate:\s+(PASS|FAIL|BYPASSED|ERROR|SKIPPED)
```

The regex uses `re.MULTILINE` so it matches at the start of any line in the
comment body. This matches the comment format produced by the Impact Gate
worker's `_build_pass_comment()`, `_build_fail_comment()`,
`_build_bypass_comment()`, and `_build_escalation_comment()`.

## Rollback Procedure

If the scan-done workflow starts producing incorrect results or false alerts:

1. **Disable the workflow:** Navigate to GitHub → Actions → Impact Gate Scan
   Done → ⋮ → Disable workflow.
2. **Revert scan code** to the last known-good commit:
   ```bash
   git revert <bad-commit-hash> --no-edit
   git push origin main
   ```
3. **Delete stale alert issues** if the CTO received incorrect alerts. There
   is no automated alert-cleanup — delete alert issues manually from the
   Paperclip UI.
4. **Re-enable workflow** after the fix is deployed.

To manually delete an incorrect alert issue:
```bash
curl -X DELETE "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| Scan reports "0 total done fix issues" | No fix/bug issues in `done` status | Check Paperclip status filter; may be correct |
| Scan reports ungated that are actually gated | Gate comment format mismatch | Verify the issue's gate comment matches `^## Impact Gate: (PASS\|FAIL\|BYPASSED\|ERROR|SKIPPED)` |
| Alert not created despite ungated > 0 | API credentials missing | Verify `PAPERCLIP_API_*` env vars |
| | Script exited before alert step | Check step order in workflow |
| Retroactive gating fails silently | Runner error in `process_issue` | Check logs for `Retroactive gate failed for`; may need manual gating |
| Scan is slow | Large number of done issues | Use `--days-back N` to limit scope |
| QT platform plugin error | Missing system dependencies | Verify `QT_QPA_PLATFORM=offscreen` and Qt libs are installed |
| Duplicate alert issues | Previous alert not closed | The workflow creates a new alert each run — no dedup logic exists |

## Related Documents

- `scripts/scan_fix_issues_done.py` — Scan runner implementation
- `scripts/scan_done_alert.py` — Alert creation implementation
- `src/impact_gate/worker.py` — Impact Gate worker (used for retroactive gating)
- `src/touch_index/paperclip_client.py` — Paperclip API client
- `tests/test_impact_gate/test_scan_done.py` — Unit tests for scan runner
- `tests/test_impact_gate/test_scan_done_alert.py` — Unit tests for alert script
- `.github/workflows/impact-gate-scan-done.yml` — CI/CD workflow
- `docs/runbook-blast-radius-worker.md` — Related Blast Radius worker runbook

## Done-Guard (BTCAAAAA-25832)

The Impact Gate and Blast Radius workers include a **done-guard** to prevent
agent-comment-triggered reopen loops. The Paperclip platform reopens a `done`
issue when a comment is posted on it, which creates an infinite wake loop if an
agent's heartbeat logic posts comments unconditionally.

### Guard layers

| Layer | Location | Behavior |
|---|---|---|
| Client | `transition_issue_status_board()` in `paperclip_client.py` | Refuses to transition a `done` issue to a non-`done` status |
| Impact Gate | `_post_comment()` and `process_issue()` in `worker.py` | Skips comment posting when `is_issue_done()` returns True; mutes all mutations (comments, transitions, blocking issues) when scanning already-done issues |
| Blast Radius | `_post_comment()` in `generator.py` | Skips comment posting when `is_issue_done()` returns True |

### Fail-safe behavior

When the guard check itself fails (network error, API timeout), the guard
silently passes through — comments are still posted rather than being silently
dropped. This prevents false-negative suppression during API outages.

### Mute persistence

Retroactive gating on done issues persists a muted gate result via
`save_muted_gate_result()` so future scans skip the issue entirely. This
avoids repeated API calls to already-gated done issues.

### Verification

See `tests/bug_regression/test_btcaaaaa_25832_regression.py` for the full
regression suite covering all three guard layers.
