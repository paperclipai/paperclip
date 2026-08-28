#!/usr/bin/env bash
#
# Installs (or removes) a per-user launchd LaunchAgent that periodically runs
# the disk-retention reaper (scripts/reap-stale-workspaces.mjs) against this
# machine's Paperclip instance(s), plus any existing host-local run-log /
# backup retention scripts it finds via the env vars below.
#
# This intentionally uses launchd, not an OS crontab entry: it is Paperclip's
# own per-user background-maintenance mechanism, so it is inspectable and
# removable with `launchctl` like any other agent, and it never needs root.
#
# Usage:
#   scripts/install-paperclip-retention-agent.sh --install [--interval-seconds N]
#   scripts/install-paperclip-retention-agent.sh --uninstall
#   scripts/install-paperclip-retention-agent.sh --status
#
# Env (all optional):
#   PAPERCLIP_RETENTION_LABEL           launchd label (default: ai.paperclip.disk-retention)
#   PAPERCLIP_RETENTION_INTERVAL_SECS   run interval in seconds (default: 3600)
#   PAPERCLIP_RETENTION_APPLY           "1" to pass --apply (default: "1" — see note below)
#   PAPERCLIP_RETENTION_REMOVE_MERGED_WORKTREES  "1" to also pass --remove-merged-worktrees (default: "0")
#   PAPERCLIP_RETENTION_MAX_LOG_BYTES   bound each of stdout.log/stderr.log to this many bytes,
#                                       keeping one rotated backup (default: 5242880, i.e. 5 MiB)
#   PAPERCLIP_RUN_LOGS_PRUNE_SCRIPT      path to an existing run-log pruning script to also invoke, if any
#   PAPERCLIP_BACKUP_RETENTION_SCRIPT    path to an existing backup retention script to also invoke, if any
#
# Note on PAPERCLIP_RETENTION_APPLY defaulting to "1": the installed agent is
# meant to actually reclaim disk unattended, not just report. Its blast radius
# is bounded by reap-stale-workspaces.mjs's own safety tiers (see
# docs/deploy/disk-retention.md) — node_modules-only by default, full-worktree
# removal only with the separate --remove-merged-worktrees opt-in, which
# itself only fires on git-clean, fully-pushed, merged/closed, inactive
# worktrees. Set PAPERCLIP_RETENTION_APPLY=0 to install in report-only mode
# instead.
#
# Note on PAPERCLIP_RETENTION_MAX_LOG_BYTES: launchd's StandardOutPath/
# StandardErrorPath just append forever with no cap of their own — an
# hourly, indefinitely-running disk-retention agent with an unbounded log of
# its own would eventually recreate the exact problem it exists to fix. The
# generated runner rotates each log in place (copytruncate, not rename) the
# moment it exceeds this size, right before invoking the reaper each run.

set -euo pipefail

LABEL="${PAPERCLIP_RETENTION_LABEL:-ai.paperclip.disk-retention}"
INTERVAL_SECS="${PAPERCLIP_RETENTION_INTERVAL_SECS:-3600}"
APPLY="${PAPERCLIP_RETENTION_APPLY:-1}"
REMOVE_MERGED_WORKTREES="${PAPERCLIP_RETENTION_REMOVE_MERGED_WORKTREES:-0}"
MAX_LOG_BYTES="${PAPERCLIP_RETENTION_MAX_LOG_BYTES:-5242880}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REAPER_SCRIPT="$SCRIPT_DIR/reap-stale-workspaces.mjs"

AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$AGENTS_DIR/$LABEL.plist"
RUNNER_DIR="$HOME/.paperclip/retention-agent"
RUNNER_SCRIPT="$RUNNER_DIR/run.sh"
LOG_DIR="$RUNNER_DIR/logs"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

ACTION=""
for arg in "$@"; do
  case "$arg" in
    --install) ACTION="install" ;;
    --uninstall) ACTION="uninstall" ;;
    --status) ACTION="status" ;;
    --interval-seconds)
      ;; # value consumed below
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [[ "$arg" =~ ^[0-9]+$ ]]; then
        INTERVAL_SECS="$arg"
      fi
      ;;
  esac
done

if [[ -z "$ACTION" ]]; then
  usage
  exit 2
fi

require_macos() {
  # PAPERCLIP_RETENTION_ASSUME_DARWIN lets scripts/__tests__ exercise the
  # file-generation logic below on non-macOS CI runners without pretending
  # OS detection doesn't exist in production use.
  if [[ "${PAPERCLIP_RETENTION_ASSUME_DARWIN:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "error: launchd LaunchAgents are macOS-only. This host is $(uname -s)." >&2
    echo "       There is intentionally no OS-cron fallback in this installer;" >&2
    echo "       run scripts/reap-stale-workspaces.mjs via your own platform's" >&2
    echo "       equivalent user-level scheduler instead." >&2
    exit 1
  fi
}

# PAPERCLIP_RETENTION_SKIP_LAUNCHCTL lets tests verify the plist/runner files
# this script generates without mutating real launchd state (on macOS CI
# runners) or requiring launchctl to exist at all (on Linux CI runners).
launchctl_or_skip() {
  if [[ "${PAPERCLIP_RETENTION_SKIP_LAUNCHCTL:-0}" == "1" ]]; then
    echo "(skipped: launchctl $*)"
    return 0
  fi
  launchctl "$@"
}

write_runner_script() {
  mkdir -p "$RUNNER_DIR" "$LOG_DIR"
  local apply_flag="" remove_flag=""
  [[ "$APPLY" == "1" ]] && apply_flag="--apply"
  [[ "$REMOVE_MERGED_WORKTREES" == "1" ]] && remove_flag="--remove-merged-worktrees"

  # Resolve node's absolute path NOW, while this script runs interactively
  # with the installer's own (full) PATH, and bake it into the runner. A
  # launchd job runs with a minimal PATH (no Homebrew/nvm dirs), so a bare
  # `command -v node` INSIDE the runner reliably finds nothing there — this
  # was caught by actually kickstart-triggering the installed job on a real
  # host, not just by reading the plist. Still allow `command -v node` as a
  # fallback inside the runner, for the (rare) case the baked path goes stale
  # after a node upgrade/uninstall.
  local node_bin_resolved
  node_bin_resolved="$(command -v node || true)"
  if [[ -z "$node_bin_resolved" ]]; then
    echo "ERROR: 'node' not found on PATH — refusing to install a launchd job that would silently fail every run." >&2
    exit 1
  fi

  cat > "$RUNNER_SCRIPT" <<RUNNER
#!/usr/bin/env bash
# Auto-generated by scripts/install-paperclip-retention-agent.sh. Safe to
# regenerate by re-running the installer; do not hand-edit — your changes
# will be overwritten on the next --install.
set -uo pipefail

# Baked in at install time (see write_runner_script); launchd's minimal PATH
# cannot resolve a bare "node" via command -v, so this must be an absolute path.
NODE_BIN="$node_bin_resolved"
if [[ ! -x "\$NODE_BIN" ]]; then
  NODE_BIN="\$(command -v node || echo "$node_bin_resolved")"
fi

# Bound this agent's OWN stdout/stderr logs before doing anything else.
# launchd redirects this process's fd 1/2 into these exact paths, in append
# mode, before this script ever starts — an unbounded log here would be the
# disk-retention agent itself quietly recreating the disk problem it exists
# to fix.
LOG_DIR="$LOG_DIR"
MAX_LOG_BYTES="$MAX_LOG_BYTES"
rotate_log_if_large() {
  local log_file="\$1"
  [[ -f "\$log_file" ]] || return 0
  local size
  size="\$(wc -c < "\$log_file" 2>/dev/null | tr -d '[:space:]')"
  [[ "\$size" =~ ^[0-9]+\$ ]] || return 0
  if (( size > MAX_LOG_BYTES )); then
    # copytruncate, not rename+recreate: launchd already holds an open file
    # descriptor for this exact path (this process's own stdout/stderr), in
    # O_APPEND mode. Renaming the file out from under that fd would silently
    # redirect the REST of this run's own output into the renamed file
    # instead of a fresh one — the fd follows the inode, not the path.
    # Truncating IN PLACE keeps the same inode, so the next append write
    # correctly starts at offset 0 in the (now-empty) live file.
    cp -f "\$log_file" "\$log_file.1" 2>/dev/null || true
    : > "\$log_file"
  fi
}
rotate_log_if_large "\$LOG_DIR/stdout.log"
rotate_log_if_large "\$LOG_DIR/stderr.log"

echo "=== \$(date -u +%FT%TZ) reap-stale-workspaces ==="
"\$NODE_BIN" "$REAPER_SCRIPT" $apply_flag $remove_flag

if [[ -n "\${PAPERCLIP_RUN_LOGS_PRUNE_SCRIPT:-}" && -x "\${PAPERCLIP_RUN_LOGS_PRUNE_SCRIPT:-}" ]]; then
  echo "=== \$(date -u +%FT%TZ) run-logs prune ==="
  "\$PAPERCLIP_RUN_LOGS_PRUNE_SCRIPT"
fi

if [[ -n "\${PAPERCLIP_BACKUP_RETENTION_SCRIPT:-}" && -x "\${PAPERCLIP_BACKUP_RETENTION_SCRIPT:-}" ]]; then
  echo "=== \$(date -u +%FT%TZ) backup retention ==="
  "\$PAPERCLIP_BACKUP_RETENTION_SCRIPT"
fi
RUNNER
  chmod +x "$RUNNER_SCRIPT"
}

write_plist() {
  mkdir -p "$AGENTS_DIR"
  local run_logs_script="${PAPERCLIP_RUN_LOGS_PRUNE_SCRIPT:-}"
  local backup_script="${PAPERCLIP_BACKUP_RETENTION_SCRIPT:-}"
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNNER_SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>
  <key>StartInterval</key>
  <integer>$INTERVAL_SECS</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PAPERCLIP_RUN_LOGS_PRUNE_SCRIPT</key>
    <string>$run_logs_script</string>
    <key>PAPERCLIP_BACKUP_RETENTION_SCRIPT</key>
    <string>$backup_script</string>
  </dict>
</dict>
</plist>
PLIST
}

do_install() {
  require_macos
  write_runner_script
  write_plist

  # Idempotent: unload any existing instance of this label first so
  # re-running --install never errors or duplicates the agent.
  launchctl_or_skip bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl_or_skip bootstrap "gui/$(id -u)" "$PLIST_PATH"
  launchctl_or_skip enable "gui/$(id -u)/$LABEL"

  echo "Installed LaunchAgent '$LABEL' (every ${INTERVAL_SECS}s)."
  echo "  plist:  $PLIST_PATH"
  echo "  runner: $RUNNER_SCRIPT"
  echo "  logs:   $LOG_DIR"
  echo "  apply=$APPLY remove-merged-worktrees=$REMOVE_MERGED_WORKTREES"
}

do_uninstall() {
  require_macos
  launchctl_or_skip bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST_PATH"
  echo "Uninstalled LaunchAgent '$LABEL'."
}

do_status() {
  require_macos
  if [[ "${PAPERCLIP_RETENTION_SKIP_LAUNCHCTL:-0}" == "1" ]]; then
    if [[ -f "$PLIST_PATH" ]]; then
      echo "'$LABEL' plist present at $PLIST_PATH (launchctl skipped)."
    else
      echo "'$LABEL' is not loaded."
    fi
    return 0
  fi
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "'$LABEL' is loaded."
    launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|last exit"
  else
    echo "'$LABEL' is not loaded."
  fi
}

case "$ACTION" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
esac
