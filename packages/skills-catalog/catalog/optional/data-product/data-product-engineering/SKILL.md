---
name: data-product-engineering
description: "Use when turning messy CSVs, spreadsheets, source tables, or local datasets into reliable data products: EDA, DuckDB/dbt-style medallion pipelines, quality gates, metric layers, dashboard specs, and Evidence.dev dashboards."
key: paperclipai/optional/data-product/data-product-engineering
defaultInstall: false
recommendedForRoles:
  - engineer
  - data
  - cto
  - product
tags:
  - data-product
  - data-engineering
  - eda
  - duckdb
  - dashboards
  - data-quality
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [data-science, data-engineering, eda, csv, duckdb, dbt, evidence-dev, dashboards, data-quality]
    related_skills: [jupyter-live-kernel, financial-data-pipelines, software-development-workflows]
---

# Data Product Engineering

## Overview

Use this skill for recurring local data-product work: CSV or spreadsheet exploration, DuckDB warehouses, dbt/dbt-shaped transformations, medallion architecture, data-quality gates, semantic/metric layers, dashboard recommendations, and Evidence.dev implementation.

The core lesson: do **not** behave like a vague “analyst.” Behave like a **Data Product Engineer**. Produce durable artifacts and verification output that reduce user micromanagement.

## When to Use

- The user asks for data analysis, EDA, CSV profiling, dashboard recommendations, or “what can we build from this dataset?”
- A dashboard exists but seems wrong because the underlying data/model/metrics are unclear.
- The user mentions DuckDB, Evidence.dev, dbt, medallion architecture, bronze/silver/gold, semantic layer, metric layer, or data quality.
- A project needs transformation from raw CSV/spreadsheet/email/table data into a reliable local dashboard or report.
- The user is deciding whether to create a dedicated data agent/profile.

Do not use this for finance/accounting-specific ingestion details when `financial-data-pipelines` fits better; use that skill for HMA/bookkeeping/email/P&L/dividend workflows. Use this skill as the general umbrella and finance as the specialized subclass.

## Core Stance

1. **Dashboard bugs are usually data-product bugs.** Do not start by polishing HTML or charts when grain, quality, semantics, and metrics are unproven.
2. **Profile before transforming.** First prove what the data contains: schema, row count, nulls, unique values, distributions, duplicates, date ranges, outliers, PII, and candidate keys.
3. **Name the row grain early.** Every downstream metric depends on what one row represents.
4. **Use Kimball-style dimensional modeling after profiling.** Identify the business process, declare the row grain, then separate conformed dimensions from fact tables so dashboards get stable filters/selectors and measures.
5. **Separate dimensions from facts.** Identify identifiers, dates, dimensions/filters, measures/facts, statuses/enums, text, PII, and junk/admin fields.
6. **Use layers as contracts, not ceremony.** Bronze/silver/gold is useful only if each layer has explicit artifacts, tests, and row-count lineage.
7. **Centralize metric logic.** Metrics belong in DuckDB/dbt views or metric YAML/Markdown, not buried only inside dashboard pages.
8. **Tests before charts.** A dashboard over untested data is a lie with CSS.
9. **Show failing rows and exceptions.** Quality gates should produce example rows and decisions, not raw anomaly dumps.
10. **Generate a dashboard spec before implementing.** Recommend filters, charts, KPI cards, drilldowns, exclusions, and audit pages from actual data shape.
11. **End with a handoff.** Report artifacts, assumptions, verification commands, quality status, and remaining decisions.

## Default Stack Choices

- **Tiny one-off CSV:** DuckDB SQL + Markdown findings.
- **One/few CSVs feeding a dashboard:** DuckDB database + SQL views + Evidence.dev.
- **Repeated refresh or multi-source transformations:** dbt-duckdb or dbt-shaped folders (`models/bronze`, `models/silver`, `models/gold`) with tests/docs.
- **Heavy validation/external sharing:** add Frictionless schema, Great Expectations, Soda-style checks, or dbt tests.
- **Interactive exploration:** use Python/Jupyter when stateful iteration helps, but move business logic into SQL once it becomes part of the product.

## Workflow

### 0. Intake Brief

Create or update `docs/project_brief.md` with:

- decision the dashboard/report should support
- audience and review device
- refresh cadence
- source files and provenance
- primary grain hypothesis
- must-have metrics
- must-have filters
- sensitive fields / PII rules
- known caveats

If the user says “just start,” do not block. Proceed with provisional assumptions and mark them in `docs/assumptions.md`.

### 1. Bronze Ingest

Preserve source truth.

Recommended artifacts:

```text
data/bronze/raw/<source>_<date>.csv
data/bronze/manifests/<source>_<date>.json
warehouse/local.duckdb
```

Manifest should include: file path, size, SHA-256, row count, column count, detected delimiter/header/encoding, detected or forced schema, source/export notes, and load timestamp.

For CSVs, use DuckDB sniffing or equivalent before trusting inferred types. If sniffing is wrong, explicitly set delimiter/header/types/names/all-varchar and document why.

### 2. EDA / Profiling

Required artifacts:

```text
reports/profile/profile_findings.md
reports/profile/profile_report.html or profile_report.json
docs/data_dictionary.md
docs/grain_and_keys.md
```

Minimum profile checks:

- row/column count
- inferred types vs expected types
- null/blank counts
- duplicate rows
- candidate key duplicates
- date ranges and parse failures
- categorical distinct counts and top values
- numeric mean/median/min/max/percentiles/outliers
- impossible values
- high-cardinality fields
- PII/sensitive fields
- grain hypothesis

Only ask follow-up questions after profiling narrows the ambiguity.

### 3. Semantic Classification

Create `docs/semantic_model.md` classifying columns into:

- identifiers / candidate keys
- dates / time dimensions
- dimensions / filters
- facts / numeric measures
- statuses/enums
- free text
- PII/sensitive fields
- junk/admin columns

Explicitly state which columns are safe dashboard filters and which are measures.

### 3.5 Kimball / Dimensional Model

After the semantic classification, design the query model in Kimball terms before building dashboards:

- **Business process:** what event/process the fact table represents (registration, payment, attendance, order, invoice line, session, etc.).
- **Declared grain:** exactly what one row in each fact table means. If the grain is mixed, split the table or normalize before aggregating.
- **Fact tables:** additive/semi-additive/non-additive measures plus foreign keys to dimensions; avoid descriptive attributes living only in facts when they are used as filters.
- **Dimension tables:** conformed filters/selectors such as date, customer/person/org, product/program, location, source/channel, status, cohort, campaign, account/category, etc.
- **Date dimension:** default to a reusable `dim_date`/calendar spine when time filtering, period grouping, fiscal periods, or missing-date zero-fill matters.
- **Degenerate dimensions:** keep invoice/order/reference numbers on the fact when they identify a transaction but do not deserve a full dimension.
- **Bridge tables:** use for many-to-many relationships or multi-select fields rather than stuffing arrays into dashboard logic.
- **Surrogate keys:** create stable keys where natural keys are dirty, mutable, composite, or absent; preserve source keys for lineage.
- **Conformed dimensions:** reuse the same dimension definitions across marts so filters mean the same thing on every dashboard page.

Deliver `docs/dimensional_model.md` for non-trivial projects. It should list fact tables, dimensions, keys, grain, measures, filter fields, and unresolved modeling choices.

### 4. Silver Models

Goal: typed, cleaned, auditable source rows. No business aggregation yet.

Common tasks:

- normalize column names
- parse dates/timestamps
- trim/normalize strings
- standardize enums/statuses
- mark or dedupe duplicates
- create surrogate keys when needed
- split multi-select fields
- isolate/hash PII
- add provenance columns: `source_file`, `loaded_at`, `row_number`, `row_hash`

Required artifact: `reports/quality/silver_quality.md` with row counts and failed examples.

### 5. Gold / Metric Layer

Goal: dashboard-ready Kimball-style facts/dimensions/metric views.

Artifacts:

```text
models/gold/*.sql
docs/dimensional_model.md
docs/metric_glossary.md
```

Metric definitions need: name, formula, grain, filters, source model, owner/assumption, caveats.

Do not implement charts until the metric layer is explicit.

### 6. Quality Gates

Artifacts:

```text
reports/quality/data_quality.md
reports/quality/failing_rows/*.csv
```

Minimum gates:

- row count preservation or explained deltas between layers
- not-null fields
- uniqueness/candidate-key checks
- accepted values for important categories
- relationship checks for dimensions
- date range sanity
- metric sanity ranges
- freshness/source-date checks
- dashboard-blocking issues vs tolerable warnings

Quality work should find and fix root causes. Do not dump anomaly files and call that done.

### 7. Dashboard Recommendation / Spec

Create `reports/dashboard_specs/dashboard_spec.md` before implementation.

Include:

- dashboard purpose
- pages/tabs
- global filters
- KPI cards
- charts with data sources and chart types
- drilldowns/tables
- audit/quality page
- metrics intentionally excluded
- data issues blocking trustworthy charts
- mobile considerations

Chart selection should follow data shape:

- time series → line/area
- category comparison → bar
- low-cardinality part-to-whole → stacked bar or limited pie/donut
- distribution → histogram/boxplot
- relationship → scatter
- operational review → tables/cards with drilldown

### 8. Evidence.dev Implementation

Evidence.dev is a strong default for local SQL/Markdown dashboards.

Rules:

- Evidence pages consume named SQL views/sources, not hidden page-local formulas.
- Start with audit and summary pages before design polish.
- Verify sources/build before claiming success.
- For phone review, test at a concrete mobile viewport such as 390px.
- After metric-layer changes, search dashboard sources/pages for old raw table names to avoid source drift.

## Role Splitting for Larger Projects

For painful multi-source projects, split work into bounded roles:

- **Data researcher:** source semantics and best-practice patterns.
- **Data profiler:** EDA artifacts and grain/key findings.
- **Pipeline engineer:** DuckDB/dbt transformations and tests.
- **Dashboard spec writer:** pages/charts/filters/spec from metric layer and quality report.
- **Dashboard builder:** Evidence implementation.
- **Reviewer:** audits quality gates, metric definitions, source drift, and dashboard truthfulness.

Alt remains accountable for orchestration and final synthesis. Subagents should not mutate canonical data without gates.

## HMA / Accounting Lessons Generalized

The HMA accounting project showed these durable patterns:

- Bronze scope must be explicit. Rejected/skipped inputs can be preserved as audit evidence without affecting active coverage.
- Reply-thread or duplicated source material can pollute coverage if the agent does not distinguish new top-body content from quoted/old content.
- Silver review should show examples and exception summaries; do not ask William to approve hundreds of clean rows.
- Flexible detail should be modeled as normalized detail rows/cells before widening canonical fact tables.
- Metric formulas should live in query views/semantic layer, not dashboard-only SQL.
- Add lineage beside canonical facts: source file/message ID, source row, extraction version, warnings, and review status.
- Audit dashboards are first-class product surfaces, not afterthoughts.

For full session-derived detail and source-backed rationale, see `references/data-product-engineer-profile-research.md`.

## Tally Registration Default Plan

For the Tally registration dashboard project, do **not** start by improving the current HTML dashboard. First produce:

1. `profile_findings.md`
2. `grain_and_keys.md`
3. `semantic_model.md`
4. `data_quality.md`
5. `dashboard_spec.md`
6. DuckDB metric views
7. Evidence.dev dashboard only after the data model is coherent

Likely filters: curriculum/program, status, date/time period, location/cohort/source/channel, participant/school/company category if present.

Likely measures: registration count, unique participants/organizations, completion/submission count, payment/attendance/completion metrics only if the columns exist and semantics are clear.

Likely audit views: duplicates, missing critical fields, impossible dates, inconsistent labels, high-cardinality non-filters, and hidden PII fields.

## Common Pitfalls

1. **Resurrecting vague `analyst`.** Name the capability around shipped data products, not generic analysis.
2. **Starting with dashboard code.** If the data quality/model is unclear, dashboard work is premature.
3. **Medallion cosplay.** Bronze/silver/gold labels without artifacts/tests create ceremony, not reliability.
4. **Asking the user too early.** Profile first; ask after ambiguity is evidence-backed.
5. **Dumping raw anomalies.** Group by root cause, show failing examples, fix/rerun when possible.
6. **Letting dashboard pages own business logic.** Centralize metrics in SQL/views/semantic docs.
7. **Skipping source-drift audit.** After adding metric views, verify dashboards no longer use old/raw sources silently.
8. **Overusing LLM extraction.** Prefer deterministic parsers for stable source formats; use LLMs for fallback/review/ambiguous cases.

## Verification Checklist

- [ ] Raw inputs preserved and manifest written.
- [ ] Schema/profile findings produced before transformation.
- [ ] Row grain and candidate keys stated.
- [ ] Dimensions/facts/measures/statuses/PII classified.
- [ ] Silver/gold transformations are documented and tested.
- [ ] Quality report distinguishes blocking issues from warnings.
- [ ] Metric glossary or semantic layer exists before charts.
- [ ] Dashboard spec exists before implementation.
- [ ] Evidence/dev/dashboard build and source checks ran when implemented.
- [ ] Final handoff lists artifacts, commands, assumptions, and next decisions.
