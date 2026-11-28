#!/usr/bin/env bash
set -euo pipefail

usage() {
  local code="${1:-2}"
  if [ "$code" -eq 0 ]; then help_text; else help_text >&2; fi
  exit "$code"
}

help_text() {
  cat <<'EOF'
restore-verify-logs.sh: open the run-log files that a restored database points
at, and prove that they are the files the database recorded.

Usage:
  restore-verify-logs.sh <data-dir> [--run-logs-dir <dir>] [--max-missing <n>]
                         [--max-torn <n>] [--expect <n>] [--allow-empty]
                         [--allow-unverified]
                         [--dump-sha256 <hex> --archive <file>]
                         [--allow-unbound]

It reads one row per line on stdin, tab-separated (psql's default '|' is also
accepted):

  log_ref <TAB> created_at <TAB> log_bytes <TAB> log_sha256 <TAB> last_output_bytes

  "${PSQL[@]}" -d paperclip_restored -Atq -F "$(printf '\t')" -c \
    "select log_ref, created_at, log_bytes, log_sha256, last_output_bytes
       from heartbeat_runs
      where log_store = 'local_file' and log_ref is not null" > refs.tsv
  restore-verify-logs.sh /paperclip --expect <count(*) of the same rows> < refs.tsv

Every ref is checked, not a sample:

  - A finalized run's file must match the size and SHA-256 the server recorded
    at finalize (log_bytes, log_sha256). A mismatch always fails.
  - An unfinalized run has no digest. Its file must be at least
    last_output_bytes long, and must end on a newline. A shorter file always
    fails. A file that ends mid-line is torn and fails beyond --max-torn.
  - An unfinalized file is only bounded when the data-directory tar is proven
    to follow this dump: see --dump-sha256. Without that proof it fails unless
    --allow-unbound is given.
  - A missing file fails beyond --max-missing. A zero-byte file is a normal
    source state and does not fail.
  - created_at is printed next to each missing, mismatched, short or torn ref.
    The newest runs missing together means the tree was tarred before the
    dump. Old runs can be gaps the source already had.

Options:
  <data-dir>               PAPERCLIP_HOME (the restored data directory) or an
                           instance root. The run-log base is resolved from it
  --run-logs-dir <dir>     the run-log base itself. A data directory with more
                           than one instance needs it
  --max-missing <n>        tolerate up to n missing refs, default 0. Set it to
                           the count the source is known to have, never to
                           whatever makes the check pass. Content mismatches
                           have no tolerance
  --max-torn <n>           tolerate up to n unfinalized transcripts that end
                           mid-line, default 0. Measure the count with this
                           script against the live tree
  --expect <n>             the row count the database reported for the same
                           query. More or fewer rows on stdin fail before any
                           file is checked, because a pipe from `docker exec`
                           can drop rows and exit 0. Write the rows to a file
                           first
  --allow-empty            pass when no refs arrive, for a deployment that
                           keeps run logs in S3
  --allow-unverified       accept input with no digest columns and report
                           presence only. It does not waive the generation
                           marker
  --dump-sha256 <hex>      the sha256 of the dump being restored
                           (`sha256sum db-<ts>.sql.gz`). <data-dir> must be the
                           root the data-directory tar extracted to. The tar's
                           first member must be the .backup-generation marker
                           and name this digest, and so must the extracted
                           marker
  --archive <file>         the data-directory tar <data-dir> came from.
                           Required with --dump-sha256
  --allow-unbound          accept unfinalized transcripts with no generation
                           marker checked, and say so on the PASSED line
  -h, --help               print this help

The producer writes the marker after the dump and puts it first in the tar:

  sha256sum db-<ts>.sql.gz > "$PAPERCLIP_HOME/.backup-generation"
  tar -czf paperclip-<ts>.tar.gz -C "$(dirname "$PAPERCLIP_HOME")" \
    "$(basename "$PAPERCLIP_HOME")/.backup-generation" <kept paths>

Exits non-zero if more refs are missing than --max-missing, more unfinalized
transcripts are torn than --max-torn, any unfinalized transcript is short or
unbounded, or any ref's content differs from its recorded digest.
EOF
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
    -h|--help) usage 0 ;;
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
    RUN_LOGS_DIR="$DATA_DIR/data/run-logs"
  else
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
  first_member="$(set +o pipefail; tar -tzf "$ARCHIVE" 2>/dev/null | head -n 1)"
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

report() {
  if [ "$reported" -lt 20 ]; then
    echo "  $1" >&2
    reported=$((reported + 1))
  elif [ "$reported" -eq 20 ]; then
    echo "  ..." >&2
    reported=$((reported + 1))
  fi
}

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
  line="${line//$'\t'/|}"
  seps="${line//[!|]/}"
  IFS='|' read -r ref when want_bytes want_sha floor_bytes _ <<<"$line"
  case "$ref" in
    ''|/*|*..*)
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
    if [ "${#seps}" -lt 3 ]; then
      presence_only=$((presence_only + 1))
    elif [ "${#seps}" -eq 3 ]; then
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
  echo "      Select it as the fifth column (see --help). Without it an in-flight" >&2
  echo "      transcript the tar cut on a line boundary passes. Pass" >&2
  echo "      --allow-unverified to accept that knowingly." >&2
  failed=1
fi

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
  echo "      (see --help). Presence alone does" >&2
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
