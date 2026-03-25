# GitHub Plugin Design

## Goal

Build a current-runtime-compatible GitHub integration plugin for Paperclip that solves the immediate CI webhook blocker and establishes the correct long-term foundation for broader GitHub features.

The first shipped slice should recover GitHub Actions failure ingestion for `workflow_run` and `check_run`, while the overall plugin architecture should be broad enough to absorb the feature model from `paperclip-plugin-github-issues` without another rewrite.

## Why This Direction

Two different plugin sources were investigated:

- the A2A Forge CI notify plugin branch for GitHub Actions failure ingestion
- the external `paperclip-plugin-github-issues` repository as a broader GitHub integration model

Both are useful references, but neither is currently installable and runnable on this Paperclip runtime without adaptation.

The right first build therefore is:

- one GitHub plugin package
- current SDK/runtime compatibility from day one
- packaging that is installable by the current Paperclip host
- CI notify as the first implemented feature
- issue-sync and comment-sync behavior added on top of the same foundation

## Product Shape

The plugin should be treated as a general GitHub integration plugin, not a permanently narrow CI-only plugin.

### First deliverable

- receive GitHub webhook deliveries
- verify webhook HMAC signatures
- handle `workflow_run` and `check_run`
- normalize failure payloads into a single internal shape
- deduplicate repeated deliveries
- create or update Paperclip issues/comments for failures
- route work to a configured assignee when direct author mapping is unavailable
- record success in `plugin_webhook_deliveries`

### Deferred but planned

- GitHub issue linking
- bidirectional status sync
- optional comment mirroring
- GitHub issue search/link/unlink agent tools
- periodic polling

## Architecture

Create a new plugin package inside this repo, built against the current `@paperclipai/plugin-sdk` contract and modeled on the current example plugin package shape.

Recommended package location:

- `packages/plugins/github-integration/`

Recommended package identity:

- npm/package name: `@paperclipai/plugin-github`
- plugin manifest id: `paperclip.github`

Core modules:

- `constants.ts` — plugin id, webhook keys, issue labels, status constants
- `config.ts` — config parsing and validation helpers
- `github-types.ts` — minimal GitHub webhook payload types
- `verify-signature.ts` — GitHub HMAC verification
- `normalize.ts` — map GitHub webhook payloads into one internal failure shape
- `dedupe.ts` — plugin state keys and delivery dedupe logic
- `routing.ts` — resolve assignee/escalation target
- `issues.ts` — create/update/comment behavior against Paperclip issue APIs
- `github.ts` — outbound GitHub client helpers for later issue-sync features
- `worker.ts` — plugin lifecycle, webhook handling, job/tool registration
- `manifest.ts` — capabilities, webhook declarations, settings schema, optional future jobs/tools/UI

## Reuse Strategy

Reuse as much code and structure as possible from the existing GitHub plugin sources, but port them deliberately instead of trying to install them unchanged.

Use from `paperclip-plugin-github-issues`:

- manifest organization
- GitHub module boundaries
- sync-oriented helper separation
- config concepts
- future issue-sync/tool roadmap

Use from the A2A Forge CI notify plugin:

- CI event focus
- failure normalization logic
- issue routing ideas
- webhook signature verification approach
- dedupe behavior

The port rule should be:

- copy concepts and code where compatible
- rewrite any SDK touchpoints to the current runtime contract
- avoid preserving stale APIs just to keep diffs small

## Packaging And Installation

The package should be installable by the current host without depending on an unpublished npm package.

Near-term install path:

- local path install from a built package inside this repo

Target packaging rules:

- build `dist/manifest.js` and `dist/worker.js`
- do not rely on runtime build scripts during installation
- keep the first slice worker-only unless a custom UI becomes necessary

This avoids the current failure mode where source-only repos expect build steps that the host installer will not run.

## Error Handling

The plugin should fail safely and observably:

- invalid signature -> reject delivery with explicit error
- unknown event types -> accept and no-op if configured, or record ignored delivery metadata
- duplicate deliveries -> no duplicate Paperclip artifacts
- missing assignee mapping -> fall back to configured default
- malformed payloads -> structured error in delivery record and logs

## Testing Strategy

The plugin should be developed against the current SDK using automated tests before installation testing.

Required coverage for the first slice:

- config parsing
- signature verification
- webhook payload normalization
- dedupe behavior
- routing fallback behavior
- issue creation/update behavior through SDK test harnesses or mocked context

Then validate in a live Paperclip instance with:

- board install
- config save
- GitHub test delivery
- verification of `plugin_webhook_deliveries`

## Recommendation

Build one broad GitHub plugin package now, but keep the first deliverable narrowly focused on recovering CI notify.

That gives the repo:

- the correct architecture
- the correct packaging
- the fastest path to unblock DLD-585
- and a clean place to port the rest of the external GitHub plugin feature set afterward
