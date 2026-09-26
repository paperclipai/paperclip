#!/usr/bin/env bash
# Persists the canonical Spin skill bundle into the current project.

set +x
set -uo pipefail

unset CLOUDFLARE_API_TOKEN CF_API_TOKEN CLOUDFLARE_API_KEY CF_API_KEY
unset CLOUDFLARE_EMAIL CF_API_EMAIL WIDGET_SECRET TURNSTILE_SECRET
unset WRANGLER_BIN WRANGLER_VERSION
unset GITHUB_TOKEN GH_TOKEN GITLAB_TOKEN NPM_TOKEN

need_arg() {
  if [[ -z "${2-}" || "$2" == --* ]]; then
    echo "persist-skill: missing value for $1" >&2
    exit 2
  fi
}

PATH_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) need_arg "$1" "${2-}"; PATH_ARG="$2"; shift 2 ;;
    *) echo "persist-skill: unknown arg $1" >&2; exit 2 ;;
  esac
done

[[ -n "$PATH_ARG" ]] || { echo "persist-skill: --path required" >&2; exit 2; }
if [[ "$(basename "$PATH_ARG")" != "SKILL.md" ]]; then
  echo "persist-skill: --path must end in SKILL.md for a directory-based skill bundle" >&2
  echo '{"status":"error","reason":"file_target_not_supported"}'
  exit 2
fi

for command_name in git python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "persist-skill: $command_name is required" >&2
    echo "{\"status\":\"error\",\"reason\":\"${command_name}_not_available\"}"
    exit 1
  }
done

PROJECT_ROOT="$(pwd -P)"
TARGET_DIR="$(python3 -I -c 'import os,sys; print(os.path.realpath(os.path.abspath(sys.argv[1])))' "$(dirname "$PATH_ARG")")"
if [[ "$TARGET_DIR" != "$PROJECT_ROOT" && "$TARGET_DIR" != "$PROJECT_ROOT/"* ]]; then
  echo "persist-skill: target must be inside the current project" >&2
  echo '{"status":"error","reason":"target_outside_project"}'
  exit 1
fi
if [[ -e "$TARGET_DIR" ]] && ! python3 -I -c 'import os,sys; raise SystemExit(0 if not os.listdir(sys.argv[1]) else 1)' "$TARGET_DIR"; then
  echo "persist-skill: target directory is not empty" >&2
  echo '{"status":"error","reason":"target_not_empty"}'
  exit 1
fi

if ! TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/turnstile-spin-persist.XXXXXX")"; then
  echo "persist-skill: could not create a temporary directory" >&2
  echo '{"status":"error","reason":"temporary_directory_failed"}'
  exit 1
fi
trap 'rm -rf "$TEMP_DIR"' EXIT

if ! git -c core.hooksPath=/dev/null clone \
  --quiet \
  --depth 1 \
  --filter=blob:none \
  --sparse \
  "https://github.com/cloudflare/skills.git" \
  "$TEMP_DIR/repo"; then
  echo "persist-skill: clone failed" >&2
  echo '{"status":"error","reason":"clone_failed"}'
  exit 1
fi
if ! git -C "$TEMP_DIR/repo" -c core.hooksPath=/dev/null sparse-checkout set skills/turnstile-spin; then
  echo "persist-skill: sparse checkout failed" >&2
  echo '{"status":"error","reason":"sparse_checkout_failed"}'
  exit 1
fi

SOURCE_DIR="$TEMP_DIR/repo/skills/turnstile-spin"
if [[ ! -f "$SOURCE_DIR/SKILL.md" ]]; then
  echo "persist-skill: canonical bundle is missing SKILL.md" >&2
  echo '{"status":"error","reason":"skill_missing"}'
  exit 1
fi

python3 -I - "$SOURCE_DIR" "$TARGET_DIR" <<'PY'
import pathlib
import shutil
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
if target.exists():
    target.rmdir()
target.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(source, target, dirs_exist_ok=False)
for script in (target / "scripts").glob("*.sh"):
    script.chmod(0o755)
PY

python3 -I - "$PATH_ARG" "$TARGET_DIR" <<'PY'
import json
import pathlib
import sys

path_arg, bundle_root = sys.argv[1], pathlib.Path(sys.argv[2])
scripts = sorted(path.name for path in (bundle_root / "scripts").glob("*.sh"))
print(json.dumps({
    "status": "ok",
    "path": path_arg,
    "bundle_root": str(bundle_root),
    "scripts": scripts,
}))
PY
