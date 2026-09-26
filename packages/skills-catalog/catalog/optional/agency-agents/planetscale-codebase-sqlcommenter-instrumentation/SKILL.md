---
name: "planetscale-codebase-sqlcommenter-instrumentation"
description: "Inspect an application repository connected to PlanetScale and recommend SQLCommenter-compatible query tagging packages and conventions."
key: "paperclipai/optional/agency-agents/planetscale-codebase-sqlcommenter-instrumentation"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "planetscale"
  - "codebase"
  - "sqlcommenter"
  - "instrumentation"
defaultInstall: false
---
# Codebase SQLCommenter instrumentation

## Purpose

Inspect the application repository connected to PlanetScale and recommend the correct SQLCommenter-style instrumentation so PlanetScale Insights and Postgres Traffic Control can attribute queries to application code paths. Do not edit files or install dependencies without approval.

## Repository inspection

Identify:

- Language and framework.
- ORM or query builder.
- Database adapter.
- Migration tool.
- Background job system.
- Routing framework.
- Deployment metadata source, such as git SHA or release ID.
- Existing SQL comments, query tags, tracing, OpenTelemetry, or database middleware.
- PlanetScale connection configuration.
- Whether the repository connects to Vitess, Postgres, or both.

## Recommended package mapping

Use the most native maintained option for the detected stack.

### Ruby on Rails / ActiveRecord

Preferred for PlanetScale tag compatibility:

- `activerecord-sql_commenter` from PlanetScale when Rails query comments need SQLCommenter format for PlanetScale Query Insights.

Other options:

- Rails built-in query logs when sufficient and compatible with the target database/Insights behavior.
- `marginalia` for older Rails or when Basecamp-style ActiveRecord query attribution is already in use.
- `sqlcommenter_rails` where the project already uses the OpenTelemetry SQLCommenter ecosystem.

Recommend tags:

- `application`
- `controller`
- `action`
- `job`
- `route`
- `release_sha`

### Laravel / PHP

Preferred:

- `spatie/laravel-sql-commenter` for SQLCommenter-format comments compatible with PlanetScale Query Insights.

Recommend tags:

- `application`
- `route`
- `controller`
- `action`
- `job`
- `queue`
- `release_sha`

### Prisma / TypeScript / JavaScript

Preferred:

- Prisma’s first-party SQL comments packages when Prisma is detected:
  - `@prisma/sqlcommenter`
  - `@prisma/sqlcommenter-query-tags`
  - `@prisma/sqlcommenter-trace-context`

Note: PlanetScale’s Postgres query-tag docs may list Prisma as lacking official SQLCommenter support, but Prisma’s own current docs provide first-party SQLCommenter packages. Prefer current Prisma docs when Prisma is detected.

Recommend tags:

- `application`
- `service`
- `route`
- `operation`
- `feature`
- `release_sha`

### Knex / Sequelize / Express / Node

Use SQLCommenter-compatible middleware or instrumentation from the OpenTelemetry SQLCommenter ecosystem where maintained and compatible.

Recommend tags:

- `application`
- `service`
- `route`
- `controller`
- `action`
- `feature`
- `release_sha`

### Kysely / Drizzle / Bun / custom query builders

If there is no maintained SQLCommenter package, recommend manual tagging at the database client boundary or query builder extension layer.

Requirements:

- Tags must be structured SQL comments.
- Tags must be inserted before the statement terminator.
- Tags must survive ORM, proxy, and pooler behavior.
- Values must be URL encoded and safe for SQL comments.
- Tags must be low-cardinality.

### Django / SQLAlchemy / psycopg2 / Flask / Python

Use SQLCommenter instrumentation from the OpenTelemetry SQLCommenter ecosystem where compatible.

Recommend tags:

- `application`
- `framework`
- `route`
- `view`
- `job`
- `release_sha`

### Java / Hibernate / Spring

Use SQLCommenter-compatible instrumentation for Hibernate/Spring where compatible.

Recommend tags:

- `application`
- `service`
- `controller`
- `action`
- `route`
- `release_sha`

### Go / database/sql / net/http / gorilla/mux

Use SQLCommenter-compatible instrumentation or a database wrapper at the query boundary.

Recommend tags:

- `application`
- `service`
- `handler`
- `route`
- `job`
- `release_sha`

## Standard tag policy

Recommend this baseline across all frameworks:

- Stable, bounded values only.
- Normalize routes before tagging.
- Include app/service/job attribution.
- Include deploy SHA.
- Include source type for agents, scripts, BI, workers, and integrations.
- Do not include secrets, PII, user IDs, request IDs, raw tenant IDs, or raw URLs.

## Validation plan

Before recommending merge:

- Confirm generated SQL comments appear in local/staging query logs.
- Confirm comments survive the ORM, driver, pooler, and PlanetScale connection path.
- Confirm Insights displays tags.
- Confirm tag cardinality is bounded.
- Confirm Traffic Control can match the intended tags for Postgres.
- Confirm no sensitive data is present.

## Output

Return:

- Detected stack.
- Current query tagging state.
- Recommended package or manual instrumentation path.
- Proposed tag schema.
- Files likely to change.
- Validation steps.
- Risks.
- Proposed changes requiring approval.

End with:

“No repository files or dependencies have been changed.”
