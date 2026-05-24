#!/usr/bin/env bash
# Designer pod entrypoint.
#
# Responsibilities (in order):
#   1. Materialize the Chrome profile dir if a bootstrap exists at
#      $DESIGNER_PROFILE_BOOTSTRAP (a tar.gz mounted from a Secret or
#      seeded by an initContainer).
#   2. Launch Xvfb + Chrome via designer-chrome-pod.sh.
#   3. Link the designer-loop skill into the agent's $HOME/.claude/skills/.
#   4. Exec the caller's CMD (the actual agent process) so Chrome is its
#      sibling, not its child. Kubernetes restarts the pod on agent exit.
#
# Signals: tini (PID 1) forwards SIGTERM to this script; we kill Chrome +
# Xvfb on the way out so PVCs get a clean profile flush.

set -euo pipefail

PROFILE="${DESIGNER_CHROME_PROFILE:-/data/chrome-designer-profile}"
BOOTSTRAP="${DESIGNER_PROFILE_BOOTSTRAP:-}"
PID_DIR="${DESIGNER_PID_DIR:-/run/designer}"

log() { echo "[designer-entrypoint] $*"; }

# Step 1: profile bootstrap. If $PROFILE is empty AND a bootstrap tarball is
# present, extract it. Idempotent — skips if the profile already has content.
if [ -n "$BOOTSTRAP" ] && [ -f "$BOOTSTRAP" ]; then
    if [ ! -d "$PROFILE" ] || [ -z "$(ls -A "$PROFILE" 2>/dev/null)" ]; then
        log "Seeding profile from $BOOTSTRAP -> $PROFILE"
        mkdir -p "$PROFILE"
        tar -xzf "$BOOTSTRAP" -C "$PROFILE"
    else
        log "Profile $PROFILE already populated; bootstrap skipped"
    fi
fi

if [ ! -d "$PROFILE" ]; then
    log "ERROR: profile dir missing at $PROFILE and no bootstrap to seed from"
    log "       Mount a PVC at $PROFILE or set DESIGNER_PROFILE_BOOTSTRAP to a tar.gz path"
    exit 1
fi

# Step 2: launch Chrome (which launches Xvfb if not already up).
designer-chrome-pod

# Step 3: link the system-staged designer-loop skill into the agent's HOME
# so Claude Code (or paperclip-agent) discovers it at session start.
SKILL_DEST="${HOME:-/root}/.claude/skills/designer-loop"
SKILL_SRC="/opt/claude-skills/designer-loop"
if [ -d "$SKILL_SRC" ] && [ ! -e "$SKILL_DEST" ]; then
    mkdir -p "$(dirname "$SKILL_DEST")"
    ln -s "$SKILL_SRC" "$SKILL_DEST"
    log "Linked designer-loop skill -> $SKILL_DEST"
fi

# Step 4: trap signals to teardown Chrome + Xvfb cleanly.
on_exit() {
    log "Shutting down. Killing Chrome + Xvfb."
    for f in chrome xvfb; do
        if [ -f "$PID_DIR/$f.pid" ]; then
            kill -TERM "$(cat "$PID_DIR/$f.pid")" 2>/dev/null || true
        fi
    done
}
trap on_exit EXIT INT TERM

# Step 5: exec the agent (or whatever CMD was passed).
if [ "$#" -gt 0 ]; then
    log "Exec: $*"
    exec "$@"
else
    log "No agent command provided; sleeping. (Override CMD or pass argv.)"
    exec sleep infinity
fi
