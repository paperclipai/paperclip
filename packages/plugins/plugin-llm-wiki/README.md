# LLM Wiki

Local-file LLM Wiki plugin for source ingestion, wiki browsing, query, lint, and maintenance workflows.

## Scope

This package is the standalone home for LLM Wiki behavior. Wiki-specific routes,
UI, prompts, tools, local-folder templates, migrations, fixtures, and tests live
here rather than in Paperclip core.

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
- agent-free Notion <-> Wiki sync job (`notion-wiki-sync`) on `*/15 * * * *`
- agent-free Notion Strategy Poll job (`notion-strategy-poll`) on `0 * * * *`

## Notion <-> Wiki Sync

The plugin declares a native scheduled job, `notion-wiki-sync`, that runs in the
plugin worker every 15 minutes. It does not create or wake an agent.

Configuration:

- Notion token: `notionToken` plugin config, `NOTION_TOKEN`, or
  `~/.paperclip/instances/default/secrets/notion-token.txt`.
- Default Notion create parent: `notionTasksDatabaseId` plugin config,
  `NOTION_TASKS_DATABASE_ID`, or
  `~/.paperclip/instances/default/secrets/notion-tasks-database-id.txt`.
- Wiki target defaults to `wikiId=default`, `spaceSlug=default`; override with
  `notionSyncWikiId` and `notionSyncSpaceSlug`.
- `notionSyncCompanyIds` must contain the explicit company ids this scheduled job
  may process. An empty or missing list skips the run; the plugin never falls back
  to instance-wide company discovery.
- Set `notionSyncEnabled=false` to disable the job without removing it.

Data shape and behavior:

- Source API: Notion API v1, `Notion-Version: 2022-06-28`.
- Scope: all pages returned by Notion `/search` with `object=page`, i.e. all
  pages visible to the integration token. Empty search results are logged as a
  gap, not filled with placeholders.
- Notion -> Wiki writes pages under `wiki/notion/<title>-<pageid>.md`.
- Wiki frontmatter includes `source: notion`, `notion_page_id`,
  `notion_last_edited_time`, `notion_content_hash`, `notion_sync: true`, and
  `notion_url` when available.
- Wiki -> Notion writeback is opt-in: wiki pages must have
  `notion_sync: true`. Pages with `notion_page_id` replace that Notion page's
  child blocks. Pages without `notion_page_id` create a new Notion page under
  the configured Tasks database when that database id is available.
- Cursors are persisted in `notion_sync_cursors` with Notion last edit time,
  Notion content hash, wiki content hash, origin, and last sync time.
- Each run inserts one `wiki_operations` row with `operation_type=notion-sync`,
  status, counts, warnings, affected pages, and the plugin job run id.
- Conflict policy: Notion is authority for Notion-origin pages; Wiki is authority
  for Wiki-origin pages. Conflicts are appended to `wiki/log.md` and recorded in
  operation warnings; they are not silently overwritten.
- Notion 429/5xx responses retry with exponential backoff inside the run. Partial
  page failures do not abort the whole cycle.

Manual verification can run the same code path with the plugin action
`run-notion-sync`. Deploy still requires the board/operator to upgrade the
installed plugin package so the host loads the rebuilt `dist/manifest.js` and
`dist/worker.js`.

## Notion Strategy Poll

The plugin declares a native scheduled job, `notion-strategy-poll`, that runs in
the plugin worker hourly (`0 * * * *`). It is agent-free: empty polls create zero
Paperclip issues and do not create routine execution issues.

Configuration:

- Source API: Notion API v1 at `https://api.notion.com`,
  `Notion-Version: 2022-06-28`.
- Notion token: `notionStrategyPollToken`, `notionToken`, `NOTION_TOKEN`, or
  `~/.paperclip/instances/default/secrets/notion-token.txt`.
- Tasks database id: `notionStrategyPollTasksDatabaseId`,
  `notionTasksDatabaseId`, `NOTION_TASKS_DATABASE_ID`, or
  `~/.paperclip/instances/default/secrets/notion-tasks-database-id.txt`.
  Pilars Tasks DB: `26a3a489-a9ca-81a5-90a5-db6e196213ce`.
- Target CRO: `notionStrategyPollCroAgentId`, `PAPERCLIP_CRO_AGENT_ID`, or the
  Pilars CRO id `fb0272a1-0b64-42c6-bebf-835c6ea22903`.
- `notionStrategyPollCompanyIds` contains the explicit company ids this poll may
  process. When omitted it inherits `notionSyncCompanyIds`; when both are empty,
  the poll skips without attempting instance-wide company discovery.
- Set `notionStrategyPollEnabled=false` to disable the job without removing it.

Data shape and behavior:

- Queries the Tasks database via `POST /v1/databases/{databaseId}/query`, sorted
  by `last_edited_time` ascending, with a strict `last_edited_time after`
  watermark after the first successful processed delta.
- Reads each Notion page as `{ id, url, archived, last_edited_time, properties }`.
  The poller uses title from `Task name`, `Name`, or the first title property;
  status from `Status` (`status` or `select`); tags from `Tags.multi_select`.
- Strategy detection is intentionally the legacy Notion poller heuristic: skip
  Done/Cancelled/Canceled/Archived and archived pages; require at least one tag;
  then match when title contains `стратег`/`strategy` or tags include
  `Research` plus `BTC` or `Metrics`.
- Idempotency is persisted in `notion_strategy_poll_cursors`, keyed by the full
  normalized Notion page id plus exact `last_edited_time`. No 8-character page id
  prefixes are used.
- On a genuine new or changed strategy delta, the worker creates exactly one
  Paperclip issue assigned to CRO. Issue creation uses the plugin host bridge
  `ctx.issues.create` under the manifest `issues.create` capability, not an
  out-of-band cron or agent run.
- Each poll writes one `wiki_operations` row with
  `operation_type=notion-strategy-poll`, status, counts, warnings, emitted issue
  identifiers, and the plugin job run id.
- Notion 429/5xx responses retry with exponential backoff inside the run. Auth,
  schema, and API failures are recorded as operation warnings and do not create
  placeholder/proxy issues.

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
