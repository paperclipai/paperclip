#!/usr/bin/env bash
#
# secret-file-sweeper.sh — detect (and optionally neutralize) group/world-readable
# files that contain agent secret material on a Paperclip host.
#
# Why this exists (NEO-263): agents running during heartbeats sometimes dump their
# injected run-JWT to disk for ad-hoc API debugging — e.g. `printenv > /tmp/env.txt`,
# `echo $PAPERCLIP_API_KEY > /tmp/api_key.txt`, or scratch `server/.env_paperclip`
# files. These land world-readable (umask 022 -> mode 644) and re-leak the secret on
# every fresh dump. The server never writes these (PAPERCLIP_API_KEY is injected in
# the child process env only); the writer is non-deterministic agent behavior, so the
# durable control is a content-based sweeper that runs on a timer rather than a code
# patch. See NEO-261 (secret rotation) — rotation is futile while dumps recur.
#
# Detection is CONTENT-based (not filename-based) so newly-named dumps are still caught:
#   * a PAPERCLIP_* secret assigned to a JWT / non-trivial value
#   * a bare JWT (eyJ<hdr>.<payload>.<sig>)
#   * a 64-hex / 32-byte base64 secrets master key assignment
# ...in any file that is group- or world-readable (mode & 0077 != 0).
#
# Test/library fixtures (node_modules, .git, __tests__, .venv, *.dist-info) are skipped.
#
# Modes:
#   (default)    report findings to stdout; exit 2 if any are found (cron alert hook)
#   --chmod      tighten each finding to 0600 (owner-only) in place
#   --shred      shred -u each finding (irrecoverable); use for /tmp scratch dumps
#   --quarantine move each finding to $QUARANTINE_DIR (mode 600) for forensics
#
# Other flags:
#   --roots "a b c"   override scan roots (default: /tmp, server/, instance dir)
#   --quiet           only emit on findings / errors
#   --json            emit findings as JSON lines
#
# Exit codes: 0 clean, 2 findings, 3 usage/runtime error.

set -uo pipefail

PROG=$(basename "$0")
ACTION="report"
QUIET=0
JSON=0
QUARANTINE_DIR="${PAPERCLIP_SECRET_QUARANTINE_DIR:-/var/lib/paperclip/secret-quarantine}"
ROOTS_OVERRIDE=""

die() { echo "$PROG: $*" >&2; exit 3; }

while [ $# -gt 0 ]; do
  case "$1" in
    --chmod) ACTION="chmod" ;;
    --shred) ACTION="shred" ;;
    --quarantine) ACTION="quarantine" ;;
    --report) ACTION="report" ;;
    --quiet) QUIET=1 ;;
    --json) JSON=1 ;;
    --roots) shift; ROOTS_OVERRIDE="${1:-}" || die "--roots needs an argument" ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

# Resolve default roots: /tmp, the repo server/ dir, and the live instance dir.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
INSTANCE_DIR="${PAPERCLIP_HOME:-${HOME:-/root}/.paperclip}"

if [ -n "$ROOTS_OVERRIDE" ]; then
  # shellcheck disable=SC2206
  ROOTS=($ROOTS_OVERRIDE)
else
  ROOTS=("/tmp" "$REPO_ROOT/server" "$INSTANCE_DIR")
fi

log() { [ "$QUIET" -eq 1 ] || echo "$*"; }

# Content signatures for secret material. Kept in one regex for a single grep pass.
# 1) PAPERCLIP secret assigned a JWT or >=16-char value
# 2) bare JWT token
# 3) secrets master key assignment (64 hex or base64 32-byte)
SECRET_RE='PAPERCLIP_(API_KEY|AGENT_JWT_SECRET|SECRETS_MASTER_KEY|BOARD_TOKEN)[[:space:]]*=[[:space:]]*["'"'"']?(eyJ[A-Za-z0-9_.-]{12,}|[A-Za-z0-9/+_=-]{16,})'
JWT_RE='(^|[^A-Za-z0-9_])eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}'
MASTERKEY_RE='PAPERCLIP_SECRETS_MASTER_KEY[[:space:]]*=[[:space:]]*["'"'"']?([A-Fa-f0-9]{64}|[A-Za-z0-9/+]{43}=)'

EXCLUDE_RE='/node_modules/|/\.git/|/__tests__/|/\.venv/|\.dist-info/|\.test\.[tj]sx?$|\.spec\.[tj]sx?$'

findings=0
errors=0

mask_token() {
  # Echo input with any JWT/secret values masked, for safe logging.
  sed -E 's/(eyJ[A-Za-z0-9_-]{6})[A-Za-z0-9_.-]+/\1…REDACTED/g'
}

handle() {
  local f="$1" mode
  mode=$(stat -c '%a' "$f" 2>/dev/null) || return
  findings=$((findings+1))
  if [ "$JSON" -eq 1 ]; then
    printf '{"file":"%s","mode":"%s","action":"%s"}\n' "$f" "$mode" "$ACTION"
  else
    log "FINDING mode=$mode $f"
  fi
  case "$ACTION" in
    chmod)
      chmod 600 "$f" 2>/dev/null && log "  -> chmod 600" || { log "  -> chmod FAILED"; errors=$((errors+1)); }
      ;;
    shred)
      if command -v shred >/dev/null 2>&1; then shred -u "$f" 2>/dev/null; else rm -f "$f"; fi
      [ -e "$f" ] && { log "  -> shred FAILED"; errors=$((errors+1)); } || log "  -> shredded"
      ;;
    quarantine)
      mkdir -p "$QUARANTINE_DIR" 2>/dev/null && chmod 700 "$QUARANTINE_DIR" 2>/dev/null
      local dest="$QUARANTINE_DIR/$(echo "$f" | tr '/' '_').$(date +%s 2>/dev/null || echo q)"
      if mv "$f" "$dest" 2>/dev/null; then chmod 600 "$dest" 2>/dev/null; log "  -> quarantined to $dest"; else
        log "  -> quarantine FAILED"; errors=$((errors+1)); fi
      ;;
    report) : ;;
  esac
}

for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  log "scanning $root ..."
  # /tmp: agent scratch dumps land at depth 1-2; limit depth to avoid scanning
  # deep repo worktrees that are staged there. Other roots are scanned fully.
  maxdepth_arg=()
  [ "$root" = "/tmp" ] && maxdepth_arg=(-maxdepth 2)
  # Group/world-readable regular files, pruning heavy/irrelevant trees at the find level.
  while IFS= read -r -d '' f; do
    echo "$f" | grep -qE "$EXCLUDE_RE" && continue
    # Fast content gate: single grep over the first 64KB.
    if head -c 65536 "$f" 2>/dev/null | grep -qE "$SECRET_RE|$JWT_RE|$MASTERKEY_RE"; then
      handle "$f"
    fi
  done < <(find "$root" "${maxdepth_arg[@]}" \
              \( -type d \( -name node_modules -o -name .git -o -name .venv \) -prune \) -o \
              \( -type f \( -perm -004 -o -perm -040 \) -print0 \) 2>/dev/null)
done

if [ "$findings" -eq 0 ]; then
  log "clean: no group/world-readable secret-shaped files found"
  exit 0
fi

log "$PROG: $findings secret-shaped file(s) found (action=$ACTION, errors=$errors)"
# Findings are an alert condition even after remediation, so the timer/cron surfaces them.
exit 2
