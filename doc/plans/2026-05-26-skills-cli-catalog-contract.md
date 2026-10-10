# Skills CLI And Catalog Contract

Status: Phase A engineering contract
Date: 2026-05-26
Source plan: approved Paperclip skills CLI and catalog plan

This document freezes the first implementation contract for the `paperclipai skills`
command group and the app-shipped skills catalog. It is intentionally a build
contract, not a full product spec.

## Decisions

- `paperclipai skills` manages Paperclip company skills. It does not manage
  local adapter homes directly.
- Installing a skill means adding or updating a company-scoped
  `company_skills` record.
- Attaching a skill to an agent is a separate agent desired-state operation.
- Adapter runtime sync is a third step handled through adapter skill APIs.
- Root `skills/` remains reserved for Paperclip runtime and operational skills.
- App-shipped catalog skills live in `packages/skills-catalog`, not root
  `skills/`.
- Catalog skills are inspectable before install. Inspection never mutates company
  state.
- External sources continue to use the existing company skill import API in the
  first release. No separate marketplace, tap, or source registry is part of this
  phase.
- Agent desired skills continue to live in
  `adapterConfig.paperclipSkillSync.desiredSkills` for the first release. Do not
  add a normalized `agent_skills` table unless later implementation evidence
  requires it.

## Terms

- Company skill: a row in `company_skills`, owned by one company.
- Catalog skill: an app-shipped skill entry in `@paperclipai/skills-catalog`.
- Skill ref: a user-supplied company skill reference. The CLI accepts company
  skill `id`, canonical `key`, or unique `slug`.
- Catalog ref: a user-supplied catalog reference. The CLI accepts catalog `id`,
  canonical `key`, or unique `slug`.
- Desired skills: the skill key set stored on the agent adapter config.
- Runtime snapshot: the adapter-reported `AgentSkillSnapshot` for desired,
  installed, missing, stale, external, required, or unsupported skills.

## CLI Contract

All skills commands use the existing client command stack:

- Global client options: `--data-dir`, `--config`, `--context`, `--profile`,
  `--api-base`, `--api-key`, and `--json`.
- Company-scoped commands also accept `-C, --company-id <id>` and otherwise use
  `PAPERCLIP_COMPANY_ID` or the active context profile.
- Human output goes to stdout. Errors go to stderr.
- `--json` prints pretty JSON and no decorative labels.
- Successful commands exit `0`. Validation, API, or conflict errors exit `1`.
- API errors use the existing `API error <status>: <message>` formatting.
- Mutating commands print a short summary in human mode and the raw result in
  JSON mode.
- Commands that can delete or clear state must prompt in a TTY. In non-TTY mode
  they must require `--yes`.

### Company Skill Commands

These commands are Phase B and must work over existing APIs.

| Command | Behavior | JSON output |
|---|---|---|
| `skills list` | Lists company skills from `GET /api/companies/:companyId/skills`. Human rows include `id`, `key`, `slug`, `name`, `source`, `trust`, `compatibility`, and `attachedAgents`. | `CompanySkillListItem[]` |
| `skills show <skill-ref>` | Resolves `id`, `key`, or unique `slug`, then reads detail. Ambiguous slugs are conflicts. | `CompanySkillDetail` |
| `skills file <skill-ref> [--path <path>]` | Resolves the skill, reads a file with default `SKILL.md`, and prints raw file content in human mode. This command must remain pipeable. | `CompanySkillFileDetail` |
| `skills import <source>` | Calls existing import API. Source may be a local path, GitHub URL, skills.sh URL or command, `owner/repo`, `owner/repo/skill`, or URL-like source already accepted by the server. | `CompanySkillImportResult` |
| `skills create --name <name> [--slug <slug>] [--description <text>] [--body-file <path|->]` | Creates a managed local company skill. If `--body-file` is omitted, the server default body is used. `-` reads markdown from stdin. | `CompanySkill` |
| `skills scan-projects [--project-id <id>...] [--workspace-id <id>...]` | Calls project scan. Repeated flags become arrays. With neither flag, scan all accessible project workspaces. | `CompanySkillProjectScanResult` |
| `skills check [skill-ref]` | Reads update status for one skill, or for every listed company skill when no ref is provided. Unsupported statuses are shown, not hidden. | `CompanySkillCheckRow[]` |
| `skills update <skill-ref>` | Installs the update for one skill through the existing install-update API. | `CompanySkillUpdateRow` |
| `skills update --all` | Checks all skills, installs only those with `hasUpdate=true`, and reports skipped unsupported or current skills. | `CompanySkillUpdateRow[]` |
| `skills remove <skill-ref> [--yes]` | Deletes one company skill after confirmation. | `CompanySkill` |

`CompanySkillCheckRow` is a CLI-side shape:

```ts
interface CompanySkillCheckRow {
  skill: Pick<CompanySkillListItem, "id" | "key" | "slug" | "name">;
  status: CompanySkillUpdateStatus;
}
```

`CompanySkillUpdateRow` is a CLI-side shape:

```ts
interface CompanySkillUpdateRow {
  skillRef: string;
  action: "updated" | "skipped" | "failed";
  skill?: CompanySkill;
  status?: CompanySkillUpdateStatus;
  reason?: string;
}
```

### Agent Skill Commands

These commands are Phase B and use existing agent skill APIs.

| Command | Behavior | JSON output |
|---|---|---|
| `skills agent list <agent-ref>` | Resolves the agent using existing agent reference behavior, then prints the adapter `AgentSkillSnapshot`. Human rows include `key`, `runtimeName`, `desired`, `managed`, `required`, `state`, `origin`, and `detail`. | `AgentSkillSnapshot` |
| `skills agent sync <agent-ref> --skill <skill-ref>...` | Replaces the agent's non-required desired skill set with the supplied refs and triggers adapter sync. Required Paperclip skills remain enforced by the server. | `AgentSkillSnapshot` |
| `skills agent clear <agent-ref> [--yes]` | Clears non-required desired skills by sending an empty desired list, then returns the adapter snapshot. | `AgentSkillSnapshot` |

The word `sync` is deliberate: it is a desired-state replacement, not an append.
An additive command can be added later if operators need it.

### Catalog CLI Commands

These commands are Phase E and depend on the catalog APIs from Phase D.

| Command | Behavior | JSON output |
|---|---|---|
| `skills browse [--kind bundled|optional] [--category <slug>] [--query <text>]` | Lists app-shipped catalog skills. Human rows include `id`, `key`, `kind`, `category`, `slug`, `name`, `trust`, and `recommendedForRoles`. | `CatalogSkillListItem[]` |
| `skills search <query> [--kind bundled|optional] [--category <slug>]` | Alias for catalog browse with `query`. | `CatalogSkillListItem[]` |
| `skills inspect <catalog-ref>` | Shows app-shipped catalog detail and file inventory. Does not mutate company state. | `CatalogSkillDetail` |
| `skills install <catalog-ref> [--as <slug>] [--force]` | Installs a catalog skill into a company library. `--as` overrides the company skill slug. `--force` may replace a same-key catalog skill but must not bypass hard validation or dangerous security findings. | `CompanySkillInstallCatalogResult` |

Catalog commands are for the app-shipped Paperclip catalog only. External GitHub,
skills.sh, local path, and URL installs remain under `skills import <source>` in
the first release.

## Catalog Package Contract

Add a workspace package:

```text
packages/skills-catalog/
  package.json
  tsconfig.json
  src/
    index.ts
    types.ts
  catalog/
    bundled/
      <category>/
        <slug>/
          SKILL.md
          references/
          scripts/
          assets/
    optional/
      <category>/
        <slug>/
          SKILL.md
          references/
          scripts/
          assets/
  generated/
    catalog.json
  scripts/
    build-catalog-manifest.ts
    validate-catalog.ts
```

Package name: `@paperclipai/skills-catalog`.

The package exports:

- `catalogManifest`
- `catalogSkills`
- `resolveCatalogSkillRef(ref)`
- `getCatalogSkill(id)`
- TypeScript types for every manifest shape

Server and CLI code must import the generated manifest. They must not crawl
arbitrary repository paths at request time.

## Catalog Manifest

The generated artifact is `packages/skills-catalog/generated/catalog.json`.
It is checked in and regenerated by the package build or validation script.

```ts
interface CatalogManifest {
  schemaVersion: 1;
  packageName: "@paperclipai/skills-catalog";
  packageVersion: string;
  generatedAt: string;
  skills: CatalogSkill[];
}

interface CatalogSkill {
  id: string;
  key: string;
  kind: "bundled" | "optional";
  category: string;
  slug: string;
  name: string;
  description: string;
  path: string;
  entrypoint: "SKILL.md";
  trustLevel: "markdown_only" | "assets" | "scripts_executables";
  compatibility: "compatible" | "unknown" | "invalid";
  defaultInstall: boolean;
  recommendedForRoles: string[];
  requires: string[];
  tags: string[];
  files: CatalogSkillFile[];
  contentHash: string;
}

interface CatalogSkillFile {
  path: string;
  kind: "skill" | "markdown" | "reference" | "script" | "asset" | "other";
  sizeBytes: number;
  sha256: string;
}
```

`id` is path-safe:

```text
paperclipai:<kind>:<category>:<slug>
```

`key` is the canonical company skill key installed into `company_skills`:

```text
paperclipai/<kind>/<category>/<slug>
```

Example:

```json
{
  "id": "paperclipai:bundled:software-development:github-pr-workflow",
  "key": "paperclipai/bundled/software-development/github-pr-workflow",
  "kind": "bundled",
  "category": "software-development",
  "slug": "github-pr-workflow",
  "name": "github-pr-workflow",
  "description": "Prepare pull requests, review responses, and verification notes.",
  "path": "catalog/bundled/software-development/github-pr-workflow",
  "entrypoint": "SKILL.md",
  "trustLevel": "markdown_only",
  "compatibility": "compatible",
  "defaultInstall": false,
  "recommendedForRoles": ["engineer"],
  "requires": [],
  "tags": ["github", "pull-requests"],
  "files": [
    {
      "path": "SKILL.md",
      "kind": "skill",
      "sizeBytes": 1200,
      "sha256": "..."
    }
  ],
  "contentHash": "sha256:..."
}
```

## Catalog Skill Frontmatter

Each catalog `SKILL.md` must include:

```yaml
---
name: github-pr-workflow
description: Prepare pull requests, review responses, and verification notes.
key: paperclipai/bundled/software-development/github-pr-workflow
recommendedForRoles:
  - engineer
tags:
  - github
  - pull-requests
---
```

Optional frontmatter:

- `slug`
- `defaultInstall`
- `requires`
- `metadata`

The manifest generator owns `kind`, `category`, `path`, `files`,
`trustLevel`, `compatibility`, and `contentHash`.

## Catalog Validation Rules

Validation must fail when:

- A catalog entry is not under `catalog/bundled/<category>/<slug>` or
  `catalog/optional/<category>/<slug>`.
- `SKILL.md` is missing.
- `category` or `slug` is not a lowercase URL slug.
- `name` or `description` frontmatter is missing or empty.
- The frontmatter `key`, when present, does not equal the generated key.
- Two catalog entries have the same `id`, `key`, or `slug`.
- File inventory includes absolute paths, `..` segments, broken symlinks, or
  files outside the skill directory.
- A file exceeds the package-level size limit chosen by implementation.
- A skill marked `compatible` cannot be parsed as Agent Skills markdown.
- The generated manifest differs from the checked-in
  `generated/catalog.json`.

Trust level is derived from inventory:

- `scripts_executables` when any file is classified as `script`.
- `assets` when any file is classified as `asset` or `other` and no script is
  present.
- `markdown_only` when all files are markdown, references, or `SKILL.md`.

Validation must report all discovered catalog errors when practical, not just
the first one.

## Catalog API Contract

Phase D adds read APIs and one company install API.

```text
GET  /api/skills/catalog
GET  /api/skills/catalog/:catalogId
GET  /api/skills/catalog/:catalogId/files?path=SKILL.md
POST /api/companies/:companyId/skills/install-catalog
```

`GET /api/skills/catalog` accepts:

- `kind=bundled|optional`
- `category=<slug>`
- `q=<text>`

`catalogId` is the path-safe manifest `id`. The server should also support
resolution by `key` or unique `slug` where the ref is carried in a query or body,
but route parameters use `id` to avoid slash handling ambiguity.

Install request:

```ts
interface CompanySkillInstallCatalogRequest {
  catalogSkillId: string;
  slug?: string | null;
  force?: boolean;
}
```

Install result:

```ts
interface CompanySkillInstallCatalogResult {
  action: "created" | "updated" | "unchanged";
  skill: CompanySkill;
  catalogSkill: CatalogSkill;
  warnings: string[];
}
```

Install behavior:

- Creates or updates a company skill with `sourceType="catalog"`.
- Uses catalog `key` as the company skill canonical key.
- Uses catalog `slug` unless `slug` is provided.
- Materializes the catalog files into a company-managed skill directory so
  existing skill file reads continue to work.
- Stores provenance in metadata:
  - `catalogId`
  - `catalogKey`
  - `catalogKind`
  - `catalogCategory`
  - `catalogPath`
  - `packageName`
  - `packageVersion`
  - `originHash`
  - `originVersion`
  - `userModifiedAt`
  - `updateHoldReason`
- Writes activity log entries for install and update.
- Returns `409` for duplicate slug/key conflicts that cannot be resolved safely.
- Returns `422` for invalid, incompatible, or hard-blocked catalog entries.
- `force` may replace a same-key catalog-managed skill. It must not bypass
  company boundaries, permission checks, hard validation, or hard security
  findings.

## Error Semantics

Use existing HTTP semantics:

- `400`: invalid CLI arguments, invalid query/body shape, or malformed refs.
- `401`: missing or invalid auth.
- `403`: authenticated principal lacks access or mutation permission.
- `404`: skill, catalog entry, agent, file, company, or source not found.
- `409`: ambiguous slug, duplicate key/slug, update conflict, or unsafe overwrite.
- `422`: semantic violation such as invalid skill content or unsupported source.
- `500`: unexpected server failure.

CLI messages should name the next useful correction, for example:

- `Skill slug "review" is ambiguous. Use an id or key.`
- `Company ID is required. Pass --company-id, set PAPERCLIP_COMPANY_ID, or set a context profile.`
- `Catalog skill contains executable scripts and cannot be force-installed until security review semantics allow it.`

## Phase Acceptance Criteria

Phase A is complete when this contract is available in the repo and the issue
thread links it.

Phase B, CLI MVP:

- `paperclipai skills --help` exposes the Phase B command group.
- All Phase B commands work against existing company skills and agent skills
  APIs without schema or server changes.
- Skill refs resolve by id, key, or unique slug.
- Human and JSON output are covered by focused CLI tests.
- `doc/CLI.md` documents company install vs agent desired sync vs runtime sync.

Phase C, catalog package:

- `packages/skills-catalog` is a workspace package.
- Build or validation regenerates `generated/catalog.json`.
- Validation covers frontmatter, id/key/slug uniqueness, directory shape, file
  inventory, trust derivation, and stale generated output.
- Server and CLI can import the manifest without crawling arbitrary paths.
- Root `skills/` is not expanded with the app-shipped catalog.

Phase D, catalog APIs:

- Catalog list/detail/file APIs are read-only and covered by tests.
- Install-from-catalog creates auditable company-scoped skill records with
  provenance metadata and materialized files.
- Company boundary and mutation permission checks match or exceed existing
  company skill mutations.
- Duplicate and unsafe overwrite behavior is explicit and tested.

Phase E, catalog CLI:

- Operators can browse, search, inspect, and install app-shipped catalog skills.
- External source behavior remains routed through `skills import`.
- Output and errors follow the Phase B CLI conventions.
- Catalog install is clearly distinct from agent attach/sync in help and docs.

Phase F, update/reset/audit:

- Security review records decisions for origin hash, user modification detection,
  reset, audit findings, and force behavior.
- Implementation follows the review or records explicit deferrals.
- Mutating reset/update actions are activity logged.
- Tests cover dangerous findings, force behavior, and unchanged/current states.

Phase G, adapter truth model:

- Adapter snapshots accurately report `unsupported`, `persistent`, or
  `ephemeral`.
- Desired, missing, installed, stale, external, and required states are tested.
- External adapter plugins remain dynamically loaded. No hardcoded plugin imports
  are added.

Phase H, UI:

- The existing Company Skills page is extended rather than replaced.
- UX guidance covers Company, Bundled, Optional, and External source views.
- Install preview shows source, trust, provenance, update state, and file
  inventory.
- Agent attach/detach states are clear.
- Frontend handoff includes screenshots or equivalent browser evidence.

Phase I, initial skill content:

- Bundled and optional entries use the finalized frontmatter and category rules.
- Skill descriptions are specific enough for browse/search.
- No script-bearing skill lands without explicit security review evidence.
- Validation fixtures or tests cover representative content.

Phase J, QA and docs:

- QA validates CLI, catalog APIs, UI install, agent sync, portability, and adapter
  snapshots against a dev instance.
- Blocking defects are linked as first-class issues.
- `doc/CLI.md`, `doc/DEVELOPING.md`, and skill workflow docs match shipped
  behavior.

## Deferrals

- No cloud marketplace.
- No user-home tap registry.
- No hidden curator or autonomous catalog mutator.
- No normalized `agent_skills` table in the first release.
- No skill sets or bundles in the first release.
- No automatic install of every optional catalog skill.
- No replacement of company import/export as the portability path.
