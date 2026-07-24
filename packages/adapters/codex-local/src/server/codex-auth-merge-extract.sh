#!/bin/sh

if [ "$#" -ne 2 ]; then
  echo "Usage: codex-auth-merge-extract.sh <asset-dir> <asset-tar>" >&2
  exit 1
fi

asset_dir=$1
asset_tar=$2
auth_name=auth.json
stage_root="$asset_dir.paperclip-extract.$$"
stage_dir="$stage_root/stage"
preserve_dir="$stage_root/preserve"
sandbox_auth="$asset_dir/$auth_name"
host_auth="$stage_dir/$auth_name"
preserve_auth="$preserve_dir/$auth_name"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
decision_script="$script_dir/codex-auth-merge-decision.cjs"

cleanup() {
  rm -rf "$stage_root" "$asset_tar"
}
trap cleanup EXIT HUP INT TERM
rm -rf "$stage_root" &&
mkdir -p "$stage_dir" "$preserve_dir" &&
tar -xf "$asset_tar" -C "$stage_dir" || exit 1

keep_sandbox=0
if [ -f "$sandbox_auth" ]; then
  if command -v node >/dev/null 2>&1; then
    node "$decision_script" "$sandbox_auth" "$host_auth"
    decision_rc=$?
    if [ "$decision_rc" -eq 10 ]; then
      keep_sandbox=1
    else
      keep_sandbox=0
    fi
  else
    echo "[paperclip] node not found in PATH; cannot evaluate auth-merge decision - aborting sandbox restore" >&2
    exit 1
  fi
fi

if [ "$keep_sandbox" -eq 1 ]; then
  if ! ( umask 077 && rm -f "$preserve_auth" && cat "$sandbox_auth" > "$preserve_auth" ); then
    keep_sandbox=0
  fi
fi

rm -rf "$asset_dir" || exit 1
mkdir -p "$asset_dir" || exit 1
find "$stage_dir" -mindepth 1 -maxdepth 1 ! -name "$auth_name" -exec mv -f -- {} "$asset_dir/" \; || exit 1

source_auth="$host_auth"
if [ "$keep_sandbox" -eq 1 ] && [ -f "$preserve_auth" ]; then
  source_auth="$preserve_auth"
fi

if [ -f "$source_auth" ]; then
  target_auth="$asset_dir/$auth_name"
  target_tmp="$asset_dir/.auth.json.paperclip.$$"
  ( umask 077 && rm -f "$target_tmp" && cat "$source_auth" > "$target_tmp" ) || exit 1
  mv -f "$target_tmp" "$target_auth" || exit 1
fi
