#!/usr/bin/env bash
set -euo pipefail

# restore-verify-logs.sh — open the run-log files a restored database points
# at, and prove they are the files the database recorded.
#
# scripts/restore-verify.sql runs inside the database and can only see the
# database. `heartbeat_runs` rows with `log_store = 'local_file'` carry a
# relative `log_ref`; the NDJSON transcript itself is a file in the data
# directory. So a database-only restore passes every SQL check while every
# transcript is a dangling reference — which is one failure this script
# exists to catch.
#
# The other is tearing. The data-directory tar is taken from a live tree, so
# a transcript a run was still writing is captured mid-line: the file exists,
# a presence check passes, and the run's history cannot be opened intact.
# When the server finalizes a run it records the transcript's exact size and
# SHA-256 on the row (`log_bytes`, `log_sha256`), so the restored file can be
# compared with what the database says it should be. That comparison is the
# cross-artifact check; presence alone is not.
#
# It reads rows on stdin, one per line, tab-separated, so it does not need to
# know how your deployment reaches psql:
#
#   log_ref <TAB> created_at <TAB> log_bytes <TAB> log_sha256
#
#   "${PSQL[@]}" -d paperclip_restored -Atq -F "$(printf '\t')" -c \
#     "select log_ref, created_at, log_bytes, log_sha256 from heartbeat_runs
#       where log_store = 'local_file' and log_ref is not null" > refs.tsv
#   scripts/restore-verify-logs.sh /paperclip --expect <count(*) of the same rows> < refs.tsv
#
# created_at is echoed next to each missing or mismatching ref — that is what
# tells a source-side gap from a wrong artifact (see below). log_bytes and
# log_sha256 are NULL (empty) for a run the server never finalized: it was in
# flight when the dump was taken, or died before finalize. Those refs are
# checked for presence and reported as unverifiable; there is nothing to
# compare them with, and the source itself holds torn files for exactly those
# runs. With the database dumped before the tree is tarred (the documented
# order) every finalized run's file is complete in the tar, so a digest
# mismatch means a wrong artifact generation or the reverse ordering, and it
# always fails.
#
# Check every ref, not a sample. Hashing a gigabyte of transcripts takes
# seconds, and a sample turns the result into a coin toss (see --max-missing).
#
# Usage:
#   restore-verify-logs.sh <data-dir> [--run-logs-dir <dir>] [--max-missing <n>]
#                          [--expect <n>] [--allow-empty] [--allow-unverified]
#
# <data-dir> is PAPERCLIP_HOME (the restored data directory) or an instance
# root; the run-log base is resolved from it. --run-logs-dir names the base
# directly, which is what a multi-instance data directory needs.
#
# --max-missing <n>: tolerate up to n missing refs. A healthy deployment can
# carry a few dangling refs of its own — a run whose transcript was lost at the
# source before any backup was taken — and a faithful restore brings those back
# dangling. Measured on one live deployment: 11 of 6325 refs, all from one
# eight-minute window weeks earlier. Set n to the count the *source* is known to
# have, never to whatever makes the check pass. Missing refs from a wrong
# artifact look different: all of them (archive missing or extracted one level
# off), or a cluster of the newest runs (filesystem tarred before the database
# was dumped, so the files postdate the archive). Content mismatches have no
# tolerance: the source never has any (measured: 0 of 6068 finalized runs).
#
# --expect <n>: the number of rows the database reported for the same query
# (select count(*) ...). Fewer or more rows on stdin fails before any file is
# looked at. `docker exec ... | <this script>` has been measured dropping output
# when the reader falls behind — 5942 of 6457 rows arrived, exit 0, nothing on
# stderr — and a short list is checked and passes. Write the rows to a file
# first and pass the count; the runbook and restore-smoke.sh both do.
#
# --allow-unverified: accept input with no digest columns at all (the
# two-column form) and report presence only. Without it, such input fails, so
# a PASSED line always means content was compared.
#
# Exits non-zero if more than --max-missing refs are missing (default 0) or any
# ref's content differs from its recorded digest, so it gates a script.

usage() {
  echo "usage: $0 <data-dir> [--run-logs-dir <dir>] [--max-missing <n>] [--expect <n>] [--allow-empty] [--allow-unverified]" >&2
  exit 2
}

DATA_DIR=""
RUN_LOGS_DIR=""
MAX_MISSING=0
EXPECT=""
ALLOW_EMPTY=0
ALLOW_UNVERIFIED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --run-logs-dir)
      [ $# -ge 2 ] || usage
      RUN_LOGS_DIR="$2"
      shift 2
      ;;
    --max-missing)
      [ $# -ge 2 ] || usage
      case "$2" in
        ''|*[!0-9]*) echo "--max-missing needs a non-negative integer, got: $2" >&2; usage ;;
      esac
      MAX_MISSING="$2"
      shift 2
      ;;
    --expect)
      [ $# -ge 2 ] || usage
      case "$2" in
        ''|*[!0-9]*) echo "--expect needs a non-negative integer, got: $2" >&2; usage ;;
      esac
      EXPECT="$2"
      shift 2
      ;;
    --allow-empty)
      ALLOW_EMPTY=1
      shift
      ;;
    --allow-unverified)
      ALLOW_UNVERIFIED=1
      shift
      ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *)
      [ -z "$DATA_DIR" ] || usage
      DATA_DIR="$1"
      shift
      ;;
  esac
done

if [ -z "$RUN_LOGS_DIR" ]; then
  [ -n "$DATA_DIR" ] || usage
  [ -d "$DATA_DIR" ] || { echo "FAIL: data directory not found: $DATA_DIR" >&2; exit 1; }

  if [ -d "$DATA_DIR/data/run-logs" ]; then
    # <data-dir> is an instance root.
    RUN_LOGS_DIR="$DATA_DIR/data/run-logs"
  else
    # <data-dir> is PAPERCLIP_HOME: exactly one instance resolves unambiguously,
    # more than one is a choice this script must not make for you.
    candidates=()
    for candidate in "$DATA_DIR"/instances/*/data/run-logs; do
      [ -d "$candidate" ] && candidates+=("$candidate")
    done
    case "${#candidates[@]}" in
      1) RUN_LOGS_DIR="${candidates[0]}" ;;
      0)
        echo "FAIL: no run-log directory under $DATA_DIR" >&2
        echo "      looked for $DATA_DIR/data/run-logs and $DATA_DIR/instances/*/data/run-logs" >&2
        echo "      the data-directory artifact is missing, or was extracted one level off" >&2
        exit 1
        ;;
      *)
        echo "FAIL: $DATA_DIR holds ${#candidates[@]} instances; name one with --run-logs-dir:" >&2
        printf '        %s\n' "${candidates[@]}" >&2
        exit 1
        ;;
    esac
  fi
fi

[ -d "$RUN_LOGS_DIR" ] || { echo "FAIL: run-log directory not found: $RUN_LOGS_DIR" >&2; exit 1; }

# sha256sum is coreutils on a host and busybox in the alpine helper container
# the runbook uses for named volumes; both print "<hex>  <path>".
command -v sha256sum >/dev/null 2>&1 || { echo "FAIL: sha256sum not found on PATH" >&2; exit 1; }

checked=0
missing=0
mismatch=0
verified=0
unverified=0
empty=0
reported=0

# Only missing files and digest mismatches fail. A zero-byte transcript is a
# normal source state — a run that was killed before it wrote its first line
# leaves one, and a faithful restore brings the empty file back empty.
# Measured on a live deployment: 1131 of 9086 transcripts were already zero
# bytes at the source. Failing on those would make this check cry wolf on
# every healthy restore. A zero-byte file whose row carries a digest is
# verified like any other: the digest of the empty string is a real value.
report() {
  # Only the first few, so a wholly missing directory does not print thousands
  # of lines. The count at the end is the number that matters.
  if [ "$reported" -lt 20 ]; then
    echo "  $1" >&2
    reported=$((reported + 1))
  elif [ "$reported" -eq 20 ]; then
    echo "  ..." >&2
    reported=$((reported + 1))
  fi
}

# Read every row before checking any, so the count can be held to --expect
# first: a truncated list must fail as truncated, not pass as shorter.
# Tolerate trailing \r and blank lines: psql -At over `docker compose exec` is
# the documented producer and it is not guaranteed to be clean.
rows=()
while IFS= read -r line; do
  line="${line%$'\r'}"
  [ -n "$line" ] && rows+=("$line")
done
if [ -n "$EXPECT" ] && [ "${#rows[@]}" -ne "$EXPECT" ]; then
  echo "FAIL: ${#rows[@]} row(s) arrived, the database reported $EXPECT." >&2
  echo "      The ref list was cut short (or padded) on its way here; nothing" >&2
  echo "      was checked. Write the query output to a file, then feed the file." >&2
  exit 1
fi

for line in ${rows[@]+"${rows[@]}"}; do
  # Tab is the documented separator (psql -F $'\t'). psql -A without -F
  # separates with '|', and no ref, timestamp, size or digest can contain
  # one, so accept that too rather than turn a forgotten flag into "every
  # ref is missing".
  case "$line" in
    *$'\t'*) IFS=$'\t' read -r ref when want_bytes want_sha _ <<<"$line" ;;
    *) IFS='|' read -r ref when want_bytes want_sha _ <<<"$line" ;;
  esac
  case "$ref" in
    ''|/*|*..*)
      # A ref is relative and stays inside the base. Anything else is a
      # corrupt or hostile row, not a restore result.
      checked=$((checked + 1))
      missing=$((missing + 1))
      report "rejected (not a relative path inside the base): $ref"
      continue
      ;;
  esac
  checked=$((checked + 1))
  path="$RUN_LOGS_DIR/$ref"
  if [ ! -f "$path" ]; then
    missing=$((missing + 1))
    report "missing: $ref${when:+  (run created $when)}"
    continue
  fi
  if [ ! -s "$path" ]; then
    empty=$((empty + 1))
  fi
  if [ -z "$want_sha" ]; then
    # The server never finalized this run, so the database holds nothing to
    # compare against. Presence is all that can be established.
    unverified=$((unverified + 1))
    continue
  fi
  have_bytes="$(stat -c '%s' "$path")"
  if [ -n "$want_bytes" ] && [ "$have_bytes" != "$want_bytes" ]; then
    mismatch=$((mismatch + 1))
    report "mismatch: $ref  size $have_bytes, database recorded $want_bytes${when:+  (run created $when)}"
    continue
  fi
  have_sha="$(sha256sum "$path")"
  have_sha="${have_sha%% *}"
  if [ "$have_sha" != "$want_sha" ]; then
    mismatch=$((mismatch + 1))
    report "mismatch: $ref  sha256 $have_sha, database recorded $want_sha${when:+  (run created $when)}"
    continue
  fi
  verified=$((verified + 1))
done

echo "run-log base: $RUN_LOGS_DIR"

if [ "$checked" -eq 0 ]; then
  if [ "$ALLOW_EMPTY" -eq 1 ]; then
    echo "run-log check SKIPPED — no refs on stdin, --allow-empty given"
    exit 0
  fi
  echo "FAIL: no run-log refs on stdin." >&2
  echo "      Either the query returned nothing — a restored board with run" >&2
  echo "      history should not — or the pipeline into this script broke." >&2
  echo "      Pass --allow-empty only if this deployment keeps run logs in S3." >&2
  exit 1
fi

failed=0

if [ "$mismatch" -gt 0 ]; then
  echo "FAIL: $checked ref(s) checked, $mismatch content mismatch(es)." >&2
  echo "      The file the database points at is not the file the server" >&2
  echo "      finalized. A transcript captured mid-write by the tar, or files" >&2
  echo "      from a different generation than the dump. Run history for" >&2
  echo "      every affected run cannot be opened intact." >&2
  failed=1
fi

if [ "$missing" -gt "$MAX_MISSING" ]; then
  echo "FAIL: $checked ref(s) checked, $missing missing (tolerance $MAX_MISSING)." >&2
  if [ "$missing" -eq "$checked" ]; then
    echo "      Every ref is missing: the data-directory artifact did not come" >&2
    echo "      back, or it was extracted at the wrong level." >&2
  else
    echo "      Some refs are missing. If the runs above are the newest in the" >&2
    echo "      dump, the filesystem was tarred before the database was dumped" >&2
    echo "      and their files postdate the archive. If they are old, the" >&2
    echo "      source may already have lacked them — confirm there, and pass" >&2
    echo "      --max-missing <that count> only once you have." >&2
  fi
  echo "      Run history is unreadable for every affected run." >&2
  failed=1
fi

if [ "$failed" -eq 1 ]; then
  exit 1
fi

if [ "$verified" -eq 0 ] && [ "$ALLOW_UNVERIFIED" -ne 1 ]; then
  echo "FAIL: no ref carried a digest, so no transcript's content was verified." >&2
  echo "      Select log_bytes and log_sha256 as the third and fourth columns" >&2
  echo "      (see the query at the top of this script). Presence alone does" >&2
  echo "      not catch a transcript the tar captured mid-write. Pass" >&2
  echo "      --allow-unverified to accept a presence-only result knowingly." >&2
  exit 1
fi

summary="$checked ref(s) checked"
if [ "$missing" -gt 0 ]; then
  summary="$summary, $missing missing (within tolerance $MAX_MISSING)"
else
  summary="$summary, all present"
fi
if [ "$verified" -gt 0 ]; then
  summary="$summary, $verified verified against the database digest"
else
  summary="$summary, content NOT verified (no digests on stdin, --allow-unverified given)"
fi
if [ "$unverified" -gt 0 ]; then
  summary="$summary, $unverified unverifiable (no digest in the database: run never finalized)"
fi
if [ "$empty" -gt 0 ]; then
  summary="$summary ($empty zero-byte, which the source also had)"
fi
echo "run-log check PASSED — $summary"
