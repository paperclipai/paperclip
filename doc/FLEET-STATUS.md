# Fleet status panel

`scripts/fleet-status.sh` shows the state of one Paperclip fleet. It answers
four questions in one screen:

- Which agents are running work now.
- Which agents are idle and can accept work.
- Which items wait for a human.
- Which wakeups are stuck.

The panel reads the instance database. It does not write to it.

## Run it

```sh
scripts/fleet-status.sh                     # render once
scripts/fleet-status.sh --json              # the same facts as one JSON document
scripts/fleet-status.sh --watch 60          # render again every 60 seconds
scripts/fleet-status.sh --company Acme      # limit the scope to one company
scripts/fleet-status.sh --db <dsn>          # use a specific connection string
```

The command needs `psql` and a reachable PostgreSQL instance. The connection
string is taken from the first value that is set:

1. `--db`
2. `PAPERCLIP_FLEET_DATABASE_URL`
3. `DATABASE_URL`
4. `postgres://paperclip:paperclip@localhost:5432/paperclip`

The database role needs `SELECT` on `companies`, `agents`, `issues`,
`heartbeat_runs`, `agent_wakeup_requests` and `issue_recovery_actions`. A
read-only role is enough.

The development setup uses embedded PGlite. PGlite has no TCP endpoint, so the
panel cannot use it. Use an external PostgreSQL instance in the development
setup.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | Nothing needs a human. |
| `1` | At least one item needs a human. |
| `2` | The panel is unavailable. |

The panel is unavailable when the usage is wrong, when `psql` is missing, when
the database cannot be reached, when a query or a schema check fails, when a row
cannot be parsed, or when the scope matches no agent.

The text panel and the JSON document use one decision function. They cannot
report different facts.

`--watch` does not propagate these codes. A failed round is reported on stderr
and the next round starts after the interval, so a database that comes back
does not end the watch. Use a single run for health checks.

`--watch` stops when its output pipe closes (for example `fleet-status.sh
--watch 1 | head -n 1`). The closed write is detected as SIGPIPE and the
watcher exits instead of keeping the database busy after the reader leaves.

An idle agent with no unfinished work exits `0`. Free capacity is healthy. The
panel still lists it so that an operator can hand out work.

A scope that matches no company, or only archived companies, exits `2`. The
panel does not report an empty fleet as all clear. The one exception is a scope
where every agent is `terminated`. That is a real answer, so the panel prints an
empty table with the excluded count and exits `0`.

## What counts as attention

The panel calls a state out only when the database shows no waiting path for it.
A live run, a fresh queued wakeup and an active recovery action cover the whole
agent. A scheduled monitor (`monitor_next_check_at`) covers only the card it is
attached to.

The panel reports these states:

- A live run that is older than `--running-slow`, or that is silent for longer
  than `--run-silent`.
- An in-progress card that no live run, fresh wakeup or recovery action covers
  and that carries no monitor of its own. A monitor on one card does not excuse
  the other cards. The note counts only the uncovered cards.
- `in_review` work that is not the card of a live run. A review card that the
  assigned agent is running now is not counted again. The reported wait skips
  that card.
- A paused agent that still holds unfinished work. A card parked on the agent
  counts as unfinished work here, the same as an active or in-review card.
- An agent with status `error` or `pending_approval`.
- Failed wakeup requests inside the `--wake-window` window.
- Queued or deferred wakeups that are older than `--wake-stale` and that no run
  can drain. The same queue behind a live run is reported without raising
  attention, because one run serialises the wakeups of its agent.

A stale queue is not a waiting path either. An agent whose only queued wakeups
are older than `--wake-stale` counts as an agent that has work and no usable
path. The row never says "waiting to be claimed" and "queued for six hours"
about the same wakeup. One fresh entry keeps the agent in `waiting` while the
older entries are still reported.

`deferred_issue_execution` is a queue state that the scheduler resumes. It is
not a failure, so the panel never counts it as a failed wakeup. The panel
excludes `claimed` from the queue entirely. It records that a run took the
wakeup, and not every completion path advances the row to a terminal status.
Counting it would report a permanent backlog.

## Read-only boundary

Every statement runs with `default_transaction_read_only=on`. The panel refuses
to continue when this setting is not in effect. `statement_timeout` and
`lock_timeout` keep a blocked read from hanging a shell. The panel only reads.

## Thresholds

The defaults are `--running-slow 25`, `--run-silent 10`, `--todo-idle 8`,
`--review-wait 15`, `--wake-window 3` and `--wake-stale 30`. The values are
minutes, except the window in hours.

`--todo-idle` and `--review-wait` grade the note only. They do not change
whether a row is flagged. An in-progress card with no run, no wake, no monitor
and no recovery is anomalous at any age, because a healthy fleet always leaves
one of those behind.

The same values can be set through `FLEET_RUNNING_SLOW`, `FLEET_RUN_SILENT`,
`FLEET_TODO_IDLE`, `FLEET_REVIEW_WAIT`, `FLEET_WAKE_WINDOW_H` and
`FLEET_WAKE_STALE`. This keeps `--watch` invocations short. An explicit flag
wins over the environment variable, and the environment variable wins over the
built-in default. Every threshold is echoed in the header and in the JSON
`thresholds` block. A reading is always attributable to the numbers that
produced it.

## Data source and scope

The panel reads the instance database directly. The board API exposes aggregate
counts (`/api/companies/:id/dashboard`) and a decision feed
(`/api/companies/:id/attention`). Both sit behind board authorization. Neither
carries per-agent run state. Direct SQL is the only way to render this view
without adding a server endpoint. Extending the dashboard API remains the better
long-term home if this becomes a product surface rather than an operator panel.

The scope is every company with a non-archived status. `--company` narrows the
scope by id or by case-insensitive name. The same predicate runs inside the
aggregate queries, so a narrow scope also reads fewer rows. `terminated` agents
are excluded and counted in the footer. Conversation containers, hidden rows and
non-execution harness rows are excluded from work cards in the same way as the
board excludes them.

The panel depends on the six relations above. A schema change to any of them
needs a matching change here. A missing relation fails with exit `2` and a named
list. A missing column surfaces as a query failure with the PostgreSQL error.

## Known limits

- The panel applies no board authorization. Its only access control is the
  database role it connects with. Treat its output as instance-wide. Do not
  hand it to someone who lacks board access to the companies in scope.
- The Slack and chat "waiting" conversation check is not evaluated. A chat
  conversation left `in_review` can therefore appear as a review card.
- Run silence is measured from the later of the last output and the current
  attempt start. A restarted attempt never inherits silence. It is a signal to
  look, not a stall verdict.
- A fresh queued wakeup, an active recovery action and a live run are treated as
  covering every card of the agent, not only the card they name. This errs
  toward under-reporting a stall, never toward inventing one.
- The panel reports a live run that is slow or silent for inspection. It does
  not claim that the run is wedged. It does not recommend an interruption, and
  it does not suggest a field rewrite. Those calls need the run log, the
  process state and the artifacts. The panel does not read them.
- `--watch` clears the screen only on a terminal. A redirected run is a plain
  sequence of frames with no separator between them.

## Tests

```sh
node --test scripts/fleet-status.test.mjs
```

The test file covers the decision rules, the exit codes, the width calculation
for CJK text, the scope handling and the pipe behaviour. It needs no database
instance: every query is stubbed.

## Files

| File | Role |
| ---- | ---- |
| `scripts/fleet-status.sh` | Argument parsing, the read-only queries and the decision rules. |
| `scripts/fleet-status-render.sh` | The text and JSON renderers. Sourced by the panel, never run on its own. |
| `scripts/fleet-status.test.mjs` | The test suite for both files. |
| `doc/FLEET-STATUS.md` | This document. |

The panel resolves the renderer next to itself, so the two files have to stay
in the same directory.
