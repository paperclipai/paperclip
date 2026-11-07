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

## Git Mirror (Read-Only)

One wiki space per company can mirror the Markdown files of a GitHub branch, so
a handbook kept in Git shows up in the Wiki without anyone copying it. Git stays
the only writer.

Configure it on the plugin's settings page (company-scoped plugin config,
`gitMirror`): enable it, set `repository` (`owner/name`), `branch` and the wiki
`spaceSlug` (`default` is the space the Wiki opens on; any other slug is created
if missing), then pick one credential:

- a GitHub App installed on the repository: `githubAppId`,
  `githubAppInstallationId` and the App's private key as a Paperclip secret.
  Each sync mints a one-hour installation token narrowed to the one repository
  and `contents: read`, and refuses the token if GitHub grants anything wider;
- or a fine-grained token with `contents: read` on that repository, as a secret;
- or nothing, for a public repository.

How it behaves:

- The scheduled job `git-mirror-sync` runs every 15 minutes. It reads the
  branch head and stops there when the commit is unchanged; otherwise it lists
  the tree, fetches only the blobs whose Git object id changed, checks each
  blob's id against its bytes, and writes it into the space's folder. Files it
  mirrored that left the branch are deleted; it never deletes a file it did not
  write. Saving the config syncs at once; **Sync now** on the Wiki page banner
  re-fetches everything.
- Every sync runs in the handler of a company-scoped plugin event
  (`git-mirror-sync-requested`) that the plugin emits to itself: a host-issued
  invocation scope ends when its RPC settles and a scheduled job has none, and
  the host refuses unscoped calls while other invocations are active. The job
  syncs the companies the host reported through `onConfigChanged`.
- Only `*.md` files outside dot-directories are mirrored, up to 1 MB each,
  5,000 files and 50 MB in total. A truncated tree listing fails the sync
  instead of mirroring part of the repository.
- Every mirrored file lands at a path the page tools read: `AGENTS.md`,
  `IDEA.md`, `index.md`, `log.md`, `WIKI.md` and `wiki/**.md` keep their
  path, and any other Markdown file goes under `wiki/` (`README.md` becomes
  `wiki/README.md`, `docs/setup.md` becomes `wiki/docs/setup.md`). A file
  whose new path another repository file already holds, or with an upper-case
  `.MD` extension, is skipped and listed in the sync's skipped files.
- Against the repository the plugin only issues `GET` requests. Inside
  Paperclip the mirrored space refuses page writes, source captures, log
  appends, space bootstrap and (for the default space) template edits. Root
  bootstrap on a mirrored default space still sets the folder path but writes
  no starter files, and the mirror creates a missing target space without them.
- Credential fields accept only Paperclip secret references, so a raw key or
  token sent through the API is refused before it is stored. Credentials are
  checked before they reach a header, and every error the mirror stores, logs
  or returns is scrubbed of them.
- One sync runs per company at a time; a forced sync waits for the running one
  and then reads the config afresh. A sync that fails part-way is redone in
  full next time, even if the branch moved back to the last synced commit.
- A changed repository, branch or space touches nothing until the new
  credential, branch, tree and limits check out, so a misspelled branch leaves
  the working copy as it was. A changed repository or branch for the same
  space replaces the copy in place, deleting only what the new branch lacks; a
  changed space removes the old copy before the new one is written.
- A sync stops at a 10-minute budget, spent on blob fetches, deletes and the
  page index check alike, and hands the rest to a continuation.
- Sync state (commit, per-file object ids, last error) lives in plugin state;
  no credential is ever stored there or in an error message.
- The wiki-root folder path must be configured first (the Wiki setup screen, or
  the host's local-folder route). Each sync creates the folder and the plugin's
  required directories when they are missing, without bootstrap's starter files
  or managed agent. A mirror into the default space supplies the required root
  files from the repository; a mirror into another space needs the root
  bootstrapped.
- Each mirrored page is indexed (path, title from its first level-one heading,
  page type, outgoing links), so `wiki_list_pages`, `wiki_search` and backlinks
  cover it. Search covers indexed page titles and paths, not mirrored file
  contents. No revision rows are written: the repository holds the history.
  The Wiki page refetches its page list, open page and overview when the
  banner sees a sync finish.

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
