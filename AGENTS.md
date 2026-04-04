# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Engineering Standards & Workspace Rules

This project uses formal **Workspace Rules** to ensure architectural consistency, security, and operational excellence. These rules are automatically applied by AI coding assistants.

AI contributors MUST adhere to the rules defined in [`.agents/rules/`](file:///c:/github/paperclip/.agents/rules/):

- **Company Scoping** ([`rule-company-scope.md`](file:///c:/github/paperclip/.agents/rules/rule-company-scope.md)): All entities must belong to a company.
- **Contract Sync** ([`rule-contract-sync.md`](file:///c:/github/paperclip/.agents/rules/rule-contract-sync.md)): Keep DB, Shared, Server, and UI layers in sync.
- **Task Invariants** ([`rule-task-invariants.md`](file:///c:/github/paperclip/.agents/rules/rule-task-invariants.md)): Protect single-assignee and atomic checkout.
- **Activity Logging** ([`rule-activity-logging.md`](file:///c:/github/paperclip/.agents/rules/rule-activity-logging.md)): Mandatory audit trails for mutations.
- **Secret Management** ([`rule-secret-management.md`](file:///c:/github/paperclip/.agents/rules/rule-secret-management.md)): Redaction and `company_secrets` references.
- **Database Workflow** ([`rule-db-workflow.md`](file:///c:/github/paperclip/.agents/rules/rule-db-workflow.md)): Guidelines for Drizzle migrations.
- **CLI Standards** ([`rule-cli-standards.md`](file:///c:/github/paperclip/.agents/rules/rule-cli-standards.md)): Consistent flags and profiles.
- **UI Expectations** ([`rule-ui-expectations.md`](file:///c:/github/paperclip/.agents/rules/rule-ui-expectations.md)): Premium design and error handling.
- **Plan Docs** ([`rule-plan-docs.md`](file:///c:/github/paperclip/.agents/rules/rule-plan-docs.md)): Centralized and dated `doc/plans/`.
- **Definition of Done** ([`rule-definition-of-done.md`](file:///c:/github/paperclip/.agents/rules/rule-definition-of-done.md)): Verification before hand-off.
- **Contribution Standards** ([`rule-contributing.md`](file:///c:/github/paperclip/.agents/rules/rule-contributing.md)): "Thinking Path" and visual proof.

## 6. Definition of Done

A change is considered complete when it satisfies the requirements in [`rule-definition-of-done.md`](file:///c:/github/paperclip/.agents/rules/rule-definition-of-done.md) and aligns with the contribution standards in [`rule-contributing.md`](file:///c:/github/paperclip/.agents/rules/rule-contributing.md).
