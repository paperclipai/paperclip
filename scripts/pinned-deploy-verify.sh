#!/usr/bin/env bash
# plutil lint + port-ownership verifier for pinned deploy/source templates.
# Never installs or reloads launchd. Safe to run anytime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_DIR="${PAPERCLIP_PINNED_DEPLOY_TEMPLATE_DIR:-$REPO_ROOT/docs/launchd}"
HOME_DIR="${PAPERCLIP_PINNED_DEPLOY_HOME:-$HOME}"
RENDER_DIR="${PAPERCLIP_PINNED_DEPLOY_RENDER_DIR:-}"
DEPLOY_PORT="${PAPERCLIP_DEPLOY_PORT:-3100}"
SOURCE_PORT="${PAPERCLIP_SOURCE_PORT:-3101}"
DEPLOY_RUNTIME_PORT=$((DEPLOY_PORT + 10000))
SOURCE_RUNTIME_PORT=$((SOURCE_PORT + 10000))

log() { echo "[pinned-deploy-verify $(date '+%H:%M:%S')] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_cmd plutil
require_cmd lsof

render_template() {
  local src="$1"
  local dest="$2"
  local deploy_root="${PAPERCLIP_DEPLOY_ROOT:-$HOME_DIR/paperclip-deploy}"
  local source_root="${PAPERCLIP_SOURCE_ROOT:-$HOME_DIR/paperclip}"
  local start_script="${PAPERCLIP_DEPLOY_START_SCRIPT:-$deploy_root/scripts/pinned-deploy-start.sh}"
  sed \
    -e "s|__HOME__|$HOME_DIR|g" \
    -e "s|__DEPLOY_ROOT__|$deploy_root|g" \
    -e "s|__SOURCE_ROOT__|$source_root|g" \
    -e "s|__START_SCRIPT__|$start_script|g" \
    "$src" >"$dest"
}

lint_one() {
  local path="$1"
  log "plutil -lint $path"
  plutil -lint "$path" >/dev/null || fail "plutil lint failed: $path"
}

# Port ownership: given expected labels, report who holds deploy/source ports.
# Does not kill anything. Exit 1 if --strict and ownership mismatches expectations.
check_ports() {
  local strict="${1:-0}"
  local issues=0
  report_port() {
    local port="$1"
    local expect="$2"
    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -z "$pids" ]; then
      log "port :$port LISTEN=none (expect=$expect)"
      if [ "$strict" = "1" ] && [ "$expect" != "none" ] && [ "$expect" != "any-or-none" ]; then
        issues=$((issues + 1))
      fi
      return 0
    fi
    local detail
    detail="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 || true)"
    log "port :$port LISTEN pids=$pids"
    [ -n "$detail" ] && log "$detail"
    # Heuristic path match for cwd/command
    local cmd
    cmd="$(ps -o command= -p $(echo "$pids" | tr '\n' ',' | sed 's/,$//') 2>/dev/null || true)"
    log "port :$port commands: $cmd"
    if [ "$strict" = "1" ]; then
      case "$expect" in
        deploy)
          if echo "$cmd" | grep -Eq 'paperclip-deploy|pinned-deploy-start'; then
            :
          else
            log "WARN/STRICT: :$port not clearly deploy-owned"
            issues=$((issues + 1))
          fi
          ;;
        source)
          if echo "$cmd" | grep -Eq 'paperclip[^-]|launchd-start'; then
            :
          else
            log "WARN/STRICT: :$port not clearly source-owned"
            issues=$((issues + 1))
          fi
          ;;
        none)
          issues=$((issues + 1))
          ;;
        any-or-none) ;;
      esac
    fi
  }

  report_port "$DEPLOY_PORT" "deploy"
  report_port "$DEPLOY_RUNTIME_PORT" "deploy"
  report_port "$SOURCE_PORT" "source"
  report_port "$SOURCE_RUNTIME_PORT" "source"

  if [ "$issues" -gt 0 ]; then
    fail "port ownership checks failed ($issues)"
  fi
  log "port ownership check ok (strict=$strict)"
}

cmd="${1:-lint}"
case "$cmd" in
  lint|plutil)
    tmp="${RENDER_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pinned-deploy-plist.XXXXXX")}"
    mkdir -p "$tmp"
    deploy_tpl="$TEMPLATE_DIR/ie.thinkstack.paperclip-deploy.plist.template"
    source_tpl="$TEMPLATE_DIR/ie.thinkstack.paperclip-source-coexist.plist.template"
    [ -f "$deploy_tpl" ] || fail "missing $deploy_tpl"
    [ -f "$source_tpl" ] || fail "missing $source_tpl"
    render_template "$deploy_tpl" "$tmp/ie.thinkstack.paperclip-deploy.plist"
    render_template "$source_tpl" "$tmp/ie.thinkstack.paperclip-source.plist"
    lint_one "$tmp/ie.thinkstack.paperclip-deploy.plist"
    lint_one "$tmp/ie.thinkstack.paperclip-source.plist"
    # Also lint raw templates after stripping XML comments is unnecessary;
    # rendered files are the installable form.
    log "PASS plutil lint (rendered deploy + source coexist templates)"
    if [ -z "${RENDER_DIR:-}" ]; then
      rm -rf "$tmp"
    else
      log "rendered plists kept under $tmp"
    fi
    ;;
  ports)
    shift || true
    strict=0
    [ "${1:-}" = "--strict" ] && strict=1
    check_ports "$strict"
    ;;
  all)
    "$0" lint
    "$0" ports
    ;;
  *)
    cat <<'USAGE' >&2
Usage:
  pinned-deploy-verify.sh lint|plutil
  pinned-deploy-verify.sh ports [--strict]
  pinned-deploy-verify.sh all
USAGE
    exit 2
    ;;
esac
