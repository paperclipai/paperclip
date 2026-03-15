# Agent Companies Specification

Extension of the Agent Skills Specification

Version: `agentcompanies/v1-draft`

## 1. Purpose

An Agent Company package is a filesystem- and GitHub-native format for describing a company, team, agent, project, task, and associated skills using markdown files with YAML frontmatter.

This specification is an extension of the Agent Skills specification, not a replacement for it.

It defines how company-, team-, and agent-level package structure composes around the existing `SKILL.md` model.

This specification is vendor-neutral. It is intended to be usable by any agent-company runtime, not only Paperclip.

The format is designed to:

- be readable and writable by humans
- work directly from a local folder or GitHub repository
- require no central registry
- support attribution and pinned references to upstream files
- extend the existing Agent Skills ecosystem without redefining it
- be useful outside Paperclip

## 2. Core Principles

1. Markdown is canonical.
2. Git repositories are valid package containers.
3. Registries are optional discovery layers, not authorities.
4. `SKILL.md` remains owned by the Agent Skills specification.
5. External references must be pinnable to immutable Git commits.
6. Attribution and license metadata must survive import/export.
7. Slugs and relative paths are the portable identity layer, not database ids.
8. Conventional folder structure should work without verbose wiring.
9. Vendor-specific fidelity belongs in optional extensions, not the base package.

## 3. Package Kinds

A package root is identified by one primary markdown file:

- `COMPANY.md` for a company package
- `TEAM.md` for a team package
- `AGENTS.md` for an agent package
- `PROJECT.md` for a project package
- `TASK.md` for a task package
- `SKILL.md` for a skill package defined by the Agent Skills specification

A GitHub repo may contain one package at root or many packages in subdirectories.

## 4. Reserved Files And Directories

Common conventions:

```text
COMPANY.md
TEAM.md
AGENTS.md
PROJECT.md
TASK.md
SKILL.md

agents/<slug>/AGENTS.md
teams/<slug>/TEAM.md
projects/<slug>/PROJECT.md
projects/<slug>/tasks/<slug>/TASK.md
tasks/<slug>/TASK.md
skills/<slug>/SKILL.md
.paperclip.yaml

HEARTBEAT.md
SOUL.md
TOOLS.md
README.md
assets/
scripts/
references/
```

Rules:

- only markdown files are canonical content docs
- non-markdown directories like `assets/`, `scripts/`, and `references/` are allowed
- package tools may generate optional lock files, but lock files are not required for authoring

## 5. Common Frontmatter

Package docs may support these fields:

```yaml
schema: agentcompanies/v1
kind: company | team | agent | project | task
slug: my-slug
name: Human Readable Name
description: Short description
version: 0.1.0
license: MIT
authors:
  - name: Jane Doe
homepage: https://example.com
tags:
  - startup
  - engineering
metadata: {}
sources: []
```

Notes:

- `schema` is optional and should usually appear only at the package root
- `kind` is optional when file path and file name already make the kind obvious
- `slug` should be URL-safe and stable
- `sources` is for provenance and external references
- `metadata` is for tool-specific extensions
- exporters should omit empty or default-valued fields

## 6. COMPANY.md

`COMPANY.md` is the root entrypoint for a whole company package.

### Required fields

```yaml
name: Lean Dev Shop
description: Small engineering-focused AI company
slug: lean-dev-shop
schema: agentcompanies/v1
```

### Recommended fields

```yaml
version: 1.0.0
license: MIT
authors:
  - name: Example Org
goals:
  - Build and ship software products
includes:
  - https://github.com/example/shared-company-parts/blob/0123456789abcdef0123456789abcdef01234567/teams/engineering/TEAM.md
requirements:
  secrets:
    - OPENAI_API_KEY
```

### Semantics

- `includes` defines the package graph
- local package contents should be discovered implicitly by folder convention
- `includes` is optional and should be used mainly for external refs or nonstandard locations
- included items may be local or external references
- `COMPANY.md` may include agents directly, teams, projects, tasks, or skills
- a company importer may render `includes` as the tree/checkbox import UI

## 7. TEAM.md

`TEAM.md` defines an org subtree.

### Example

```yaml
name: Engineering
description: Product and platform engineering team
schema: agentcompanies/v1
slug: engineering
manager: ../cto/AGENTS.md
includes:
  - ../platform-lead/AGENTS.md
  - ../frontend-lead/AGENTS.md
  - ../../skills/review/SKILL.md
tags:
  - team
  - engineering
```

### Semantics

- a team package is a reusable subtree, not necessarily a runtime database table
- `manager` identifies the root agent of the subtree
- `includes` may contain child agents, child teams, or shared skills
- a team package can be imported into an existing company and attached under a target manager

## 8. AGENTS.md

`AGENTS.md` defines an agent.

### Example

```yaml
name: CEO
title: Chief Executive Officer
reportsTo: null
skills:
  - plan-ceo-review
  - review
```

### Semantics

- body content is the canonical default instruction content for the agent
- `docs` points to sibling markdown docs when present
- `skills` references reusable `SKILL.md` packages by skill shortname or slug
- a bare skill entry like `review` should resolve to `skills/review/SKILL.md` by convention
- if a package references external skills, the agent should still refer to the skill by shortname; the skill package itself owns any source refs, pinning, or attribution details
- tools may allow path or URL entries as an escape hatch, but exporters should prefer shortname-based skill references in `AGENTS.md`
- vendor-specific adapter/runtime config should not live in the base package
- local absolute paths, machine-specific cwd values, and secret values must not be exported as canonical package data

### Skill Resolution

The preferred association standard between agents and skills is by skill shortname.

Suggested resolution order for an agent skill entry:

1. a local package skill at `skills/<shortname>/SKILL.md`
2. a referenced or included skill package whose declared slug or shortname matches
3. a tool-managed company skill library entry with the same shortname

Rules:

- exporters should emit shortnames in `AGENTS.md` whenever possible
- importers should not require full file paths for ordinary skill references
- the skill package itself should carry any complexity around external refs, vendoring, mirrors, or pinned upstream content
- this keeps `AGENTS.md` readable and consistent with `skills.sh`-style sharing

## 9. PROJECT.md

`PROJECT.md` defines a lightweight project package.

### Example

```yaml
name: Q2 Launch
description: Ship the Q2 launch plan and supporting assets
owner: cto
```

### Semantics

- a project package groups related starter tasks and supporting markdown
- `owner` should reference an agent slug when there is a clear project owner
- a conventional `tasks/` subfolder should be discovered implicitly
- `includes` may contain `TASK.md`, `SKILL.md`, or supporting docs when explicit wiring is needed
- project packages are intended to seed planned work, not represent runtime task state

## 10. TASK.md

`TASK.md` defines a lightweight starter task.

### Example

```yaml
name: Monday Review
assignee: ceo
project: q2-launch
schedule:
  timezone: America/Chicago
  startsAt: 2026-03-16T09:00:00-05:00
  recurrence:
    frequency: weekly
    interval: 1
    weekdays:
      - monday
    time:
      hour: 9
      minute: 0
```

### Semantics

- body content is the canonical markdown task description
- `assignee` should reference an agent slug inside the package
- `project` should reference a project slug when the task belongs to a `PROJECT.md`
- tasks are intentionally basic seed work: title, markdown body, assignee, and optional recurrence
- tools may also support optional fields like `priority`, `labels`, or `metadata`, but they should not require them in the base package

### Scheduling

The scheduling model is intentionally lightweight. It should cover common recurring patterns such as:

- every 6 hours
- every weekday at 9:00
- every Monday morning
- every month on the 1st
- every first Monday of the month
- every year on January 1

Suggested shape:

```yaml
schedule:
  timezone: America/Chicago
  startsAt: 2026-03-14T09:00:00-05:00
  recurrence:
    frequency: hourly | daily | weekly | monthly | yearly
    interval: 1
    weekdays:
      - monday
      - wednesday
    monthDays:
      - 1
      - 15
    ordinalWeekdays:
      - weekday: monday
        ordinal: 1
    months:
      - 1
      - 6
    time:
      hour: 9
      minute: 0
    until: 2026-12-31T23:59:59-06:00
    count: 10
```

Rules:

- `timezone` should use an IANA timezone like `America/Chicago`
- `startsAt` anchors the first occurrence
- `frequency` and `interval` are the only required recurrence fields
- `weekdays`, `monthDays`, `ordinalWeekdays`, and `months` are optional narrowing rules
- `ordinalWeekdays` uses `ordinal` values like `1`, `2`, `3`, `4`, or `-1` for “last”
- `time.hour` and `time.minute` keep common “morning / 9:00 / end of day” scheduling human-readable
- `until` and `count` are optional recurrence end bounds
- tools may accept richer calendar syntaxes such as RFC5545 `RRULE`, but exporters should prefer the structured form above

## 11. SKILL.md Compatibility

A skill package must remain a valid Agent Skills package.

Rules:

- `SKILL.md` should follow the Agent Skills spec
- Paperclip must not require extra top-level fields for skill validity
- Paperclip-specific extensions must live under `metadata.paperclip` or `metadata.sources`
- a skill directory may include `scripts/`, `references/`, and `assets/` exactly as the Agent Skills ecosystem expects
- tools implementing this spec should treat `skills.sh` compatibility as a first-class goal rather than inventing a parallel skill format

In other words, this spec extends Agent Skills upward into company/team/agent composition. It does not redefine skill package semantics.

### Example compatible extension

```yaml
---
name: review
description: Paranoid code review skill
allowed-tools:
  - Read
  - Grep
metadata:
  paperclip:
    tags:
      - engineering
      - review
  sources:
    - kind: github-file
      repo: vercel-labs/skills
      path: review/SKILL.md
      commit: 0123456789abcdef0123456789abcdef01234567
      sha256: 3b7e...9a
      attribution: Vercel Labs
      usage: referenced
---
```

## 12. Source References

A package may point to upstream content instead of vendoring it.

### Source object

```yaml
sources:
  - kind: github-file
    repo: owner/repo
    path: path/to/file.md
    commit: 0123456789abcdef0123456789abcdef01234567
    blob: abcdef0123456789abcdef0123456789abcdef01
    sha256: 3b7e...9a
    url: https://github.com/owner/repo/blob/0123456789abcdef0123456789abcdef01234567/path/to/file.md
    rawUrl: https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/path/to/file.md
    attribution: Owner Name
    license: MIT
    usage: referenced
```

### Supported kinds

- `local-file`
- `local-dir`
- `github-file`
- `github-dir`
- `url`

### Usage modes

- `vendored`: bytes are included in the package
- `referenced`: package points to upstream immutable content
- `mirrored`: bytes are cached locally but upstream attribution remains canonical

### Rules

- `commit` is required for `github-file` and `github-dir` in strict mode
- `sha256` is strongly recommended and should be verified on fetch
- branch-only refs may be allowed in development mode but must warn
- exporters should default to `referenced` for third-party content unless redistribution is clearly allowed

## 13. Resolution Rules

Given a package root, an importer resolves in this order:

1. local relative paths
2. local absolute paths if explicitly allowed by the importing tool
3. pinned GitHub refs
4. generic URLs

For pinned GitHub refs:

1. resolve `repo + commit + path`
2. fetch content
3. verify `sha256` if present
4. verify `blob` if present
5. fail closed on mismatch

An importer must surface:

- missing files
- hash mismatches
- missing licenses
- referenced upstream content that requires network fetch
- executable content in skills or scripts

## 14. Import Graph

A package importer should build a graph from:

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- `SKILL.md`
- local and external refs

Suggested import UI behavior:

- render graph as a tree
- checkbox at entity level, not raw file level
- selecting an agent auto-selects required docs and referenced skills
- selecting a team auto-selects its subtree
- selecting a project auto-selects its included tasks
- selecting a recurring task should surface its schedule before import
- selecting referenced third-party content shows attribution, license, and fetch policy

## 15. Vendor Extensions

Vendor-specific data should live outside the base package shape.

For Paperclip, the preferred fidelity extension is:

```text
.paperclip.yaml
```

Example uses:

- adapter type and adapter config
- adapter env inputs and defaults
- runtime settings
- permissions
- budgets
- approval policies
- project execution workspace policies
- issue/task Paperclip-only metadata

Rules:

- the base package must remain readable without the extension
- tools that do not understand a vendor extension should ignore it
- Paperclip tools may emit the vendor extension by default as a sidecar while keeping the base markdown clean

Suggested Paperclip shape:

```yaml
schema: paperclip/v1
agents:
  claudecoder:
    adapter:
      type: claude_local
      config:
        model: claude-opus-4-6
    inputs:
      env:
        ANTHROPIC_API_KEY:
          kind: secret
          requirement: optional
          default: ""
        GH_TOKEN:
          kind: secret
          requirement: optional
        CLAUDE_BIN:
          kind: plain
          requirement: optional
          default: claude
```

Additional rules for Paperclip exporters:

- do not duplicate `promptTemplate` when `AGENTS.md` already contains the agent instructions
- do not export provider-specific secret bindings such as `secretId`, `version`, or `type: secret_ref`
- export env inputs as portable declarations with `required` or `optional` semantics and optional defaults
- warn on system-dependent values such as absolute commands and absolute `PATH` overrides
- omit empty and default-valued Paperclip fields when possible

## 16. Export Rules

A compliant exporter should:

- emit markdown roots and relative folder layout
- omit machine-local ids and timestamps
- omit secret values
- omit machine-specific paths
- preserve task descriptions and recurrence definitions when exporting tasks
- omit empty/default fields
- default to the vendor-neutral base package
- Paperclip exporters should emit `.paperclip.yaml` as a sidecar by default
- preserve attribution and source references
- prefer `referenced` over silent vendoring for third-party content
- preserve `SKILL.md` as-is when exporting compatible skills

## 17. Licensing And Attribution

A compliant tool must:

- preserve `license` and `attribution` metadata when importing and exporting
- distinguish vendored vs referenced content
- not silently inline referenced third-party content during export
- surface missing license metadata as a warning
- surface restrictive or unknown licenses before install/import if content is vendored or mirrored

## 18. Optional Lock File

Authoring does not require a lock file.

Tools may generate an optional lock file such as:

```text
company-package.lock.json
```

Purpose:

- cache resolved refs
- record final hashes
- support reproducible installs

Rules:

- lock files are optional
- lock files are generated artifacts, not canonical authoring input
- the markdown package remains the source of truth

## 19. Paperclip Mapping

Paperclip can map this spec to its runtime model like this:

- base package:
  - `COMPANY.md` -> company metadata
  - `TEAM.md` -> importable org subtree
  - `AGENTS.md` -> agent identity and instructions
  - `PROJECT.md` -> starter project definition
  - `TASK.md` -> starter issue/task definition, or automation template when recurrence is present
  - `SKILL.md` -> imported skill package
  - `sources[]` -> provenance and pinned upstream refs
- Paperclip extension:
  - `.paperclip.yaml` -> adapter config, runtime config, env input declarations, permissions, budgets, and other Paperclip-specific fidelity

Inline Paperclip-only metadata that must live inside a shared markdown file should use:

- `metadata.paperclip`

That keeps the base format broader than Paperclip.

This specification itself remains vendor-neutral and intended for any agent-company runtime, not only Paperclip.

## 20. Cutover

Paperclip should cut over to this markdown-first package model as the primary portability format.

`paperclip.manifest.json` does not need to be preserved as a compatibility requirement for the future package system.

For Paperclip, this should be treated as a hard cutover in product direction rather than a long-lived dual-format strategy.

## 21. Minimal Example

```text
lean-dev-shop/
├── COMPANY.md
├── agents/
│   ├── ceo/AGENTS.md
│   └── cto/AGENTS.md
├── projects/
│   └── q2-launch/
│       ├── PROJECT.md
│       └── tasks/
│           └── monday-review/
│               └── TASK.md
├── teams/
│   └── engineering/TEAM.md
├── tasks/
│   └── weekly-review/TASK.md
└── skills/
    └── review/SKILL.md

Optional:

```text
.paperclip.yaml
```
```

**Recommendation**
This is the direction I would take:

- make this the human-facing spec
- define `SKILL.md` compatibility as non-negotiable
- treat this spec as an extension of Agent Skills, not a parallel format
- make `companies.sh` a discovery layer for repos implementing this spec, not a publishing authority
