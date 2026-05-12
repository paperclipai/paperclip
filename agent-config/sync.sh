#!/usr/bin/env bash
# Sync agent instruction files from this fork into live Paperclip agent dirs.
#
# Paperclip's `instructionsBundleMode: "managed"` reads instructions from a
# local directory tree under each company/agent. There is no native git-backed
# source. This script bridges the gap:
#
#   agent-config/companies/{companyId}/agents/{agentId}/instructions/*.md
#       --copies-into-->
#   {paperclipRoot}/companies/{companyId}/agents/{agentId}/instructions/
#
# Usage:
#   ./agent-config/sync.sh [--pull] [--dry-run] [--mirror] [--root PATH]
#
# --pull     Run `git pull --ff-only` before syncing.
# --dry-run  Show what would change without writing.
# --mirror   Delete files in target that are absent from agent-config.
# --root     Paperclip instance root containing `companies/`. Defaults to
#            $PAPERCLIP_INSTANCE_ROOT, then $HOME/.paperclip/instances/default.

set -euo pipefail

PULL=0
DRY_RUN=0
MIRROR=0
PAPERCLIP_ROOT="${PAPERCLIP_INSTANCE_ROOT:-$HOME/.paperclip/instances/default}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull) PULL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --mirror) MIRROR=1; shift ;;
    --root) PAPERCLIP_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_ROOT="$SCRIPT_DIR/companies"
MANIFEST="$SCRIPT_DIR/manifest.json"

[[ -d "$CONFIG_ROOT" ]] || { echo "Config root not found: $CONFIG_ROOT" >&2; exit 1; }
[[ -f "$MANIFEST" ]]    || { echo "Manifest not found: $MANIFEST" >&2; exit 1; }
[[ -d "$PAPERCLIP_ROOT" ]] || { echo "Paperclip root not found: $PAPERCLIP_ROOT" >&2; exit 1; }

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

if [[ "$PULL" == "1" ]]; then
  echo "==> git pull --ff-only origin master"
  git -C "$FORK_ROOT" pull --ff-only origin master
fi

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

mapfile -t companies < <(jq -r '.companies[].id' "$MANIFEST")
for company_id in "${companies[@]}"; do
  company_name=$(jq -r --arg id "$company_id" '.companies[] | select(.id==$id) | .name' "$MANIFEST")
  echo "==> Company: $company_name [$company_id]"
  mapfile -t agents < <(jq -r --arg cid "$company_id" '.companies[] | select(.id==$cid) | .agents[].id' "$MANIFEST")
  for agent_id in "${agents[@]}"; do
    agent_name=$(jq -r --arg cid "$company_id" --arg aid "$agent_id" \
      '.companies[] | select(.id==$cid) | .agents[] | select(.id==$aid) | .name' "$MANIFEST")
    src="$CONFIG_ROOT/$company_id/agents/$agent_id/instructions"
    dst="$PAPERCLIP_ROOT/companies/$company_id/agents/$agent_id/instructions"
    if [[ ! -d "$src" ]]; then
      echo "  ! $agent_name: source missing ($src); skipping" >&2
      continue
    fi
    if [[ ! -d "$dst" ]]; then
      if [[ "$DRY_RUN" == "1" ]]; then echo "  + CREATE $dst"
      else mkdir -p "$dst"
      fi
    fi
    new=0; updated=0; unchanged=0; removed=0
    src_names=()
    for f in "$src"/*.md; do
      [[ -e "$f" ]] || continue
      name="$(basename "$f")"
      src_names+=("$name")
      target="$dst/$name"
      needs_copy=1
      if [[ -f "$target" ]]; then
        if [[ "$(hash_file "$f")" == "$(hash_file "$target")" ]]; then
          needs_copy=0; unchanged=$((unchanged+1))
        fi
      fi
      if [[ "$needs_copy" == "1" ]]; then
        if [[ -f "$target" ]]; then updated=$((updated+1)); else new=$((new+1)); fi
        if [[ "$DRY_RUN" == "1" ]]; then echo "    ~ $name"
        else cp "$f" "$target"
        fi
      fi
    done
    if [[ "$MIRROR" == "1" && -d "$dst" ]]; then
      for f in "$dst"/*.md; do
        [[ -e "$f" ]] || continue
        name="$(basename "$f")"
        keep=0
        for k in "${src_names[@]}"; do [[ "$k" == "$name" ]] && { keep=1; break; }; done
        if [[ "$keep" == "0" ]]; then
          removed=$((removed+1))
          if [[ "$DRY_RUN" == "1" ]]; then echo "    - DELETE $name"
          else rm -f "$f"
          fi
        fi
      done
    fi
    printf "  %-20s new=%d updated=%d unchanged=%d removed=%d\n" "$agent_name" "$new" "$updated" "$unchanged" "$removed"
  done
done
