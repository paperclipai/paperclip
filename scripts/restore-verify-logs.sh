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
#   log_ref <TAB> created_at <TAB> log_bytes <TAB> log_sha256 <TAB> last_output_bytes
#
#   "${PSQL[@]}" -d paperclip_restored -Atq -F "$(printf '\t')" -c \
#     "select log_ref, created_at, log_bytes, log_sha256, last_output_bytes
#        from heartbeat_runs
#       where log_store = 'local_file' and log_ref is not null" > refs.tsv
#   scripts/restore-verify-logs.sh /paperclip --expect <count(*) of the same rows> < refs.tsv
#
# created_at is echoed next to each missing, mismatching or torn ref — that is
# what tells a source-side gap from a wrong artifact (see below). log_bytes and
# log_sha256 are NULL (empty) for a run the server never finalized: it was in
# flight when the dump was taken, or died before finalize. With the database
# dumped before the tree is tarred (the documented order) every finalized
# run's file is complete in the tar, so a digest mismatch means a wrong
# artifact generation or the reverse ordering, and it always fails.
#
# An unfinalized transcript has no digest, but it has a floor. While a run is
# live the server writes last_output_bytes — the transcript's byte total — to
# the row after the append it counts, so with the dump taken first the
# restored file is at least that long. A file shorter than that was cut by
# the tar, wherever the cut fell, and always fails. Longer is normal: the tar
# ran after the dump and the run kept writing. The floor lags: it is written
# at most once a minute, so output from the last minute before the dump is
# recorded nowhere in the dump and no per-file check can bound it. NULL means
# the run never produced output.
#
# What bounds it is the pairing. A transcript is append-only, so a tar that
# read it after the dump finished holds every byte the run wrote before the
# dump. A tar from an earlier backup run can sit at or past the stale floor,
# end on a line boundary, and still lack events the dump preceded — nothing
# in the file tells the two apart. So the producer writes the dump artifact's
# sha256 to <data-dir>/.backup-generation after the dump is complete, and
# names that marker as the tar's first member:
#
#   sha256sum db-<ts>.sql.gz > "$PAPERCLIP_HOME/.backup-generation"
#   tar -czf paperclip-<ts>.tar.gz -C "$(dirname "$PAPERCLIP_HOME")" \
#     "$(basename "$PAPERCLIP_HOME")/.backup-generation" <kept paths>
#
# --dump-sha256 holds the archive's first member to the dump being restored.
# First matters: the marker is one mutable file, and a tar that walks the
# tree for hours can reach it after a later backup run rewrote it, having
# already read its transcripts before that run's dump. What the tar read
# before any transcript is its first member, so that is the one checked. A
# first member that is not the marker, or names any other dump, fails before
# any ref is checked; so does a restored tree whose marker names another.
# Without --dump-sha256 an unfinalized transcript is unbounded and fails
# unless --allow-unbound is given. Finalized runs need no marker: a
# transcript from another generation does not match their digest.
#
# It also has a shape: the server appends whole NDJSON lines, so an intact
# transcript is empty or ends in a newline. A last byte other than a newline
# is a cut-off event, counted as torn, failing beyond --max-torn.
# Measured on one live deployment: 286 unfinalized transcripts, 285 at or
# past their floor and 1 empty with none, 0 short; 23 torn at the source
# itself (runs interrupted by server restarts weeks earlier).
#
# Check every ref, not a sample. Hashing a gigabyte of transcripts takes
# seconds, and a sample turns the result into a coin toss (see --max-missing).
#
# Usage:
#   restore-verify-logs.sh <data-dir> [--run-logs-dir <dir>] [--max-missing <n>]
#                          [--max-torn <n>] [--expect <n>] [--allow-empty]
#                          [--allow-unverified]
#                          [--dump-sha256 <hex> --archive <file>]
#                          [--allow-unbound]
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
# --max-torn <n>: tolerate up to n unfinalized transcripts that end mid-line.
# Same rule as --max-missing: the count the source is known to have, which you
# get by running this script against the live tree, never whatever makes the
# check pass. A torn transcript beyond that count was torn by the backup — a
# run in flight while the tar read its file — and its last event is lost.
#
# --expect <n>: the number of rows the database reported for the same query
# (select count(*) ...). Fewer or more rows on stdin fails before any file is
# looked at. `docker exec ... | <this script>` has been measured dropping output
# when the reader falls behind — 5942 of 6457 rows arrived, exit 0, nothing on
# stderr — and a short list is checked and passes. Write the rows to a file
# first and pass the count; the runbook and restore-smoke.sh both do.
#
# --dump-sha256 <hex>: the sha256 of the database dump artifact being
# restored (`sha256sum db-<ts>.sql.gz`). <data-dir> must then be the root the
# data-directory archive extracted to, which is where .backup-generation is.
#
# --archive <file>: the data-directory archive <data-dir> was extracted from.
# Required with --dump-sha256; its first member is the marker checked.
#
# --allow-unbound: accept unfinalized transcripts with no generation marker
# checked, and say so on the PASSED line. For artifacts from a producer that
# does not write the marker; it is the old guarantee, stated as such.
#
# --allow-unverified: accept input with no digest columns at all (the
# two-column form) and report presence only. Without it, such input fails, so
# a PASSED line always means content was compared. It does not waive the
# marker: a row with no digest is unfinalized as far as this script knows.
#
# Exits non-zero if more than --max-missing refs are missing (default 0), more
# than --max-torn unfinalized transcripts are torn (default 0), or any ref's
# content differs from its recorded digest, so it gates a script.

usage() {
  echo "usage: $0 <data-dir> [--run-logs-dir <dir>] [--max-missing <n>] [--max-torn <n>] [--expect <n>] [--allow-empty] [--allow-unverified] [--dump-sha256 <hex> --archive <file>] [--allow-unbound]" >&2
  exit 2
}

DATA_DIR=""
RUN_LOGS_DIR=""
MAX_MISSING=0
MAX_TORN=0
EXPECT=""
ALLOW_EMPTY=0
ALLOW_UNVERIFIED=0
DUMP_SHA=""
ARCHIVE=""
ALLOW_UNBOUND=0

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
    --max-torn)
      [ $# -ge 2 ] || usage
      case "$2" in
        ''|*[!0-9]*) echo "--max-torn needs a non-negative integer, got: $2" >&2; usage ;;
      esac
      MAX_TORN="$2"
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
    --dump-sha256)
      [ $# -ge 2 ] || usage
      DUMP_SHA="$(printf '%s' "$2" | tr 'A-F' 'a-f')"
      case "$DUMP_SHA" in
        *[!0-9a-f]*) echo "--dump-sha256 needs a sha256 hex digest, got: $2" >&2; usage ;;
      esac
      [ "${#DUMP_SHA}" -eq 64 ] || { echo "--dump-sha256 needs a sha256 hex digest, got: $2" >&2; usage; }
      shift 2
      ;;
    --archive)
      [ $# -ge 2 ] || usage
      ARCHIVE="$2"
      shift 2
      ;;
    --allow-unbound)
      ALLOW_UNBOUND=1
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

# Tie the tar to the dump before trusting any unfinalized transcript in it.
generation_proven=0
if [ -n "$DUMP_SHA" ]; then
  [ -n "$DATA_DIR" ] || { echo "--dump-sha256 needs <data-dir>, the root the archive extracted to" >&2; usage; }
  [ -n "$ARCHIVE" ] || { echo "--dump-sha256 needs --archive, the data-directory tar: its first member is the marker checked" >&2; usage; }
  [ -f "$ARCHIVE" ] || { echo "FAIL: archive not found: $ARCHIVE" >&2; exit 1; }
  marker="$DATA_DIR/.backup-generation"
  if [ ! -f "$marker" ]; then
    echo "FAIL: no .backup-generation marker in $DATA_DIR; nothing was checked." >&2
    echo "      The producer did not write one, or the archive was extracted" >&2
    echo "      one level off. Nothing ties this tar to the dump being restored." >&2
    exit 1
  fi
  marker_sha=""
  read -r marker_sha _ < "$marker" || true
  marker_sha="$(printf '%s' "$marker_sha" | tr 'A-F' 'a-f')"
  if [ "$marker_sha" != "$DUMP_SHA" ]; then
    echo "FAIL: the data directory was not taken after this dump; nothing was checked." >&2
    echo "      restoring dump $DUMP_SHA" >&2
    echo "      marker names ${marker_sha:-(empty)}" >&2
    echo "      The tar belongs to a different backup run. Restore the tar written" >&2
    echo "      by the same run as the dump." >&2
    exit 1
  fi
  # The tree's marker is the last copy the tar read. The first member is the
  # copy it read before any transcript, and only that one orders the tar
  # after the dump. head closes the listing early; tar's SIGPIPE is fine,
  # an unreadable archive leaves the name empty and fails below.
  first_member="$(set +o pipefail; tar -tzf "$ARCHIVE" 2>/dev/null | head -n 1)"
  # At the root, or under exactly one top-level directory: the level the
  # runbook's --strip-components=1 extracts to <data-dir>.
  if ! [[ "${first_member#./}" =~ ^([^/]+/)?\.backup-generation$ ]]; then
    echo "FAIL: .backup-generation is not the first member of $ARCHIVE; nothing was checked." >&2
    echo "      first member is ${first_member:-(none: unreadable archive)}" >&2
    echo "      Unless the tar reads the marker before any transcript, a backup run" >&2
    echo "      that started later can rewrite it mid-walk, and the tar carries that" >&2
    echo "      run's name over transcripts read before its dump." >&2
    exit 1
  fi
  first_sha="$(set +o pipefail; tar -xzOf "$ARCHIVE" "$first_member" 2>/dev/null | head -n 1)"
  first_sha="${first_sha%% *}"
  first_sha="$(printf '%s' "$first_sha" | tr 'A-F' 'a-f')"
  if [ "$first_sha" != "$DUMP_SHA" ]; then
    echo "FAIL: the data-directory tar was not started after this dump; nothing was checked." >&2
    echo "      restoring dump   $DUMP_SHA" >&2
    echo "      first member names ${first_sha:-(empty)}" >&2
    echo "      The tar started before this dump finished — a different backup run," >&2
    echo "      possibly one still walking the tree when this dump was written." >&2
    echo "      Restore the tar written by the same run as the dump." >&2
    exit 1
  fi
  generation_proven=1
fi

# sha256sum is coreutils on a host and busybox in the alpine helper container
# the runbook uses for named volumes; both print "<hex>  <path>".
command -v sha256sum >/dev/null 2>&1 || { echo "FAIL: sha256sum not found on PATH" >&2; exit 1; }

checked=0
missing=0
mismatch=0
verified=0
unverified=0
floored=0
short=0
unbounded_input=0
presence_only=0
torn=0
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
  # ref is missing". Tabs are turned into '|' before splitting: tab is IFS
  # whitespace, so `read` would merge the empty log_bytes/log_sha256 of an
  # unfinalized row and shift last_output_bytes into log_bytes.
  line="${line//$'\t'/|}"
  seps="${line//[!|]/}"
  IFS='|' read -r ref when want_bytes want_sha floor_bytes _ <<<"$line"
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
    # The server never finalized this run, so the database holds no digest.
    # It does hold a floor: last_output_bytes is written to the row after
    # the append it counts, and the dump precedes the tar, so the restored
    # file is at least that long. Shorter is a cut the tar made, on a line
    # boundary or not.
    if [ "${#seps}" -lt 3 ]; then
      # No digest columns at all: presence-only input, which makes no claim
      # about content and is refused below unless --allow-unverified.
      presence_only=$((presence_only + 1))
    elif [ "${#seps}" -eq 3 ]; then
      # The four-column query: digests selected, the floor not. (Fewer
      # columns is presence-only input, which the digest rule below refuses.)
      unbounded_input=$((unbounded_input + 1))
    elif [ -n "$floor_bytes" ]; then
      case "$floor_bytes" in
        *[!0-9]*)
          short=$((short + 1))
          report "short: $ref  unreadable last_output_bytes: $floor_bytes"
          continue
          ;;
      esac
      have_bytes="$(stat -c '%s' "$path")"
      if [ "$have_bytes" -lt "$floor_bytes" ]; then
        short=$((short + 1))
        report "short: $ref  $have_bytes bytes, database recorded at least $floor_bytes${when:+  (run created $when)}"
        continue
      fi
    fi
    # What can still be established is that the file stops on a line
    # boundary; a last byte other than a newline is a cut-off event.
    if [ -s "$path" ] && [ "$(tail -c 1 "$path" | od -An -tx1 | tr -d ' \n')" != "0a" ]; then
      torn=$((torn + 1))
      report "torn: $ref  unfinalized, ends mid-line${when:+  (run created $when)}"
      continue
    fi
    if [ -n "$floor_bytes" ]; then
      floored=$((floored + 1))
    else
      unverified=$((unverified + 1))
    fi
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

if [ "$short" -gt 0 ]; then
  echo "FAIL: $checked ref(s) checked, $short unfinalized transcript(s) shorter than the output the database recorded." >&2
  echo "      The dump recorded more output for these runs than their restored" >&2
  echo "      files hold, so the tar cut them off. Either the filesystem was" >&2
  echo "      tarred before the database was dumped, or the files are from an" >&2
  echo "      older generation. No tolerance: the source never has any." >&2
  failed=1
fi

if [ "$unbounded_input" -gt 0 ] && [ "$ALLOW_UNVERIFIED" -ne 1 ]; then
  echo "FAIL: $unbounded_input unfinalized ref(s) arrived without a last_output_bytes column." >&2
  echo "      Select it as the fifth column (see the query at the top of this" >&2
  echo "      script). Without it an in-flight transcript the tar cut on a line" >&2
  echo "      boundary passes. Pass --allow-unverified to accept that knowingly." >&2
  failed=1
fi

# Every unfinalized transcript that got this far, torn or not, is only
# known to hold what the dump preceded if the tar is known to follow it.
unbound=0
if [ "$generation_proven" -ne 1 ]; then
  unbound=$((floored + unverified + torn))
fi
if [ "$unbound" -gt 0 ] && [ "$ALLOW_UNBOUND" -ne 1 ]; then
  echo "FAIL: $unbound unfinalized transcript(s) cannot be bounded: nothing proves this" >&2
  echo "      tar was taken after this dump. One from an earlier backup run can be" >&2
  echo "      as long as the database recorded, end on a line boundary, and still" >&2
  echo "      lack events the dump holds. Pass --dump-sha256 <sha256 of the dump>" >&2
  echo "      to check the .backup-generation marker, or --allow-unbound to" >&2
  echo "      accept that knowingly." >&2
  failed=1
fi

if [ "$torn" -gt "$MAX_TORN" ]; then
  echo "FAIL: $checked ref(s) checked, $torn unfinalized transcript(s) end mid-line (tolerance $MAX_TORN)." >&2
  echo "      If the runs above were in flight when the backup ran, the tar cut" >&2
  echo "      their files off while they were being written. If they are old," >&2
  echo "      the source may already hold them torn — run this script against" >&2
  echo "      the live tree, and pass --max-torn <that count> only once you have." >&2
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
if [ "$floored" -gt 0 ]; then
  summary="$summary, $floored unfinalized at or past the length the database recorded"
fi
if [ "$unverified" -gt 0 ]; then
  summary="$summary, $unverified unfinalized ending on a line boundary with no recorded length"
fi
if [ "$torn" -gt 0 ]; then
  summary="$summary, $torn unfinalized torn mid-line (within tolerance $MAX_TORN)"
fi
if [ "$unbound" -gt 0 ]; then
  summary="$summary, $unbound unfinalized NOT bounded (no generation marker checked, --allow-unbound given)"
fi
if [ "$generation_proven" -eq 1 ]; then
  summary="$summary, data directory taken after dump ${DUMP_SHA:0:12}"
fi
if [ "$empty" -gt 0 ]; then
  summary="$summary ($empty zero-byte, which the source also had)"
fi
echo "run-log check PASSED — $summary"
