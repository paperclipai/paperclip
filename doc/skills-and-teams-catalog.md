# Skills and teams catalog

Authoring, shipping, storing, and synchronizing skills and team packages.

## Version-based skill authoring and delivery

Managed content uses `managed-skill-content.ts`: prepare and verify outside the
publication transaction, then compare the captured head and publish version,
projections, audit and applicable receipt together. `skill-execution-content.ts`
owns disposable filesystem bindings. Do not write managed installed directories
or infer missing content from an absent cache. Keep linked-local behavior explicit.

The [conversion and qualification guide](skill-ephemeral-web-servers.md) documents
bounded eligibility/verification commands and the one-time writer maintenance
boundary. `managed-skill-content.test.ts` covers the focused domain behavior;
`ephemeral-skills-process.test.ts` requires independent disposable Postgres and
S3 fixtures and starts separate Node processes. The optional
`PAPERCLIP_TEST_POSTGRES_ADMIN_URL` creates a random test database per suite.
The server starts the `tailscale` command only when the bind configuration reads
a tailnet address, and at most one time per process, so local fixtures need no
`PAPERCLIP_TAILNET_BIND_HOST`. Do not use fixture timings collected during
builds as hosted performance evidence.

## App-Shipped Skills Catalog

Skill-library reads still reconcile bundled releases, folders, and direct local
sources on each request. Folder classification reads only its source-kind field,
and local-source reconciliation reads only local sources. Bundled reconciliation
keeps current skill access checks but does not resolve unused folder paths.
Attachment counts read only nonterminated agents' saved desired-skill selections and
resolve them once against the complete visible skill list. Detail reads and
stored inputs remain complete.

Run the synthetic HTTP comparison through the production skills router:

```sh
pnpm --filter @paperclipai/server exec tsx scripts/benchmark-skill-list.ts --samples=5 --network-delay-ms=3.5
```

The harness starts disposable PostgreSQL, synthetic skills and agents, and a
loopback HTTP server. It checks both normal and conditional responses and records
inventory phases, SQL calls, and PostgreSQL result-value bytes. These bytes omit
protocol framing and do not measure provider billing. The actor is an authenticated
board fixture; the harness does not test login. To use a task-owned local PostgreSQL
server instead of embedded PostgreSQL, pass `--postgres-port=PORT` and
`--postgres-user=USER`. It creates and removes a separate test database. Keep timing
runs separate from builds and tests; repeat both source versions when host noise
is material. Repeat with `--capture-values=false` for acceptance timings without
the response-value observer. Add `--baseline-ref=COMMIT --capture-values=false`
to alternate the original and current skill services against the same database
and actor. This mode checks full response equality through equivalent local HTTP
handlers. The normal mode uses the production router. Only `company-skills.ts`
differs in paired mode; imported helpers stay at the current checkout.


Plugin environment drivers can declare `skillKeys` that reference their own
manifest-managed skills. Selecting that environment adds those skills to the
normal authorized skill selection, including an explicitly empty optional
selection. Core installs a missing managed skill in the current company's
library during lifecycle reconciliation or new-run admission and preserves existing
skill edits and explicit version pins. New managed skills use
`plugin-<short-plugin-id>-<skill-slug>` for both the library slug and SKILL.md name.
The short ID is the final dot-separated plugin ID component, without a leading
`plugin-`. An unrelated skill can keep the same slug in a separate canonical
record. The required environment skill wins during delivery: a selected company
skill with the same slug or name is omitted and reported as shadowed. Stored agent
assignments and both library records remain unchanged. Run warnings and snapshots,
and the plugin runtime response, identify the omitted key and the winning key. Existing company copies keep their edits and names
until reset. Lifecycle callers request installation with
`agents.getRuntime(agentId, companyId, undefined, true)`; ordinary runtime reads and
recovery do not install newly declared skills. Run
preparation captures the same immutable versions as ordinary assignments;
recovery uses the saved selection. The lifecycle runtime reader includes the
effective default environment's skills before synchronizing the persistent home.
A task provider can pass its selected environment ID to `agents.getRuntime` when
a task overrides that default. This
contract currently applies to `driver: "plugin"` environments. Other drivers
and plugin drivers without `skillKeys` keep their existing behavior. No agent
configuration is rewritten, and no background scan is added. Changes to implicitly
selected skills, the effective default environment, or plugin requirements enqueue
normal durable runtime events, so an idle ready computer receives updates without
a new run. Failed synchronization retains the event for the existing retry path.

The Paperclip app ships a curated catalog of company skills out of the box. The
catalog is a workspace package at `packages/skills-catalog`:

```text
packages/skills-catalog/
  catalog/
    bundled/<category>/<slug>/SKILL.md   # recommended defaults
    optional/<category>/<slug>/SKILL.md  # role/domain-specific
  generated/catalog.json                  # checked-in manifest
  scripts/
    build-catalog-manifest.ts             # regenerate generated/catalog.json
    validate-catalog.ts                   # validation only
  src/                                    # builder + types consumed by server/CLI
```

Server and CLI import the generated manifest; they do not crawl repository
paths at request time. Root `skills/` remains reserved for Paperclip runtime
skills and is not part of the catalog.

Skill-capable legacy local adapters always select the bundled
`paperclipai/paperclip/paperclip` operational skill when it is present in the
runtime inventory. This applies to existing agents without a stored skill
preference and to explicit empty optional-skill selections. The operational
skill supplies the control-plane workflow that those adapters need for
heartbeats. The `complain` and `suggestion-box` runtime skills are also selected
automatically alongside it; see [Agent commentary](agent-commentary.md).
Other runtime skills remain controlled by
`paperclipSkillSync.desiredSkills`. The native `paperclip_runner` does not use
this legacy default because its protocol supplies the control-plane contract.
An empty native runtime selection returns before company skill inventory work.
An explicit empty stored key set does the same. Nonempty selections still use
the current inventory, version and access checks. Legacy automatic selections
still resolve their operational and feedback skills.

Validate the catalog without writing the manifest:

```sh
pnpm --filter @paperclipai/skills-catalog validate
```

Regenerate `generated/catalog.json` after editing any catalog `SKILL.md`,
frontmatter, file inventory, category, or slug:

```sh
pnpm --filter @paperclipai/skills-catalog build:manifest
```

The package's `build` script runs `build:manifest` and then `tsc`; tests live
under `pnpm --filter @paperclipai/skills-catalog test`. Validation fails when:

- a catalog entry is not under `catalog/bundled/<category>/<slug>` or
  `catalog/optional/<category>/<slug>`
- `SKILL.md` is missing or the frontmatter `name`/`description` is empty
- the frontmatter `key` disagrees with the generated canonical key
- two catalog entries share an `id`, `key`, or `slug`
- file inventory contains absolute paths, `..`, broken symlinks, or files
  outside the skill directory
- the regenerated manifest differs from the checked-in
  `generated/catalog.json`

Trust level is derived from inventory: `markdown_only` (markdown + references
only), `assets` (other non-script files), or `scripts_executables` (any
executable script). The build contract is documented in
`doc/plans/2026-05-26-skills-cli-catalog-contract.md`.

CI runs `pnpm --filter @paperclipai/skills-catalog validate` and the package's
vitest suite, so always regenerate the manifest in the same commit as the
catalog change.

## Skill Version Snapshot Retention

A run uses a skill version from a directory on disk:
`<instance>/skills/<companyId>/__versions__/<skillId>/<versionId>/`. The server
writes this directory from the stored files of the `company_skill_versions` row.
The directory is a cache. When the server removes it and the row stays, the next
run that selects the version writes it again.

Agent skill settings read version-cache locations without projecting repository
snapshots, checking every cached file, or updating cache access records. An absent
cache is reported as awaiting materialization on the next run. Run preparation
still restores and validates the complete selected snapshot, including supporting
files, before delivery. `snapshotLatest` retains this execution behavior even
when upstream materialization is disabled.
Skill-list and skill-sync responses report stored assignment pins in
`desiredSkillEntries`. A resolved runtime `versionId` does not turn a selection
that follows Latest into a pin when the UI saves another assignment.

The server starts scanning one minute after startup, then hourly, in batches of
50 inspected directories with one-second continuations. Current versions,
explicit agent pins, active runs, and unresolved recovery pins stay. A company
with an active or unsettled run whose pins are unknown is skipped. Optional
`PAPERCLIP_SKILL_VERSION_RETENTION_KEEP` retains additional newest versions
(default `0`). Idle versions expire after `PAPERCLIP_SKILL_VERSION_RETENTION_GRACE_MINUTES`
(default `60`). Separate `__version_access__` records track use; existing caches
without records receive a full observation period before expiration.

Finished interrupted runs release their pins only after controller ownership,
native finalization, and environment cleanup have settled. Older native runs
without a pin map can supply their complete selection from the saved execution
input. The recovery parser validates its digests, and its company, run, agent,
and issue binding must match. Captured version IDs remain protected; unversioned
skills use separate runtime asset bundles. Missing or invalid evidence still
blocks cleanup. This fallback does not write pins or change recovery records.

Preparation, durable run pins, audits, and eviction share a company-scoped
PostgreSQL lock across processes. Eligible directories are atomically renamed
to unique managed `.trash-<UUID>` names. Deletion runs outside the preparation
lock and resumes after a crash. Saved version and repository snapshot rows are
retained, and normal runtime use restores missing caches without upstream access.

Paperclip Runner preparation skips this lock when the effective selection has no
skills or a saved selection is explicitly empty. It still records the empty
version snapshot. Explicit skill references, selected versions, and the legacy
operational skill keep their existing authorization and cache-lock requirements.

The sweep also handles orphan version directories after explicit skill deletion,
preserving captured run pins until they settle. Only recognized staging/trash
names are eligible; unknown directories and symlinked paths are retained.

Set `PAPERCLIP_SKILL_VERSION_RETENTION_DRY_RUN=true` before rollout to inspect
candidate bytes and skip reasons without deleting or changing access records.
Set `PAPERCLIP_SKILL_VERSION_RETENTION_ENABLED=false` to disable sweeps while
leaving restoration available. Internal `skillVersionRetentionService` methods
support company-scoped diagnosis and bounded instance-wide continuations.
Server logs report candidates, allocated bytes reclaimed, and skip reasons.
Compare volume usage separately because concurrent writes affect net savings.

## App-Shipped Teams Catalog

The team catalog package mirrors the skills catalog workflow for
agentcompanies/v1 team packages:

```text
packages/teams-catalog/
  catalog/
    bundled/<category>/<slug>/TEAM.md
    optional/<category>/<slug>/TEAM.md
  generated/catalog.json
  scripts/
    build-catalog-manifest.ts
    validate-catalog.ts
```

Validate without writing the manifest:

```sh
pnpm --filter @paperclipai/teams-catalog validate
```

Regenerate `generated/catalog.json` after editing catalog team files:

```sh
pnpm --filter @paperclipai/teams-catalog build:manifest
```

Team install/preview APIs enforce source policy. External skill sources require
explicit approval flags, and local-path skill sources are development-only
unless `allowLocalPathSources` is set by the caller.

## Project repository skills

New GitHub project workspace attachments enqueue imports transactionally. A bounded
server worker drains imports and checks enabled sources every five minutes. Shutdown
cancels owned scans and releases their leases. Sources can be refreshed manually or
paused through Skills → Sources. Legacy repositories appear there without being
imported until the user chooses Import skills.

Storybook: **Skills → Project repository skills**. Its production UI journeys use
in-memory provider and execution fixtures. Live GitHub refresh and execution need
separate acceptance evidence. Run the focused browser suite against built Storybook,
or set `STORYBOOK_TEST_BASE_URL` to an owned Storybook dev server.

Workspace preparation no longer reads or writes physical-root source/reader ledgers
or persistent `anonymous_only` / `managed` directory classifications. Explicit
workspace selection checks record access; admission checks the persisted current
selection without requiring disclosure of historical workspace metadata. Repository
copy/publication callbacks recheck concrete source/destination identities and the
current task binding. They do not inventory peer workspaces. Existing
`isolatedRemoteSource` receipts remain restorable, but new local sources are not
replaced with remote clones because of historical file ownership.

The disposable workspace-preparation performance harness is:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-preparation-history.ts --baseline-ref=df80616d98119cbf5abd40549794d9980a5fabf6
```

It compares actual preparation guards with synthetic history. Local timings are
separate from Git materialization, environment acquisition, and provider startup.

## Skill-source background synchronization

Skill imports and automatic source refreshes use the delivery coordinator. Workspace
attachment, adoption, source settings, manual refresh, disconnection, project deletion,
and company status changes notify it through their database transaction. Nested
transactions notify after the outer transaction settles. Budget pause/resume uses
the same notification. The existing database work protocol resolves uncertain commits.

Startup reconstructs work from `project_skill_sources` and `company_skill_sources`.
After each sweep, the worker schedules the earliest eligible `next_sync_at`, postponed
until an outstanding lease expires. Due batches and conflicting claims retry after
five seconds; failures retain their saved backoff. Finishing imports admits deferred
repositories into the existing capacity limits. Empty or inactive configuration has
no recurring synchronization SQL. Automatic sources still check upstream every five
minutes, because upstream changes do not send this worker an event.

The worker defers dispatch during idle drain and warm standby, preserving requests
until a successful sweep. Shutdown aborts provider reads and waits for the current
sweep. Notifications are process-local: independent SQL writers and separate live
server replicas are not a supported notification path. Restart restores saved work.

These deadlines are not yet covered by the Paperclip Cloud scheduled-wake contract.
The sleep-safety report retains the instance while an active company has pending
imports or eligible automatic refreshes. Removing the five-second discovery poll
establishes worker quiet; it does not establish host or database suspension.

The targeted suites also accept external PostgreSQL when embedded PostgreSQL is
unavailable. Use a separate, disposable database whose name ends in `_test` for each variable:
`PAPERCLIP_SKILL_SYNC_TEST_DATABASE_URL`,
`PAPERCLIP_PROJECT_SKILLS_TEST_DATABASE_URL`, and
`PAPERCLIP_SKILL_SOURCES_TEST_DATABASE_URL`. The suites apply migrations and create
test data; the synchronization suite truncates company data between tests.

### Controlled default-cadence sleep acceptance

The opt-in `domain_deadlines_v1` negotiation adds owner-bound skill deadline
handoff coverage. Legacy callers retain the conservative blockers described above.
The checked-in `scripts/test-skill-default-cadence.mjs` launcher checks this local
flow with the actual app, signed tenant routes, Cloud controller and PostgreSQL
alarm store. Git contents, S3 and physical child stop/start use controlled local
providers. A matching service checkout with
`src/sleep/fixtures/default-cadence-bridge.ts` and its normal compiled output is
required for the host flow. The PG0 controls do not require that checkout or a DB.
The launcher does not start a cluster, build artifacts, or contact live providers.

Use Node **24.22.2**, pnpm **9.15.4**, and Node **22.23.4** for the matching service.
Prepare the server dependency closure with a frozen lockfile. Build only missing
TypeScript prerequisites explicitly; the launcher does not install or build them.
From the app repository root:

```sh
export NODE24=/absolute/path/to/node-v24.22.2/bin/node
export PNPM9=/absolute/path/to/pnpm-9.15.4/bin/pnpm
export PATH="$(dirname "$NODE24"):$(dirname "$PNPM9"):$PATH"
"$PNPM9" --filter @paperclipai/server... install --frozen-lockfile --ignore-scripts
for package in packages/shared packages/plugins/sdk packages/paperclip-eval-kernel packages/paperclip-runner; do
  (cd "$package" && "$NODE24" node_modules/typescript/bin/tsc -p tsconfig.json)
done
(cd packages/paperclip-runner && "$NODE24" node_modules/typescript/bin/tsc -p tsconfig.surfaces.json)
export SKILL_SLEEP_RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-skill-sleep.XXXXXX")"
export PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG="$SKILL_SLEEP_RESULTS/controls-guard.jsonl"
"$NODE24" scripts/test-skill-default-cadence.mjs --controls
```

This PG0 lane runs 44 controls. It explicitly defers the single real-PostgreSQL
observer case before its support probe. It requires the actual worker's preloaded
guard marker and matching receipt. Ordinary Vitest runs keep all subprocess
controls and defer only that launcher-specific parent assertion. An explicit
prewire mode or guard-log setting makes the unchanged assertion mandatory; a
missing or invalid marker fails. The launcher never installs the guard late.

For host acceptance, separately create empty, owned databases on an existing local
PostgreSQL 17 server. Use distinct names ending in `_test`. The test applies normal
migrations and writes fixtures; it never starts an embedded cluster. Use a fresh
pair for each attempt, including the full run after bootstrap. Prepare the matching
service dependencies separately and compile its normal `tsconfig.build.json` with
Node 22. The recorded local runtime used service source
`2cb54f904031dcf69a32902cd853b43f74d6f301`. Current service publication
`389878364b42dd129835d263f91882c5774d5123` carries that measured helper source through
its normal upstream merge; the runtime was not repeated on that service merge.
An arbitrary service revision is not an interchangeable prerequisite.

```sh
export PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT=/absolute/path/to/matching-service
export PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE=/absolute/path/to/node-v22.23.4/bin/node
export PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA=389878364b42dd129835d263f91882c5774d5123
test "$(git -C "$PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT" rev-parse HEAD)" = "$PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_SHA"
(cd "$PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_CHECKOUT" && "$PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_NODE" node_modules/typescript/bin/tsc -p tsconfig.build.json)
export PAPERCLIP_TEST_POSTGRES_ADMIN_URL=postgres://paperclip@127.0.0.1:55448/postgres
export PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL=postgres://paperclip@127.0.0.1:55448/skill_sleep_bootstrap_app_test
export PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL=postgres://paperclip@127.0.0.1:55448/skill_sleep_bootstrap_cloud_test
export PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE="$SKILL_SLEEP_RESULTS/bootstrap"
mkdir -p "$PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE"
unset PAPERCLIP_MAINTENANCE_PG0_CONTROLS
export PAPERCLIP_SKILL_DEFAULT_CADENCE_STAGE=bootstrap
export PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG="$SKILL_SLEEP_RESULTS/bootstrap-guard.jsonl"
"$NODE24" scripts/test-skill-default-cadence.mjs
```

Bootstrap checks revision 1, the legacy refusal, the signed bounded handoff and the
exact durable ACK before child stop. It does not check a due wake. For the complete
run, first create a different empty pair, then run:

```sh
export PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL=postgres://paperclip@127.0.0.1:55448/skill_sleep_cycles_app_test
export PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL=postgres://paperclip@127.0.0.1:55448/skill_sleep_cycles_cloud_test
export PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE="$SKILL_SLEEP_RESULTS/two-cycle"
mkdir -p "$PAPERCLIP_SKILL_DEFAULT_CADENCE_EVIDENCE"
export PAPERCLIP_SKILL_DEFAULT_CADENCE_STAGE=two-cycle
export PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG="$SKILL_SLEEP_RESULTS/two-cycle-guard.jsonl"
"$NODE24" scripts/test-skill-default-cadence.mjs
```

Use a new guard-log path for each attempt. The full mode takes about 10-14 minutes.
It retains the original 300-second source cadence, real app/SQL clocks, D-120 alarm
eligibility and the existing 850-second test timeout. Do not shorten the cadence,
write deadlines, or substitute a fake clock. The launcher uses one worker and no
file parallelism. Budget runtime pools for the app's potential 10 connections plus
Cloud's shared 2 and one transient observer; each pool is at most 4. The recorded
server limit was 40. Run this fixture without other heavy tests or builds.

Receipts retain both original deadlines, durable alarm generations, distinct cold
processes and persisted revisions 2 and 3. Each cold start also checks a measured
10-second app SQL/upstream/outgoing-HTTP quiet window. Awake guards can still show
2 PostgreSQL sockets: quiet SQL does not mean all connections are closed. This is
controlled local acceptance, not strict 90-second host acceptance, live-provider
qualification or proof of deployed Railway/Neon suspension. Keep failed attempts
and audit owned sessions/processes before database cleanup.
