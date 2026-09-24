---
title: Backup And Restore
summary: What a deployment backup contains, and how to restore one under pressure
---

A backup you have never restored is a guess. This page is the restore path for a
self-hosted deployment, written to be followed while something is broken: the
order, what has to be stopped, and how to tell the restore actually worked before
you put load on it.

Read [Database](/deploy/database) first if you are not sure which of the three
database modes you are running. This page assumes a Docker Compose deployment
where PostgreSQL runs as a container and Paperclip's data directory is a host
path or volume — the shape [Docker](/deploy/docker) describes.

## The three artifacts

A deployment backup is not one file. It is three, and they cover different
stores:

| Artifact | Made with | Covers |
|---|---|---|
| `db-<ts>.sql.gz` | `pg_dump` of the Paperclip database | the board: companies, agents, projects, issues, comments, documents, work products, run *metadata*, secret *metadata* |
| `state-<ts>.tar.gz` | tar of the deployment's own state directory | whatever your deployment tooling keeps outside Paperclip (schedules, daemon state, its logs) |
| `paperclip-<ts>.tar.gz` | tar of the Paperclip data directory (`/paperclip`, or whatever `PAPERCLIP_HOME` points at) | the secrets master key, agent and company workspaces, project checkouts, run log files, uploaded attachments and assets |

**None of the three is sufficient alone, and the database is not the biggest
dependency.** Two things in particular live only in the data directory:

- **The secrets master key** (`instances/<id>/secrets/master.key`). The database
  stores secret *metadata* — names, versions, owners, access events — encrypted
  against this key. Restore the database without it and every stored credential
  is undecryptable. [Secrets](/deploy/secrets) covers this in full.
- **Run logs.** `heartbeat_runs` rows carry `log_store = 'local_file'` and a
  relative `log_ref`; the NDJSON transcript itself is a file under
  `instances/<id>/data/run-logs/`. A database-only restore gives you run history
  — status, timings, token usage, exit codes, stdout/stderr excerpts — with every
  full transcript a dangling reference.

Attachments and assets behave the same way when storage is local-disk; see
[Storage](/deploy/storage).

## Are the three artifacts consistent with each other?

This is the question that decides whether a short backup interval buys anything.

**The database dump is internally consistent, on its own, always.** `pg_dump`
reads in a single `REPEATABLE READ` snapshot, so no amount of concurrent agent
traffic can tear it. A dump taken while runs are in flight is a clean picture of
one instant. You do not need to stop anything to get a trustworthy database
backup.

**The three artifacts are not consistent with each other.** They are taken
sequentially, and nothing coordinates them, so the skew between them is the
wall-clock gap between the commands — which for a tar of a large data directory
is minutes to hours, not seconds. A run that writes a comment to the database and
a file to a workspace in that gap lands in one artifact and not the other.

The direction of the skew is what matters, and it is worth getting right:

- **Dump the database first, tar the filesystem afterwards.** Then the filesystem
  is never *older* than the database. Every file the database references already
  existed when the dump was taken, so it is present in the later tar; the tar's
  only extra content is files nothing points at yet, which is harmless garbage.
- Reversed — tar first, dump last — the database can reference files created
  after the tar was made, and those references are dangling on restore. That is
  the failure mode that looks like data loss.

Residual risk in the recommended order is deletion: a file the dump references
that gets cleaned up before the tar reaches it. Keep backup runs away from
scheduled cleanup and this stays rare.

### What quiescing would actually cost

True cross-artifact consistency means no writes for the whole window: stop
Paperclip, take all three artifacts, start it again. The window is dominated by
the tar, so this is only worth doing if the data directory is small.

It usually is not. A working deployment's data directory accumulates content that
is *regenerable* and often dwarfs the irreplaceable part — repository clones and
worktrees, build caches, installed CLI payloads, and, recursively, earlier
database backups. Taring all of it hourly is not a backup strategy; it is a copy
loop.

So the practical answer is to **shrink the artifact rather than lengthen the
downtime**:

- Exclude the regenerable paths from the data-directory tar — repo clones and
  worktrees, build/compiler caches, install stores, temp dirs, and the backup
  directory itself. Keep `instances/<id>/secrets`, the company and project
  workspaces, `data/run-logs`, `data/storage`, `skills`, and `config.json`.
- Once the tar is small, quiescing becomes affordable, and a frequent cadence
  becomes meaningful. Until then a frequent cadence mostly re-copies caches.
- If the filesystem supports snapshots (LVM, ZFS, btrfs), snapshot the data
  directory and tar the snapshot. That gives a consistent filesystem image
  without stopping anything, and it is strictly better than either option above.

A short interval on the **database dump alone** is cheap and worth having
independently of the tar — it is the system of record, and it is self-consistent
by construction.

## Restoring

The order below never leaves the deployment without a database, and keeps a
one-command rollback available until the very end. Read it through before
starting.

### 0. Before you touch anything

Identify the artifacts you intend to restore and confirm they are intact. A
truncated gzip is the most common bad surprise, and it costs nothing to check:

```sh
gzip -t db-<ts>.sql.gz && echo "db artifact intact"
gzip -t paperclip-<ts>.tar.gz && echo "volume artifact intact"
gzip -t state-<ts>.tar.gz && echo "state artifact intact"
```

Write down what the board held before the incident if you can still reach it —
company, agent, issue and comment counts. You will compare against these at the
end. If the board is already gone, the numbers in the dump are what they are.

### 1. Stop everything that writes

Stop Paperclip and any deployment daemon that drives it. **Leave PostgreSQL
running** — you need it to load the dump.

```sh
paperclipai service stop                        # installed as a background service
docker compose -f compose.yaml stop paperclip   # or, if it runs as a container

paperclipai service status                      # confirm it is down
docker compose -f compose.yaml ps               # db should still be Up
```

Stop any deployment daemon that drives Paperclip too, or it will keep writing
while you restore underneath it.

Confirm nothing still holds the data directory before restoring over it:

```sh
sudo fuser -vm /paperclip 2>&1 | head
```

Runs that were in flight when you stopped are left mid-flight in the database.
They come back as `running` rows that no process owns; expect to see them and
clear them after the board is up, not now.

### 2. Restore the filesystem artifacts

Do these before the database, for one reason: they are the slow, bulky steps, and
until step 3 the existing database is still intact and still your fallback. If a
tar turns out to be bad you have lost nothing.

**Never untar over a live tree.** Extraction merges: files the archive does not
contain are left behind, so you end up with a mix of two generations that looks
like a successful restore. Move the old contents aside first, and keep them until
you are done.

How you move them aside depends on whether the data directory is its own mount
point — a bind mount or an attached volume cannot be renamed, only emptied:

```sh
findmnt -T /paperclip    # does TARGET equal /paperclip itself?
```

**If it is a mount point**, move the contents aside *inside* the mount, so the
move is a same-filesystem rename and stays instant even at a hundred gigabytes:

```sh
sudo mkdir -p /paperclip/.pre-restore
sudo find /paperclip -mindepth 1 -maxdepth 1 -not -name .pre-restore \
  -exec mv -t /paperclip/.pre-restore {} +
sudo tar -xzf paperclip-<ts>.tar.gz -C /paperclip --strip-components=1
```

**If it is an ordinary directory**, stage beside it and swap:

```sh
sudo mkdir -p /paperclip.restored
sudo tar -xzf paperclip-<ts>.tar.gz -C /paperclip.restored --strip-components=1
sudo mv /paperclip /paperclip.old && sudo mv /paperclip.restored /paperclip
```

`--strip-components=1` is there because the archive holds the directory itself
(`paperclip/...`), not its bare contents. Check with
`tar -tzf paperclip-<ts>.tar.gz | head -3` if you are unsure — extracting one
level off is the easiest mistake to make here.

The deployment state directory is the same shape. It holds a `state/` entry, so it
extracts into the deployment root without stripping:

```sh
mv /path/to/deployment/state /path/to/deployment/state.pre-restore
tar -xzf state-<ts>.tar.gz -C /path/to/deployment
```

Now check two things that nothing later will tell you about.

**The master key.** It must be present and `0600`:

```sh
ls -l /paperclip/instances/*/secrets/master.key
```

If the artifact predates the secrets in the database, see
[Secrets](/deploy/secrets) — metadata restored without its key is not recoverable
by any later step.

**Ownership.** `tar` run as root restores the uid/gid recorded in the archive. If
the archive was made on a host where Paperclip ran under a different uid than the
one it will run as now, every file is owned by a stranger and the server fails on
its first write:

```sh
stat -c '%U %G %n' /paperclip/instances | head
sudo chown -R "$(id -u)":"$(id -g)" /paperclip   # only if the owner is wrong
```

### 3. Load the database into a side database, not over the live one

Restore into a **new** database first. This is the difference between a restore
and a gamble: if the dump is bad you find out before destroying anything, and the
switch at the end is two renames with instant rollback.

A plain `pg_dump` artifact — no `--clean`, no `--create` — contains `CREATE`
statements and no `DROP`s, so **it only loads into an empty database**. Pointed at
a database that already has the schema it fails on the first `CREATE TABLE`. Do
not run migrations on the target first; the dump carries the full schema *and*
the migration journal, so the restored database already knows which migrations
have run.

```sh
docker compose -f compose.yaml exec -T db \
  psql -U paperclip -d postgres -c 'CREATE DATABASE paperclip_restored'

gunzip -c db-<ts>.sql.gz | docker compose -f compose.yaml exec -T db \
  psql -U paperclip -d paperclip_restored -v ON_ERROR_STOP=1 --quiet --no-psqlrc
```

`ON_ERROR_STOP=1` is not optional. Without it psql reports errors and carries on,
and you get a partially populated database that exits 0.

Two things the dump expects from the target cluster, both satisfied by a stock
deployment where the Paperclip role owns the database:

- **The same role name.** A plain dump carries `OWNER TO` and `GRANT` statements
  naming the source's role. Restoring into a cluster without that role fails.
- **Permission to create extensions.** The schema uses `pg_trgm` and
  `fuzzystrmatch`; `CREATE EXTENSION` needs a superuser or equivalent.

### 4. Verify before you point the server at it

Run the bundled checker against the database you just loaded. It asserts the
invariants a restore breaks silently, prints a board inventory for you to compare
against your pre-incident numbers, and exits non-zero if anything failed:

```sh
docker compose -f compose.yaml exec -T db \
  psql -U paperclip -d paperclip_restored -v ON_ERROR_STOP=1 -f - \
  < scripts/restore-verify.sql
```

```
=== restore verification ===
             check             | status |                     detail
-------------------------------+--------+------------------------------------------------------
 core relations present        | PASS   | all 7 core relations present
 migration journal present     | PASS   | 282 migration(s) recorded, newest hash 499fcad50ac2476c
 required extensions installed | PASS   | pg_trgm, fuzzystrmatch
 referential integrity         | PASS   | no orphaned rows across 6 relationships
 board is populated            | PASS   | 2 company/companies, 21 agent(s)
 sequences ahead of their data | PASS   | 2 sequence(s) checked, all ahead of their column max
...
RESTORE VERIFICATION PASSED
```

Any `FAIL` stops the restore. In particular:

- **`board is populated` failing** is the quiet catastrophe — a structurally
  perfect, empty database. Every other check passes on one.
- **`sequences ahead of their data` failing** does not break anything until the
  first insert after go-live, which then fails on a duplicate key. Note that
  `setval` is not transactional, so this cannot be fixed by rolling back; fix it
  forward with `setval` to the column's max.

Compare the printed inventory against your pre-incident counts. The checker
cannot do this for you — a restore target has no way to know what the source
held.

### 5. Swap the database in and start up

Renames need no active connections, which is why Paperclip is still stopped.

```sh
docker compose -f compose.yaml exec -T db psql -U paperclip -d postgres <<'SQL'
ALTER DATABASE paperclip RENAME TO paperclip_prior;
ALTER DATABASE paperclip_restored RENAME TO paperclip;
SQL
```

Then start Paperclip. It applies any migrations newer than the dump on boot,
which is expected and is why the migration journal had to come back intact.

```sh
paperclipai service start    # or: docker compose -f compose.yaml up -d
```

`paperclip_prior` is your rollback. Keep it until you are satisfied, then drop
it — it is a full copy and it is not free.

### 6. After the board is up

- Sign in and confirm the board reads: companies, agents, issues, comments, and
  a run's history with its log opening (that last one exercises the database and
  the data directory together, which nothing before this point does).
- Clear runs left `running` by step 1.
- Re-check that scheduled work is where you expect it rather than all firing at
  once on catch-up.
- Take a fresh backup. The restored deployment has no backup of its own yet.

## Restoring only the database, for a test

To check that an artifact is loadable without touching a deployment, load it into
a throwaway PostgreSQL of the same major version and run the checker:

```sh
docker run -d --name restore-test \
  -e POSTGRES_USER=paperclip -e POSTGRES_DB=paperclip -e POSTGRES_PASSWORD=test \
  postgres:17-alpine

gunzip -c db-<ts>.sql.gz | docker exec -i restore-test \
  psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 --quiet --no-psqlrc

docker exec -i restore-test psql -U paperclip -d paperclip -v ON_ERROR_STOP=1 \
  -f - < scripts/restore-verify.sql

docker rm -f restore-test
```

`POSTGRES_USER=paperclip` is what makes the dump's `OWNER TO`/`GRANT` statements
resolve, and it makes that user a superuser so `CREATE EXTENSION` succeeds. This
is worth running on a schedule — an untested artifact is the thing this page
exists to prevent.

## Giving a customer their data back

**Do not hand over a backup artifact.** All three are whole-deployment: one
database holds every company, and the data directory holds every company's
workspaces and the shared secrets master key. Handing one to a single customer
discloses every other customer on that deployment.

The per-company export is the deliverable:

```
POST /api/companies/:companyId/exports
```

It emits a portable bundle scoped to one company — the company itself, its
agents, projects, issues with their comments, documents, work products,
attachments, monitors and routines, skills, labels, and its environment-input
declarations. It is the same format the import side consumes, so a customer can
load it into another Paperclip instance rather than receive an archive they cannot
open. The board exposes the same thing in the UI, and
`POST /api/companies/:companyId/exports/preview` shows what a given selection
would contain before you produce it.

Two limits to state plainly when you send one:

- **Secret values are not included, by design.** Environment inputs of kind
  `secret` export as declarations — the key and whether it is required — never the
  value. The customer re-supplies their own credentials on import.
- **Heartbeat run history is not included.** `heartbeat_runs`,
  `heartbeat_run_events` and the NDJSON run logs are deployment-level operational
  data and are not part of the company bundle. If a customer specifically asks
  for their run history, it has to be extracted from a backup rather than
  exported, and it needs scoping to their company first.

At teardown, produce the export *before* destroying anything, confirm the
customer can open it, and only then delete. Deleting the company and then
discovering the export was incomplete is unrecoverable once the backups age out.
