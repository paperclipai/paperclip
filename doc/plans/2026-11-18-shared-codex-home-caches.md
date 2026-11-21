# Shared Codex skill homes for native sessions

> Delivery (2026-11-19): shipped as one standalone pull request from `master` (branch `perf/shared-skill-homes`), independent of PR #22152. References to #22152 below record how the work started; this branch does not contain or need its commits.

Status: design, awaiting user approval (2026-11-18). Nothing below is approved for
implementation yet.

## Problem and measured evidence

A native Paperclip Runner session with the Codex provider gets its own
`CODEX_HOME` under `<instance>/runtime/paperclip-runner/durable-sessions/<scope>/codex-home`.

Windows instance (`C:\.paperclip`, 2026-11-18), 243 sessions, 39 GB:

| Entry | Size per session | Total | What it is |
| --- | --- | --- | --- |
| `cache/remote_plugin_catalog` | ~73 MB | 14 GB | remote plugin catalog, synced by the app-server at startup |
| `plugins/cache/openai-curated-remote` | ~45 MB | 9.6 GB | 21 OpenAI plugin bundles, same sync |
| `skills/` | up to 349 MB | 7.9 GB | the session's assigned skills, copied from their bundles |
| `sessions/`, sqlite | ~2–10 MB | — | the actual conversation |

WSL Linux instance (2026-11-18), the
target platform: 274 sessions, `skills/` = 9.2 GB in total, but only **30 distinct
skill sets**; one copy of each set is 2.0 GB. The server's existing bundle store
(`runtime-context-assets/`, all bundles and instructions) is 2.5 GB.

Every launch also re-copies `skills/` (`releaseMaterializedNativeRuntimeSkills`
then `prepareIsolatedCodexHome`), so the copy costs start-up time as well as disk.

### Already fixed (quick fix)

Every Paperclip thread already disables Codex plugins and apps
(`SKILLLESS_BASE_CONFIG` in `codex-security-config.ts`), but the app-server's own
`config.toml` did not. Commit `dbabe81f4a` writes `plugins = false`,
`remote_plugin = false` and `apps = false` under `[features]`. It was added to the
branch of PR #22152 (whose own change, `70910a6163` and follow-ups, expires the
`codex-home` of sessions whose issues closed) and cherry-picked to local `develop`
as `66b279c898`. A fresh home is now ~3 MB instead of ~120 MB. This design
covers what remains: `skills/`.

## What the user wants

- One copy of a skill set's bytes, not one per session.
- A new session must not rebuild those bytes; it re-uses them when nothing changed.
- Updating skills when they do change may take a short lock.
- Target platform: Paperclip Runner on Mac/Linux. Windows is not a target, so the
  before/after acceptance comes from WSL/Linux; the Windows instance only gains
  the plugin fix.

Non-goals: one shared `CODEX_HOME` per agent/project (conversation state, credentials,
quarantine, failover and retention all stay per session); Legacy adapters
(`codex_local` has its own per-agent homes, PR #18787/#19844); ACPX, OpenCode and
other providers; remote Runner hosts in the first rollout.

Anti-goals: an agent being able to modify a skill another run is using; a session
seeing skills it was not assigned; a skill update changing skills under a run in
the middle of a turn; a session that can no longer resume.

## How Codex finds skills (spike, Codex 0.160.0 / 0.166.0 / 0.170.0)

Measured with the app-server's `skills/list` (details in the session notes folder,
`shared-codex-home-findings.md`):

- Roots: `CODEX_HOME/skills` (plus bundled `.system`, ~0.4 MB), user
  `$HOME/.agents/skills`, repository `.agents/skills`, plugin skills.
- On Linux the user root follows the process `HOME`; a skill in
  `$HOME/.agents/skills` is listed with scope `user`. Startup plus `skills/list`
  wrote nothing into `HOME`, also when the tree was read-only.
- On Windows Codex ignores `HOME`/`USERPROFILE` and reads the real profile.
- `[[skills.config]] path = ...` only toggles a skill; it cannot add one.
- App-server `skills/extraRoots/set` exists but rejects every path in 0.160, 0.166
  and 0.170 ("AbsolutePathBuf deserialized without a base path"). Unusable.
- Paperclip already sets the app-server `HOME` to the session `CODEX_HOME`
  (`createRunnerdCodexAppServerArgs`, `runner-provider-launch.ts`). The
  filesystem policy denies `HOME` and `CODEX_HOME` to the agent sandbox, then
  re-admits `codexHome/skills` and every `skill.bundle.rootPath` as read-only.

## Approaches considered

1. **Skill home through `HOME`, as copies (chosen).** Point the app-server `HOME`
   at a sealed, content-addressed directory whose `.agents/skills/` holds the
   assigned skills, copied once from the existing bundle store. `CODEX_HOME` stays
   per session and keeps only the conversation. No links, no new Codex features.
   WSL figures: 9.2 GB becomes ~2.0 GB. Works on Mac/Linux; Windows keeps today's copy.
2. **Same, with read-only symlinks into the existing bundle store.** `.agents/skills/<name>`
   would link to `runtime-context-assets/bundles/<digest>`, which is already sealed,
   content-addressed, manifest-verified and lease-retained. Extra disk ~0 instead of
   ~2.0 GB. Needs an explicit exception to the no-link policy of PR #22033 and an
   untested check that Codex follows linked skill directories. Kept as a later step.
3. **`skills/extraRoots/set`.** Cleanest, but broken in every Codex version up to 0.170.
4. **One shared `CODEX_HOME` per agent/project.** Rejected: conversation sqlite,
   per-launch credentials, quarantine/failover/retention all assume one session per
   home; large rework for ~3–10 MB per session after the quick fix.

Why approach 1 does not conflict with the PR #22033 policy: that policy rejects
links into mutable host caches. Approach 1 links nothing, and a skill home is
immutable once published (sealed read-only, content-addressed, never edited in
place). A change in skills produces a new directory.

## Design

### Skill home store

- Location: `<instance>/runtime/paperclip-runner/skill-homes/<digest>/`, a sibling of
  `durable-sessions/`, not inside it. Code that lists `durable-sessions` entries
  (`native-session-executor.ts`, the expiration sweep) is unaffected.
- `digest` = sha256 over canonical JSON of: a layout schema version, and for each
  assigned skill in runtime-name order its `runtimeName` and `bundle.digest` (or,
  once PR #22033 lands, its versioned repository-skill representation). Paths are
  never part of the digest.
- No company key, consistent with the existing instance-wide bundle store
  (`runtime-context-assets/bundles/<digest>`). A session can only reach the home
  whose digest equals its own assignment, so it only ever sees skills it was
  assigned. (Builder's call, recorded for review.)
- Contents: `.agents/skills/<runtimeName>/...` produced by the existing
  materializer (`materializeNativeRuntimeSkills`, or the shared planner from
  PR #22033 once merged), plus a `manifest.json` (relative path, size, sha256 per
  file). The manifest format reuses `file-manifest-cache`/`verifyFileManifest`
  where the runner can import it; otherwise a runner-side equivalent.
- Sessions of the same agent and project have the same skills, so they resolve
  to the same home. Other agents with the same skill set share it too.

### Publish (the short lock)

- Computed on the runner from the runtime context it already receives (skill
  runtime names and bundle digests are there; no company id is needed).
- If `<digest>/` exists and verifies (below), use it: no copy.
- Otherwise stage into `skill-homes/.staging-<uuid>/`, materialize, write the
  manifest, seal (existing `protectStagedTree`: files 0444, directories 0555), then
  `rename` to `<digest>/`. If the rename finds an existing directory, another
  launch won: discard the staging copy and verify the winner. The atomic rename
  is the lock; no lock files or polling.

### Verification on reuse

- Exact file membership, regular files only, no links, sizes, and sha256 of every
  file. Timestamps are never trusted (same rule as PR #22033).
- A mismatch renames that home aside into `skill-homes/quarantine/` and publishes a
  fresh one. A run never starts on a home that failed verification.
- Full hashing reads the bytes once per launch but writes nothing, replacing a copy
  that reads and writes them. Measure it; a cheaper check is acceptable only if it
  still detects equal-size edits with restored mtimes.
- Implemented (2026-11-18): full hashing on every reuse took 16-33 s for a 25k-file
  set. After sealing, each file's inode, size and ctime are recorded in
  `skill-homes/<digest>.stat.json`; reuse compares those and runs the full hash only
  on a mismatch. ctime changes on any write, chmod or replacement and cannot be set
  back by an unprivileged process, so equal-size edits with restored mtimes are still
  detected. Warm reuse is now under 1 s (`doc/benchmarks/2026-11-18-shared-codex-skill-homes.md`).

### Which launches use a skill home

All three Codex home-preparation paths in `runnerd-codex-transport.ts`, on Mac/Linux
with an isolated (not preconfigured) home:

- **Fresh launch** (`prepareIsolatedCodexHome` with a runtime context): publish or
  verify the home for the context's digest, write the reference marker (below), pass
  it as `HOME`. `CODEX_HOME/skills` is no longer written (Codex still adds its own
  `.system` skills there).
- **Recovery / reattach** (`prepareIsolatedCodexRecoveryHome`): today it keeps the
  retained skills. New: read the marker and reuse that home after verification. If
  it is missing or fails verification and the runtime context is available,
  republish it; otherwise fail the launch with a named error rather than start
  without the session's skills.
- **Maintenance** (`context: null`): no skills; `HOME` stays the session `CODEX_HOME`
  as today.
- **Explicit skill inputs** (`resolve(codexHome, "skills", runtimeName, "SKILL.md")`
  in `runnerd-codex-transport.ts`) point at the skill home path instead.
- **Filesystem policy:** keep denying `HOME` and `CODEX_HOME`; admit
  `<skill home>/.agents/skills` read-only instead of `codexHome/skills`. The existing
  read-only grant of each `skill.bundle.rootPath` stays.
- Preconfigured (user-owned) homes, Windows hosts and remote Runner hosts keep the
  current copy into `CODEX_HOME/skills`, through an explicit, named compatibility
  path rather than a silent fallback.

### Reference marker (who uses a home)

- A small file `codex-home/paperclip-skill-home.json` with the digest and schema
  version. It sits inside the session's `codex-home`, so it lives and dies with it:
  when PR #22152's sweep expires a closed session's `codex-home`, the reference goes
  too, and the session root and runner state stay as before.
- A separate marker file, not a field in `RUNNERD_STATE_SCHEMA` or
  `CODEX_PROVIDER_STATE_SCHEMA`, so no state-schema bump and no change for
  sessions in flight during the upgrade. (Builder's call, recorded for review.)
- `skills` is not added to `CODEX_HOME_CHECKPOINT_EXCLUDED_ENTRIES` (changed while
  planning): recovery of sessions that still copy skills (Windows, preconfigured,
  remote) relies on the retained `codex-home/skills`. With a skill home that
  directory only holds Codex's own `.system` skills (~0.4 MB).

### Changing skills during a run

- A run keeps the home it launched with. A skill change yields a new digest and a
  new home; the next launch picks it up.
- The home is read-only, so Codex's skills watcher never sees a change mid-turn.

### Existing sessions

- On the next fresh launch of an old session, its `CODEX_HOME/skills/` is released
  (existing call) and the session moves to a skill home.
- Paperclip, not Codex, builds explicit skill inputs. These must resolve to the
  skill home for migrated sessions. When `skills.include_instructions` is on
  (launches with a runtime context), Codex's skill list also carries the new
  paths. Resume one old-layout session and invoke a skill to prove both.

### Garbage collection

- A home may be removed when no `durable-sessions/*/codex-home/paperclip-skill-home.json`
  names its digest, and it was not published or verified within a grace period
  (proposal: 24 h; launches update a `last-used` timestamp file next to the home,
  outside the sealed tree).
- Removal renames to `skill-homes/.retiring-<uuid>`, re-checks the markers, then
  deletes, matching the retire pattern in `native-harness-backup-expiration.ts`. A
  launch that finds its home missing or retiring publishes a new one.
- Runs from the existing native harness expiration sweep: no new timer or worker.

### Remote Runner hosts (later)

Remote launches already stage skills per session under
`<runnerFilesystemRoot>/context/skills/<index>-<digest>`. The same store can live on
the remote host. That needs its own transport manifest and acceptance.

## Verification and acceptance

Red/green tests:

- Two fresh launches with the same skills create one skill home; both app-server
  argument sets carry the same `HOME`; the skill bytes exist once on disk. Fails on
  today's code, which copies into each `CODEX_HOME/skills`.
- A different skill version gets a different home.
- Equal-size edit with restored mtime, an extra file, a missing file and a symlink
  substitution are each detected on reuse.
- Parallel launches with the same digest publish one home and both start.
- Recovery reuses the recorded home; a missing home is republished or fails with
  the named error.
- GC keeps a referenced home and a home within the grace period, and removes an
  unreferenced, expired one; expiring a session's `codex-home` drops its reference.
- Windows and preconfigured homes still copy into `CODEX_HOME/skills`.
- Resume an old-layout session and invoke one of its skills.

Measured on WSL Linux, same skill set, before
and after:

- disk: per-session `codex-home` size, and total bytes for two sessions;
- start-up: `prepareIsolatedCodexHome` duration and time to the provider's first
  event, cold (new digest) and warm (existing digest);
- one real turn with a real Codex login: Codex writes nothing into `HOME`, and the
  agent can read a skill's supporting files.

Run `pnpm verify` in WSL and the required CI checks on the final revision.

## Relation to other work

- PR #22033 (shared skill repositories) removes duplicate repository copies within
  one skill set. This design stores that result once per digest. The layout schema
  version in the digest keeps both layouts apart.
- PR #22152 expires a closed session's `codex-home`; that also drops its skill-home
  reference. GC of skill homes runs from the same sweep.

## Left to the builder

Module and helper names, manifest details within the rules above, the exact grace
period, bounded I/O for hashing, and the minimum fixture size for the measurements.

## Separate follow-up (not part of this work)

On Windows, Codex reads the operator's own `C:\Users\<user>\.agents\skills` into
isolated Paperclip sessions, because it ignores `HOME` there. That is an isolation
leak on the current platform and needs its own fix.
