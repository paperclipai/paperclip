#!/usr/bin/env bash
#
# fleet-status — one-screen view of a Paperclip fleet: who is working, who is
# idle, what is waiting on a human, and which wakeups are stuck.
#
# Read-only. It issues SELECTs against the instance database and refuses to run
# outside a read-only transaction (see "Read-only boundary" below).
#
# Usage
#   scripts/fleet-status.sh                     # render once
#   scripts/fleet-status.sh --json              # machine-readable, same facts
#   scripts/fleet-status.sh --watch 60          # re-render every 60s
#   scripts/fleet-status.sh --company Acme   # scope to one company (name or id)
#   scripts/fleet-status.sh --db <dsn>          # override the connection string
#
# Exit codes (identical for text and JSON)
#   0  nothing needs a human right now
#   1  at least one item needs a human (see "What counts as attention")
#   2  the panel is unavailable: bad usage, psql missing, unreachable database,
#      query/schema failure, unparsable row, or a scope that matches no agent
#
#   --watch keeps running and does not propagate these codes; each failure is
#   reported on stderr and the next interval still runs.
#
# What counts as attention (exit 1)
#   · a live run older than --running-slow, or silent longer than --run-silent
#   · a run stuck in the queue longer than --wake-stale
#   · in-progress cards that no live run, fresh wakeup or recovery action covers
#     and that carry no monitor of their own
#   · in_review work that is not the card of a live run
#   · a paused agent that still holds unfinished work
#   · agent status error / pending_approval
#   · failed wakeup requests inside the --wake-window window
#   · queued or deferred wakeups older than --wake-stale when no run could be
#     draining them; behind a live run the same queue is reported, not flagged
#
# What does NOT count as attention (exit 0)
#   · an idle agent with no unfinished work — that is free capacity, not a
#     problem. It is reported so you can hand it work, and nothing more.
#   · an idle agent whose work is covered by a scheduled monitor, a queued
#     wakeup, or an active recovery action — something is already moving.
#
# Deliberately not decided here
#   A long or silent run is reported as a run to inspect. This panel does not
#   claim the run is wedged, does not recommend interrupting it, and does not
#   suggest rewriting or clearing any field. Those calls need the run log,
#   process state and artifacts, which this tool does not read.
#
# Read-only boundary
#   Every statement runs with default_transaction_read_only=on, so a write
#   fails instead of succeeding quietly. The panel also sets statement_timeout
#   and lock_timeout so a blocked read cannot hang a shell, and it verifies the
#   read-only setting before trusting the session.
#
# Data source and schema dependency
#   Direct SQL, not the HTTP API. The board API exposes aggregate counts
#   (/dashboard) and a decision feed (/attention), both behind board auth, and
#   neither carries per-agent run state. This tool therefore depends on these
#   relations: companies, agents, issues, heartbeat_runs, agent_wakeup_requests,
#   issue_recovery_actions. A schema change to any of them needs a matching
#   change here; a missing relation fails loudly with exit 2, and a missing
#   column surfaces as a query failure.
#
#   Embedded PostgreSQL (DATABASE_URL unset) has no TCP endpoint, so this tool
#   needs an external PostgreSQL instance.
#
# Dependencies: bash >= 3.2 and the psql client. No python, no jq.

set -uo pipefail

readonly PROG="fleet-status"
readonly SCHEMA_VERSION=1
readonly FIELD_COUNT=21
readonly FS=$'\x1f'

# Defaults. Override with flags; see usage().
DB_DSN=""
COMPANY=""
MODE="text"
WATCH=""

RUNNING_SLOW=25   # minutes a live run may age before it is worth inspecting
RUN_SILENT=10     # minutes without output before a live run is worth inspecting
TODO_IDLE=8       # minutes of no update on in-progress work before it is stale
REVIEW_WAIT=15    # minutes in_review may wait before it is called backlogged
WAKE_WINDOW_H=3   # hours of failed-wakeup history to summarise
WAKE_STALE=30     # minutes a queued/deferred wakeup may wait before it is stale

STATEMENT_TIMEOUT_MS=15000
LOCK_TIMEOUT_MS=3000

ROWS=""
SQL_OUT=""
SQL_ERR=""
ERR_FILE=""

# Summary counters, filled by the single classification pass.
N_TOTAL=0
N_BUSY=0
N_QUEUED=0
N_IDLE_WORK=0
N_WAITING=0
N_FREE=0
N_PAUSED=0
N_ERROR=0
N_PENDING_APPROVAL=0
A_AGENTS=0
A_LONG_RUNNING=0
A_SILENT_RUN=0
A_IDLE_WORK=0
A_PAUSED_WORK=0
A_AGENT_ERROR=0
A_PENDING_APPROVAL=0
A_REVIEW=0
A_FAILED_WAKE=0
A_STALE_WAKE=0
A_FAILED_WAKE_EVENTS=0
A_STALE_WAKE_EVENTS=0
NEEDS_ATTENTION=0
SCOPE_NAMES=""
SCOPE_NAME_LIST=()
SCOPE_MULTI=0
EXCLUDED_TERMINATED=0
GENERATED_AT=""
GENERATED_AT_ISO=""
UTF8_LOCALE=""

usage() {
  cat <<'EOF'
fleet-status — read-only Paperclip fleet panel.

Usage:
  scripts/fleet-status.sh [options]

Options:
  --json                 emit one JSON document instead of the text panel
  --watch <seconds>      re-render every <seconds> until interrupted
  --company <name|id>    limit the panel to one company (default: all companies)
  --db <dsn>             PostgreSQL connection string
  --running-slow <min>   live-run age that is worth inspecting   (default 25)
  --run-silent <min>     live-run silence worth inspecting        (default 10)
  --todo-idle <min>      in-progress age the note calls stale     (default 8)
  --review-wait <min>    in_review age the note calls backlogged  (default 15)
  --wake-window <hours>  failed-wakeup history window             (default 3)
  --wake-stale <min>     queued-wakeup wait that reads as stale   (default 30)
  -h, --help             show this help

Exit codes:
  0  nothing needs a human
  1  something needs a human
  2  panel unavailable (usage, psql, connection, query, schema, empty scope)

--todo-idle and --review-wait grade the note only: they do not change whether a
row is flagged. An in-progress card with no run, no wake, no monitor and no
recovery is anomalous at any age, because a healthy fleet always leaves one of
those behind.

Connection string resolution order: --db, PAPERCLIP_FLEET_DATABASE_URL,
DATABASE_URL, then postgres://paperclip:paperclip@localhost:5432/paperclip.

Thresholds can also be set through FLEET_RUNNING_SLOW, FLEET_RUN_SILENT,
FLEET_TODO_IDLE, FLEET_REVIEW_WAIT, FLEET_WAKE_WINDOW_H and FLEET_WAKE_STALE.
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

warn() {
  printf '%s: %s\n' "$PROG" "$*" >&2
}

# The rendering layer sits next to this script. Resolve the directory from
# the invocation, so the panel runs the same way from any working directory.
case "${BASH_SOURCE[0]}" in
  */*) FLEET_DIR=${BASH_SOURCE[0]%/*} ;;
  *)
    # Invoked through PATH: ask the shell where it found the command.
    FLEET_SELF=$(command -v -- "${BASH_SOURCE[0]}" 2>/dev/null) || FLEET_SELF=""
    case "$FLEET_SELF" in
      */*) FLEET_DIR=${FLEET_SELF%/*} ;;
      *) FLEET_DIR=. ;;
    esac
    ;;
esac
. "$FLEET_DIR/fleet-status-render.sh"

# ---------------------------------------------------------------- arguments

# Validates in the current shell: a die inside $(...) would only exit the
# subshell and let the script continue with an empty value.
assert_uint() {
  local name=$1 value=$2
  case "$value" in
    ''|*[!0-9]*) die "$name needs a non-negative integer, got '$value'" ;;
  esac
}

# Applies the environment defaults. This runs before the flags are parsed, so an
# explicit flag always wins over an exported default.
apply_env_defaults() {
  if [ -n "${FLEET_RUNNING_SLOW:-}" ]; then
    assert_uint FLEET_RUNNING_SLOW "$FLEET_RUNNING_SLOW"; RUNNING_SLOW=$FLEET_RUNNING_SLOW
  fi
  if [ -n "${FLEET_RUN_SILENT:-}" ]; then
    assert_uint FLEET_RUN_SILENT "$FLEET_RUN_SILENT"; RUN_SILENT=$FLEET_RUN_SILENT
  fi
  if [ -n "${FLEET_TODO_IDLE:-}" ]; then
    assert_uint FLEET_TODO_IDLE "$FLEET_TODO_IDLE"; TODO_IDLE=$FLEET_TODO_IDLE
  fi
  if [ -n "${FLEET_REVIEW_WAIT:-}" ]; then
    assert_uint FLEET_REVIEW_WAIT "$FLEET_REVIEW_WAIT"; REVIEW_WAIT=$FLEET_REVIEW_WAIT
  fi
  if [ -n "${FLEET_WAKE_WINDOW_H:-}" ]; then
    assert_uint FLEET_WAKE_WINDOW_H "$FLEET_WAKE_WINDOW_H"; WAKE_WINDOW_H=$FLEET_WAKE_WINDOW_H
  fi
  if [ -n "${FLEET_WAKE_STALE:-}" ]; then
    assert_uint FLEET_WAKE_STALE "$FLEET_WAKE_STALE"; WAKE_STALE=$FLEET_WAKE_STALE
  fi
}

parse_args() {
  apply_env_defaults
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) MODE="json"; shift ;;
      --watch|--watch=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--watch needs a number of seconds"
          val=$2; shift
        fi
        assert_uint "--watch" "$val"
        [ "$val" -ge 1 ] || die "--watch needs at least 1 second"
        WATCH=$val; shift ;;
      --company|--company=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--company needs a company name or id"
          val=$2; shift
        fi
        [ -n "$val" ] || die "--company needs a company name or id"
        while [ "${val# }" != "$val" ]; do val=${val# }; done
        while [ "${val% }" != "$val" ]; do val=${val% }; done
        COMPANY=$val; shift ;;
      --db|--db=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--db needs a connection string"
          val=$2; shift
        fi
        [ -n "$val" ] || die "--db needs a connection string"
        DB_DSN=$val; shift ;;
      --running-slow|--running-slow=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--running-slow needs minutes"
          val=$2; shift
        fi
        assert_uint "--running-slow" "$val"; RUNNING_SLOW=$val; shift ;;
      --run-silent|--run-silent=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--run-silent needs minutes"
          val=$2; shift
        fi
        assert_uint "--run-silent" "$val"; RUN_SILENT=$val; shift ;;
      --todo-idle|--todo-idle=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--todo-idle needs minutes"
          val=$2; shift
        fi
        assert_uint "--todo-idle" "$val"; TODO_IDLE=$val; shift ;;
      --review-wait|--review-wait=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--review-wait needs minutes"
          val=$2; shift
        fi
        assert_uint "--review-wait" "$val"; REVIEW_WAIT=$val; shift ;;
      --wake-window|--wake-window=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--wake-window needs hours"
          val=$2; shift
        fi
        assert_uint "--wake-window" "$val"; WAKE_WINDOW_H=$val; shift ;;
      --wake-stale|--wake-stale=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--wake-stale needs minutes"
          val=$2; shift
        fi
        assert_uint "--wake-stale" "$val"; WAKE_STALE=$val; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument '$1' (try --help)" ;;
    esac
  done

  if [ -z "$DB_DSN" ]; then
    DB_DSN="${PAPERCLIP_FLEET_DATABASE_URL:-${DATABASE_URL:-postgres://paperclip:paperclip@localhost:5432/paperclip}}"
  fi

  if [ -n "$WATCH" ] && [ "$MODE" = "json" ]; then
    warn "--json with --watch emits one JSON document per interval, not one stream."
  fi
}

# ---------------------------------------------------------------- transport

# Runs SQL from stdin in a read-only session with a bounded runtime. stdout is
# the data stream; stderr goes to ERR_FILE so a NOTICE can never corrupt rows.
query() {
  SQL_OUT=$(PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=${LOCK_TIMEOUT_MS}" \
    psql "$DB_DSN" -X -q -t -A -F "$FS" -v ON_ERROR_STOP=1 \
      -v company="$COMPANY" \
      -v wake_window_h="$WAKE_WINDOW_H" \
      -v wake_stale="$WAKE_STALE" \
      -f - 2>"$ERR_FILE")
  local rc=$?
  SQL_ERR=$(<"$ERR_FILE")
  return $rc
}

explain_sql_failure() {
  local rc=$1 err=$2
  case "$rc" in
    2) warn "cannot connect to the database (psql exit 2)."
       warn "  check --db / PAPERCLIP_FLEET_DATABASE_URL / DATABASE_URL."
       warn "  note: embedded PostgreSQL (DATABASE_URL unset) has no TCP endpoint,"
       warn "  so this panel needs an external PostgreSQL instance." ;;
    3) warn "the query failed (psql exit 3)." ;;
    *) warn "psql failed (exit $rc)." ;;
  esac
  if [ -n "$err" ]; then
    printf '%s\n' "$err" | sed 's/^/  /' >&2
  fi
  case "$err" in
    *"does not exist"*|*"no such table"*)
      warn "  a missing relation or column means the database schema and this"
      warn "  panel have drifted; update scripts/fleet-status.sh to match." ;;
  esac
}

preflight() {
  command -v psql >/dev/null 2>&1 || die "psql not found in PATH; install the PostgreSQL client."

  query <<'SQL'
SELECT current_setting('default_transaction_read_only'),
       coalesce((
         SELECT string_agg(name, ',' ORDER BY name)
         FROM (VALUES
           ('agents'),
           ('agent_wakeup_requests'),
           ('companies'),
           ('heartbeat_runs'),
           ('issue_recovery_actions'),
           ('issues')
         ) AS required(name)
         WHERE to_regclass(current_schema() || '.' || name) IS NULL
       ), '');
SQL
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    explain_sql_failure "$rc" "$SQL_ERR"
    return 2
  fi

  local ro missing rest
  ro=${SQL_OUT%%"$FS"*}
  rest=${SQL_OUT#*"$FS"}
  missing=${rest%%"$FS"*}
  if [ "$ro" != "on" ]; then
    die "refusing to run: the session is not read-only (default_transaction_read_only=$ro)."
  fi
  if [ -n "$missing" ]; then
    die "missing relation(s): $missing. The database schema and this panel have drifted."
  fi
  return 0
}

# Splits the scope list into the individual company names and builds the
# display string. The list uses the field separator, so a name that holds a "|"
# or any other printable character stays one name.
scope_names_split() {
  local rest=$1 name first=1
  SCOPE_NAME_LIST=()
  SCOPE_NAMES=""
  while [ -n "$rest" ]; do
    case "$rest" in
      *"$FS"*) name=${rest%%"$FS"*}; rest=${rest#*"$FS"} ;;
      *) name=$rest; rest="" ;;
    esac
    SCOPE_NAME_LIST+=("$name")
    if [ "$first" -eq 1 ]; then
      SCOPE_NAMES=$name
      first=0
    else
      SCOPE_NAMES="${SCOPE_NAMES}, ${name}"
    fi
  done
}

# Resolves the company scope in one round trip: how many companies matched,
# their names, and how many terminated agents the scope holds. A scope that
# matches nothing is a configuration problem, not an all-clear.
resolve_scope() {
  query <<'SQL'
WITH scoped AS (
  SELECT id, name, status
  FROM companies
  WHERE :'company' = ''
     OR id::text = :'company'
     OR lower(name) = lower(:'company')
)
SELECT (SELECT count(*) FROM scoped)::text,
       (SELECT count(*) FROM scoped WHERE status = 'archived')::text,
       (SELECT count(*) FROM agents a
        JOIN scoped s ON s.id = a.company_id
        WHERE a.status = 'terminated' AND s.status <> 'archived')::text,
       (SELECT coalesce(string_agg(regexp_replace(name, '[[:cntrl:]]', ' ', 'g'), E'\x1f' ORDER BY name), '') FROM scoped);
SQL
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    explain_sql_failure "$rc" "$SQL_ERR"
    return 2
  fi

  # The names come last, joined with the field separator. A company name may
  # hold any printable character, including "|", so it is never split on a
  # character that a name can contain.
  local count rest archived
  count=${SQL_OUT%%"$FS"*}
  rest=${SQL_OUT#*"$FS"}
  archived=${rest%%"$FS"*}
  rest=${rest#*"$FS"}
  EXCLUDED_TERMINATED=${rest%%"$FS"*}
  rest=${rest#*"$FS"}
  scope_names_split "$rest"

  case "$count" in
    ''|*[!0-9]*) die "unexpected scope answer from the database: '$count'" ;;
  esac
  case "$EXCLUDED_TERMINATED" in
    ''|*[!0-9]*) EXCLUDED_TERMINATED=0 ;;
  esac
  case "$archived" in
    ''|*[!0-9]*) archived=0 ;;
  esac
  if [ "$count" -eq 0 ]; then
    if [ -n "$COMPANY" ]; then
      die "no company matches --company '$COMPANY'."
    fi
    die "no company rows found; check that --db points at the intended instance."
  fi
  if [ "$archived" -eq "$count" ]; then
    die "scope '$SCOPE_NAMES' is archived; the panel excludes archived companies."
  fi
  if [ "$count" -gt 1 ]; then SCOPE_MULTI=1; fi
  return 0
}

# ---------------------------------------------------------------- data

fetch_rows() {
  query <<'SQL'
WITH live_run AS (
  -- The run that best explains what an agent is doing right now: a running run
  -- outranks a queued one, which outranks a scheduled retry.
  SELECT DISTINCT ON (r.agent_id)
         r.agent_id,
         r.status,
         r.issue_id,
         r.created_at,
         r.started_at,
         r.last_output_at,
         (SELECT i.identifier FROM issues i WHERE i.id = r.issue_id) AS card
  FROM heartbeat_runs r
  WHERE r.status IN ('running', 'queued', 'scheduled_retry')
    AND (:'company' = '' OR r.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  ORDER BY r.agent_id,
           CASE r.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
           r.created_at DESC
),
card_stats AS (
  -- Conversation containers, hidden rows and non-execution harness rows are
  -- not work cards, so they are excluded the same way the board excludes them.
  -- The review age skips the card of the live run, so "waiting for a decision"
  -- never reports the age of work that is currently being executed.
  SELECT i.assignee_agent_id AS agent_id,
         count(*) FILTER (WHERE i.status IN ('todo', 'in_progress')) AS active_cards,
         count(*) FILTER (WHERE i.status IN ('todo', 'in_progress')
                            AND i.monitor_next_check_at IS NOT NULL) AS active_monitored,
         count(*) FILTER (WHERE i.status = 'in_review') AS review_cards,
         count(*) FILTER (WHERE i.status IN ('backlog', 'blocked')) AS parked_cards,
         now() - min(i.updated_at) FILTER (WHERE i.status IN ('todo', 'in_progress')) AS oldest_active,
         now() - min(i.updated_at) FILTER (
           WHERE i.status = 'in_review' AND i.id IS DISTINCT FROM lr.issue_id
         ) AS oldest_review
  FROM issues i
  LEFT JOIN live_run lr ON lr.agent_id = i.assignee_agent_id
  WHERE i.status NOT IN ('done', 'cancelled')
    AND i.hidden_at IS NULL
    AND i.harness_kind IS NULL
    AND i.conversation_agent_id IS NULL
    AND (:'company' = '' OR i.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  GROUP BY i.assignee_agent_id
),
pending_wake AS (
  -- No time window: a wakeup that has waited for hours is the interesting case.
  -- "claimed" is deliberately excluded: it records that a run took the wakeup,
  -- and not every completion path advances the row to a terminal status, so
  -- counting it would report permanent backlog.
  SELECT w.agent_id,
         count(*) AS n,
         count(*) FILTER (
           WHERE w.created_at < now() - (:'wake_stale'::int * interval '1 minute')
         ) AS stale_n,
         now() - min(w.created_at) AS oldest
  FROM agent_wakeup_requests w
  WHERE w.status IN ('queued', 'deferred_issue_execution')
    AND (:'company' = '' OR w.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  GROUP BY w.agent_id
),
failed_wake AS (
  -- deferred_issue_execution is a queue state the scheduler resumes, not a
  -- failure, so it is deliberately absent from this bucket.
  SELECT w.agent_id,
         count(*) AS n,
         mode() WITHIN GROUP (
           ORDER BY left(coalesce(nullif(btrim(w.error), ''), w.reason, 'unknown'), 60)
         ) AS detail
  FROM agent_wakeup_requests w
  WHERE w.status = 'failed'
    AND w.created_at > now() - (:'wake_window_h'::int * interval '1 hour')
    AND (:'company' = '' OR w.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  GROUP BY w.agent_id
),
recovery AS (
  SELECT ra.owner_agent_id AS agent_id, count(*) AS n
  FROM issue_recovery_actions ra
  WHERE ra.status IN ('active', 'escalated')
    AND (:'company' = '' OR ra.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  GROUP BY ra.owner_agent_id
)
SELECT
  regexp_replace(c.name, '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(a.name, '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(a.status, '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(coalesce(a.pause_reason, ''), '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(coalesce(lr.status, ''), '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(coalesce(lr.card, ''), '[[:cntrl:]]', ' ', 'g'),
  -- Run age counts from the start of this execution attempt, falling back to
  -- creation time for a run that has not started yet. NULL stays NULL so the
  -- caller can tell "no run" apart from "zero minutes".
  coalesce((extract(epoch FROM now() - coalesce(lr.started_at, lr.created_at)) / 60)::int, -1),
  -- Silence counts from the later of the last output and this attempt's start,
  -- so a restarted attempt never inherits silence from an earlier one.
  coalesce((extract(epoch FROM now()
      - greatest(lr.last_output_at, coalesce(lr.started_at, lr.created_at))) / 60)::int, -1),
  coalesce(cs.active_cards, 0),
  coalesce(cs.active_monitored, 0),
  coalesce(cs.review_cards, 0),
  (SELECT count(*) FROM issues x WHERE x.id = lr.issue_id AND x.status = 'in_review'),
  coalesce(cs.parked_cards, 0),
  coalesce((extract(epoch FROM cs.oldest_active) / 60)::int, -1),
  coalesce((extract(epoch FROM cs.oldest_review) / 60)::int, -1),
  coalesce(fw.n, 0),
  regexp_replace(coalesce(fw.detail, ''), '[[:cntrl:]]', ' ', 'g'),
  coalesce(pw.n, 0),
  coalesce(pw.stale_n, 0),
  coalesce((extract(epoch FROM pw.oldest) / 60)::int, -1),
  coalesce(rc.n, 0)
FROM agents a
JOIN companies c ON c.id = a.company_id
LEFT JOIN live_run lr ON lr.agent_id = a.id
LEFT JOIN card_stats cs ON cs.agent_id = a.id
LEFT JOIN pending_wake pw ON pw.agent_id = a.id
LEFT JOIN failed_wake fw ON fw.agent_id = a.id
LEFT JOIN recovery rc ON rc.agent_id = a.id
WHERE a.status <> 'terminated'
  AND c.status <> 'archived'
  AND (:'company' = '' OR c.id::text = :'company' OR lower(c.name) = lower(:'company'))
ORDER BY c.name, (lr.status IS NOT NULL) DESC, a.name;
SQL
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    explain_sql_failure "$rc" "$SQL_ERR"
    return 2
  fi
  return 0
}

# ---------------------------------------------------------------- classify

# Globals set by classify_row: ROW_STATE, ROW_ATTENTION (space-separated codes),
# ROW_NOTE (one human sentence), ROW_REVIEW_PENDING.
ROW_STATE=""
ROW_ATTENTION=""
ROW_NOTE=""
ROW_REVIEW_PENDING=0

# classify_row reads the 21 fields of one row from its arguments.
#
# The rule this encodes: a state is only called out when the database shows no
# waiting path for it. A live run, a scheduled monitor, a queued wakeup and an
# active recovery action all count as something already moving.
classify_row() {
  local company=$1 name=$2 status=$3 pause_reason=$4
  local run_state=$5 run_card=$6 run_age=$7 run_silent=$8
  local active=$9 monitored=${10} review=${11} review_in_run=${12} parked=${13}
  local oldest_active=${14} oldest_review=${15}
  local failed=${16} failed_detail=${17}
  local pending=${18} stale_pending=${19} oldest_pending=${20} recoveries=${21}

  ROW_ATTENTION=""
  ROW_NOTE=""
  ROW_REVIEW_PENDING=$((review - review_in_run))
  if [ "$ROW_REVIEW_PENDING" -lt 0 ]; then ROW_REVIEW_PENDING=0; fi

  # Cards that nothing is scheduled to pick up. A live run, a fresh queued
  # wakeup or an active recovery covers the whole agent; a monitor only covers
  # the card it is attached to, so it is subtracted per card rather than
  # suppressing the whole row.
  #
  # A queued wakeup only counts as a path while it is fresh. Treating a stale
  # queue as a path would print "waiting to be claimed" and "queued for six
  # hours" about the same wakeup in one row.
  local fresh_pending=$((pending - stale_pending))
  if [ "$fresh_pending" -lt 0 ]; then fresh_pending=0; fi
  local uncovered=0
  if [ "$active" -gt 0 ] && [ "$fresh_pending" -eq 0 ] && [ "$recoveries" -eq 0 ]; then
    uncovered=$((active - monitored))
    if [ "$uncovered" -lt 0 ]; then uncovered=0; fi
  fi

  case "$run_state" in
    running|queued|scheduled_retry)
      if [ "$run_state" = "running" ]; then ROW_STATE="busy"; else ROW_STATE="queued"; fi
      if [ "$run_state" = "running" ]; then
        # The age threshold and the silence threshold are independent. A run can
        # go silent long before it is old, and it must be reported either way.
        local slow=0 silent=0
        if [ "$run_age" -ge "$RUNNING_SLOW" ]; then slow=1; fi
        if [ "$run_silent" -ge "$RUN_SILENT" ]; then silent=1; fi
        if [ "$slow" -eq 1 ]; then
          ROW_ATTENTION="$ROW_ATTENTION long_run"
        fi
        if [ "$silent" -eq 1 ]; then
          ROW_ATTENTION="$ROW_ATTENTION silent_run"
        fi
        if [ "$silent" -eq 1 ]; then
          ROW_NOTE="running ${run_age}m, no new output for ${run_silent}m: check the run log and the artifacts"
        elif [ "$slow" -eq 1 ]; then
          ROW_NOTE="running ${run_age}m: check the progress and the artifacts"
        fi
      elif [ "$run_age" -ge "$WAKE_STALE" ]; then
        ROW_ATTENTION="$ROW_ATTENTION stale_run"
        ROW_NOTE="not running after ${run_age}m: check the wakeups and the concurrency limit"
      fi
      ;;
    *)
      # No live run. Agent-level status decides the branch before work does,
      # otherwise a paused agent is misreported as an idle one.
      case "$status" in
        paused)
          ROW_STATE="paused"
          # Parked cards (backlog or blocked) are unfinished work too. A paused
          # agent that only holds those still needs a human.
          if [ $((active + review + parked)) -gt 0 ]; then
            ROW_ATTENTION="$ROW_ATTENTION paused_with_work"
            ROW_NOTE="paused but still holds ${active} open / ${review} in review / ${parked} parked${pause_reason:+ (reason: ${pause_reason})}: confirm this is intended"
          elif [ -n "$pause_reason" ]; then
            ROW_NOTE="paused (reason: ${pause_reason})"
          fi
          ;;
        error)
          ROW_STATE="error"
          ROW_ATTENTION="$ROW_ATTENTION agent_error"
          ROW_NOTE="agent status is error: check the failure of the last run"
          ;;
        pending_approval)
          ROW_STATE="pending_approval"
          ROW_ATTENTION="$ROW_ATTENTION pending_approval"
          ROW_NOTE="awaiting approval"
          ;;
        *)
          if [ "$uncovered" -gt 0 ]; then
            ROW_STATE="idle_with_work"
            ROW_ATTENTION="$ROW_ATTENTION idle_with_work"
            if [ "$oldest_active" -ge "$TODO_IDLE" ]; then
              ROW_NOTE="${uncovered} open card(s) have no monitor, and no run, usable wakeup or recovery action covers them: the oldest is ${oldest_active}m old"
            else
              ROW_NOTE="${uncovered} open card(s) have no monitor, and no run, usable wakeup or recovery action covers them"
            fi
          elif [ "$active" -gt 0 ]; then
            ROW_STATE="waiting"
            if [ "$monitored" -gt 0 ]; then
              ROW_NOTE="${active} open card(s) have a monitor: waiting for the next check"
            elif [ "$fresh_pending" -gt 0 ]; then
              ROW_NOTE="${active} open card(s) and ${fresh_pending} queued wakeup(s): waiting to be claimed"
            else
              ROW_NOTE="${active} open card(s)"
            fi
          else
            ROW_STATE="free"
          fi
          ;;
      esac
      ;;
  esac

  if [ "$stale_pending" -gt 0 ]; then
    if [ -z "$run_state" ]; then
      # Nothing is running, so nothing can be draining this queue.
      ROW_ATTENTION="$ROW_ATTENTION stale_wake"
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}; }queue: ${stale_pending} wakeup(s) queued longer than ${WAKE_STALE}m (oldest ${oldest_pending}m)"
    else
      # A live run serialises its agent's wakeups, so an old queue entry is not
      # by itself a fault. Report the fact without claiming attention.
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}; }queue: ${stale_pending} more wakeup(s) queued (oldest ${oldest_pending}m); a run is active or queued, so they are not counted as stale"
    fi
  fi

  if [ "$failed" -gt 0 ]; then
    ROW_ATTENTION="$ROW_ATTENTION failed_wake"
    if [ -n "$failed_detail" ]; then
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}; }wake: ${failed} failed wakeup(s) in the last ${WAKE_WINDOW_H}h (${failed_detail})"
    else
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}; }wake: ${failed} failed wakeup(s) in the last ${WAKE_WINDOW_H}h"
    fi
  fi

  if [ "$ROW_REVIEW_PENDING" -gt 0 ]; then
    ROW_ATTENTION="$ROW_ATTENTION review_waiting"
    if [ "$oldest_review" -ge "$REVIEW_WAIT" ]; then
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}; }review: ${ROW_REVIEW_PENDING} card(s) await a decision, the oldest is ${oldest_review}m old"
    else
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}; }review: ${ROW_REVIEW_PENDING} card(s) await a decision"
    fi
  fi

  if [ "$recoveries" -gt 0 ]; then
    ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}; }recovery: ${recoveries} action(s) in progress"
  fi

  # Trim the single leading space left by the append pattern above. A sed here
  # cost more than the rest of the row put together.
  ROW_ATTENTION=${ROW_ATTENTION# }
}

# Applies one classified row to the summary counters.
tally_row() {
  local failed_events=${1:-0} stale_events=${2:-0}
  N_TOTAL=$((N_TOTAL + 1))
  case "$ROW_STATE" in
    busy) N_BUSY=$((N_BUSY + 1)) ;;
    queued) N_QUEUED=$((N_QUEUED + 1)) ;;
    idle_with_work) N_IDLE_WORK=$((N_IDLE_WORK + 1)) ;;
    waiting) N_WAITING=$((N_WAITING + 1)) ;;
    free) N_FREE=$((N_FREE + 1)) ;;
    paused) N_PAUSED=$((N_PAUSED + 1)) ;;
    error) N_ERROR=$((N_ERROR + 1)) ;;
    pending_approval) N_PENDING_APPROVAL=$((N_PENDING_APPROVAL + 1)) ;;
  esac

  local code marked=0
  for code in $ROW_ATTENTION; do
    marked=1
    case "$code" in
      long_run|stale_run) A_LONG_RUNNING=$((A_LONG_RUNNING + 1)) ;;
      silent_run) A_SILENT_RUN=$((A_SILENT_RUN + 1)) ;;
      idle_with_work) A_IDLE_WORK=$((A_IDLE_WORK + 1)) ;;
      paused_with_work) A_PAUSED_WORK=$((A_PAUSED_WORK + 1)) ;;
      agent_error) A_AGENT_ERROR=$((A_AGENT_ERROR + 1)) ;;
      pending_approval) A_PENDING_APPROVAL=$((A_PENDING_APPROVAL + 1)) ;;
      review_waiting) A_REVIEW=$((A_REVIEW + ROW_REVIEW_PENDING)) ;;
      failed_wake)
        A_FAILED_WAKE=$((A_FAILED_WAKE + 1))
        A_FAILED_WAKE_EVENTS=$((A_FAILED_WAKE_EVENTS + failed_events)) ;;
      stale_wake)
        A_STALE_WAKE=$((A_STALE_WAKE + 1))
        A_STALE_WAKE_EVENTS=$((A_STALE_WAKE_EVENTS + stale_events)) ;;
    esac
  done
  if [ "$marked" -eq 1 ]; then A_AGENTS=$((A_AGENTS + 1)); fi

  if [ "$marked" -eq 1 ]; then NEEDS_ATTENTION=1; fi
}

# ---------------------------------------------------------------- rendering
#
# The output layer lives in scripts/fleet-status-render.sh and is sourced
# below. It holds the layout and the JSON escaping only, so that the
# decision rules in this file stay the single source of truth.
# ---------------------------------------------------------------- pipeline

# Splits one transport row into F and rejects a wrong field count instead of
# silently dropping the row.
F=()
split_row() {
  local rest=$1 field n=0
  F=()
  while :; do
    case "$rest" in
      *"$FS"*)
        field=${rest%%"$FS"*}
        rest=${rest#*"$FS"}
        F[$n]=$field
        n=$((n + 1))
        ;;
      *)
        F[$n]=$rest
        n=$((n + 1))
        break
        ;;
    esac
  done
  if [ "$n" -ne "$FIELD_COUNT" ]; then
    die "row has $n fields, expected $FIELD_COUNT; the query and the parser disagree."
  fi
}

reset_counters() {
  N_TOTAL=0; N_BUSY=0; N_QUEUED=0; N_IDLE_WORK=0; N_WAITING=0; N_FREE=0
  N_PAUSED=0; N_ERROR=0; N_PENDING_APPROVAL=0
  A_AGENTS=0; A_LONG_RUNNING=0; A_SILENT_RUN=0; A_IDLE_WORK=0
  A_PAUSED_WORK=0; A_AGENT_ERROR=0; A_PENDING_APPROVAL=0; A_REVIEW=0
  A_FAILED_WAKE=0; A_STALE_WAKE=0; A_FAILED_WAKE_EVENTS=0; A_STALE_WAKE_EVENTS=0
  NEEDS_ATTENTION=0
  # Scope is re-derived every run; leaving it set would keep the company column
  # visible after a --watch run whose scope shrank to one company.
  SCOPE_MULTI=0
}

collect() {
  reset_counters
  resolve_scope || return 2
  fetch_rows || return 2
  ROWS=$SQL_OUT
  # An empty table is only suspicious when nothing explains it. A scope whose
  # agents are all terminated is a real, quiet answer; anything else usually
  # means the wrong database or company, and must not read as all-clear.
  if [ -z "$ROWS" ] && [ "$EXCLUDED_TERMINATED" -eq 0 ]; then
    die "the query returned no agents for scope '$SCOPE_NAMES'; check --db and --company."
  fi
  return 0
}

# Single source of truth for the exit status of one successful run, so the text
# and JSON modes cannot disagree.
decide_exit() {
  if [ "$NEEDS_ATTENTION" -eq 1 ]; then return 1; fi
  return 0
}

run_once() {
  GENERATED_AT=$(date '+%Y-%m-%d %H:%M:%S')
  GENERATED_AT_ISO=$(date '+%Y-%m-%dT%H:%M:%S%z')
  collect || return 2
  if [ "$MODE" = "json" ]; then
    render_json
  else
    render_text
  fi
  decide_exit
}

main() {
  parse_args "$@"

  ERR_FILE=$(mktemp "${TMPDIR:-/tmp}/fleet-status.XXXXXX") || die "cannot create a temporary file"
  trap 'rm -f "$ERR_FILE"' EXIT

  if [ -n "$WATCH" ]; then
    while :; do
      # Only clear a real terminal: the escape sequence would otherwise land in
      # a redirected file once per frame.
      if [ -t 1 ]; then clear 2>/dev/null || true; fi
      # Each attempt runs in a subshell. A failure that ends the shell (a
      # company that was archived, a database that went away) then ends that
      # attempt only, so the watcher reports it and tries again.
      #
      # Exit 1 is a normal "needs attention" render; only 2 means the panel
      # could not answer, and only that is worth a warning between intervals.
      # Exit 141 (128 + SIGPIPE) means the output pipe closed (e.g. piped to
      # head), so the watcher stops instead of keeping the database busy.
      # SIGPIPE is ignored inside the subshell so that a failed write returns
      # an exit code instead of killing the subshell with an unhandled signal.
      ( trap "" PIPE; preflight && run_once )
      rc=$?
      if [ "$rc" -eq 141 ]; then
        break
      fi
      if [ "$rc" -eq 2 ]; then
        warn "panel unavailable; retrying in ${WATCH}s"
      fi
      sleep "$WATCH"
    done
    return 0
  fi

  preflight || return 2
  run_once
  return $?
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
  exit $?
fi
