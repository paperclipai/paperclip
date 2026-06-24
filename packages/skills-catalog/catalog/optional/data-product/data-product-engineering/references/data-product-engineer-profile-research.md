# Data Product Engineer Profile Research — 2026-06-20

## Why this reference exists

William had two connected pain points:

1. **Tally registration dashboard** — current dashboard likely visualizes poorly understood CSV data; need proper EDA and dashboard recommendations before implementation.
2. **HMA accounting project** — local finance/data pipeline was painful because agents needed repeated correction through bronze/silver/gold, extraction QA, anomaly interpretation, and dashboard migration.

The durable lesson is that local data projects need a workflow/profile contract, not a vague `analyst` persona.

## External research synthesis

### Medallion architecture

Databricks frames medallion architecture as progressive quality layers: bronze/raw, silver/validated, gold/enriched/business-ready.

Agent implication: use bronze/silver/gold as artifact contracts, not ceremony. Every layer needs row counts, purpose, tests, and lineage.

Source: https://docs.databricks.com/aws/en/lakehouse/medallion

### DuckDB for CSV ingestion and EDA

DuckDB can sniff CSV dialect, header, delimiter, and types with CSV auto-detection and `sniff_csv()`. It also supports explicit recovery options when inference is wrong: overriding header, names, types, `sample_size=-1`, `union_by_name`, etc.

Agent implication: first EDA step should inspect/sniff CSV; do not infer types from headers by vibes.

Sources:
- https://duckdb.org/docs/current/data/csv/auto_detection.html
- https://duckdb.org/docs/current/data/csv/tips.html

### dbt-style sources/tests/semantic layer

Relevant patterns:

- dbt data tests are SQL assertions returning failing records.
- Built-in tests include `unique`, `not_null`, `accepted_values`, and `relationships`.
- dbt sources document upstream data and can support freshness checks.
- semantic models define entities and dimensions; metrics define reusable formulas.

Agent implication: even without full dbt, copy the shape: source declarations, tests that emit failing rows, named metrics, and docs.

Sources:
- https://docs.getdbt.com/docs/build/data-tests
- https://docs.getdbt.com/docs/build/sources
- https://docs.getdbt.com/docs/build/semantic-models
- https://docs.getdbt.com/docs/build/metrics-overview

### Evidence.dev

Evidence.dev is SQL/Markdown for reports/data apps. It can use database sources and flat files, extracts sources to Parquet, and supports DuckDB-dialect SQL in Markdown.

Agent implication: good target for local inspectable dashboards because pages and queries are text-reviewable. But metric formulas should still live in named SQL views/sources, not hidden only inside page-local SQL.

Sources:
- https://docs.evidence.dev/
- https://docs.evidence.dev/core-concepts/data-sources/
- https://docs.evidence.dev/core-concepts/queries/

### Data profiling and contracts

- ydata-profiling can generate reports/statistics/visualizations and surface missing data, duplicates, and outliers.
- Frictionless schemas/data packages give lightweight CSV contracts.
- SodaCL-style checks provide vocabulary for missingness, validity, duplicates, row count, freshness, schema, failed rows, and referential integrity.

Agent implication: create `profile_findings.md`, optional HTML/JSON profiling report, schema/contract files, and data-quality checks. Treat these as deliverables, not chat narration.

Sources:
- https://docs.profiling.ydata.ai/latest/
- https://docs.profiling.ydata.ai/latest/getting-started/quickstart/
- https://framework.frictionlessdata.io/docs/guides/describing-data.html
- https://docs.soda.io/soda-documentation/soda-v3/soda-cl-overview

### Agent workflow design

Anthropic’s agent guidance emphasizes simple, composable workflows before open-ended autonomy.

Agent implication: for data products, define fixed phases and gates. Let agents iterate autonomously only inside bounded steps.

Source: https://www.anthropic.com/engineering/building-effective-agents

### Chart selection

Data-to-Viz and Vega-Lite reinforce that chart type should follow data structure.

Agent implication: dashboard recommendations should be data-shape driven: time series, category comparison, distribution, relationship, part-to-whole, operational table/card views.

Sources:
- https://www.data-to-viz.com/
- https://vega.github.io/vega-lite/docs/

## Local HMA project inspection summary

Repo inspected during the session:

- Local path: `/Users/alt/repo/hma-accounting`
- Remote: `https://github.com/Doweig/hma-accounting.git`
- Stack: Python ingestion, canonical CSVs, generated DuckDB (`data/portfolio.duckdb`), Evidence.dev dashboard, Git LFS-backed bronze evidence.

### Observed architecture

1. **Bronze/raw**
   - `data/bronze/hma/guillaume-verbal/`
   - raw `.eml`, attachments, manifests, rejected/skipped audits
   - raw emails partitioned by immutable email chronology, not parsed accounting month

2. **Silver/review**
   - staging outputs under `.local/hma-extraction/staging/`
   - versioned review/golden artifacts under `data/golden/hma/...`
   - Excel inspection under `data/silver/hma_excel_latest/`

3. **Canonical facts**
   - `data/monthly_pl.csv`
   - `data/dividends.csv`
   - `data/restaurants.csv`
   - `data/investments.csv`
   - `data/ownership.csv`

4. **Gold/query layer**
   - DuckDB metric views from `ingestion.metric_views.create_metric_views`
   - examples: annual revenue, valuation base, portfolio return summary, IRR cashflow base

5. **Presentation**
   - Evidence.dev pages such as raw/audit, financials, returns, portfolio

### What worked

- Local-first command surface with Makefile tasks.
- Raw evidence preserved before parsing.
- Query/metric layer in DuckDB views.
- Evidence.dev as reviewable dashboard surface.
- Dashboard abstraction ladder: Raw/Audit → Financials → Returns → Portfolio.

### What was painful

- Medallion labels did not eliminate ambiguity.
- Bronze scope drifted until active scope became P&L/accounting-source-only.
- Reply-thread chatter polluted candidate/coverage counts because quoted original P&L tables looked like new P&L content.
- Silver review risked becoming manual row approval instead of exception review.
- Initial extraction could miss secondary/detail/ratio tables.
- Dashboard source drift appeared when old raw-ish sources remained after metric views existed.
- Excel trackers were cumulative evidence snapshots, not canonical ledgers.

### Durable fixes

- Define active bronze scope explicitly.
- Preserve rejected/skipped evidence without counting it in active coverage.
- Detect quoted replies/top-body content before candidate selection.
- Use small benchmark sets before full-corpus parsing.
- Use LLM extraction as fallback/review for ambiguous rows, not default bulk processing when deterministic parsing is reliable.
- Capture flexible details as normalized rows/cells before widening facts.
- Add machine quality gates early: coverage, uniqueness, required fields, accepted values, arithmetic/business invariants.
- Add lineage beside canonical facts.
- Audit dashboard pages/sources after metric-layer migrations.

## Proposed Hermes skill/profile architecture

### Skills first

Create reusable class-level skills before creating a new profile:

- `data-product-engineering` — umbrella, this skill.
- Possible future support templates/scripts under this skill:
  - `templates/project_brief.md`
  - `templates/dashboard_spec.md`
  - `templates/metric_glossary.md`
  - `scripts/profile_csv_duckdb.py`
  - `scripts/generate_quality_report.py`

### Profile later

If this workflow is used on 2–3 projects, create a Hermes profile named `data-product-engineer` with:

- file, terminal, code execution, browser, skills, session search, GBrain access
- optional Jupyter live kernel
- no live email/Slack/GitHub write access by default
- strong instruction to produce artifacts and verification output
- explicit prohibition on dashboard implementation before profile/quality/spec gates

### Role split for bigger projects

- Researcher: source semantics and external best practices.
- Profiler: EDA and grain/key reports.
- Pipeline engineer: DuckDB/dbt transformations and tests.
- Dashboard spec writer: charts/filters/pages from metric and quality reports.
- Builder: Evidence implementation.
- Reviewer: metric/source-drift/quality audit.

Alt remains accountable for final orchestration and synthesis.

## Tally registration recommended first pass

Do not improve the existing HTML dashboard first. First produce:

1. `profile_findings.md`
2. `grain_and_keys.md`
3. `semantic_model.md`
4. `data_quality.md`
5. `dashboard_spec.md`
6. DuckDB metric views
7. Evidence.dev dashboard only after those are coherent

Likely filters: curriculum/program, status, date/time, location/cohort/source/channel, participant/school/company category if present.

Likely measures: registration count, unique participants/organizations, completion/submission count, payment/attendance/completion only if columns exist and semantics are clear.

Likely audit views: duplicates, missing critical fields, impossible dates, inconsistent labels, high-cardinality fields that should not be filters, and hidden PII.
