# Built-in Company Templates Plan

Status: Draft  
Owner: Backend + UI  
Date: 2026-03-08

## Goal

Add first-party, built-in company templates to Paperclip so a user can create a new company from a curated template without leaving the product or manually assembling a portability bundle.

This should reuse the existing portability/import system instead of creating a second, parallel template pipeline.

## Why This Matters

Paperclip already has the low-level primitive for portable companies:

- export/import of company metadata and agents
- manifest validation
- collision preview
- import from local path, URL, or GitHub

What it does not have is a productized template experience:

- no built-in template catalog in the repo
- no template list API
- no onboarding picker
- no stable in-repo format for first-party templates

The README and ClipHub docs already point in this direction. This plan scopes a practical V1 that can ship inside the open-source repo without requiring the full ClipHub marketplace.

## V1 Scope

- First-party templates stored in-repo under `templates/`
- New portability source type for built-in templates
- Read-only template catalog API
- Onboarding flow support for "create company from template"
- Reuse of existing preview/import behavior and collision handling
- One or two neutral example templates maintained in-repo

## Explicit Non-Goals

- Public template marketplace / ClipHub service
- Paid templates
- Template publishing workflow
- Import/export of goals, projects, issues, or seed tasks
- Skill bundle packaging beyond what already fits in agent markdown/config
- Template versioning beyond repo version control

## Current Baseline

The current portability contract is sufficient for a template V1, but it is intentionally narrow.

Today the manifest supports:

- company metadata
- agents
- agent markdown instructions
- adapter config
- runtime config
- permissions
- reporting structure

Today it does not support:

- goals
- projects
- issues
- seed tasks
- company-level budget defaults
- packaged skill folders

That means built-in templates in V1 are org blueprints, not full operational company snapshots.

## Proposed Repository Format

Each built-in template lives under `templates/<template-id>/`.

### Required Files

- `templates/<template-id>/template.json`
- `templates/<template-id>/paperclip.manifest.json`
- `templates/<template-id>/COMPANY.md` if manifest includes company
- `templates/<template-id>/agents/<slug>/AGENTS.md` for each agent

### `template.json`

This is display metadata for the built-in catalog. It is intentionally separate from the portability manifest.

Suggested shape:

```json
{
  "id": "solo-founder-lite",
  "name": "Solo Founder Lite",
  "description": "A minimal company with a CEO and one execution agent.",
  "category": "starter",
  "tags": ["starter", "2-agent", "local"],
  "recommended": true,
  "icon": "rocket",
  "source": {
    "kind": "builtin",
    "path": "templates/solo-founder-lite"
  }
}
```

### `paperclip.manifest.json`

This remains the canonical portability artifact already supported by the server import path.

## Proposed Shared Contract Changes

Extend the portability source union with a built-in source:

```ts
{ type: "builtin"; templateId: string }
```

This keeps preview/import flows consistent:

- inline bundle
- remote URL
- GitHub URL
- built-in template

The built-in source resolves to repo-local files rather than fetching over the network.

## Proposed Server Design

### Template Registry

Add a small server-side registry that:

- scans `templates/*/template.json`
- validates metadata
- resolves template root paths safely
- exposes built-in templates as catalog entries

Suggested files:

- `server/src/templates/registry.ts`
- `server/src/templates/types.ts`

### API Endpoints

Add:

- `GET /api/templates`
- `GET /api/templates/:templateId`
- `POST /api/templates/:templateId/preview-import`
- `POST /api/templates/:templateId/import`

These endpoints should internally call the existing company portability preview/import logic.

Alternative acceptable implementation:

- extend `/api/companies/import/preview`
- extend `/api/companies/import`
- let UI send `source: { type: "builtin", templateId }`

This is lower surface area and probably the better V1.

### Resolution Rules

Built-in template resolution should:

- read `template.json`
- read `paperclip.manifest.json`
- load referenced markdown files from the same template root
- return the same `ResolvedSource` shape used by other portability sources

This keeps built-in templates as a new source type, not a new import system.

## Proposed UI Design

### Onboarding

Update onboarding so the first step offers:

- Blank company
- Start from template

If "Start from template" is selected:

- fetch built-in templates
- show a simple catalog
- show description, category, tags, and agent count
- on selection, create company through the existing preview/import path

### Company Creation Surfaces

Optional V1 follow-up:

- add "Import template" to the Companies page
- add "Browse templates" empty-state CTA when there are no companies

## Initial Template Policy

The open-source repo should ship generic, broadly useful templates only.

Suggested first-party examples:

- `solo-founder-lite`
- `engineering-pod`

Do not couple the upstream feature to a personal or branded template. A downstream project can add `safe-autonomous-organization` once the framework exists.

## Safe Autonomous Organization Fit

This framework is sufficient for a V1 `Safe Autonomous Organization` template because it can encode:

- company description and approval posture
- safety/governance-oriented org structure
- per-agent prompt/instruction markdown
- adapter/runtime defaults
- reporting lines
- permissions

It is not sufficient yet to encode:

- seed projects
- seed goals
- seed tasks
- benchmark/eval workflows
- packaged skill directories

Those belong in a phase-2 portability expansion.

## Implementation Plan

## Phase 1: Contracts + Registry

- [ ] Extend `packages/shared/src/validators/company-portability.ts` with `builtin` source type
- [ ] Export new types from `packages/shared/src/index.ts`
- [ ] Add server template registry under `server/src/templates/`
- [ ] Define template metadata validator
- [ ] Add path resolution rooted at repo `templates/`

Acceptance criteria:

- server can list built-in templates from disk
- invalid template metadata fails clearly
- built-in template resolves into the same internal structure as other portability sources

## Phase 2: Portability Integration

- [ ] Extend `server/src/services/company-portability.ts` to resolve `source.type === "builtin"`
- [ ] Reuse existing preview/import logic unchanged after source resolution
- [ ] Add tests for built-in source resolution

Acceptance criteria:

- preview/import works for built-in templates without separate import code paths
- collision behavior matches existing portability behavior

## Phase 3: API

- [ ] Add `GET /api/templates`
- [ ] Add `GET /api/templates/:templateId`
- [ ] Either:
  - [ ] add explicit template preview/import endpoints, or
  - [ ] keep API surface minimal and use the existing company import endpoints with `builtin` source

Acceptance criteria:

- UI can enumerate built-in templates
- UI can preview and import from a selected built-in template

## Phase 4: UI

- [ ] Update `ui/src/components/OnboardingWizard.tsx`
- [ ] Add template list/query client in `ui/src/api/companies.ts` or new `ui/src/api/templates.ts`
- [ ] Add template selection UI in onboarding
- [ ] Preserve blank-company onboarding path

Acceptance criteria:

- a new user can create a company from a built-in template in one guided flow
- blank-company flow continues to work unchanged

## Phase 5: Example Templates

- [ ] Add `templates/solo-founder-lite/`
- [ ] Add `templates/engineering-pod/`
- [ ] Validate they import cleanly in dev

Acceptance criteria:

- repo contains at least one working built-in template
- template files are human-readable and easy to fork into downstream packs

## Testing

- [ ] server tests for built-in source resolution
- [ ] server tests for template listing API
- [ ] integration test for preview/import from a built-in template
- [ ] UI test or smoke coverage for onboarding template selection

## Open Questions

1. Should the built-in catalog be server-driven only, or can static UI assets be acceptable in V1?
2. Should template metadata include compatibility hints such as supported adapters or local/cloud suitability?
3. Should V1 templates be allowed to reference remote documentation links inside markdown, or should first-party templates be fully self-contained?
4. When portability grows to include projects/goals/issues, should built-in templates adopt that automatically or be version-gated by manifest schema version?

## Recommended Merge Strategy

1. Merge the generic built-in template framework first.
2. Merge one or two neutral starter templates.
3. Build `Safe Autonomous Organization` as a downstream template pack or follow-up PR after the framework stabilizes.
