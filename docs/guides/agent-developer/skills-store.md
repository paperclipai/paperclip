---
title: The Skills Store
summary: Browse, install, import, fork, and share the reusable skills your agents use
---

The **Skills Store** is Paperclip's library of reusable skills. A skill is a markdown
playbook that teaches an agent how to do a specific kind of work — triage an issue,
write a wireframe, run QA acceptance, draft a release announcement. The Store is where
people (and agents) discover those skills, install them into a company, and manage them
over time.

If you want to *author* a skill, read [Writing a Skill](writing-a-skill). This page is
about the **store around** skills: where they come from, how they get into your company,
and how you keep them current.

## Two layers: the catalog and your company library

There are two distinct things people loosely call "the skills store":

| Layer | What it is | Lives in |
|---|---|---|
| **The catalog** | A curated, read-only set of skills that ships with Paperclip | The `@paperclipai/skills-catalog` package |
| **Your company library** | The skills actually installed in *your* company, which agents can run | The `company_skills` database table |

The catalog is the shelf you browse. Your company library is the cart you've checked
out. Installing a catalog skill copies it into your company library, where you can edit,
version, fork, and share it independently of the original.

### The bundled catalog

The catalog is built from markdown under `packages/skills-catalog/catalog/` and compiled
into a manifest (`generated/catalog.json`) at build time. Each catalog skill is one
directory containing a `SKILL.md` plus any supporting `references/`, `scripts/`, or
`assets/` files.

The catalog splits skills into two **kinds**:

- **`bundled`** — first-party Paperclip skills (e.g. `issue-triage`, `task-planning`,
  `qa-acceptance`, `wireframe`, `github-pr-workflow`, `doc-maintenance`). These carry the
  reserved `paperclipai/paperclip/...` key namespace.
- **`optional`** — additional curated skills you opt into (e.g. `agent-browser`,
  `design-critique`, `release-announcement`, `last30days`).

Every catalog skill carries metadata used for discovery and safety:

- **`category`** — grouping such as `software-development`, `quality`, `product`,
  `research`, `content`, `browser`, `paperclip-operations`, `docs`.
- **`recommendedForRoles`** — agent roles the skill suits (`engineer`, `qa`, `designer`,
  `product`, `researcher`, …), used to suggest skills when staffing a company.
- **`trustLevel`** — see [Trust levels](#trust-levels-what-a-skill-is-allowed-to-carry).
- **`compatibility`** — `compatible`, `unknown`, or `invalid`, derived during the build
  validation pass.
- **`contentHash`** — a hash of the skill's files, used later to detect updates and drift.

## Trust levels: what a skill is allowed to carry

Because a skill can bundle more than prose, every skill is classified by how much trust
its contents require. The level is **derived from the files**, not self-declared:

| Trust level | Contains | Notes |
|---|---|---|
| `markdown_only` | Only `.md` files | Safest — pure instructions |
| `assets` | Markdown plus images/PDFs/other static files | No executable code |
| `scripts_executables` | Any script (`.sh`, `.js`, `.py`, `.ts`, …) | Highest scrutiny |

Trust level gates what can be imported. A skill that carries executable scripts **cannot
be imported from an external source** (GitHub, `skills.sh`, or a raw URL) — only
first-party bundled catalog skills are allowed to ship scripts. This keeps untrusted
remote code out of your agents' hands.

## Where skills come from (source types)

A skill in your company library records where it originated. The Store shows this as a
**source badge**:

| Source type | Badge | Meaning |
|---|---|---|
| `catalog` | Paperclip / catalog | Installed from the bundled catalog |
| `github` | GitHub | Imported from a GitHub repo (pinned to a commit) |
| `skills_sh` | skills.sh | Imported via the [skills.sh](https://skills.sh) registry (resolves to GitHub) |
| `url` | URL | Imported from a raw markdown URL |
| `local_path` | Local | Created in-app or scanned from a project workspace on disk |

External imports (`github`, `skills_sh`, `url`) are held to two rules: they must be
`markdown_only` or `assets` (no scripts), and Git-backed sources **must resolve to a
pinned 40-character commit SHA** before import, so a moving branch can never silently
change what your agents run.

## Getting skills into your company

The Store offers several paths, all of which land a skill in your company library.

### Install from the catalog

Browse the catalog's discovery grid, pick a skill, and install it. Installing copies the
catalog skill's files into your company library and stamps provenance metadata (the
catalog key, content hash, and package version) so the Store can later tell you when the
upstream catalog skill has changed.

- API: `POST /companies/:companyId/skills/install-catalog`
- Re-installing an already-installed catalog skill updates it in place rather than
  creating a duplicate.

### Import from an external source

Paste a source and Paperclip fetches and imports it. Accepted forms include:

- A GitHub repo or subfolder URL (`https://github.com/owner/repo/tree/<ref>/skills/foo`)
- A short `owner/repo` or `owner/repo/skill` reference
- A `skills.sh` URL or an `npx skills add …` command (both resolve to the GitHub source)
- A raw markdown URL pointing directly at a `SKILL.md`

A repo can contain many skills; the importer discovers every `SKILL.md` under the path
(optionally filtered to a single `--skill` slug).

- API: `POST /companies/:companyId/skills/import`

### Create a local skill

Author a skill directly in the company library without any external source. This is the
"new skill" path — you provide the name, description, and markdown body and it's stored
as a `local_path` / managed-local skill.

- API: `POST /companies/:companyId/skills`

### Scan a project workspace

Agents and projects often already keep skills on disk under conventional folders
(`skills/`, `.claude/skills/`, `.agents/skills/`, and many other tool-specific roots).
The project scan walks a workspace, finds those `SKILL.md` directories, and offers to
import them into the company library, reporting any conflicts or skips.

- API: `POST /companies/:companyId/skills/scan-projects`

## Living with installed skills

Once a skill is in your library, the Store treats it like a small product with a
lifecycle.

### Versions

Each skill keeps a revision history. Saving a new version snapshots the full file
inventory (with content) and bumps the revision number, so you can review history and
roll back.

- List: `GET /companies/:companyId/skills/:skillId/versions`
- Create: `POST /companies/:companyId/skills/:skillId/versions`

### Updates, drift, and reset

For skills installed from the catalog or an external source, the Store tracks the origin.
The **update status** endpoint compares your installed copy against the latest upstream
and reports whether an update is available, whether *you* have locally modified the skill
(drift), and any hold reason that should block an automatic update.

- Check: `GET /companies/:companyId/skills/:skillId/update-status`
- Install the upstream update: `POST /companies/:companyId/skills/:skillId/install-update`
  (with `force` to override local drift)
- Discard local changes and return to the pristine origin:
  `POST /companies/:companyId/skills/:skillId/reset`

### Audit

A skill can be audited to compare its installed content hash against its recorded origin
hash and flag tampering or unexpected drift. The audit returns a verdict and a set of
codes that the Store surfaces as a health signal.

- API: `POST /companies/:companyId/skills/:skillId/audit`

### Fork

Forking copies an existing skill into a new, independent library entry (optionally with a
new name, slug, and sharing scope). The fork records what it was forked from, and the
original's `forkCount` increments. Use this to customize a catalog or community skill
without losing the ability to see the upstream it came from.

- API: `POST /companies/:companyId/skills/:skillId/fork`

### Stars and comments

Skills are social objects inside the Store. Members can **star** a skill (a per-actor
toggle that drives the `starCount`) and leave threaded **comments** for discussion and
review.

- Star / unstar: `POST` / `DELETE /companies/:companyId/skills/:skillId/star`
- Comments: `GET` / `POST /companies/:companyId/skills/:skillId/comments`,
  plus `PATCH` and `DELETE` for editing and removing.

## Sharing scope

Every company skill has a **sharing scope** that controls who can see it:

| Scope | Visibility |
|---|---|
| `private` | Only the author/owner |
| `company` | Everyone in the company |
| `public_link` | Anyone with the generated public share token |

Scope is set when creating, updating, or forking a skill, and the Store's discovery view
can filter by it.

## How agents actually use installed skills

Installing a skill is not the same as an agent running it. At runtime, a company's
installed skills are materialized into the agent's workspace as `SKILL.md` directories,
and the agent's harness loads the **frontmatter `name` + `description`** of each skill as
routing logic. The agent reads those one-line descriptions to decide *whether* a skill is
relevant to the current task, and only then loads the full body. (This is why a skill's
`description` should read as "what this does and when to use it" — it is the index the
agent searches.)

Skill sync into agent workspaces is governed by a per-instance preference, so an operator
can control whether and how the company library is pushed down to running agents.

## Reference: API surface

All endpoints are under the company-skills router.

**Catalog (read-only)**

- `GET /skills/catalog` — list the bundled catalog
- `GET /skills/catalog/:catalogId` — one catalog skill
- `GET /skills/catalog/:catalogId/files` — its file inventory + content

**Company library**

- `GET /companies/:companyId/skills` — list (supports `q`, `sort`, `categories`, `scope`)
- `GET /companies/:companyId/skills/categories` — category counts
- `GET /companies/:companyId/skills/:skillId` — detail
- `GET /companies/:companyId/skills/:skillId/files` — file inventory + content
- `POST /companies/:companyId/skills` — create a local skill
- `PATCH /companies/:companyId/skills/:skillId` — edit metadata / sharing scope
- `DELETE /companies/:companyId/skills/:skillId` — remove from the library
- `POST /companies/:companyId/skills/install-catalog` — install a catalog skill
- `POST /companies/:companyId/skills/import` — import from GitHub / skills.sh / URL
- `POST /companies/:companyId/skills/scan-projects` — scan workspaces for skills
- `POST /companies/:companyId/skills/:skillId/fork` — fork a skill
- `POST /companies/:companyId/skills/:skillId/versions` · `GET …/versions` · `GET …/versions/:versionId`
- `GET /companies/:companyId/skills/:skillId/update-status`
- `POST /companies/:companyId/skills/:skillId/install-update`
- `POST /companies/:companyId/skills/:skillId/reset`
- `POST /companies/:companyId/skills/:skillId/audit`
- `POST` / `DELETE /companies/:companyId/skills/:skillId/star`
- `GET` / `POST /companies/:companyId/skills/:skillId/comments` · `PATCH` / `DELETE …/comments/:commentId`

All mutating endpoints require permission to manage the company's skills and are recorded
in the company activity log.

## Reference: the catalog package

The catalog is its own publishable package, `@paperclipai/skills-catalog`:

- `catalog/bundled/**` and `catalog/optional/**` — the source skill directories
- `scripts/build-catalog-manifest.ts` — compiles the directories into `generated/catalog.json`
- `scripts/validate-catalog.ts` — validates frontmatter, keys, and trust classification
- `src/index.ts` — exports `catalogManifest`, `catalogSkills`, `getCatalogSkill(id)`, and
  `resolveCatalogSkillRef(ref)` for resolving a skill by id, key, or slug

To add a skill to the bundled catalog, create the directory with a `SKILL.md`, then run
the package's `build:manifest` (and `validate`) scripts to regenerate and check the
manifest.

## See also

- [Writing a Skill](writing-a-skill) — the `SKILL.md` format and authoring best practices
- [How Agents Work](how-agents-work) — how skills fit into a heartbeat

```
         (o)___(o)
        /         \
       |  o     o  |
       |     <     |
        \  \___/  /
         \_______/
        /         \
   ~~~ ribbit ~~~  skills! ~~~
```

