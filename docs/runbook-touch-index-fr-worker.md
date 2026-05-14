# Runbook: Touch Index FR Ingestion Worker

## Overview

The Touch Index FR (Feature Request / FDR) Ingestion Worker maintains the
`touch_index_fr_files` table in PostgreSQL — a data catalog that tracks which
source files were touched by each FDR-labelled issue.

This data powers:
- **Blast Radius** — when a bug fix is proposed, the system queries
  `touch_index_fr_files` to find which FDR issues might be impacted
- **Impact Gate** — validates that fix issues don't break FR requirements
- **Data Catalog** — provides clean file-reference APIs for backtesting and
  strategy analysis

## Architecture

```
                    Paperclip API
                         |
    +--------------------+--------------------+
    |                    |                    |
    v                    v                    v
  FR Worker          Bug Worker         Blast Radius
  (this worker)      (sibling)          (consumer)

  FR Worker flow:
    1. Poll Paperclip for FDR-labelled issues updated in last N minutes
    2. For each issue, extract file paths (priority order):
       a. Comments — implementing agent's done-comment mentions files
       b. Git history — commits referencing the issue identifier
       c. Issue description — lower-signal text extraction
    3. Upsert rows into touch_index_fr_files
    4. Transition each processed issue to "done"
    5. Run data quality validation
```

### File extraction strategy

| Priority | Source | Signal | How it works |
|----------|--------|--------|--------------|
| 1 (best) | **Comments** | High | `comment_extractor.fetch_and_extract()` — parses backtick-wrapped and bare paths from issue comments |
| 2 | **Git history** | Medium | `git_extractor.get_files_for_issue()` — finds commits whose message contains the issue ID |
| 3 | **Description** | Low | `comment_extractor.extract_files_from_text()` — parses the issue body text |

## CLI Usage

### Polling mode (default)

```bash
cd /path/to/repo
PYTHONPATH=src python -m touch_index fr
```

### Single issue (webhook trigger)

```bash
python -m touch_index fr --issue-id <uuid>
```

### Flags

| Flag | Description |
|------|-------------|
| `--issue-id <uuid>` | Process a single FDR issue by Paperclip UUID |
| `--lookback-minutes <N>` | Process issues updated within N minutes (default: 30) |
| `--dry-run` | Log what would be ingested without writing to DB or transitioning |
| `--validate` | Run data quality validation after ingestion (exits non-zero on failure) |
| `--json-summary` | Output structured JSON summary to stdout |

### Through the runner script

```bash
python scripts/run_touch_index_fr_worker.py [--lookback-minutes N] [--dry-run] [--validate] [--json-summary]
python scripts/run_touch_index_fr_worker.py --issue-id <uuid> [--dry-run] [--validate] [--json-summary]
```

### Console script entry point

```bash
touch-index fr [options]
touch-index-fr [options]
```

## CI/CD Pipeline

Workflow: `.github/workflows/touch-index-fr-worker.yml`

### Triggers

| Trigger | Schedule / Event |
|---------|-----------------|
| `schedule` | Every 15 minutes (`*/15 * * * *`) |
| `repository_dispatch` | `issue_created`, `issue_updated`, `issue_status_changed` |
| `workflow_dispatch` | Manual trigger with optional `issue_id`, `lookback_minutes` |

### Concurrency

Group: `touch-index-fr-worker` — `cancel-in-progress: false` ensures runs queue
rather than cancel each other.

### Step sequence

1. **Checkout** the repository
2. **Set up Python** 3.12
3. **Install dependencies** from `requirements.txt`
4. **Resolve issue ID** from event payload (supports both `workflow_dispatch`
   inputs and `repository_dispatch` client_payload)
5. **Run FR worker** with appropriate flags
6. **Validate FR data quality** (always, even on worker failure)

### Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `PAPERCLIP_API_URL` | Secret | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | Secret | API authentication |
| `PAPERCLIP_COMPANY_ID` | Secret | Company/org ID |
| `POSTGRES_HOST` | Secret | PostgreSQL host |
| `POSTGRES_PORT` | Secret | PostgreSQL port (default: 5432) |
| `POSTGRES_DB` | Secret | Database name (default: optimizer_v3) |
| `POSTGRES_USER` | Secret | Database user (default: optimizer_admin) |
| `POSTGRES_PASSWORD` | Secret | Database password |

## Database Schema

### `touch_index_fr_files`

```sql
CREATE TABLE touch_index_fr_files (
    id                UUID        NOT NULL DEFAULT gen_random_uuid(),
    file_path         TEXT        NOT NULL,
    fr_issue_id       UUID        NOT NULL,
    fr_identifier     TEXT        NOT NULL,
    fr_owner_agent_id UUID        NOT NULL,
    source            TEXT        NOT NULL DEFAULT 'unknown',
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX uq_touch_fr_file_issue
    ON touch_index_fr_files (file_path, fr_issue_id);

CREATE INDEX idx_touch_fr_file_path
    ON touch_index_fr_files (file_path);
```

- `source` values: `'comments'`, `'git'`, `'description'`, `'unknown'`
- `fr_owner_agent_id` is set to `00000000-0000-0000-0000-000000000000` when the
  issue has no assignee
- The unique constraint on `(file_path, fr_issue_id)` makes upserts idempotent

## Local Development

### Setup

```bash
cd /path/to/repo
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your PAPERCLIP_API_KEY, POSTGRES_PASSWORD, etc.
```

### Run tests

```bash
# All touch index tests (327 tests)
python -m pytest tests/test_touch_index/ -v

# FR worker-specific tests
python -m pytest tests/test_touch_index/test_fr_worker.py -v

# With coverage
python -m pytest tests/test_touch_index/ \
  --cov=src/touch_index --cov-report=term-missing
```

### Dry-run test

```bash
PYTHONPATH=src python -m touch_index fr --dry-run
```

### Process a known FDR issue

```bash
PYTHONPATH=src python -m touch_index fr --issue-id <uuid> --dry-run
```

### Validate existing data

```bash
python scripts/validate_touch_index_fr.py --stale-hours 168
```

## Data Quality Monitoring

The `touch_index.quality` module provides three categories of checks:

### Coverage

Compares FDR issues in Paperclip vs `touch_index_fr_files`. Alerts when
coverage drops below 90%.

```bash
python -c "
from touch_index.db import get_engine
from touch_index.quality import run_quality_checks
print(run_quality_checks(get_engine()))
"
```

### Freshness

Reports row age statistics and flags stale rows (updated_at older than the
threshold, default 168 hours / 7 days).

### Consistency

Detects:
- Null owner rows (sentinel UUID)
- Null `updated_at` values
- Duplicate `(file_path, fr_issue_id)` pairs
- Orphan `fr_issue_id` values (issue no longer exists in Paperclip)
- **Source distribution** — counts of rows by extraction method
  (`comments`, `git`, `description`) for monitoring extraction health

### Quality report structure (JSON)

```json
{
  "passed": true,
  "coverage": {
    "total_fdr_issues": 42,
    "indexed_fdr_issues": 40,
    "coverage_pct": 95.2,
    "missing_issue_identifiers": ["BTCAAAAA-XYZ"]
  },
  "freshness": {
    "total_rows": 320,
    "max_age_hours": 12.5,
    "min_age_hours": 0.1,
    "stale_rows": 0,
    "stale_threshold_hours": 168
  },
  "consistency": {
    "null_owner_rows": 0,
    "null_updated_at_rows": 0,
    "duplicate_pairs": 0,
    "orphan_fr_issue_ids": []
  }
}
```

## Watermark Strategy

The worker uses a 30-minute look-back window (configurable via
`--lookback-minutes`) with idempotent upserts. This means:

- No watermark state file is needed
- Re-processing is safe (the `ON CONFLICT DO UPDATE` handles duplicates)
- Late-firing routines are covered by the overlap window
- Single-issue webhook events are processed immediately with no look-back

## Rollback Procedure

If the FR worker begins ingesting incorrect file references:

1. **Disable the workflow:** GitHub Actions -> Touch Index FR Worker -> Disable workflow
2. **Rollback the worker code:**
   ```bash
   git revert <bad-commit-hash> --no-edit
   git push origin main
   ```
3. **Clean corrupted data:**
   ```sql
   DELETE FROM touch_index_fr_files WHERE fr_issue_id = '<bad-uuid>';
   DELETE FROM touch_index_fr_files WHERE updated_at > '<bad-timestamp>';
   ```
4. **Re-enable workflow** after the fix is deployed

## Monitoring & Alerting

Key log lines at `INFO` level:

| Log pattern | Meaning |
|-------------|---------|
| `Fetching FDR issues updated after ...` | Poll cycle started |
| `Found N FDR issue(s) to process` | Issues to ingest this cycle |
| `FR %s: indexed N file(s) via %s` | Successfully ingested issue |
| `FR %s: no files found in comments, git, or description` | No extractable files |
| `Marked %s as done` | Issue transitioned in Paperclip |
| `Failed to mark %s as done` | Transition API call failed |
| `VALIDATION PASSED` | All quality checks clean |
| `VALIDATION FAILED` | Quality check threshold breached |
| `COVERAGE: N%` | Coverage metric |
| `FRESHNESS: N stale rows` | Staleness metric |
| `CONSISTENCY: ...` | Consistency issues detected |

The `--json-summary` flag outputs structured JSON suitable for downstream
automation and dashboards.

## Troubleshooting

| Symptom | Likely Cause | Action |
|---------|-------------|--------|
| No issues processed | No FDR issues updated in window | Check `--lookback-minutes` value |
| | API credentials missing | Verify `PAPERCLIP_API_*` env vars |
| | DB connection failure | Check `POSTGRES_*` env vars |
| 0 files indexed for all issues | No done-comments on issues | Check if implementing agents post file references |
| | Git extraction failing | Check repo is cloned with full history |
| Validation fails | Coverage below 90% | Run backfill to catch missed issues |
| | Stale rows detected | Check worker cron schedule |
| | Orphan rows | Clean up deleted issues from DB |
| Duplicate rows | Unique constraint not enforced | Run `validate_touch_index_fr.py` to detect |
| Worker exits non-zero | DB health check failed | Verify PostgreSQL is reachable |
| | Paperclip API timeout | Retry; check API status |

## Related Documents

- `src/touch_index/fr_worker.py` — Worker implementation
- `src/touch_index/__main__.py` — Unified CLI entry point
- `src/touch_index/quality.py` — Data quality monitoring
- `src/touch_index/comment_extractor.py` — File path extraction from text
- `src/touch_index/git_extractor.py` — File path extraction from git history
- `src/touch_index/paperclip_client.py` — Paperclip API client
- `src/touch_index/db.py` — PostgreSQL connection factory
- `alembic/versions/20260511_add_touch_index_tables.py` — Schema migration
- `alembic/versions/20260512_add_fr_files_source_col.py` — Source column migration
- `.github/workflows/touch-index-fr-worker.yml` — CI/CD workflow
- `scripts/run_touch_index_fr_worker.py` — Runner script
- `scripts/validate_touch_index_fr.py` — Validation script
- `scripts/backfill_touch_index.py` — 90-day backfill script
