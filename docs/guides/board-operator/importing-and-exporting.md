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
└── .paperclip.yaml     # Adapter config, repositories, env inputs, routines
```

- **COMPANY.md** defines company name, description, and metadata.
- **AGENT.md** files contain agent identity, role, and instructions.
- **SKILL.md** files are compatible with the Agent Skills ecosystem.
- **.paperclip.yaml** holds Paperclip-specific config (adapter types, repository relationships, env inputs, budgets) as an optional sidecar.

## Export & Import in the App

Both flows are also available in the web UI as company settings pages: **Export** and **Import** appear in the company settings navigation.

The **Export** page lets you pick exactly which files go into the bundle before downloading it. Above the file tree it shows a **"Not included in this export"** panel — the export fidelity report — listing data the bundle will not carry (for example attachments, approvals, cost history, or activity log entries), with blocking issues highlighted.

The **Import** page previews the package, lets you resolve name collisions and adapter assignments, and applies the import. A **"Start imported agents and routines paused"** checkbox (on by default) makes imported agents and routines land paused instead of live. After the import finishes, an **"Activate imported agents and routines"** panel lists everything that was imported paused so you can resume the agents and activate the routines you select — nothing starts running until you say so.

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
- Company repository catalog metadata, project hints, and direct agent grants
- Task/issue descriptions (when included)
- Skill packages (as references or vendored content)
- Adapter type and env input declarations in `.paperclip.yaml`

Secret values, machine-local paths, and database IDs are **never** exported.

Repository provider installations are environment-local and are never portable. Exported repository entries contain only secret-free identity/clone metadata and portable project or agent slugs. They do not contain connection ids, installation configuration, provider metadata, tokens, secret refs, or clone credentials.

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
- **Warnings** — Potential issues like missing skills, disconnected repository providers, or unresolved project/agent mappings

Provider-backed repositories always import as disconnected manual catalog metadata. Re-authorize the provider on the destination and sync it there before expecting provider refresh or clone credentials. Resolvable project hints and direct agent grants are restored; unresolved slugs stay visible in preview and are skipped during apply.

Repository hints and execution workspaces are intentionally different. A project hint says which repository the work may touch. A workspace is an actual checkout/runtime location. Import recreates only workspaces explicitly declared in the package. Legacy packages that mention a repository only through a workspace `repoUrl` recover a manual catalog row and project hint, but Paperclip does not create any additional workspace from that hint.

Imported agents always land with timer heartbeats disabled. Assignment/on-demand wake behavior from the package is preserved, but scheduled runs stay off until a board operator re-enables them.

Imports can additionally request `pauseAutomations` (the default in the app's Import page) so imported agents and routines land fully paused. Use the post-import activation panel — or resume the agents and activate the routines individually — when you are ready for them to run.

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
| Export fidelity report | `GET /api/companies/{companyId}/export/fidelity` |
| Preview import (existing company) | `POST /api/companies/{companyId}/imports/preview` |
| Apply import (existing company) | `POST /api/companies/{companyId}/imports/apply` |
| Preview import (new company) | `POST /api/companies/import/preview` |
| Apply import (new company) | `POST /api/companies/import` |

Import apply requests accept `pauseAutomations: true` to create imported agents and routines in a paused state.

CEO agents can also use the safe import routes (`/imports/preview` and `/imports/apply`) which enforce non-destructive rules: `replace` is rejected, collisions resolve with `rename` or `skip`, and issues are always created as new.

## GitHub Sources

Paperclip supports several GitHub URL formats:

- Full URL: `https://github.com/org/repo`
- Subfolder URL: `https://github.com/org/repo/tree/main/path/to/company`
- Shorthand: `org/repo`
- Shorthand with path: `org/repo/path/to/company`

Use `--ref` to pin to a specific branch, tag, or commit hash when importing from GitHub.
