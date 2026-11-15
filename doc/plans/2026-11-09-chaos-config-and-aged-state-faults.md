# Restart chaos: config and aged-state faults (CF1–CF4)

Status: CF1–CF3 are implemented in `tests/restart-chaos/config-faults.ts` and `config-wave.ts`. CF4 is designed here but not built.

## Why

Every chaos wave starts from a new instance that has default, valid settings. On
2026-11-09, production failures came from state that a new instance never has:

- **#20269.** A project's explicit setup command named `scripts/provision-worktree.sh`,
  a script that had been renamed. Workspace preparation failed before the provider ran.
- **#20361.** An OpenRouter binding selected the responsible user's personal account
  default, but that default did not exist. Verification retried forever, and the task
  stayed Queued.

## Oracle (CF1–CF4)

"The task completes" is not the oracle. A task passes when all of these hold:

- **Bounded rest.** Within a bound, the task either completes or rests where the task
  page names the broken setting.
- **No silent waiting.** No run retries unchanged configuration forever. Nothing stays
  Queued without a live owner or a named wait.
- **Restart safety.** The rest survives a K1 or K2 restart.
- **Repair.** After the harness repairs the setting and uses the action the task offers
  (card, Retry, or agent setup Retry), the task completes.

See the README section "Config faults" for the exact checks.

## CF4: aged instance (design)

**Goal.** Start the wave on an instance that an older release created. That release saves
tasks and settings, including CF1–CF3 breaks and parked tasks. Then switch the same
database and instance directory to the current build. Grade with the CF oracle.

**Reuse.** K14 already has the switching machinery:

- `ChaosSupervisor.create({ upgradeFrom })` starts the server from a prepared older
  checkout.
- `supervisor.fault("K14")` stops that server gracefully and starts the current checkout
  against the same database, port, secrets and instance home.
- The prepared checkout is made with `git worktree add <dir> <commit>` and
  `node scripts/agent-preflight.mjs`, as in the K14 section of the README.

Build CF4 on these. Do not add a second upgrade path.

**Changes to `config-wave.ts`** (about half a day):

1. **New flag.** Add `--upgrade-from <dir>`. Check that the directory is prepared, the
   same way `main.ts preflight` does.
2. **Seed and break on the older build.** The older build runs `seedChaosLab`, creates
   each task's resources, applies the break, and launches the task. Use only routes that
   both builds have. Where a route differs, use the older build's route.
3. **Barrier.** Wait until every task has finished its broken phase, so it has rested or
   reached its bound. The parked state is then saved by the older build.
4. **One switch.** Fire `K14` once for the wave. This replaces each task's own K1/K2.
   Re-check the rest on the current build, using the same check as after a restart.
5. **Repair on the current build.** Run repair and the offered action on the current
   build, then grade.
6. **Record both commits.** Write both commits into the summary. The K14 receipt already
   includes them.

**What it covers that CF1–CF3 do not:**

- Older-release run state is resumed by the current build:
  - setup cards created by the older build
  - lifecycle operations whose old retry policy was "retry every 60 s"
  - interruptions projected by older code
- Settings written by older validators that newer validators would reject. A
  `refused_on_write` setting can still exist in an aged database. CF4 is the only way to
  reach that case without writing directly to the database.

**Commit choice.** Use the commit one or two releases back. Also use the commit just
before a known fix. For example, the merge base of #20361 makes the old build save a
CF2 queued-without-card state, which the fixed build must then recover.

**Cost and limits.**

- A prepared older checkout takes about 3 minutes with the shared preflight cache, plus
  about 2 GB of disk.
- Waves stay at 4 tasks or fewer and a concurrency of 2 or less.
- It runs locally only, as K14 does.

**Not designed here.** Months-old data shapes, such as rows from migrations long since
squashed. A seeded fixture database taken from an older release would cover them.
Capture one only when an upgrade incident shows the need.
