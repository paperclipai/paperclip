#!/usr/bin/env bash
# Install this skill into a user-level skill home:
#
#   ./install.sh --dsh                    ~/.dsh/skills/switch-agent-models
#   ./install.sh --agents                 ~/.agents/skills/switch-agent-models
#   ./install.sh --claude                 ~/.claude/skills/switch-agent-models
#   ./install.sh --codex                  ~/.codex/skills/switch-agent-models
#   ./install.sh --kimi                   ~/.kimi-code/skills/switch-agent-models
#   ./install.sh --dir PATH               any directory that holds skills
#   ./install.sh --all                    every home that already exists
#
# Options: --canonical DIR (one real copy, other homes link to it),
#          --force, --dry-run, --uninstall (needs --force).
set -euo pipefail

SLUG="switch-agent-models"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=0
DRY=0
UNINSTALL=0
CANON=""
TARGETS=()

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

absolute_dir() {
  python3 -c 'import os, sys; print(os.path.realpath(os.path.abspath(sys.argv[1])))' "$1"
}

add_home() {
  TARGETS+=("$(absolute_dir "$1")/$SLUG")
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh) add_home "${DSH_SKILLS_DIR:-$HOME/.dsh/skills}" ;;
    --agents) add_home "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}" ;;
    --claude) add_home "${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}" ;;
    --codex) add_home "${CODEX_SKILLS_DIR:-$HOME/.codex/skills}" ;;
    --kimi) add_home "${KIMI_SKILLS_DIR:-$HOME/.kimi-code/skills}" ;;
    --dir) shift; [ $# -gt 0 ] || usage; add_home "$1" ;;
    --canonical) shift; [ $# -gt 0 ] || usage; CANON="$(absolute_dir "$1")/$SLUG" ;;
    --all)
      candidates=(
        "${DSH_SKILLS_DIR:-$HOME/.dsh/skills}"
        "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
        "${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
        "${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"
        "${KIMI_SKILLS_DIR:-$HOME/.kimi-code/skills}"
      )
      for candidate in "${candidates[@]}"; do
        [ -d "$candidate" ] && add_home "$candidate"
      done
      ;;
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
  shift
done

if [ ${#TARGETS[@]} -eq 0 ] && [ -z "$CANON" ]; then
  echo "nothing selected; pass --dsh, --agents, --claude, --codex, --kimi, --dir PATH, or --all" >&2
  usage
fi

python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null || {
  echo "this skill needs python3 (3.9 or newer) on PATH" >&2
  exit 1
}

# Refuse overlapping paths before touching any destination. Do not follow the
# final symlink: replacing or uninstalling a link must not remove its target.
python3 - "$SRC" ${CANON:+"$CANON"} ${TARGETS[@]+"${TARGETS[@]}"} <<'PY' || exit 1
import os, sys
src = os.path.realpath(sys.argv[1])
paths = list(dict.fromkeys(sys.argv[2:]))
def overlaps(a, b):
    return os.path.commonpath((a, b)) in (a, b)
for dest in paths:
    if overlaps(src, dest):
        sys.exit(f"unsafe destination overlaps source: {dest}")
for i, dest in enumerate(paths):
    for other in paths[i + 1:]:
        if overlaps(dest, other):
            sys.exit(f"overlapping destinations: {dest} and {other}")
PY

same_copy() {
  [ -d "$1" ] && [ ! -L "$1" ] && diff -rq "$SRC" "$1" >/dev/null 2>&1
}

install_physical() {
  local dest="$1"
  if [ "$DRY" = 1 ]; then echo "would install to $dest"; return 0; fi
  local stage
  mkdir -p -- "$(dirname "$dest")" || { echo "cannot create parent of $dest" >&2; return 1; }
  stage="$(mktemp -d "$(dirname "$dest")/.${SLUG}.XXXXXX")" || { echo "cannot stage $dest" >&2; return 1; }
  if ! cp -R "$SRC"/. "$stage"/ || ! rm -rf -- "$stage/scripts/__pycache__"; then
    echo "cannot stage copy for $dest" >&2
    rm -rf -- "$stage" || echo "cannot clean up $stage" >&2
    return 1
  fi
  chmod +x "$stage/scripts/switch_models.py" "$stage/install.sh" 2>/dev/null || true
  if [ -L "$dest" ] || [ -d "$dest" ]; then
    if ! rm -rf -- "$dest"; then
      echo "cannot remove $dest" >&2
      rm -rf -- "$stage" || echo "cannot clean up $stage" >&2
      return 1
    fi
  fi
  if ! mv -- "$stage" "$dest"; then
    echo "cannot install to $dest" >&2
    rm -rf -- "$stage" || echo "cannot clean up $stage" >&2
    return 1
  fi
  echo "installed: $dest"
}

link_copy() {
  local dest="$1" target="$2"
  if [ "$DRY" = 1 ]; then echo "would link $dest -> $target"; return 0; fi
  mkdir -p -- "$(dirname "$dest")" || { echo "cannot create $(dirname "$dest")" >&2; return 1; }
  ln -s -- "$target" "$dest" || { echo "cannot link $dest -> $target" >&2; return 1; }
  echo "linked: $dest -> $target"
}

remove_one() {
  local dest="$1"
  if [ -L "$dest" ] || [ -d "$dest" ]; then
    [ "$DRY" = 1 ] && { echo "would remove $dest"; return 0; }
    rm -rf -- "$dest" || { echo "cannot remove $dest" >&2; return 1; }
    echo "removed $dest"
  else
    echo "not installed: $dest"
  fi
  return 0
}

handle() {
  local dest="$1"

  if [ "$UNINSTALL" = 1 ]; then
    [ "$FORCE" = 1 ] || { echo "refusing to remove $dest without --force" >&2; return 1; }
    remove_one "$dest"
    return $?
  fi

  local want_link=""
  if [ -n "$CANON" ] && [ "$dest" != "$CANON" ]; then
    want_link="$CANON"
  fi

  if [ -L "$dest" ]; then
    if [ -n "$want_link" ] && [ "$(readlink "$dest")" = "$want_link" ]; then
      echo "up to date: $dest -> $want_link"
      return 0
    fi
    [ "$FORCE" = 1 ] || { echo "already a link elsewhere: $dest (pass --force to replace)" >&2; return 1; }
  elif [ -d "$dest" ]; then
    if [ -z "$want_link" ] && same_copy "$dest"; then
      echo "up to date: $dest"
      return 0
    fi
    [ "$FORCE" = 1 ] || { echo "already installed and different: $dest (pass --force to replace)" >&2; return 1; }
  elif [ -e "$dest" ]; then
    echo "destination is not a directory or link: $dest" >&2
    return 1
  fi

  if [ -n "$want_link" ]; then
    if [ "$DRY" != 1 ] && { [ -L "$dest" ] || [ -d "$dest" ]; }; then
      rm -rf -- "$dest" || { echo "cannot remove $dest" >&2; return 1; }
    fi
    link_copy "$dest" "$want_link"
  else
    install_physical "$dest"
  fi
}

failed=0
if [ -n "$CANON" ]; then
  if ! handle "$CANON"; then
    echo "canonical install failed; no other target was changed" >&2
    exit 1
  fi
fi
for dest in "${TARGETS[@]+"${TARGETS[@]}"}"; do
  [ "$dest" = "$CANON" ] && continue
  handle "$dest" || failed=1
done

if [ "$failed" != 0 ]; then
  echo "one or more targets were not installed" >&2
  exit 1
fi

if [ "$UNINSTALL" != 1 ] && [ ${#TARGETS[@]} -gt 0 ]; then
  echo
  echo "Start a new agent session so it discovers the skill, then try:"
  echo "  python3 ${TARGETS[0]}/scripts/switch_models.py --help"
fi
