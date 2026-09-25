#!/usr/bin/env bash
set -euo pipefail

# restore-verify-logs.sh — open the run-log files a restored database points at.
#
# scripts/restore-verify.sql runs inside the database and can only see the
# database. `heartbeat_runs` rows with `log_store = 'local_file'` carry a
# relative `log_ref`; the NDJSON transcript itself is a file in the data
# directory. So a database-only restore passes every SQL check while every
# transcript is a dangling reference — which is exactly the failure this script
# exists to catch.
#
# It reads refs on stdin, one per line, so it does not need to know how your
# deployment reaches psql. Send the run's creation time as a second,
# tab-separated column and it is echoed next to each missing ref — that is what
# tells a source-side gap from a wrong artifact (see below):
#
#   "${PSQL[@]}" -d paperclip_restored -Atqc \
#     "select log_ref || E'\t' || created_at from heartbeat_runs
#       where log_store = 'local_file' and log_ref is not null" \
#   | scripts/restore-verify-logs.sh /paperclip
#
# Check every ref, not a sample. Six thousand stat() calls take seconds, and a
# sample turns the result into a coin toss (see --max-missing).
#
# Usage:
#   restore-verify-logs.sh <data-dir> [--run-logs-dir <dir>] [--max-missing <n>] [--allow-empty]
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
# was dumped, so the files postdate the archive).
#
# Exits non-zero if more than --max-missing refs are missing (default 0), so it
# gates a script.

usage() {
  echo "usage: $0 <data-dir> [--run-logs-dir <dir>] [--max-missing <n>] [--allow-empty]" >&2
  exit 2
}

DATA_DIR=""
RUN_LOGS_DIR=""
MAX_MISSING=0
ALLOW_EMPTY=0

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
    --allow-empty)
      ALLOW_EMPTY=1
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

checked=0
missing=0
empty=0
reported=0

# Only missing files fail. A zero-byte transcript is a normal source state —
# a run that was killed before it wrote its first line leaves one, and a
# faithful restore brings the empty file back empty. Measured on a live
# deployment: 1131 of 9086 transcripts were already zero bytes at the source.
# Failing on those would make this check cry wolf on every healthy restore.
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

while IFS= read -r line; do
  # Tolerate trailing \r and blank lines: psql -At over `docker compose exec`
  # is the documented producer and it is not guaranteed to be clean.
  line="${line%$'\r'}"
  [ -n "$line" ] || continue
  ref="${line%%$'\t'*}"
  when=""
  [ "$ref" = "$line" ] || when="${line#*$'\t'}"
  case "$ref" in
    /*|*..*)
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
  elif [ ! -s "$path" ]; then
    empty=$((empty + 1))
  fi
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
  exit 1
fi

summary="$checked ref(s) checked"
if [ "$missing" -gt 0 ]; then
  summary="$summary, $missing missing (within tolerance $MAX_MISSING)"
else
  summary="$summary, all present"
fi
if [ "$empty" -gt 0 ]; then
  summary="$summary ($empty zero-byte, which the source also had)"
fi
echo "run-log check PASSED — $summary"
