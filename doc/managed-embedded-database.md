# Managed embedded PostgreSQL (Paperclip Cloud)

A Paperclip Cloud stack can run its database as a PostgreSQL cluster on the
stack's own volume instead of an external provider. This document is the core
side of that contract: what the image does, what the Cloud harness must send,
and how release migrations and recovery work. Self-hosted deployments are
unaffected; they keep the behavior in [DATABASE.md](DATABASE.md).

Source of truth for every field and code below:
`packages/shared/src/managed-database.ts` (schemas) and
`packages/shared/src/managed-database-server.ts` (HMAC). The supervisor lives
in `server/src/managed-database/`.

## Inputs

| Variable | Content |
| --- | --- |
| `PAPERCLIP_MANAGED_DATABASE` | JSON `ManagedDatabaseConfig`. Absent: not an embedded stack. Blank or malformed: the container refuses to start. |
| `PAPERCLIP_MANAGED_DATABASE_CONTROL_KEY` | base64, at least 32 random bytes, unique per stack. Signs commands and receipts. Never reaches the app. |

`DATABASE_URL`, `DATABASE_MIGRATION_URL`, and
`PAPERCLIP_PLUGIN_MIGRATION_DATABASE_URL` must not be set beside
`PAPERCLIP_MANAGED_DATABASE`; each is a conflicting external setting and fails
closed. A stack that uses an external provider keeps the existing rule: an
authenticated public app with no `DATABASE_URL` refuses to start.

```json
{
  "v": 1,
  "provider": "embedded",
  "stackId": "stk_123",
  "configGeneration": 4,
  "engineMajor": 18,
  "mode": "serving",
  "volume": { "id": "vol_abc", "mountPath": "/paperclip", "idEnvVar": "RAILWAY_VOLUME_ID" },
  "cluster": { "state": "existing", "initializationId": "init_01", "systemIdentifier": "7412345678901234567" },
  "root": "/paperclip/.managed-database"
}
```

- `cluster.state: "initialize"` authorizes one first initialization bound to
  `initializationId`. After the first readiness report, write a new generation
  with `state: "existing"` and the reported `systemIdentifier`. No path ever
  creates an empty database on an established stack.
- `engineMajor` is pinned independently of the image. This release supports 18.
- `root` must be an absolute, normalized path inside `volume.mountPath`.
- `mode: "maintenance"` starts PostgreSQL and the command surface only; the app
  and every app writer stay stopped.

## Process and privilege model

The image entrypoint (`scripts/docker-entrypoint.sh`) sees
`PAPERCLIP_MANAGED_DATABASE`, refuses to continue unless it is root, keeps the
supervisor's files out of the usual `chown node` pass, and execs
`/opt/paperclip-managed-database/main.mjs run -- <app command>` as root.

The supervisor never runs from `/app`, because the `node` user owns that tree.
The `cloud` target builds a self-contained bundle
(`scripts/build-managed-database-supervisor.mjs`): `main.mjs`, its
`migrations/`, the PostgreSQL `engine/`, and `release.json`, the release
identity taken from the app tree at image build. The bundle is root-owned. The
entrypoint refuses to start if any file in it is not owned by root or is
writable by group or others. The bundle refuses to start if `release.json`
does not describe its own migrations.

Rename permission comes from the parent directory, so the root-only modes
inside `root` would protect nothing if the app could write a directory above
it. After the ownership pass, the entrypoint makes every directory from the
parent of `root` up to `volume.mountPath` `root:node 1775`. The app still
creates and replaces its own entries in its home (`/paperclip`), but the sticky
bit stops it from renaming or replacing `root`. The entrypoint refuses a `root`
that is not a normalized path inside a mount other than `/`, and a symbolic link
among those directories. The supervisor refuses to start if any ancestor of
`root` is owned by another user, or is writable by other users without the
sticky bit.

The ownership pass does not trust the supervisor path alone, because a volume
written before those parents were protected can hold it under another name. The
pass also skips every directory that holds a root-owned `volume.json`, and
everything the database user owns.

| Identity | Runs | Can reach |
| --- | --- | --- |
| root | supervisor | everything under `root`; holds the control key |
| `paperclip-db` | `postgres` | `root/data` (0700) and its socket dir (0700) |
| `node` | tenant app | `root/public/readiness.json`, `root/public/control.sock`, loopback TCP with its own role |

Database roles (created at first initialization):

| Role | Access |
| --- | --- |
| `paperclip_supervisor` | bootstrap superuser; Unix socket only |
| `paperclip_owner` | owns the tenant database and core schema; runs migrations; Unix socket only |
| `paperclip_app` | DML on core and plugin tables, read-only migration journal; loopback TCP to `paperclip` only |
| `paperclip_plugin` | inherits `paperclip_app`; may create and change only `plugin_*` schemas (event trigger `paperclip_plugin_ddl_guard`) for runtime plugin installs |

App and plugin passwords rotate at every supervisor start. The owner and
superuser passwords stay in `root/secrets` (0700 root).

The app receives `DATABASE_URL` (`paperclip_app@127.0.0.1`),
`PAPERCLIP_PLUGIN_MIGRATION_DATABASE_URL`, `PAPERCLIP_DATABASE_PROVIDER=managed-embedded`,
the readiness file and control socket paths, the stack id and generation, and
`PAPERCLIP_MIGRATION_AUTO_APPLY=false`. It refuses to start if any of them is
inconsistent, if supervisor-only variables reached it, or if the readiness file
does not report a current schema in serving mode. It never applies migrations.

## Startup checks (before any write)

1. Config parses; no conflicting external settings.
2. The image's bundled engine major equals `engineMajor`, and the major is supported.
3. `volume.mountPath` is a separate filesystem from `/`; `idEnvVar` (if set) equals `volume.id`.
4. Supervisor state (`root`, `marker.json`, `volume.json`, `secrets/`) is real, not symlinked, and owned by the supervisor. Every ancestor of `root` is owned by the supervisor or root and is not writable by other users unless it is sticky.
5. `volume.json` and `marker.json` match the stack, volume, initialization, engine major, and (for `existing`) system identifier.
6. `data/PG_VERSION` equals `engineMajor`.
7. After start: `server_version_num` and `pg_control_system().system_identifier` match the marker.

A first initialization that crashed before readiness is redone only under the
same `initialize` config. If the schema is not current, or a recovery hold is
active, a serving config still does not start the app; the supervisor serves the
maintenance surface instead.

## Commands

`POST /__paperclip/managed-database/v1/command`, body `ManagedDatabaseCommand`,
header `x-paperclip-managed-database-signature: v1=<hex>` =
HMAC-SHA256(key, `"paperclip-managed-database:command:" + canonicalJson(body)`).
In maintenance mode the supervisor serves this on `$PORT`. In serving mode the
app relays the bytes to `root/public/control.sock`; the app has no key, so it
can forward but not forge.

Archives use `/__paperclip/managed-database/v1/archive` with the same
signature header:

- `GET` (download): the command goes in `x-paperclip-managed-database-command`
  as base64url JSON.
- `PUT` (upload): the body starts with the command as one line of JSON ending
  in `\n`, at most 256 KiB (`managedDatabaseUploadPreamble`). The archive bytes
  follow. The command is not a header because its receipt lists every table,
  which can exceed HTTP header limits. The command line must arrive within
  30 seconds, and at most 4 uploads may wait for theirs. An unsigned or
  malformed upload, and an archive longer than its receipt's `sizeBytes`, are
  answered with `connection: close` and the rest of the body is not read. A
  client that keeps sending can see a connection reset instead of the
  response. Signed rejections drain the body, so a signed client receives them.

`GET /__paperclip/managed-database/v1/health` (and
`/api/health` while no app runs) returns `{ "status": "starting" | "maintenance" | "serving" | "recovery" }`.

Every command carries `v, stackId, configGeneration, commandId, issuedAt, kind, args`;
all but `status`, `receipt.get`, and `lease.acquire` carry `lease: { id, epoch }`.

| kind | Mode | Effect |
| --- | --- | --- |
| `status` | any | Signed readiness identity, lease, retained databases, local snapshots. |
| `receipt.get` | any | `args: { commandId, requestSha256 }`. Read-only; never stored. Returns `details.state`: `found` with the original signed `receipt`, `running`, or `unknown`, plus the current `hold`. A hash that does not match the stored request is `command_id_conflict`. |
| `lease.acquire` / `renew` / `release` | any | The epoch increases on every grant and survives restarts. No grant or release while a mutating command runs. |
| `snapshot.create` | any | `pg_dump --format=custom` of the tenant database (`paperclip-pgdump-custom-v1`). Row counts and the journal fingerprint come from the same exported snapshot. `quiesced` in maintenance, `online` while serving. |
| `snapshot.download` | any | Streams the archive with `x-paperclip-archive-sha256`. Store it off-volume. |
| `snapshot.upload` | maintenance | Body = command line, then the archive; `args.receipt` = a signed `snapshot.create` receipt from this stack. Rejects other stacks, other engine majors, and sha256 mismatches. A retry of an archive already on the volume restores missing metadata. |
| `snapshot.delete` | any | Removes a local archive. |
| `snapshot.restore` | maintenance | `pg_restore --single-transaction` into a staging database, verify row counts and journal against the receipt, re-check the lease, swap by rename, retain the old database as `paperclip_pre_restore_<id>`. Clears a recovery hold. |
| `restore.discard` | maintenance | Drops a retained `paperclip_pre_restore_*` database. |
| `schema.migrate` | maintenance | Requires a quiesced snapshot at the current journal on this cluster, and `args.release` equal to this image's bundled migrator. Re-checks the lease immediately before it starts. Runs it as `paperclip_owner`. A failure or interrupt leaves a recovery hold that only a restore clears. |

Rejections (`outcome: "rejected"`): `bad_signature`, `invalid_command`,
`wrong_stack`, `stale_generation`, `clock_skew` (more than 5 minutes),
`lease_stale`, `lease_conflict`, `busy`, `mode_forbidden`,
`command_id_conflict`, `not_found`, `precondition_failed`, `recovery_hold`,
`unsupported`. Receipts are signed with purpose `receipt` and kept under
`root/receipts/`. Each records the request hash (`requestSha256`, sha256 of
the canonical command) and the generation it ran under.

### Reconciling a lost response

The harness must save a command durably before sending it. If the response is
lost, it recovers the outcome instead of sending a new command:

- Resend the exact saved command. A recorded receipt for the same `commandId`
  and request hash is returned before the generation and replay-window checks,
  so this works after a long harness restart or a generation change. Nothing
  runs again. Reusing the `commandId` with any change, including a refreshed
  `issuedAt`, is `command_id_conflict`.
- Or send a fresh `receipt.get` for the current generation with the saved
  command's `commandId` and request hash.

A command with no recorded receipt is checked as new: it must carry the
running generation, be inside the replay window, and pass the lease and busy
checks. `unknown` therefore never authorizes resending a stale command. Treat
it as "did not finish": the command was rejected before it ran, or the
container stopped while it ran. In the second case `hold` names an
interrupted migration or restore. Inspect `status` before choosing a new
command under a fresh lease.

## Release capability

`main.mjs capability` prints `ManagedDatabaseCapability`: contract versions,
engine majors, bundled engine version, snapshot formats, and the release
(`migrationsDigest`, `latestMigration`, `migrationCount`, `version`, `commit`).
The `cloud` Docker target writes it to `/app/managed-database-capability.json`
and fails the build unless the engine major and a snapshot format are present.
Treat an image without the file, without contract `1`, or without the stack's
engine major as ineligible for an embedded stack.

## Release sequence (harness)

1. Lock the stack. New generation with `mode: "maintenance"` on the current image; wait for health `maintenance`.
2. `lease.acquire`, `snapshot.create`, `snapshot.download`; verify sha256; store off-volume with the receipt.
3. Deploy the target image, still in maintenance (new generation). `status` must report the same `systemIdentifier`.
4. `schema.migrate` with the target release and the snapshot id. On failure: `snapshot.restore` (upload first if the archive is not on the volume), then return to the previous image.
5. New generation with `mode: "serving"`. `status` must report schema `current` and the expected generation and release. Release the lease and reopen traffic.

Keep the lease for the whole sequence. After a container interrupt the lease
remains valid, so the same executor resumes with it and another executor gets
`lease_conflict` until it expires.

## Recovery behavior

- PostgreSQL crash: the supervisor stops the app, restarts PostgreSQL (bounded
  attempts), re-verifies the cluster identity, and relaunches the app. If
  recovery is exhausted, the supervisor exits non-zero so the platform restarts
  the container through the full startup checks.
- Container interrupt: PostgreSQL crash recovery replays WAL at the next start;
  committed data survives.
- Interrupted migration: the hold (`migration_interrupted`) persists; the app
  stays stopped until a restore.
- Interrupted restore: at start the supervisor finishes a verified swap or rolls
  back an unverified one and holds the stack (`restore_interrupted`). A
  finished swap clears any earlier hold, as an uninterrupted restore does.
- Archives are flushed to disk before their metadata is written and before
  they are renamed into place. A snapshot exists only once its archive is in
  place; startup removes partial files and metadata without an archive.

## Testing

- `server/src/__tests__/managed-database-contract.test.ts`: schema, signatures,
  preflight, leases, app contract (no engine needed).
- `managed-database-supervisor.test.ts` and `managed-database-recovery.test.ts`:
  real embedded PostgreSQL. Snapshot tests need `pg_dump`/`pg_restore` 18
  (`postgresql-client-18`, or `PAPERCLIP_MANAGED_DATABASE_PG_CLIENT_BIN_DIR`) and
  skip with a message otherwise.
- `managed-database-bundle.test.ts`: builds the image bundle and checks that it
  reports the same capability as the source tree, that its engine can run
  `initdb`, and that it refuses a mismatched `release.json`.
- `managed-database-os-isolation.test.ts`: opt-in, root only. It creates two
  system users and mounts tmpfs volumes:
  `sudo -E env PATH="$PATH:/usr/sbin:/sbin" PAPERCLIP_MANAGED_DATABASE_OS_TESTS=1 ./node_modules/.bin/vitest run src/__tests__/managed-database-os-isolation.test.ts`
  from a checkout the unprivileged users can read.

## Not covered here

The Cloud repository owns off-volume archive storage, encryption, and
retention; registry fields; provisioning and warm pools; sleep/wake ordering;
admin display; and provider transfers.
