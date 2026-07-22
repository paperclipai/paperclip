# 2026-03-13 Company Import / Export V2 Plan

Status: Proposed implementation plan
Date: 2026-03-13
Audience: Product and engineering
Supersedes for package-format direction:
- `doc/plans/2026-02-16-module-system.md` sections that describe company templates as JSON-only
- `docs/specs/cliphub-plan.md` assumptions about blueprint bundle shape where they conflict with the markdown-first package model

## 1. Purpose

This document defines the next-stage plan for Paperclip company import/export.

The core shift is:

- move from a Paperclip-specific JSON-first portability package toward a markdown-first package format
- make GitHub repositories first-class package sources
- treat the company package model as an extension of the existing Agent Skills ecosystem instead of inventing a separate skill format
- support company, team, agent, and skill reuse without requiring a central registry

The normative package format draft lives in:

- `docs/companies/companies-spec.md`

This plan is about implementation and rollout inside Paperclip.

Adapter-wide skill rollout details live in:

- `doc/plans/2026-03-14-adapter-skill-sync-rollout.md`

## 2. Executive Summary

Paperclip already has portability primitives in the repo:

- server import/export/preview APIs
- CLI import/export commands
- shared portability types and validators

Those primitives are being cut over to the new package model rather than extended for backward compatibility.

The new direction is:

1. markdown-first package authoring
2. GitHub repo or local folder as the default source of truth
3. a vendor-neutral base package spec for agent-company runtimes, not just Paperclip
4. the company package model is explicitly an extension of Agent Skills
5. no future dependency on `paperclip.manifest.json`
6. implicit folder discovery by convention for the common case
7. an always-emitted `.paperclip.yaml` sidecar for high-fidelity Paperclip-specific details
8. package graph resolution at import time
9. entity-level import UI with dependency-aware tree selection
10. `skills.sh` compatibility is a V1 requirement for skill packages and skill installation flows
11. adapter-aware skill sync surfaces so Paperclip can read, diff, enable, disable, and reconcile skills where the adapter supports it

## 3. Product Goals

### 3.1 Goals

- A user can point Paperclip at a local folder or GitHub repo and import a company package without any registry.
- A package is readable and writable by humans with normal git workflows.
- A package can contain:
  - company definition
  - org subtree / team definition
  - agent definitions
  - optional starter projects and tasks
  - reusable skills
- V1 skill support is compatible with the existing `skills.sh` / Agent Skills ecosystem.
- A user can import into:
  - a new company
  - an existing company
- Import preview shows:
  - what will be created
  - what will be updated
  - what is skipped
  - what is referenced externally
  - what needs secrets or approvals
- Export preserves attribution, licensing, and pinned upstream references.
- Export produces a clean vendor-neutral package plus a Paperclip sidecar.
- `companies.sh` can later act as a discovery/index layer over repos implementing this format.

### 3.2 Non-Goals

- No central registry is required for package validity.
- This is not full database backup/restore.
- This does not attempt to export runtime state like:
  - heartbeat runs
  - API keys
  - spend totals
  - run sessions
  - transient workspaces
- This does not require a first-class runtime `teams` table before team portability ships.

## 4. Current State In Repo

Current implementation exists here:

- shared types: `packages/shared/src/types/company-portability.ts`
- shared validators: `packages/shared/src/validators/company-portability.ts`
- server routes: `server/src/routes/companies.ts`
- server service: `server/src/services/company-portability.ts`
- CLI commands: `cli/src/commands/client/company.ts`

Current product limitations:

1. Import/export UX still needs deeper tree-selection and skill/package management polish.
2. Adapter-specific skill sync remains uneven across adapters and must degrade cleanly when unsupported.
3. Projects and starter tasks should stay opt-in on export rather than default package content.
4. Import/export still needs stronger coverage around attribution, pin verification, and executable-package warnings.
5. The current markdown frontmatter parser is intentionally lightweight and should stay constrained to the documented shape.

## 5. Canonical Package Direction

### 5.1 Canonical Authoring Format

The canonical authoring format becomes a markdown-first package rooted in one of:

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- `SKILL.md`

The normative draft is:

- `docs/companies/companies-spec.md`

### 5.2 Relationship To Agent Skills

Paperclip must not redefine `SKILL.md`.

Rules:

- `SKILL.md` stays Agent Skills compatible
- the company package model is an extension of Agent Skills
- the base package is vendor-neutral and intended for any agent-company runtime
- Paperclip-specific fidelity lives in `.paperclip.yaml`
- Paperclip may resolve and install `SKILL.md` packages, but it must not require a Paperclip-only skill format
- `skills.sh` compatibility is a V1 requirement, not a future nice-to-have

### 5.3 Agent-To-Skill Association

`AGENTS.md` should associate skills by skill shortname or slug, not by verbose path in the common case.

Preferred example:

- `skills: [review, react-best-practices]`

Resolution model:

- `review` resolves to `skills/review/SKILL.md` by package convention
- if the skill is external or referenced, the skill package owns that complexity
- exporters should prefer shortname-based associations in `AGENTS.md`
- importers should resolve the shortname against local package skills first, then referenced or installed company skills
### 5.4 Base Package Vs Paperclip Extension

The repo format should have two layers:

- base package:
  - minimal, readable, social, vendor-neutral
  - implicit folder discovery by convention
  - no Paperclip-only runtime fields by default
- Paperclip extension:
  - `.paperclip.yaml`
  - adapter/runtime/permissions/budget/workspace fidelity
  - emitted by Paperclip tools as a sidecar while the base package stays readable

### 5.5 Relationship To Current V1 Manifest

`paperclip.manifest.json` is not part of the future package direction.

This should be treated as a hard cutover in product direction.

- markdown-first repo layout is the target
- no new work should deepen investment in the old manifest model
- future portability APIs and UI should target the markdown-first model only

## 6. Package Graph Model

### 6.1 Entity Kinds

Paperclip import/export should support these entity kinds:

- company
- team
- agent
- project
- task
- skill

### 6.2 Team Semantics

`team` is a package concept first, not a database-table requirement.

In Paperclip V2 portability:

- a team is an importable org subtree
- it is rooted at a manager agent
- it can be attached under a target manager in an existing company

This avoids blocking portability on a future runtime `teams` model.

Imported-team tracking should initially be package/provenance-based:

- if a team package was imported, the imported agents should carry enough provenance to reconstruct that grouping
- Paperclip can treat “this set of agents came from team package X” as the imported-team model
- provenance grouping is the intended near- and medium-term team model for import/export
- only add a first-class runtime `teams` table later if product needs move beyond what provenance grouping can express

### 6.3 Dependency Graph

Import should operate on an entity graph, not raw file selection.

Examples:

- selecting an agent auto-selects its required docs and skill refs
- selecting a team auto-selects its subtree
- selecting a company auto-selects all included entities by default
- selecting a project auto-selects its starter tasks

The preview output should reflect graph resolution explicitly.

## 7. External References, Pinning, And Attribution

### 7.1 Why This Matters

Some packages will:

- reference upstream files we do not want to republish
- include third-party work where attribution must remain visible
- need protection from branch hot-swapping

### 7.2 Policy

Paperclip should support source references in package metadata with:

- repo
- path
- commit sha
- optional blob sha
- optional sha256
- attribution
- license
- usage mode

Usage modes:

- `vendored`
- `referenced`
- `mirrored`

Default exporter behavior for third-party content should be:

- prefer `referenced`
- preserve attribution
- do not silently inline third-party content into exports

### 7.3 Trust Model

Imported package content should be classified by trust level:

- markdown-only
- markdown + assets
- markdown + scripts/executables

The UI and CLI should surface this clearly before apply.

## 8. Import Behavior

### 8.1 Supported Sources

- local folder
- local package root file
- GitHub repo URL
- GitHub subtree URL
- direct URL to markdown/package root

Registry-based discovery may be added later, but must remain optional.

### 8.2 Import Targets

- new company
- existing company

For existing company imports, the preview must support:

- collision handling
- attach-point selection for team imports
- selective entity import

### 8.3 Collision Strategy

Current `rename | skip | replace` support remains, but matching should improve over time.

Preferred matching order:

1. prior install provenance
2. stable package entity identity
3. slug
4. human name as weak fallback

Slug-only matching is acceptable only as a transitional strategy.

### 8.4 Required Preview Output

Every import preview should surface:

- target company action
- entity-level create/update/skip plan
- referenced external content
- missing files
- hash mismatch or pinning issues
- env inputs, including required vs optional and default values when present
- unsupported content types
- trust/licensing warnings

### 8.5 Adapter Skill Sync Surface

People want skill management in the UI, but skills are adapter-dependent.

That means portability and UI planning must include an adapter capability model for skills.

Paperclip should define a new adapter surface area around skills:

- list currently enabled skills for an agent
- report how those skills are represented by the adapter
- install or enable a skill
- disable or remove a skill
- report sync state between desired package config and actual adapter state

Examples:

- Claude Code / Codex style adapters may manage skills as local filesystem packages or adapter-owned skill directories
- OpenClaw-style adapters may expose currently enabled skills through an API or a reflected config surface
- some adapters may be read-only and only report what they have

Planned adapter capability shape:

- `supportsSkillRead`
- `supportsSkillWrite`
- `supportsSkillRemove`
- `supportsSkillSync`
- `skillStorageKind` such as `filesystem`, `remote_api`, `inline_config`, or `unknown`

Baseline adapter interface:

- `listSkills(agent)`
- `applySkills(agent, desiredSkills)`
- `removeSkill(agent, skillId)` optional
- `getSkillSyncState(agent, desiredSkills)` optional

Planned Paperclip behavior:

- if an adapter supports read, Paperclip should show current skills in the UI
- if an adapter supports write, Paperclip should let the user enable/disable imported skills
- if an adapter supports sync, Paperclip should compute desired vs actual state and offer reconcile actions
- if an adapter does not support these capabilities, the UI should still show the package-level desired skills but mark them unmanaged

## 9. Export Behavior

### 9.1 Default Export Target

Default export target should become a markdown-first folder structure.

Example:

```text
my-company/
├── COMPANY.md
├── agents/
├── teams/
└── skills/
```

### 9.2 Export Rules

Exports should:

- omit machine-local ids
- omit timestamps and counters unless explicitly needed
- omit secret values
- omit local absolute paths
- omit duplicated inline prompt content from `.paperclip.yaml` when `AGENTS.md` already carries the instructions
- preserve references and attribution
- emit `.paperclip.yaml` alongside the base package
- express adapter env/secrets as portable env input declarations rather than exported secret binding ids
- preserve compatible `SKILL.md` content as-is

Projects and issues should not be exported by default.

They should be opt-in through selectors such as:

- `--projects project-shortname-1,project-shortname-2`
- `--issues PAP-1,PAP-3`
- `--project-issues project-shortname-1,project-shortname-2`

This supports “clean public company package” workflows where a maintainer exports a follower-facing company package without bundling active work items every time.

### 9.3 Export Units

Initial export units:

- company package
- team package
- single agent package

Later optional units:

- skill pack export
- seed projects/tasks bundle

## 10. Storage Model Inside Paperclip

### 10.1 Short-Term

In the first phase, imported entities can continue mapping onto current runtime tables:

- company -> companies
- agent -> agents
- team -> imported agent subtree attachment plus package provenance grouping
- skill -> company-scoped reusable package metadata plus agent-scoped desired-skill attachment state where supported

### 10.2 Medium-Term

Paperclip should add managed package/provenance records so imports are not anonymous one-off copies.

Needed capabilities:

- remember install origin
- support re-import / upgrade
- distinguish local edits from upstream package state
- preserve external refs and package-level metadata
- preserve imported team grouping without requiring a runtime `teams` table immediately
- preserve desired-skill state separately from adapter runtime state
- support both company-scoped reusable skills and agent-scoped skill attachments

Suggested future tables:

- package_installs
- package_install_entities
- package_sources
- agent_skill_desires
- adapter_skill_snapshots

This is not required for phase 1 UI, but it is required for a robust long-term system.

## 11. API Plan

### 11.1 Keep Existing Endpoints Initially

Retain:

- `POST /api/companies/:companyId/export`
- `POST /api/companies/import/preview`
- `POST /api/companies/import`

But evolve payloads toward the markdown-first graph model.

### 11.2 New API Capabilities

Add support for:

- package root resolution from local/GitHub inputs
- graph resolution preview
- source pin and hash verification results
- entity-level selection
- team attach target selection
- provenance-aware collision planning

### 11.3 Parsing Changes

Replace the current ad hoc markdown frontmatter parser with a real parser that can handle:

- nested YAML
- arrays/objects reliably
- consistent round-tripping

This is a prerequisite for the new package model.

## 12. CLI Plan

The CLI should continue to support direct import/export without a registry.

Target commands:

- `paperclipai company export <company-id> --out <path>`
- `paperclipai company import <path-or-url> --dry-run`
- `paperclipai company import <path-or-url> --target existing -C <company-id>`

Planned additions:

- `--package-kind company|team|agent`
- `--attach-under <agent-id-or-slug>` for team imports
- `--strict-pins`
- `--allow-unpinned`
- `--materialize-references`
- `--sync-skills`

## 13. UI Plan

### 13.1 Company Settings Import / Export

Add a real import/export section to Company Settings.

Export UI:

- export package kind selector
- include options
- local download/export destination guidance
- attribution/reference summary

Import UI:

- source entry:
  - upload/folder where supported
  - GitHub URL
  - generic URL
- preview pane with:
  - resolved package root
  - dependency tree
  - checkboxes by entity
  - trust/licensing warnings
  - secrets requirements
  - collision plan

### 13.2 Team Import UX

If importing a team into an existing company:

- show the subtree structure
- require the user to choose where to attach it
- preview manager/reporting updates before apply
- preserve imported-team provenance so the UI can later say “these agents came from team package X”

### 13.3 Skills UX

See also:

- `doc/plans/2026-03-14-skills-ui-product-plan.md`

If importing skills:

- show whether each skill is local, vendored, or referenced
- show whether it contains scripts/assets
- preserve Agent Skills compatibility in presentation and export
- preserve `skills.sh` compatibility in both import and install flows
- show agent skill attachments by shortname/slug rather than noisy file paths
- treat agent skills as a dedicated agent tab, not just another subsection of configuration
- show current adapter-reported skills when supported
- show desired package skills separately from actual adapter state
- offer reconcile actions when the adapter supports sync

## 14. Rollout Phases

### Phase 1: Stabilize Current V1 Portability

- add tests for current portability flows
- replace the frontmatter parser
- add Company Settings UI for current import/export capabilities
- start cutover work toward the markdown-first package reader

### Phase 2: Markdown-First Package Reader

- support `COMPANY.md` / `TEAM.md` / `AGENTS.md` root detection
- build internal graph from markdown-first packages
- support local folder and GitHub repo inputs natively
- support agent skill references by shortname/slug
- resolve local `skills/<slug>/SKILL.md` packages by convention
- support `skills.sh`-compatible skill repos as V1 package sources

### Phase 3: Graph-Based Import UX And Skill Surfaces

- entity tree preview
- checkbox selection
- team subtree attach flow
- licensing/trust/reference warnings
- company skill library groundwork
- dedicated agent `Skills` tab groundwork
- adapter skill read/sync UI groundwork

### Phase 4: New Export Model

- export markdown-first folder structure by default

### Phase 5: Provenance And Upgrades

- persist install provenance
- support package-aware re-import and upgrades
- improve collision matching beyond slug-only
- add imported-team provenance grouping
- add desired-vs-actual skill sync state

### Phase 6: Optional Seed Content

- goals
- projects
- starter issues/tasks

This phase is intentionally after the structural model is stable.

## 15. Documentation Plan

Primary docs:

- `docs/companies/companies-spec.md` as the package-format draft
- this implementation plan for rollout sequencing

Docs to update later as implementation lands:

- `doc/SPEC-implementation.md`
- `docs/api/companies.md`
- `docs/cli/control-plane-commands.md`
- board operator docs for Company Settings import/export

## 16. Open Questions

1. Should imported skill packages be stored as managed package files in Paperclip storage, or only referenced at import time?
   Decision: managed package files should support both company-scoped reuse and agent-scoped attachment.
2. What is the minimum adapter skill interface needed to make the UI useful across Claude Code, Codex, OpenClaw, and future adapters?
   Decision: use the baseline interface in section 8.5.
3. Should Paperclip support direct local folder selection in the web UI, or keep that CLI-only initially?
4. Do we want optional generated lock files in phase 2, or defer them until provenance work?
5. How strict should pinning be by default for GitHub references:
   - warn on unpinned
   - or block in normal mode
6. Is package-provenance grouping enough for imported teams, or do we expect product requirements soon that would justify a first-class runtime `teams` table?
   Decision: provenance grouping is enough for the import/export product model for now.

## 17. Recommendation

Engineering should treat this as the current plan of record for company import/export beyond the existing V1 portability feature.

Immediate next steps:

1. accept `docs/companies/companies-spec.md` as the package-format draft
2. implement phase 1 stabilization work
3. build phase 2 markdown-first package reader before expanding ClipHub or `companies.sh`
4. treat the old manifest-based format as deprecated and not part of the future surface

This keeps Paperclip aligned with:

- GitHub-native distribution
- Agent Skills compatibility
- a registry-optional ecosystem model
