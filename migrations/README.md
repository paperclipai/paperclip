# Enrichment Staging — Database Migrations

[SAG-2147](/SAG/issues/SAG-2147) + [SAG-2149](/SAG/issues/SAG-2149) | Parent: [SAG-2136](/SAG/issues/SAG-2136)

Plain SQL migrations for the enrichment pipeline's isolated Postgres schema.
No migration runner required — apply with `psql` directly.

---

## Schema design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Schema name | `enrichment_staging` | Matches pilot terminology; clearly separate from `public` (production catalog) |
| Migration tool | Plain SQL + `psql` | No framework dependency; easy to audit; wraps each migration in a transaction |
| Status type | Postgres `ENUM` (typed) | Prevents invalid status strings at the DB level |
| Append-only enforcement | Role-level `GRANT INSERT` (no UPDATE/DELETE granted) | Strongest guarantee; survives application-layer bugs |
| FK to production | None | Hard constraint from issue spec; promotion is explicit `INSERT ... SELECT` |
| `anomaly_score` | `NUMERIC(5,4)` | 4 decimal places (0.0000–1.0000); matches validator.py output range |

**Which Postgres instance:** TBD — SSI Director sign-off required (acceptance criterion).
The migration is instance-agnostic and runs on any Postgres ≥ 13.

---

## Applying the migration

```bash
# Migration 001: schema + tables + roles (SAG-2147)
psql -U postgres -d <your_db> -f migrations/001_enrichment_staging_up.sql

# Migration 002: review view + enrichment_ui_reader role (SAG-2149)
psql -U postgres -d <your_db> -f migrations/002_review_view_up.sql

# Migration 003: pricing_staleness_alerts table + roles (SAG-6327 Phase 1)
psql -U postgres -d <your_db> -f migrations/003_pricing_staleness_alerts_up.sql

# Rollback 003, then 002, then 001
psql -U postgres -d <your_db> -f migrations/003_pricing_staleness_alerts_down.sql
psql -U postgres -d <your_db> -f migrations/002_review_view_down.sql
psql -U postgres -d <your_db> -f migrations/001_enrichment_staging_down.sql
```

Run as a superuser (`postgres`) or a role with `CREATEROLE` + `CREATE ON DATABASE`.

---

## Verifying permissions

After applying the forward migration, run the negative-test suite:

```bash
psql -U postgres -d <your_db> -f migrations/tests/test_permissions.sql

# Migration 003: pricing_staleness_alerts negative-test suite
psql -U postgres -d <your_db> -f migrations/tests/test_pricing_staleness_permissions.sql
```

Scan the output for any `UNEXPECTED` lines. Zero such lines = all checks passed.

`test_permissions.sql` verifies:
1. `enrichment_dispatcher` cannot INSERT/UPDATE/DELETE into `public` schema tables.
2. `enrichment_reviewer` cannot INSERT into `public` schema tables.
3. `enrichment_promotion_log` is append-only: INSERT allowed, UPDATE/DELETE denied for both roles.

`test_pricing_staleness_permissions.sql` verifies:
1. `pricing_staleness_writer` cannot INSERT into `public` schema tables.
2. `pricing_staleness_reader` cannot INSERT into `public` schema tables.
3. `pricing_staleness_alerts` is append-only: INSERT allowed for the writer role, UPDATE/DELETE denied for both roles.

---

## Tables

### `enrichment_staging.enrichment_queue`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `source_row_id` | TEXT | Catalog SKU or equivalent identifier |
| `payload_json` | JSONB | Raw source row sent to the enrichment model |
| `status` | ENUM | `pending` → `in_flight` → `done` \| `failed` |
| `created_at` | TIMESTAMPTZ | Auto-set |
| `started_at` | TIMESTAMPTZ | Set when dispatcher picks up the row |
| `finished_at` | TIMESTAMPTZ | Set on terminal status |

### `enrichment_staging.enrichment_staging`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `batch_id` | UUID | Groups rows processed in the same dispatcher run |
| `source_row_id` | TEXT | Matches `enrichment_queue.source_row_id` (no FK) |
| `primary_output_json` | JSONB | Model's primary enrichment output |
| `fallback_output_json` | JSONB | Fallback/secondary enrichment (if used) |
| `validator_result` | JSONB | Output from `validator.py` |
| `anomaly_score` | NUMERIC(5,4) | 0.0–1.0 from anomaly detector |
| `reviewer_verdict` | TEXT | Free-text verdict from reviewer agent or human |
| `human_approved_at` | TIMESTAMPTZ | |
| `human_approved_by` | TEXT | User or agent ID |
| `promoted_at` | TIMESTAMPTZ | Set when row is promoted to production |

### `enrichment_staging.enrichment_promotion_log`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `batch_id` | UUID | Batch that was promoted |
| `row_count` | INTEGER | Number of rows in this promotion event |
| `approver_agent_id` | TEXT | Paperclip agent ID of approver |
| `approver_user_id` | TEXT | Human user ID of approver |
| `promoted_at` | TIMESTAMPTZ | Auto-set; promotion timestamp |
| `payload_json` | JSONB | Snapshot of promoted rows or promotion metadata |

### `enrichment_staging.pricing_staleness_alerts`

[SAG-6327](/SAG/issues/SAG-6327) Phase 1 | Parent: [SAG-6302](/SAG/issues/SAG-6302)
Reconciled to the tested runner contract in [SAG-6353](/SAG/issues/SAG-6353).

Append-only detection-alert log written by the nightly pricing staleness runner
(SAG-6327 Phase 3+4, SAG-6344). One row per detection event across the four
signals (anomaly, version/hash drift, SLA breach, bulk escalation). Column
grain matches the runner's own `StalenessAlert` shape 1:1 — no reconciliation
layer needed between the two.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `signal_type` | TEXT | CHECK-constrained: `anomaly` \| `version_hash_drift` \| `sla_breach` \| `bulk_escalation` |
| `severity` | TEXT | CHECK-constrained: `warn` \| `critical` |
| `record_key` | TEXT | Plain text identifier; no FK; decoupled from Pricing's feed-spec grain (SAG-6341) |
| `detected_at` | TIMESTAMPTZ | Auto-set; indexed |
| `warm_up` | BOOLEAN | True while inside the Phase 4 30-day warm-up window |
| `details_json` | JSONB | Signal-specific evidence (pct_delta, versions, due/committed timestamps, etc.) |

Indexed on `(detected_at)` and `(record_key)` — the latter serves the Phase 5
freeze-arming check ("≥1 clean baseline median per record").

---

## Roles

| Role | Table | Privileges |
|---|---|---|
| `enrichment_dispatcher` | `enrichment_queue` | SELECT, INSERT, UPDATE |
| `enrichment_dispatcher` | `enrichment_staging` | SELECT, INSERT, UPDATE |
| `enrichment_dispatcher` | `enrichment_promotion_log` | INSERT only |
| `enrichment_reviewer` | `enrichment_queue` | SELECT only |
| `enrichment_reviewer` | `enrichment_staging` | SELECT, INSERT, UPDATE |
| `enrichment_reviewer` | `enrichment_promotion_log` | INSERT only |
| `pricing_staleness_writer` | `pricing_staleness_alerts` | SELECT, INSERT (append-only; nightly runner) |
| `pricing_staleness_reader` | `pricing_staleness_alerts` | SELECT only (digest / QA / freeze-arming consumers) |
| All roles | `public` schema | **No write access** (explicitly revoked) |
