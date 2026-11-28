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
  `design-critique`, `release-announcement`, `last30days`, `ramp`).

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

GitHub sources support scripts after the existing content audit passes. Importing
never executes scripts, hooks, dependency installers, or builds. Raw URL and
`skills.sh` imports retain their existing script restrictions. Unsafe content,
secrets, invalid paths, and oversized files are still rejected.

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

Git-backed sources **must resolve to a pinned 40-character commit SHA** before
import. A moving branch cannot change what agents run until you refresh its source.
GitHub originals are read-only; use **Make a copy** to edit an independent local skill.

### Thin wrappers for external live playbooks

Some optional catalog skills intentionally do not vendor a third-party playbook. The
`ramp` skill is the model: Paperclip ships the stable governance wrapper, source
allowlist, and approval gates, then tells the agent to fetch Ramp's current published
instructions from `agents.ramp.com` when the task starts.

Use this pattern only when the external provider's setup flow changes often enough that
a vendored snapshot would go stale, and when Paperclip can keep the safety boundary in
the wrapper. For financial, legal, or account-control domains, the wrapper must require
Paperclip approvals before spend, incorporation, account authorization, card issuance,
data sharing, or other irreversible actions. The tradeoff should be documented in the
skill or PR so reviewers can evaluate freshness against external-instruction risk. If
the provider mixes official and community playbooks on the same host, the wrapper must
fail closed on unclear provenance and require separate approval before using any
third-party tool, connector, browser automation service, or credential flow introduced
by a fetched playbook.

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

### Sync skills from GitHub

Open **Skills → Sources → Import from GitHub** (also in the **New** menu), choose a connected repository or
click **… or add public repo by URL** to paste a GitHub.com repository URL, then choose **Find skills**. The searchable list
combines repositories from all GitHub connections you can access, with duplicates
removed. Paperclip automatically uses an authorized connection for the chosen
repository. Pasted URLs also use your authorized connections when available,
including public repositories outside the list. Public repositories can use
anonymous access when no connection succeeds; private repositories require access.
A company without a GitHub connection installed reads with its `GITHUB_TOKEN`,
`GH_TOKEN` or `PAPERCLIP_GITHUB_TOKEN` company secret instead of anonymously.

A repository URL uses the default branch. Paste a branch URL such as
`https://github.com/owner/repo/tree/feature/new-skills` to track another branch,
including branches whose names contain slashes. **Add repos**
opens the standard setup in Apps. Completing or cancelling setup returns you to
the importer with your draft retained; the repository list refreshes automatically.
Use the refresh button beside the repository count to reload accessible repositories.

New imports keep repository files together. **View files** opens the included
repository inventory. The skill tree stays open, with every discovered skill
selected. Containing folders start expanded; individual package files start
collapsed. Folder checkboxes select descendant skills. Uncheck skills that should
not appear in the library; their files still accompany the selected skills as
repository support content. Supporting files cannot be deselected individually.
Existing sources retain their saved import mode.

Use the inspection button or click an included file to open a read-only preview.
The inspector shows the repository path, scanned commit, byte sizes, executable
flags, and any `compatibility` requirements declared by the author. Text previews
show up to 64 KiB; binary assets show metadata and a link to GitHub for viewing or
download. Preview reads use the current caller's GitHub access and re-audit the
package at that exact commit. Preview failures do not alter selection or installed
content. Existing sources gain inspection metadata on their next successful refresh.

Shared files present in the repository are included automatically. Missing
references, omitted files, and setup problems appear in one expandable warnings
list. The same warnings remain on the saved source after import and refresh.
Reference detection is a best-effort check, not a complete dependency analysis.
Declared runtime requirements appear in the file inspector.

Warnings do not require a repair choice or confirmation. Import saves available
content and registers usable selected skills. A malformed entrypoint stays
selected with a **Needs setup** warning; its supported original files remain
repository content. Unsupported links, oversized files, and files rejected by
execution or secret-disclosure checks are omitted with path-specific warnings.
Importing never runs scripts, hooks, dependency installation, or builds.

Scans support up to 1,000 skill packages and 10,000 package files, counting repeated
file copies, with a 100 MiB scan budget. The repository path index supports up to
100,000 paths, each at most 4,096 characters and 64 levels deep. Discovery returns
manifests without retaining every package's content.

### Keep repository files together

This is the default for new imports, including skills that share agents, scripts,
policies, or sibling skills.
Paperclip saves supported repository files at the scanned commit. The skill checkboxes
control which entrypoints appear in the company library; unselected helper skills
remain available as supporting files. Add the imported skills to an agent to use
that repository in its runtime. **View files** shows exactly what
will be copied, including root license and credit files.

Repository packages support regular files up to 1 MiB each, 9,990 files, and
61 MiB of content. Omitted files produce warnings; they do not block the remaining
repository. Source-access or download failures retain
all previously installed versions. Changes to shared files create a new version
for each selected entrypoint; pinned versions retain their original repository.

Authors can optionally add `paperclip.skills.json` at the repository root:

```json
{
  "version": 1,
  "skills": ["skills/review/SKILL.md", "skills/research/SKILL.md"],
  "requirements": "Requires Python 3.11, Git, and GitHub access for code reviews."
}
```

The listed paths must identify existing skill entrypoints. They do not change the
all-selected import default, remove other files, or prevent users from selecting
other entrypoints. The manifest only supplies
declarative metadata: it never runs setup commands. Dependencies, credentials,
subagent tools, and scheduled jobs still need to be configured in the agent's environment.

At runtime, each selected skill contains a generated discovery `SKILL.md` that
points to the untouched original in `.paperclip-repository/`. Relative references
resolve from that original directory. Original file bytes and executable flags
are preserved; discovery policy in `agents/openai.yaml` is also copied beside the
entrypoint. Existing adapters copy this self-contained package to their runtime.
Multiple enabled entrypoints currently repeat the repository files in the runtime,
while the company database stores each immutable repository snapshot once.

Repeated scans resolve the branch's current commit and reuse the caller's cached
snapshot when it is unchanged. Each server process allows one active scan per
caller and two per company. Per minute, callers can open 30 snapshots and download
6 repositories; companies can open 60 snapshots and download 12 repositories.
Cached scans do not consume the download quota. A limit returns a retry message;
installed skills remain available.

**Skills → Sources** shows repositories, installed skill links, and connection errors.
Click a repository title to open it on GitHub. Its three-dot menu contains
**Refresh**, **Select skills**, and **Disconnect source**. **Refresh** applies valid
updates immediately. New skills wait for
**Select skills → Save selection** before import. Previously declined skills stay
unchecked, including additions beneath excluded folders.

Unchecking an installed skill stops future syncing and keeps its content and agent
assignments. **Disconnect source** does the same for the whole repository. Remove
an installed skill separately if you want it gone from the library. Upstream deletion
shows **Removed from source** and retains the installed version; a moved path is a
new skill, not an inferred rename.

Installed content is stored locally, so viewing, testing, and agent execution work
without GitHub access. Updates preserve skill identity, organization, assignments,
and history. New versions are created only when package bytes or executable modes
change; active runs and pinned versions keep their existing content. Skill Studio
can view and test originals. **Make a copy** creates an independent editable skill.

Older imports with no saved tracking branch resolve the repository’s default branch
on their first successful refresh. If an explicit source already tracks that branch,
the adopted source keeps a **Default branch** alias so both sets of installed skill
identities and selections remain intact. Explicit branch and commit pins are preserved.

Recognizable older GitHub imports are adopted into Sources without refetching or
changing content; the first successful refresh completes their local snapshots.
Bundled/catalog, project/local, unsupported-host, and `skills.sh` imports keep their
existing behavior. Sync is manual and GitHub.com-only; upstream editing and pull
requests are not part of this milestone.

While finding skills, the dialog shows the scan stages, the current file, and
recently checked skills as their local packages are validated. Large repositories show real
package and file counts; you can cancel and retry without importing partial
results. Selection opens only after the full scan completes. Importing displays
an animated saving state while complete local packages are prepared. Animations
respect reduced-motion preferences.

Paperclip fetches one shallow Git snapshot, preserving committed bytes and executable
permissions without checking out or running repository code. Download progress shows
Git's measured receiving and preparing percentages before discovery begins. The server
requires Git. Downloads are limited to 128 MiB and three minutes; at most two downloads
run concurrently. Up to four temporary snapshots (including active downloads) are kept
for ten minutes, scoped to the company and caller's authorization. Preview and import
can reuse the exact scanned commit after checking access again. Installed skills remain
local and independent of this temporary cache. GitHub's API is still used for repository
identity and the connection picker, so metadata requests can still encounter rate limits.

The discovery API keeps its normal JSON response. Clients requesting
`Accept: application/x-ndjson` receive `progress` and `candidate` events followed
by `complete` (containing the discovery response), or a terminal `error`. A stream
ending without `complete` is unsuccessful; partial candidates are not importable.
Progress contains metadata only, never package file contents.

Source APIs live beneath `/api/companies/:companyId/skill-sources`:

| Method/path | Purpose |
|---|---|
| `GET /` and `GET /:sourceId` | List sources and entries |
| `GET /repositories` | Browse repositories through existing GitHub grants |
| `POST /discover` | Discover and validate packages at one commit |
| `POST /preview` | Preview an audited package file at an immutable commit using current caller access |
| `POST /` | Import selected packages at the discovered commit |
| `PATCH /:sourceId` | Save selection/exclusions and optional connection, with revision check |
| `POST /:sourceId/refresh` | Refresh selected skills; discover new ones for review |
| `DELETE /:sourceId` | Disconnect while retaining installed skills |

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
