# Agent Companies Specification Reference

The normative specification lives at:

- Web: https://agentcompanies.io/specification
- Local: docs/companies/companies-spec.md

Read the local spec file before generating any package files. The spec defines the canonical format and all frontmatter fields. Below is a quick-reference summary for common authoring tasks.

## Package Kinds

| File       | Kind    | Purpose                                           |
| ---------- | ------- | ------------------------------------------------- |
| COMPANY.md | company | Root entrypoint, org boundary and defaults        |
| TEAM.md    | team    | Reusable org subtree                              |
| AGENTS.md  | agent   | One role, instructions, and attached skills       |
| PROJECT.md | project | Planned work grouping                             |
| TASK.md    | task    | Portable starter task                             |
| SKILL.md   | skill   | Agent Skills capability package (do not redefine) |

## Directory Layout

```
company-package/
├── COMPANY.md
├── agents/
│   └── <slug>/AGENTS.md
├── teams/
│   └── <slug>/TEAM.md
├── projects/
│   └── <slug>/
│       ├── PROJECT.md
│       └── tasks/
│           └── <slug>/TASK.md
├── tasks/
│   └── <slug>/TASK.md
├── skills/
│   └── <slug>/SKILL.md
├── assets/
├── scripts/
├── references/
└── .paperclip.yaml          (optional vendor extension)
```

## Common Frontmatter Fields

```yaml
schema: agentcompanies/v1
kind: company | team | agent | project | task
slug: url-safe-stable-identity
name: Human Readable Name
description: Short description for discovery
version: 0.1.0
license: MIT
authors:
  - name: Jane Doe
tags: []
metadata: {}
sources: []
```

- `schema` usually appears only at package root
- `kind` is optional when filename makes it obvious
- `slug` must be URL-safe and stable
- exporters should omit empty or default-valued fields

## COMPANY.md Required Fields

```yaml
name: Company Name
description: What this company does
slug: company-slug
schema: agentcompanies/v1
```

Optional: `version`, `license`, `authors`, `goals`, `includes`, `requirements.secrets`

## AGENTS.md Key Fields

```yaml
name: Agent Name
title: Role Title
reportsTo: <agent-slug or null>
skills:
  - skill-shortname
```

- Body content is the agent's default instructions
- Skills resolve by shortname: `skills/<shortname>/SKILL.md`
- Do not export machine-specific paths or secrets

## TEAM.md Key Fields

```yaml
name: Team Name
description: What this team does
slug: team-slug
manager: ../agent-slug/AGENTS.md
includes:
  - ../agent-slug/AGENTS.md
  - ../../skills/skill-slug/SKILL.md
```

## PROJECT.md Key Fields

```yaml
name: Project Name
description: What this project delivers
owner: agent-slug
```

## TASK.md Key Fields

```yaml
name: Task Name
assignee: agent-slug
project: project-slug
schedule:
  timezone: America/Chicago
  startsAt: 2026-03-16T09:00:00-05:00
  recurrence:
    frequency: weekly
    interval: 1
    weekdays: [monday]
    time: { hour: 9, minute: 0 }
```

## Source References (for external skills/content)

```yaml
sources:
  - kind: github-file
    repo: owner/repo
    path: path/to/SKILL.md
    commit: <full-sha>
    sha256: <hash>
    attribution: Owner Name
    license: MIT
    usage: referenced
```

Usage modes: `vendored` (bytes included), `referenced` (pointer only), `mirrored` (cached locally)

Default to `referenced` for third-party content.
