---
title: Importing & Exporting Companies
summary: Export companies to portable packages and import them from local paths or GitHub
---

Paperclip companies can be exported to portable markdown packages and imported from local directories or GitHub repositories. This lets you share company configurations, duplicate setups, and version-control your agent teams.

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
└── .paperclip.yaml     # Adapter config, env inputs, routines
```

- **COMPANY.md** defines company name, description, and metadata.
- **AGENT.md** files contain agent identity, role, and instructions.
- **SKILL.md** files are compatible with the Agent Skills ecosystem.
- **.paperclip.yaml** holds Paperclip-specific config (adapter types, env inputs, budgets) as an optional sidecar.

## Exporting a Company

Export a company into a portable folder:

```sh
paperclipai company export <company-id> --out ./my-export
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--out <path>` | Output directory (required) | — |
| `--include <values>` | Comma-separated set: `company`, `agents`, `projects`, `issues`, `tasks`, `skills` | `company,agents` |
| `--skills <values>` | Export only specific skill slugs | all |
| `--projects <values>` | Export only specific project shortnames or IDs | all |
| `--issues <values>` | Export specific issue identifiers or IDs | none |
| `--project-issues <values>` | Export issues belonging to specific projects | none |
| `--expand-referenced-skills` | Vendor skill file contents instead of keeping upstream references | `false` |

### Examples

```sh
# Export company with agents and projects
paperclipai company export abc123 --out ./backup --include company,agents,projects

# Export everything including tasks and skills
paperclipai company export abc123 --out ./full-export --include company,agents,projects,tasks,skills

# Export only specific skills
paperclipai company export abc123 --out ./skills-only --include skills --skills review,deploy
```

### What Gets Exported

- Company name, description, and metadata
- Agent names, roles, reporting structure, and instructions
- Project definitions and workspace config
- Task/issue descriptions (when included)
- Skill packages (as references or vendored content)
- Adapter type and env input declarations in `.paperclip.yaml`

Secret values, machine-local paths, and database IDs are **never** exported.

## Importing a Company

Import from a local directory, GitHub URL, or GitHub shorthand:

```sh
# From a local folder
paperclipai company import ./my-export

# From a GitHub URL
paperclipai company import https://github.com/org/repo

# From a GitHub subfolder
paperclipai company import https://github.com/org/repo/tree/main/companies/acme

# From GitHub shorthand
paperclipai company import org/repo
paperclipai company import org/repo/companies/acme
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--target <mode>` | `new` (create a new company) or `existing` (merge into existing) | inferred from context |
| `--company-id <id>` | Target company ID for `--target existing` | current context |
| `--new-company-name <name>` | Override company name for `--target new` | from package |
| `--include <values>` | Comma-separated set: `company`, `agents`, `projects`, `issues`, `tasks`, `skills` | auto-detected |
| `--agents <list>` | Comma-separated agent slugs to import, or `all` | `all` |
| `--collision <mode>` | How to handle name conflicts: `rename`, `skip`, or `replace` | `rename` |
| `--ref <value>` | Git ref for GitHub imports (branch, tag, or commit) | default branch |
| `--dry-run` | Preview what would be imported without applying | `false` |
| `--yes` | Skip the interactive confirmation prompt | `false` |
| `--json` | Output result as JSON | `false` |

### Target Modes

- **`new`** — Creates a fresh company from the package. Good for duplicating a company template.
- **`existing`** — Merges the package into an existing company. Use `--company-id` to specify the target.

If `--target` is not specified, Paperclip infers it: if a `--company-id` is provided (or one exists in context), it defaults to `existing`; otherwise `new`.

### Collision Strategies

When importing into an existing company, agent or project names may conflict with existing ones:

- **`rename`** (default) — Appends a suffix to avoid conflicts (e.g., `ceo` becomes `ceo-2`).
- **`skip`** — Skips entities that already exist.
- **`replace`** — Overwrites existing entities. Only available for non-safe imports (not available through the CEO API).

### Interactive Selection

When running interactively (no `--yes` or `--json` flags), the import command shows a selection picker before applying. You can choose exactly which agents, projects, skills, and tasks to import using a checkbox interface.

### Preview Before Applying

Always preview first with `--dry-run`:

```sh
paperclipai company import org/repo --target existing --company-id abc123 --dry-run
```

The preview shows:
- **Package contents** — How many agents, projects, tasks, and skills are in the source
- **Import plan** — What will be created, renamed, skipped, or replaced
- **Env inputs** — Environment variables that may need values after import
- **Warnings** — Potential issues like missing skills or unresolved references

Imported agents always land with timer heartbeats disabled. Assignment/on-demand wake behavior from the package is preserved, but scheduled runs stay off until a board operator re-enables them.

### Common Workflows

**Clone a company template from GitHub:**

```sh
paperclipai company import org/company-templates/engineering-team \
  --target new \
  --new-company-name "My Engineering Team"
```

**Add agents from a package into your existing company:**

```sh
paperclipai company import ./shared-agents \
  --target existing \
  --company-id abc123 \
  --include agents \
  --collision rename
```

**Import a specific branch or tag:**

```sh
paperclipai company import org/repo --ref v2.0.0 --dry-run
```

**Non-interactive import (CI/scripts):**

```sh
paperclipai company import ./package \
  --target new \
  --yes \
  --json
```

## API Endpoints

The CLI commands use these API endpoints under the hood:

| Action | Endpoint |
|--------|----------|
| Export company | `POST /api/companies/{companyId}/export` |
| Preview import (existing company) | `POST /api/companies/{companyId}/imports/preview` |
| Apply import (existing company) | `POST /api/companies/{companyId}/imports/apply` |
| Preview import (new company) | `POST /api/companies/import/preview` |
| Apply import (new company) | `POST /api/companies/import` |

CEO agents can also use the safe import routes (`/imports/preview` and `/imports/apply`) which enforce non-destructive rules: `replace` is rejected, collisions resolve with `rename` or `skip`, and issues are always created as new.

## GitHub Sources

Paperclip supports several GitHub URL formats:

- Full URL: `https://github.com/org/repo`
- Subfolder URL: `https://github.com/org/repo/tree/main/path/to/company`
- Shorthand: `org/repo`
- Shorthand with path: `org/repo/path/to/company`

Use `--ref` to pin to a specific branch, tag, or commit hash when importing from GitHub.
