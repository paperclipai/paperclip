---
title: Importing & Exporting Companies
summary: Export companies to portable packages and import them from local paths or GitHub
---

AGNB companies can be exported to portable markdown packages and imported from local directories or GitHub repositories. This lets you share company configurations, duplicate setups, and version-control your agent teams.

## Package Format

Exported packages follow the [Agent Companies specification](/companies/companies-spec) and use a markdown-first structure:

```text
my-company/
├── COMPANY.md          # Company metadata
├── agents/
│   ├── ceo/AGENT.md    # Agent instructions + frontmatter
│   └── cto/AGENT.md
├── projects/
│   └── main/PROJECT.md
├── skills/
│   └── review/SKILL.md
├── tasks/
│   └── onboarding/TASK.md
└── .paperclip.yaml          # Adapter config, env inputs, routines
```

- **COMPANY.md** defines company name, description, and metadata.
- **AGENT.md** files contain agent identity, role, and instructions.
- **SKILL.md** files are compatible with the Agent Skills ecosystem.
- **.paperclip.yaml** holds AGNB-specific config (adapter types, env inputs, budgets) as an optional sidecar.

## Exporting a Company

Export a company from the cockpit (**Company → Export**) or via the API. You choose what to include and where it goes.

### What you can include

| Set | Description | Default |
|-----|-------------|---------|
| `company` | Company name, description, and metadata | included |
| `agents` | Agent names, roles, reporting structure, and instructions | included |
| `projects` | Project definitions and workspace config | optional |
| `issues` / `tasks` | Issue and task descriptions | optional |
| `skills` | Skill packages, as references or vendored content | optional |

You can scope an export to specific skill slugs, project shortnames, or issue identifiers, and choose whether to vendor referenced skill contents or keep upstream references.

### What gets exported

- Company name, description, and metadata
- Agent names, roles, reporting structure, and instructions
- Project definitions and workspace config
- Task/issue descriptions (when included)
- Skill packages (as references or vendored content)
- Adapter type and env input declarations in `.paperclip.yaml`

Secret values, machine-local paths, and database IDs are **never** exported.

## Importing a Company

Import from a local directory, a GitHub URL, or GitHub shorthand:

- Full URL — `https://github.com/org/repo`
- Subfolder URL — `https://github.com/org/repo/tree/main/companies/acme`
- Shorthand — `org/repo` or `org/repo/companies/acme`

### Import options

| Option | Description | Default |
|--------|-------------|---------|
| Target | `new` (create a new company) or `existing` (merge into an existing one) | inferred from context |
| Company | Target company for `existing` imports | current context |
| New company name | Override company name for `new` imports | from package |
| Include | Which sets to import: `company`, `agents`, `projects`, `issues`, `tasks`, `skills` | auto-detected |
| Agents | Which agent slugs to import, or `all` | `all` |
| Collision | How to handle name conflicts: `rename`, `skip`, or `replace` | `rename` |
| Ref | Git ref for GitHub imports (branch, tag, or commit) | default branch |
| Dry run | Preview what would be imported without applying | off |

### Target modes

- **`new`** — Creates a fresh company from the package. Good for duplicating a company template.
- **`existing`** — Merges the package into an existing company.

If a target is not specified, AGNB infers it: if a company is provided (or one exists in context), it defaults to `existing`; otherwise `new`.

### Collision strategies

When importing into an existing company, agent or project names may conflict with existing ones:

- **`rename`** (default) — Appends a suffix to avoid conflicts (e.g., `ceo` becomes `ceo-2`).
- **`skip`** — Skips entities that already exist.
- **`replace`** — Overwrites existing entities. Only available for non-safe imports (not available through the CEO API).

### Preview before applying

Always preview first with a dry run. The preview shows:

- **Package contents** — How many agents, projects, tasks, and skills are in the source
- **Import plan** — What will be created, renamed, skipped, or replaced
- **Env inputs** — Environment variables that may need values after import
- **Warnings** — Potential issues like missing skills or unresolved references

Imported agents always land with timer heartbeats disabled. Assignment/on-demand wake behavior from the package is preserved, but scheduled runs stay off until a board operator re-enables them.

## API Endpoints

The same export/import flows are available over the REST API:

| Action | Endpoint |
|--------|----------|
| Export company | `POST /api/companies/{companyId}/export` |
| Preview import (existing company) | `POST /api/companies/{companyId}/imports/preview` |
| Apply import (existing company) | `POST /api/companies/{companyId}/imports/apply` |
| Preview import (new company) | `POST /api/companies/import/preview` |
| Apply import (new company) | `POST /api/companies/import` |

CEO agents can also use the safe import routes (`/imports/preview` and `/imports/apply`) which enforce non-destructive rules: `replace` is rejected, collisions resolve with `rename` or `skip`, and issues are always created as new.

## GitHub Sources

AGNB supports several GitHub URL formats:

- Full URL: `https://github.com/org/repo`
- Subfolder URL: `https://github.com/org/repo/tree/main/path/to/company`
- Shorthand: `org/repo`
- Shorthand with path: `org/repo/path/to/company`

Pin to a specific branch, tag, or commit hash with a Git ref when importing from GitHub.
