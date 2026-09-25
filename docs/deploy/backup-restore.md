---
title: Backup And Restore
summary: What a deployment backup contains, and how to restore one under pressure
---

A backup you have never restored is a guess. This page is the restore path for a
self-hosted deployment, written to be followed while something is broken: the
order, what has to be stopped, and how to tell the restore actually worked before
you put load on it.

Read [Database](/deploy/database) first if you are not sure which of the three
database modes you are running. The restore below covers a deployment with a
**separate PostgreSQL** — a container, or a hosted server. Embedded PostgreSQL
is different in kind and is covered at the end.

There is no single Compose layout to write against, so this page does not
pretend there is: the next section has you name your deployment's moving parts
once, and every command afterwards uses those names.

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

**The filesystem tar is not internally consistent either.** `tar` walks the tree
and reads each file when it reaches it, so it is a smear across the whole walk,
not an image of one instant. A file appended to while tar is reading it is
captured part-written, and an update that spans several files can be captured
with some of them updated and some not. This is a property of `tar`, not of the
ordering, and no cadence fixes it.

Given that, the direction of the skew between the two is what you can still
control, and it is worth getting right:

- **Dump the database first, tar the filesystem afterwards.** Then the filesystem
  is never *older* than the database. Every file the database references already
  existed when the dump was taken, so it is present in the later tar; the tar's
  only extra content is files nothing points at yet, which is harmless garbage.
- Reversed — tar first, dump last — the database can reference files created
  after the tar was made, and those references are dangling on restore. That is
  the failure mode that looks like data loss.

This ordering removes the *systematic* direction of failure. It does not make the
pair a point-in-time image, and two residual risks survive it:

- **Deletion.** A file the dump references, cleaned up before tar reaches it, is
  dangling on restore exactly as if the order had been reversed. Keep backup runs
  away from scheduled cleanup.
- **Tearing**, as above: a file the dump references can be captured mid-write.

So state the guarantee at the level it actually holds:

| What | Restores to a single instant? |
|---|---|
| The database dump alone | **Yes**, always, by construction |
| The data directory tar alone | No — smeared across the walk |
| The two together | No — skewed by the gap, and the tar is smeared |

**A shorter interval shortens how much you lose, not how consistent an artifact
set is.** An hourly *database* cadence is worth buying: it is the system of
record and it is self-consistent. An hourly *artifact set* is a set of hourly
smears unless the producer quiesces or snapshots — so if a plan sells an hourly
tier, what that tier should shorten is the dump, and the honest phrasing is about
recovery point, not about consistency.

Fixing this properly is producer-side work, not restore-side: it is the tooling
that takes the artifacts that must quiesce or snapshot. The next section is what
that would cost.

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

Until a producer does one of those things, none of this is a property of the
schedule, and a backup tier should not be described as if it were. What a tier
buys today is *how much you lose*, bounded by the interval of each artifact
separately.

## Name your deployment's three moving parts first

Every command in the restore refers to three things that differ per deployment.
Resolve them here and the rest of the page is copy-pasteable. Guessing any of
them is how an operator swaps a database while Paperclip is still writing to it,
or extracts an archive over a live tree.

### The stop and start commands

| Shape | Stop | Start |
|---|---|---|
| Native service (systemd user unit, `paperclipai install`) | `paperclipai service stop` | `paperclipai service start` |
| Compose service | `docker compose -f <file> stop <name>` | `docker compose -f <file> up -d <name>` |
| Plain container | `docker stop <name>` | `docker start <name>` |

**There is no canonical service name, so do not assume one.** In this
repository `docker/docker-compose.yml` calls the application service `server`
and `docker/docker-compose.quickstart.yml` calls it `paperclip`; a deployment
that runs Paperclip natively alongside a Compose database has no application
service in the Compose file at all. List yours:

```sh
docker compose -f <file> config --services
```

A `stop` naming a service that does not exist fails, and if you are not reading
the exit code you will carry on restoring underneath a live server. The
confirmation step below is there to catch exactly that.

### The `psql` invocation — `$PSQL`

Define it once as a shell array; every database command below is
`"${PSQL[@]}" -d <database> ...`.

| Shape | Definition |
|---|---|
| PostgreSQL as a Compose service named `db` | `PSQL=(docker compose -f <file> exec -T db psql -U paperclip)` |
| Hosted or external PostgreSQL | `PSQL=(psql -h <host> -U paperclip)` |

`-T` matters: without it Compose allocates a TTY and piping a dump in fails.

**Embedded PostgreSQL has no `$PSQL` and no separate database artifact.** The
database lives *inside* the data directory (`instances/<id>/db`), so the
data-directory artifact already carries it and steps 3 to 5 do not apply —
restore is steps 1, 2 and 6 only. The Docker quickstart is this shape.
`paperclipai db:backup` is its backup path; see [Database](/deploy/database).

### The data directory — `$PC_DATA`

```sh
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' <container>
```

- **A host path** (bind mount, or a native deployment): `PC_DATA=/paperclip`, and
  `findmnt`, `fuser` and `tar` work on it directly.
- **A named volume** (`docker/docker-compose.yml` uses `paperclip-data`): there is
  no host path to point those at. Do the filesystem work inside a throwaway
  container bound to the volume instead — this page marks every place that
  applies:

  ```sh
  VOL=paperclip-data
  docker run --rm -v "$VOL":/paperclip -v "$PWD":/artifacts:ro alpine sh -c '<command>'
  ```

  Nothing else may be attached to the volume while you do this, which is what
  stopping Paperclip in restore step 1 buys you.

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

Stop Paperclip, using the stop command you resolved above. **Leave PostgreSQL
running** — you need it to load the dump. Stop any deployment daemon that drives
Paperclip too, or it will keep writing while you restore underneath it.

Then confirm it is actually down. This is not ceremony: a `stop` naming a
service that does not exist exits non-zero and leaves the writer running, and
every destructive step after this assumes it is gone.

```sh
paperclipai service status                  # native: expect "stopped"
docker compose -f <file> ps                 # compose: the app gone, db still Up
curl -sf -o /dev/null http://localhost:3100/api/health && echo "STILL SERVING — stop it"
```

Confirm nothing still holds the data directory before restoring over it.

**Host path:**

```sh
sudo fuser -vm "$PC_DATA" 2>&1 | head
```

**Named volume** — ask Docker instead, since there is no host path to check:

```sh
docker ps -a --filter volume="$VOL" --format '{{.Names}}\t{{.State}}'
```

Nothing may be in state `running`.

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

**A named volume** has no host path: do the whole thing in a
throwaway container bound to the volume. Move aside inside the volume, so the
move is a same-filesystem rename and stays instant even at a hundred gigabytes:

```sh
docker run --rm -v "$VOL":/paperclip -v "$PWD":/artifacts:ro alpine sh -c '
  mkdir -p /paperclip/.pre-restore &&
  find /paperclip -mindepth 1 -maxdepth 1 -not -name .pre-restore \
    -exec mv -t /paperclip/.pre-restore {} + &&
  tar -xzf /artifacts/paperclip-<ts>.tar.gz -C /paperclip --strip-components=1'
```

**A host path** splits on whether it is its own mount point — a bind mount or an
attached volume cannot be renamed, only emptied:

```sh
findmnt -T "$PC_DATA"    # does TARGET equal $PC_DATA itself?
```

*If it is a mount point*, move aside inside the mount, for the same reason:

```sh
sudo mkdir -p "$PC_DATA/.pre-restore"
sudo find "$PC_DATA" -mindepth 1 -maxdepth 1 -not -name .pre-restore \
  -exec mv -t "$PC_DATA/.pre-restore" {} +
sudo tar -xzf paperclip-<ts>.tar.gz -C "$PC_DATA" --strip-components=1
```

*If it is an ordinary directory*, stage beside it and swap:

```sh
sudo mkdir -p "$PC_DATA.restored"
sudo tar -xzf paperclip-<ts>.tar.gz -C "$PC_DATA.restored" --strip-components=1
sudo mv "$PC_DATA" "$PC_DATA.old" && sudo mv "$PC_DATA.restored" "$PC_DATA"
```

`--strip-components=1` is there because the archive holds the directory itself
(`paperclip/...`), not its bare contents. Check with
`tar -tzf paperclip-<ts>.tar.gz | head -3` if you are unsure — extracting one
level off is the easiest mistake to make here, and it looks like success until
something opens a file. Step 4's run-log check is what catches it.

The deployment state directory is the same shape. It holds a `state/` entry, so it
extracts into the deployment root without stripping:

```sh
mv /path/to/deployment/state /path/to/deployment/state.pre-restore
tar -xzf state-<ts>.tar.gz -C /path/to/deployment
```

Now check two things that nothing later will tell you about.

**The master key.** It must be present and `0600`:

```sh
ls -l "$PC_DATA"/instances/*/secrets/master.key
# named volume:
docker run --rm -v "$VOL":/paperclip alpine ls -l /paperclip/instances/*/secrets/master.key
```

If the artifact predates the secrets in the database, see
[Secrets](/deploy/secrets) — metadata restored without its key is not recoverable
by any later step.

**Ownership.** `tar` run as root restores the uid/gid recorded in the archive. If
the archive was made on a host where Paperclip ran under a different uid than the
one it will run as now, every file is owned by a stranger and the server fails on
its first write:

```sh
stat -c '%U %G %n' "$PC_DATA"/instances | head
sudo chown -R "$(id -u)":"$(id -g)" "$PC_DATA"   # only if the owner is wrong
```

On a named volume the uid that matters is the one *inside* the container, so
compare against the image's user rather than your shell's.

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
"${PSQL[@]}" -d postgres -c 'CREATE DATABASE paperclip_restored'

gunzip -c db-<ts>.sql.gz \
  | "${PSQL[@]}" -d paperclip_restored -v ON_ERROR_STOP=1 --quiet --no-psqlrc
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
"${PSQL[@]}" -d paperclip_restored -v ON_ERROR_STOP=1 -f - < scripts/restore-verify.sql
```

```
=== restore verification ===
             check             | status |                                 detail
-------------------------------+--------+------------------------------------------------------------------------
 core relations present        | PASS   | all 7 core relations present
 migration journal present     | PASS   | 282 migration(s) recorded, newest hash 499fcad50ac2476c
 required extensions installed | PASS   | pg_trgm, fuzzystrmatch
 referential integrity         | PASS   | no orphaned rows across 6 relationships
 board is populated            | PASS   | 21 agents, 2 companies, 10185 issue_comments, 2946 issues, 16 projects
 run history present           | PASS   | 62543 heartbeat_run_events, 6268 heartbeat_runs
 sequences ahead of their data | PASS   | 2 sequence(s) checked, all ahead of their column max
...
RESTORE VERIFICATION PASSED
```

Any `FAIL` stops the restore. In particular:

- **`board is populated` failing** is the quiet catastrophe — a structurally
  perfect, empty database. Every other check passes on one, which is why this
  check gates issues and comments and not just companies and agents.
- **`run history present` failing** usually means a truncated artifact.
  `heartbeat_runs` and `heartbeat_run_events` are the largest tables in the dump,
  so a cut stream loses these first while everything else still looks fine.
- **`sequences ahead of their data` failing** does not break anything until the
  first insert after go-live, which then fails on a duplicate key. Note that
  `setval` is not transactional, so this cannot be fixed by rolling back; fix it
  forward with `setval` to the column's max.

`-v allow_empty=1` downgrades the two population gates to `WARN`, for the rare
restore whose source genuinely held none of those rows. Passing it to silence a
restore that *should* have data is how an empty database gets waved through.

Compare the printed inventory against your pre-incident counts. The checker
cannot do this for you — a restore target has no way to know what the source
held.

**Then check the run logs, which the SQL cannot.** `restore-verify.sql` runs
inside the database; the NDJSON transcripts are files in the data directory. A
database-only restore — or a data-directory archive extracted one level off —
passes every check above with every transcript dangling. This is the only step
that exercises both artifacts at once:

```sh
"${PSQL[@]}" -d paperclip_restored -Atqc \
  "select log_ref || E'\t' || created_at from heartbeat_runs
    where log_store = 'local_file' and log_ref is not null" \
| scripts/restore-verify-logs.sh "$PC_DATA"
```

```
run-log base: /paperclip/instances/default/data/run-logs
run-log check PASSED — 6323 ref(s) checked, all present (1092 zero-byte, which the source also had)
```

It checks every ref, not a sample — a few thousand `stat` calls take seconds,
and a sample turns the result into a coin toss. Zero-byte transcripts are
normal: a run killed before its first line leaves one, and a faithful restore
brings it back empty. Only *missing* files fail.

**Missing refs need reading, not just counting.** A deployment can carry a few
dangling refs of its own — a run whose transcript was lost at the source long
before any backup was taken — and a faithful restore brings those back dangling
too. Measured on one live deployment: 11 of 6323 refs, all from a single
eight-minute window weeks earlier. The script prints each missing ref with its
run's creation time so you can tell the cases apart:

- **Every ref missing** — the data-directory artifact did not come back, or was
  extracted one level off.
- **A cluster of the newest runs missing** — the filesystem was tarred *before*
  the database was dumped, and those files postdate the archive. That is the
  ordering failure described above, and it is real loss.
- **A few old ones** — the source already lacked them. Confirm at the source if
  it still exists, then re-run with `--max-missing <that count>`. Set it to the
  number the source is known to lack, never to the number that makes the check
  pass.

On a named volume, run it inside the helper container with the repository
mounted, or copy the refs out and check them there.

### 5. Swap the database in and start up

A rename needs no active connections on the database being renamed, which is why
Paperclip is still stopped. It also **cannot run inside a transaction**, so these
two statements cannot be made atomic — which is the whole hazard here, and why
they are run one at a time with the error check in between.

```sh
"${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -c \
  'ALTER DATABASE paperclip RENAME TO paperclip_prior'

"${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -c \
  'ALTER DATABASE paperclip_restored RENAME TO paperclip'
```

`ON_ERROR_STOP=1` matters as much here as it did in step 3, for a different
reason. Feed both statements to one psql without it and a failure on the second
is reported and then ignored: the exit status is 0, and the deployment is left
with **no database named `paperclip` at all** — the live one renamed away, the
restored one not renamed in. Starting Paperclip then either fails or initializes
an empty database over the top.

If the second rename does fail — the usual cause is a connection still attached
to `paperclip_restored`, often a psql from step 4 you left open — put the
original back before doing anything else:

```sh
"${PSQL[@]}" -d postgres -c \
  "select pid, datname, application_name from pg_stat_activity
    where datname in ('paperclip_restored', 'paperclip_prior')"

"${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -c \
  'ALTER DATABASE paperclip_prior RENAME TO paperclip'   # back to where you started
```

Then close the stray connection and retry the pair. Verify before you start
anything:

```sh
"${PSQL[@]}" -d postgres -Atqc \
  "select datname from pg_database where datname like 'paperclip%'"
```

It must list `paperclip` and `paperclip_prior`. If `paperclip` is absent, do not
start the server — you are in the stranded state above. Otherwise start Paperclip. It applies any
migrations newer than the dump on boot, which is expected and is why the
migration journal had to come back intact.

```sh
paperclipai service start    # or the compose/container start you resolved above
```

`paperclip_prior` is your rollback: stop Paperclip and rename the pair back.
Keep it until you are satisfied, then drop it — it is a full copy and it is not
free.

### 6. After the board is up

- Sign in and confirm the board reads: companies, agents, issues, comments, and
  a run's history with its log opening. Step 4 checked the same join from the
  outside; this is the first time the server itself does it.
- Clear runs left `running` by step 1.
- Re-check that scheduled work is where you expect it rather than all firing at
  once on catch-up.
- Take a fresh backup. The restored deployment has no backup of its own yet.

## Testing artifacts without touching a deployment

An artifact nobody has restored is a guess, so do not wait for an incident to
find out. `scripts/restore-smoke.sh` runs the restore end to end against a
throwaway PostgreSQL and exits non-zero on the first failure, which makes it
something you can put on a timer:

```sh
scripts/restore-smoke.sh --db db-<ts>.sql.gz --volume paperclip-<ts>.tar.gz
```

It needs `docker` and `tar`; psql runs inside the container, so the host needs no
PostgreSQL client. In order it checks:

1. both artifacts are intact (`gzip -t`);
2. a clean `postgres:17-alpine` accepts the dump under `ON_ERROR_STOP=1`;
3. `restore-verify.sql` passes — relations, migration journal, extensions,
   referential integrity, a populated board, run history, sequences;
4. the data-directory archive extracts at the right level with
   `--strip-components=1`;
5. the secrets master key is in it, at mode `0600`;
6. every run-log file the restored database points at is present in the
   extracted tree — `--max-missing <n>` tolerates the source's own known
   dangling refs, as in step 4 above.

Steps 4 to 6 are the ones a database-only test cannot reach, and they are where
the silent failures live: an archive extracted one level off, a master key that
was never in the artifact, transcripts that did not come back. Without
`--volume` the script says so in its own output rather than implying a clean
bill of health.

`POSTGRES_USER=paperclip` inside the script is what makes the dump's
`OWNER TO`/`GRANT` statements resolve, and it makes that role a superuser so
`CREATE EXTENSION` succeeds.

**What this does not cover.** It proves the artifacts restore and that the two
halves agree; it does not boot a Paperclip server against the result. The last
mile — signing in, opening a run's log through the UI — is step 6 of the restore
above and stays manual.

## Giving a customer their data back

**Do not hand over a backup artifact.** All three are whole-deployment: one
database holds every company, and the data directory holds every company's
workspaces and the shared secrets master key. Handing one to a single customer
discloses every other customer on that deployment.

The per-company export is the deliverable:

```
POST /api/companies/:companyId/exports
```

**Send the selection explicitly.** An empty body does not mean "everything": the
default is the company and its agents only, and `projects`, `issues` and `skills`
are off unless you ask for them. Ask for all five:

```json
{
  "include": {
    "company": true,
    "agents": true,
    "projects": true,
    "issues": true,
    "skills": true
  }
}
```

That emits a portable bundle scoped to one company — the company itself, its
agents, projects, issues with their comments, documents, work products,
attachments, monitors and routines, skills, and its environment-input
declarations. Note what rides on which flag rather than existing on its own:
**comments, documents, work products, attachments, monitors, labels and routines
all come in with `issues`**, so an export without it is not a partial board, it
is a directory of agents.

It is the same format the import side consumes, so a customer can load it into
another Paperclip instance rather than receive an archive they cannot open. The
board exposes the same thing in the UI.

**Preview before you hand it over, every time:**

```
POST /api/companies/:companyId/exports/preview
```

Same body, and it reports what the selection would actually contain. Compare the
counts against the company's board before you send the bundle, and certainly
before you delete anything — an export missing its issues looks like a valid
bundle, imports without error, and is discovered to be empty long after the
source is gone.

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
