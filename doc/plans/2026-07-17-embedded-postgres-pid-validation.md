# Embedded PostgreSQL PID Validation and Safe Recovery

Status: Proposed for review  
Date: 2026-07-17  
Branch: `fix/embedded-postgres-pid-validation`  
Grounded in: `paperclipai/paperclip` `upstream/master` at `5d42382df4c5724085967027485fcd39b91b01ae`

## Goal

Prevent Paperclip from treating an unrelated process that reused a stale
`postmaster.pid` PID as the embedded PostgreSQL server, while preserving safe
reuse of the real embedded cluster and automatic recovery from PID files that
are provably stale.

Observable success means:

- a pre-reboot `postmaster.pid` whose PID now belongs to another process is not
  adopted as PostgreSQL;
- Paperclip removes only a PID file that it can prove stale and starts the
  embedded database normally;
- a reachable PostgreSQL instance is reused only after its resolved
  `data_directory` matches the configured embedded data directory;
- an ambiguous live current-boot PID fails closed without removing the PID file
  or starting a second postmaster against the same data directory;
- server, migration, routine-maintenance, and worktree paths use the same
  classification contract.

## Incident Evidence

On the Gimle iMac after a reboot, the persisted
`~/.paperclip/instances/default/db/postmaster.pid` named PID `1406`, while PID
`1406` belonged to an nginx worker and no PostgreSQL process or listener was
present. The installed server accepted the PID because `process.kill(pid, 0)`
succeeded, skipped embedded PostgreSQL startup, and repeatedly failed to connect
to `127.0.0.1:54329`.

Recovery required stopping the launchd jobs, independently confirming that no
PostgreSQL process/listener existed, archiving the stale PID file, and starting
Paperclip again. The live instance is healthy now and is explicitly outside the
implementation workspace for this change.

## Assumptions

- PostgreSQL's `postmaster.pid` fields remain in their documented order: PID on
  line 1, data directory on line 2, start epoch seconds on line 3, and port on
  line 4.
- `os.uptime()` provides a sufficiently accurate current-boot boundary when
  compared with the PID-file start epoch using a small clock-skew tolerance.
- A successful PostgreSQL query for `data_directory` is stronger cluster
  identity evidence than a process name or PID alone.
- A live current-boot PID that cannot be verified may represent a PostgreSQL
  startup or failure in progress. Preserving the PID file and reporting an
  actionable error is safer than deleting it.
- The production iMac remains on the existing installed canary until this source
  change is reviewed, tested, released, and separately approved for deployment.

## Scope

### In scope

- Add one side-effect-free embedded PostgreSQL inspection/classification helper
  in `@paperclipai/db`.
- Parse and validate the relevant `postmaster.pid` fields once.
- Distinguish absent, verified running, provably stale, and ambiguous states.
- Prove a running cluster by connecting to the recorded port and matching
  `SHOW data_directory`/`current_setting('data_directory')` to the expected
  directory.
- Treat invalid/dead PID files and files whose PostgreSQL start timestamp
  predates the current OS boot as stale.
- Preserve and surface ambiguous live current-boot PID files.
- Apply the shared result in server startup, migration startup, routines, and
  worktree startup/repair guards.
- Add regression tests for the incident and for fail-closed behavior.

### Out of scope

- Modifying, restarting, upgrading, or deploying the live iMac Paperclip
  instance during implementation.
- Editing generated `dist/` or the globally installed npm package by hand.
- Replacing embedded PostgreSQL, changing database credentials, or changing the
  external `DATABASE_URL` path.
- Automatically killing a process that happens to occupy the PID.
- Automatically deleting a current-boot PID file when cluster identity remains
  ambiguous.
- Refactoring the duplicated embedded PostgreSQL constructors beyond sharing
  classification and identity evidence.
- Changing generic process-liveness helpers whose callers need only liveness,
  not identity.

## Classification Contract

The shared inspector accepts the expected data directory and preferred port,
reads `postmaster.pid` when present, and returns a discriminated result:

| State | Evidence | Caller action |
|---|---|---|
| `absent` | No PID file | Preserve the existing configured-port adoption probe, then start if no matching cluster is reachable |
| `running` | A PostgreSQL connection on the PID-file/configured fallback port whose resolved data directory matches; PID liveness alone is never sufficient | Reuse the reported PID (when valid) and port |
| `stale` | No matching expected cluster is reachable, and the PID is invalid/dead, the PID-file start time is provably before the current OS boot, or supported process inspection definitively identifies a non-PostgreSQL command | Archive/log or remove only that PID file, then use the normal adoption/start path |
| `ambiguous` | A live current-boot PID cannot otherwise be proven stale and PostgreSQL is unreachable, reports another data directory, or required identity fields cannot establish the expected cluster | Fail with PID, port, data directory, and recovery guidance; preserve the file and do not start another postmaster |

The inspector does not delete files, start processes, or mutate the database.
Each lifecycle owner performs its existing startup action only after consuming
the classification.

For compatibility, a missing or invalid PID-file port falls back to the
configured port for probing, but successful reuse still requires a matching
database data directory. A successfully parsed recorded port takes precedence
over the configured port.

## Affected Areas

- `packages/db/src/embedded-postgres-lifecycle.ts` (new): parsing,
  current-boot classification, database identity probe, and result types.
- `packages/db/src/embedded-postgres-lifecycle.test.ts` (new): deterministic
  lifecycle and incident regression coverage.
- `packages/db/src/index.ts`: export the shared inspector and types.
- `packages/db/src/migration-runtime.ts`: replace PID-only adoption and restrict
  PID-file removal to `stale`.
- `server/src/index.ts`: replace inline PID-only logic, honor the recorded port,
  log stale recovery, and fail closed for ambiguous identity.
- `server/src/__tests__/server-startup-feedback-export.test.ts`: consumer-level
  reuse and ambiguity coverage using the existing startup test seam.
- `cli/src/commands/routines.ts`: consume the shared classification before
  maintenance startup.
- `cli/src/commands/worktree.ts`: consume the shared classification for database
  startup and make repair/reseed guards conservative for ambiguous live state.
- CLI tests only where needed to prove the changed guard/consumer contract;
  avoid duplicating the package classifier matrix.

## Behavioral Details

### Parsing and boot boundary

- Reject non-integer/non-positive PIDs and ports as invalid fields.
- Parse line 3 only as positive epoch seconds.
- Estimate boot epoch as `Date.now() - os.uptime() * 1000`.
- Apply a five-minute tolerance to avoid false stale classification from clock
  resolution or ordinary wall-clock adjustments.
- First allow a successful expected-cluster identity probe to produce `running`.
  If that probe fails, classify a valid PID-file start time older than the
  tolerated boot boundary as `stale` even if `process.kill(pid, 0)` succeeds.
  This is the concrete reboot/PID reuse repair path.

### Identity verification

- `process.kill(pid, 0)` remains a liveness precheck only.
- Probe the PID-file port (or configured fallback) using the existing
  `getPostgresDataDirectory` utility.
- Normalize both paths with `path.resolve` before comparison.
- Reuse only on an exact normalized match.
- A reachable PostgreSQL server using another directory is `ambiguous`, not a
  free port and not an adoptable server.
- On supported POSIX hosts, process command inspection may provide negative
  evidence after the database probe fails: a command definitively unrelated to
  PostgreSQL makes the PID file `stale`. An unavailable or inconclusive command
  lookup remains `ambiguous`. Process names are never positive identity proof.
- Distinguish `ESRCH` (dead) from `EPERM` (exists but inaccessible). `EPERM`
  remains live/ambiguous unless pre-boot or definitive non-PostgreSQL evidence
  proves the PID file stale.

### Safe mutation

- Only callers that receive `stale` may remove the PID file.
- Removal remains immediately adjacent to the existing start path and is logged
  with the stale reason.
- `ambiguous` never removes or renames the file and never starts embedded
  PostgreSQL.
- No code sends signals to the PID from `postmaster.pid`.

### Consumer consistency

- Server and migration paths reuse the inspector's reported port.
- Routines and worktree maintenance use the same startup contract.
- Worktree repair/reseed guards treat both `running` and `ambiguous` as unsafe to
  overwrite; only `absent` and `stale` permit the existing stopped-target path.
- External PostgreSQL behavior is unchanged.

## Analog Delta Matrix

| Field | Required content |
|---|---|
| Analog family | Primary: `packages/db/src/migration-runtime.ts` plus `getPostgresDataDirectory`, which already adopts a PID-file-less server only after data-directory verification. Supporting: `findAdoptableLocalService`, which treats PID liveness as only one input and verifies command/cwd/config/port, with tests rejecting a live owner from another workspace. Rejected counterexample: the PID-only `getRunningPid`/`readRunningPostmasterPid` family in server, DB, and CLI. |
| Coverage | Contract/implementation/composition/consumer/lifecycle/error come from the DB adoption and local-service adoption paths. Test behavior comes from the cross-workspace live-owner rejection tests. Trust and persistence boundaries are independently anchored at current HEAD. Palace/codebase-memory were unavailable, so all load-bearing evidence uses Serena plus targeted `rg` and git blame against `5d42382df`. |
| Invariants to preserve | Persistent embedded data directory; existing external-Postgres path; configured-port adoption when PID file is absent; no second postmaster against an ambiguous live cluster; no process termination; existing initialization, migration, logging, and stop ownership. |
| Required differences | Apply data-directory identity verification even when the PID is live; parse and honor PID-file port; recognize pre-boot PID files; expose one shared classification to all consumers; remove a PID file only after a `stale` result; fail closed for ambiguous live current-boot identity. |
| Rejected differences | No launchd wrapper workaround as the primary fix; no process-name-only identity rule; no automatic kill; no broad embedded-PostgreSQL constructor refactor; no dependency update; no live iMac mutation. |
| Failure modes | Wall-clock/uptime skew; malformed or partially written PID file; PID reuse before/after reboot; unavailable/inconclusive process inspection; PostgreSQL starting but not ready; wrong cluster on the port; recorded/configured port divergence; probe timeout/refusal; concurrent Paperclip starts; consumer accidentally deleting an ambiguous PID file. |
| Tests before code | Reproduce with a live unrelated PID and a pre-boot PID-file timestamp; verify original classifier would call it running while the new classifier returns stale. Add current-boot non-PostgreSQL PID coverage, plus an inconclusive-inspection/unreachable-port case that returns ambiguous and preserves the file. |
| Verification | Run focused DB classifier tests first, server startup consumer tests second, CLI worktree/routines tests third, then package typechecks, full Vitest, and build. Review the final diff against this matrix and verify no live iMac command was executed. |

## Test Plan

### Package classifier tests

1. No `postmaster.pid` returns `absent`.
2. Malformed or non-positive PID returns `stale` without signaling another
   process.
3. Dead PID returns `stale`.
4. A live unrelated process combined with a pre-boot PostgreSQL start timestamp
   returns `stale` (direct regression for the iMac incident).
5. A live current-boot PID with a definitively non-PostgreSQL command and no
   matching database returns `stale` on supported hosts.
6. A live current-boot PID whose command inspection is unavailable or
   inconclusive and whose database is unreachable returns `ambiguous`.
7. `EPERM` is not treated as a dead PID and remains fail-closed without other
   stale evidence.
8. A reachable PostgreSQL reporting another data directory returns `ambiguous`
   when the live PID cannot otherwise be proven stale.
9. A reachable PostgreSQL reporting the expected normalized data directory
   returns `running` and uses the PID-file port.
10. Missing/invalid PID-file port uses the configured fallback for probing but
   still requires the data-directory match.
11. Boot-boundary tolerance does not classify a just-started cluster as stale.
12. Inspection never modifies the PID file.

Use narrow dependency injection for time, uptime, PID liveness/error codes,
process command inspection, and the database probe so tests are deterministic
and do not depend on the host's real boot time or a real production data
directory. Keep production defaults internal to the helper.

### Consumer tests

- Server startup reuses the inspector's recorded port for the final admin and
  application connection strings.
- Server startup rejects `ambiguous` with an actionable error before creating
  or starting an embedded PostgreSQL instance.
- Migration startup removes a PID file only for `stale`; ambiguity propagates
  without deletion.
- Worktree repair/reseed treats ambiguity as a live-target safety block.
- Existing routines/worktree happy-path tests continue to pass.

### Verification commands

Run narrow checks first:

```sh
pnpm exec vitest run packages/db/src/embedded-postgres-lifecycle.test.ts
pnpm exec vitest run server/src/__tests__/server-startup-feedback-export.test.ts
pnpm exec vitest run cli/src/__tests__/worktree.test.ts cli/src/__tests__/routines.test.ts
pnpm --filter @paperclipai/db typecheck
pnpm --filter @paperclipai/server typecheck
pnpm --filter paperclipai typecheck
```

Then the repository PR-ready gates:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

No live iMac smoke is run during implementation. After a reviewed canary is
published, deployment and reboot verification are a separate explicitly
approved operational step with a backup and rollback plan.

## Acceptance Criteria

- [ ] PID occupancy alone cannot produce a `running` embedded PostgreSQL result.
- [ ] The exact pre-reboot PID reuse incident classifies the PID file as stale.
- [ ] Only a database whose normalized data directory matches is reused.
- [ ] The recorded PID-file port is used for verified reuse.
- [ ] Ambiguous live current-boot identity preserves the PID file and prevents a
      second postmaster start.
- [ ] Invalid/dead/pre-boot stale PID files permit the normal recovery path.
- [ ] Server, migration, routines, and worktree consumers share one classifier.
- [ ] Worktree destructive guards remain conservative for ambiguous state.
- [ ] External PostgreSQL behavior is unchanged.
- [ ] Targeted tests, package typechecks, full Vitest, and build pass, or any
      unrun check is explicitly reported.
- [ ] The implementation branch contains no generated `dist/` edits,
      `pnpm-lock.yaml` change, or live iMac mutation.

## Rollout and Rollback

Implementation and validation occur only in the local source checkout. After
review, merge, and canary publication, deployment to the iMac must be a separate
operator-approved action:

1. record the currently installed package version and service health;
2. confirm current backups and preserve the installed package for rollback;
3. install the reviewed canary;
4. restart once during a maintenance window;
5. verify `/api/health`, the embedded PostgreSQL PID/port/data directory, and
   watchdog connectivity;
6. perform a controlled reboot regression only with explicit approval.

Rollback reinstalls the previous package version and does not alter the embedded
database directory. The classifier contains no schema or migration change.

## Open Questions

- Should a later follow-up add bounded retry for a verified PostgreSQL process
  that is still starting? This proposal intentionally fails closed instead of
  adding startup timing policy to the PID fix.
- Should stale PID files be archived rather than removed by all upstream
  consumers? The current source removes stale files; this proposal keeps that
  behavior but logs the classification reason. Archiving can be a separate
  observability enhancement.
