# Agent Companies Spec Inventory

This document indexes every part of the Paperclip codebase that touches the [Agent Companies Specification](docs/companies/companies-spec.md) (`agentcompanies/v1-draft`).

Use it when you need to:

1. **Update the spec** — know which implementation code must change in lockstep.
2. **Change code that involves the spec** — find all related files quickly.
3. **Keep things aligned** — audit whether implementation matches the spec.

---

## 1. Specification & Design Documents

| File | Role |
|---|---|
| `docs/companies/companies-spec.md` | **Normative spec** — defines the markdown-first package format (COMPANY.md, TEAM.md, AGENTS.md, PROJECT.md, TASK.md, SKILL.md), reserved files, frontmatter schemas, and vendor extension conventions (`.paperclip.yaml`). |
| `doc/plans/2026-03-13-company-import-export-v2.md` | Implementation plan for the markdown-first package model cutover — phases, API changes, UI plan, and rollout strategy. |
| `doc/SPEC-implementation.md` | V1 implementation contract; references the portability system and `.paperclip.yaml` sidecar format. |
| `docs/specs/cliphub-plan.md` | Earlier blueprint bundle plan; partially superseded by the markdown-first spec (noted in the v2 plan). |
| `doc/plans/2026-02-16-module-system.md` | Module system plan; JSON-only company template sections superseded by the markdown-first model. |
| `doc/plans/2026-03-14-skills-ui-product-plan.md` | Skills UI plan; references portable skill files and `.paperclip.yaml`. |
| `doc/plans/2026-03-14-adapter-skill-sync-rollout.md` | Adapter skill sync rollout; companion to the v2 import/export plan. |

## 2. Shared Types & Validators

These define the contract between server, CLI, and UI.

| File | What it defines |
|---|---|
| `packages/shared/src/types/company-portability.ts` | TypeScript interfaces: `CompanyPortabilityManifest`, `CompanyPortabilityFileEntry`, `CompanyPortabilityEnvInput`, export/import/preview request and result types, manifest entry types for agents, skills, projects, issues, companies. |
| `packages/shared/src/validators/company-portability.ts` | Zod schemas for all portability request/response shapes — used by both server routes and CLI. |
| `packages/shared/src/types/index.ts` | Re-exports portability types. |
| `packages/shared/src/validators/index.ts` | Re-exports portability validators. |

## 3. Server — Services

| File | Responsibility |
|---|---|
| `server/src/services/company-portability.ts` | **Core portability service.** Export (manifest generation, markdown file emission, `.paperclip.yaml` sidecars), import (graph resolution, collision handling, entity creation), preview (planned-action summary). Handles skill key derivation, task recurrence parsing, and package README generation. References `agentcompanies/v1` version string. |
| `server/src/services/company-export-readme.ts` | Generates `README.md` and Mermaid org-chart for exported company packages. |
| `server/src/services/index.ts` | Re-exports `companyPortabilityService`. |

## 4. Server — Routes

| File | Endpoints |
|---|---|
| `server/src/routes/companies.ts` | `POST /api/companies/:companyId/export` — legacy export bundle<br>`POST /api/companies/:companyId/exports/preview` — export preview<br>`POST /api/companies/:companyId/exports` — export package<br>`POST /api/companies/import/preview` — import preview<br>`POST /api/companies/import` — perform import |

Route registration lives in `server/src/app.ts` via `companyRoutes(db, storage)`.

## 5. Server — Tests

| File | Coverage |
|---|---|
| `server/src/__tests__/company-portability.test.ts` | Unit tests for the portability service (export, import, preview, manifest shape, `agentcompanies/v1` version). |
| `server/src/__tests__/company-portability-routes.test.ts` | Integration tests for the portability HTTP endpoints. |

## 6. CLI

| File | Commands |
|---|---|
| `cli/src/commands/client/company.ts` | `company export` — exports a company package to disk (flags: `--out`, `--include`, `--projects`, `--issues`, `--projectIssues`).<br>`company import` — imports a company package from a file or folder (flags: `--from`, `--include`, `--target`, `--companyId`, `--newCompanyName`, `--agents`, `--collision`, `--dryRun`).<br>Reads/writes portable file entries and handles `.paperclip.yaml` filtering. |

## 7. UI — Pages

| File | Role |
|---|---|
| `ui/src/pages/CompanyExport.tsx` | Export UI: preview, manifest display, file tree visualization, ZIP archive creation and download. Filters `.paperclip.yaml` based on selection. Shows manifest and README in editor. |
| `ui/src/pages/CompanyImport.tsx` | Import UI: source input (upload/folder/GitHub URL/generic URL), ZIP reading, preview pane with dependency tree, entity selection checkboxes, trust/licensing warnings, secrets requirements, collision strategy, adapter config. |

## 8. UI — Components

| File | Role |
|---|---|
| `ui/src/components/PackageFileTree.tsx` | Reusable file tree component for both import and export. Builds tree from `CompanyPortabilityFileEntry` items, parses frontmatter, shows action indicators (create/update/skip), and maps frontmatter field labels. |

## 9. UI — Libraries

| File | Role |
|---|---|
| `ui/src/lib/portable-files.ts` | Helpers for portable file entries: `getPortableFileText`, `getPortableFileDataUrl`, `getPortableFileContentType`, `isPortableImageFile`. |
| `ui/src/lib/zip.ts` | ZIP archive creation (`createZipArchive`) and reading (`readZipArchive`) — implements ZIP format from scratch for company packages. CRC32, DOS date/time encoding. |
| `ui/src/lib/zip.test.ts` | Tests for ZIP utilities; exercises round-trip with portability file entries and `.paperclip.yaml` content. |

## 10. UI — API Client

| File | Functions |
|---|---|
| `ui/src/api/companies.ts` | `companiesApi.exportBundle`, `companiesApi.exportPreview`, `companiesApi.exportPackage`, `companiesApi.importPreview`, `companiesApi.importBundle` — typed fetch wrappers for the portability endpoints. |

## 11. Skills & Agent Instructions

| File | Relevance |
|---|---|
| `skills/paperclip/references/company-skills.md` | Reference doc for company skill library workflow — install, inspect, update, assign. Skill packages are a subset of the agent companies spec. |
| `server/src/services/company-skills.ts` | Company skill management service — handles SKILL.md-based imports and company-level skill library. |
| `server/src/services/agent-instructions.ts` | Agent instructions service — resolves AGENTS.md paths for agent instruction loading. |

## 12. Quick Cross-Reference by Spec Concept

| Spec concept | Primary implementation files |
|---|---|
| `COMPANY.md` frontmatter & body | `company-portability.ts` (export emitter + import parser) |
| `AGENTS.md` frontmatter & body | `company-portability.ts`, `agent-instructions.ts` |
| `PROJECT.md` frontmatter & body | `company-portability.ts` |
| `TASK.md` frontmatter & body | `company-portability.ts` |
| `SKILL.md` packages | `company-portability.ts`, `company-skills.ts` |
| `.paperclip.yaml` vendor sidecar | `company-portability.ts`, `CompanyExport.tsx`, `company.ts` (CLI) |
| `manifest.json` | `company-portability.ts` (generation), shared types (schema) |
| ZIP package format | `zip.ts` (UI), `company.ts` (CLI file I/O) |
| Collision resolution | `company-portability.ts` (server), `CompanyImport.tsx` (UI) |
| Env/secrets declarations | shared types (`CompanyPortabilityEnvInput`), `CompanyImport.tsx` (UI) |
| README + org chart | `company-export-readme.ts` |
