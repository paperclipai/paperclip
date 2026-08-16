# LLM Wiki

Local-file LLM Wiki plugin for source ingestion, wiki browsing, query, lint, and maintenance workflows.

## Scope

This package is the standalone home for LLM Wiki behavior. Wiki-specific routes,
UI, prompts, tools, local-folder templates, migrations, fixtures, and tests live
here rather than in Paperclip core.

## Shared company context (project spaces + agent API)

The wiki is the company's shared context surface: every Paperclip project gets
its own wiki space, and every agent can read and contribute through a scoped
HTTP API.

- **Project-bound spaces** (migration `004_project_spaces.sql`): the worker
  subscribes to `project.created`/`project.updated` and keeps one shared space
  per project (`spaces/proj-<slug>/`, display name follows project renames,
  archived projects archive their space). A `reconcile-project-spaces` action
  and a best-effort startup sweep cover pre-existing projects.
- **Zero-config activation**: when no wiki root is configured, bootstrap (and
  the first project space) auto-configures a managed default under
  `<PAPERCLIP_HOME>/instances/<id>/plugin-data/<companyId>/<pluginKey>/wiki-root`.
- **Agent API** (`auth: "board-or-agent"`, base
  `/api/plugins/paperclipai.plugin-llm-wiki/api`): `GET /agent/space-index`,
  `GET /agent/search` (company-wide body search), `GET /agent/page`,
  `POST /agent/page` (expectedHash with 409 + currentHash on conflict),
  `POST /agent/capture` (raw source + queued ingest operation), and
  `POST /agent/log`. Routes accept `spaceSlug`, `projectId`, or `projectName`;
  writes record agent/user attribution on revisions and sources.
- **Company-required skill**: the `wiki` managed skill ships with
  `required: true`, so the host force-syncs it to every agent on every runtime
  (host-side support: `required` flag on plugin-managed skill declarations).
- **Body search** (migration `005_body_search.sql`): `wiki_search_documents`
  keeps a secret-redacted, capped text mirror per page/source with trigram
  indexes; `wiki_search` and `/agent/search` rank over bodies, and a
  `reindex-search` action rebuilds the cache from disk (disk stays truth).
- **Revision recovery** (migration `006_revision_attribution.sql`): page
  revisions now store contents plus `author_kind`/`author_id`/`author_run_id`.
- **Second-brain model** (migration `007_second_brain.sql`): Markdown frontmatter,
  aliases, tags, wikilinks, ordinary local Markdown links, accepted AI link
  suggestions, and Canvas edges share one normalized relationship graph.
- **Obsidian-style workspaces**: company, project-space, and depth-limited local
  graphs sit alongside a durable visual Canvas with note/text cards, typed
  connections, autosave, undo/redo, revision history, and rollback. This is a
  Paperclip-native model; it does not claim Obsidian `.canvas` compatibility.
- **Privacy and traceability**: notes and canvases are either company-visible or
  owner-private. The owning human and same-company agents can work with private
  knowledge; other humans cannot discover it. Every mutation stores human/agent,
  run, revision, and activity metadata. Semantic links proposed by agents remain
  pending until a signed-in human accepts them, and acceptance never rewrites the
  source Markdown.
- **Recoverable lifecycle**: notes can be moved/renamed, archived to Wiki trash,
  restored, or rolled back to a content snapshot. Graph references and Canvas
  note cards follow a rename.
- **Maintenance activation**: the `activate-wiki-maintenance` action resumes
  the Wiki Maintainer, activates the three maintenance routines, and warns when
  the maintainer has no monthly budget.

The alpha surface includes:

- manifest-declared Wiki page, sidebar entry, and settings page
- trusted local folder declaration for `raw/`, `wiki/`, `AGENTS.md`, `IDEA.md`, `wiki/index.md`, and `wiki/log.md`
- plugin database namespace migration for wiki instances, sources, pages, operations, query sessions, and resource bindings
- managed `Wiki Maintainer` agent, managed `LLM Wiki` project, and paused managed routines for wiki update processing, lint, and index refresh
- plugin-operation issue creation using `surfaceVisibility: "plugin_operation"`
- local source capture into `raw/` with metadata rows in the plugin DB namespace
- opt-in company-scoped Paperclip event ingestion controls for issues, comments, and documents; event ingestion is disabled by default and routes captured raw provenance into the default space only
- manual Paperclip project/root issue distillation and bounded backfill actions with explicit work items, operation issues, source caps, and estimated cost recording
- Paperclip-derived distillation (cursor windows, manual `distill-now`, backfill) always writes into the default wiki space in Phase 1; non-default spaces remain on manual / raw-file ingest until per-space Paperclip ingestion profiles ship
- Paperclip-derived distillation maintains `wiki/projects/<slug>/standup.md` as the executive current-state view for each represented project, alongside durable `wiki/projects/<slug>/index.md` knowledge pages
- wiki page writes with plugin path validation, atomic local-folder writes, metadata/revision rows, backlink extraction, and optional stale-hash protection
- wiki tools for search/read/write/propose patch/source/log/index/backlinks workflows

## Phase 5 Security Gate

Paperclip-derived text ingestion stays limited to issue titles/descriptions, issue comments, and issue documents.

- Issue attachments/assets are **metadata-only** in Phase 5.
- Issue work products are **metadata-only** in Phase 5.
- The wiki must not fetch `/api/assets/:id/content`, dereference work-product `url` fields, or store those capability-bearing links in source bundles/snapshots.

The accepted policy lives in [doc/plans/2026-05-06-llm-wiki-paperclip-asset-security-gate.md](../../../doc/plans/2026-05-06-llm-wiki-paperclip-asset-security-gate.md).

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

From the Paperclip repo root:

```bash
pnpm --filter @paperclipai/plugin-llm-wiki typecheck
pnpm --filter @paperclipai/plugin-llm-wiki test
pnpm --filter @paperclipai/plugin-llm-wiki build
```

## Alpha Verification

Run these commands from the Paperclip repo root before handing off alpha plugin
changes:

```bash
pnpm --filter @paperclipai/plugin-llm-wiki typecheck
pnpm --filter @paperclipai/plugin-llm-wiki test
pnpm --filter @paperclipai/plugin-llm-wiki build
```

The focused Vitest suite covers:

- standalone package boundaries and package-local harness dependencies
- required local folder bootstrap writes
- raw source capture plus ingest metadata persistence
- hidden plugin-operation issue creation for ingest/query/file-as-page workflows
- disabled and enabled Paperclip event ingestion paths
- managed routine declarations, manual distill/backfill work items, source cap handling, and backfill project/date scoping
- atomic page writes, metadata/revision rows, backlinks, and stale-hash refusal
- query session creation, run-id recording, stream event forwarding, and completion updates
- filing a streamed query answer back into the wiki through a hidden operation

Remaining alpha gaps:

- Browser screenshot capture is maintained separately under `tests/screenshots`;
  generated `screenshots/` outputs are local artifacts and are ignored by git.
- Host-level plugin install and live agent invocation still need Paperclip
  server/runtime smoke coverage when preparing a release candidate.



## Install Into Paperclip

The production image builds and validates the Wiki bundle and defaults
`PAPERCLIP_BUNDLED_PLUGINS=llm-wiki`, so a missing or previously errored Wiki is
provisioned during startup before plugin workers load. Other deployments can use
the same comma-separated environment variable explicitly.

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/Users/dotta/paperclip/.paperclip/worktrees/PAP-3179-design-a-llm-wiki-plugin/packages/plugins/plugin-llm-wiki","isLocalPath":true}'
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.

After changing manifest-loaded assets such as skills, agent instructions, or
templates, recompile the local plugin before re-enabling it:

```bash
pnpm --filter @paperclipai/plugin-llm-wiki build
```

The package-local `dist/` directory is ignored by git, but local Paperclip
installs load the compiled `dist/manifest.js` and `dist/worker.js` files at
runtime. If activation failed before the rebuild, re-enable the plugin or
restart the Paperclip dev server so the host imports the fresh bundle.

## Local File Layout

```text
<configured-wiki-root>/
  AGENTS.md
  IDEA.md
  .gitignore
  raw/
    .gitkeep
  wiki/
    index.md
    log.md
    sources/
      .gitkeep
    projects/
      .gitkeep
      <project-slug>/
        index.md
        standup.md
        decisions.md
        history.md
    entities/
      .gitkeep
    concepts/
      .gitkeep
    synthesis/
      .gitkeep
```

Use the settings page or `bootstrap-root` action to configure the folder and
write the starter files. The plugin uses Paperclip's local folder API for path
containment, symlink checks, read/write validation, and atomic writes.

Bootstrap preserves existing files rather than overwriting operator edits. The
default first-install skeleton is copied from the vanilla LLM Wiki layout, with
`CLAUDE.md` renamed to `AGENTS.md` and Paperclip project overviews, standups,
decisions, and history kept together under `wiki/projects/<slug>/`.

## Managed Agent Instructions

Plugin-managed agent instruction bundles live under:

```text
agents/<agent-key>/AGENTS.md
```

For this plugin the Wiki Maintainer source bundle is `agents/wiki-maintainer/AGENTS.md`.
Any additional files in that folder are installed as sibling instruction files
for the managed agent. The settings health check reports drift from these
defaults, and resetting the managed agent asks for confirmation before replacing
customized instructions.
