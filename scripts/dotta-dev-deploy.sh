#!/usr/bin/env bash

set -euo pipefail

readonly LIVE_APP_DIR="/srv/paperclip/app"
readonly LIVE_SERVICE="paperclip.service"
readonly DEFAULT_BACKUP_DIR="/srv/paperclip/home/.paperclip/instances/default/data/backups"
readonly DEFAULT_HEALTH_URL="http://127.0.0.1:3100/api/health"
readonly MANIFEST_GENERATOR="scripts/dotta-dev-train.sh"
readonly TRAIN_BRANCH="dev/dotta"

dry_run=false
manifest_path=".paperclip/dotta-dev-manifest.json"
source_ref="origin/dev/dotta"
app_dir="$LIVE_APP_DIR"
stage_dir=""
backup_dir="$DEFAULT_BACKUP_DIR"
health_url="$DEFAULT_HEALTH_URL"
hot_restart_report="/srv/paperclip/home/.paperclip/instances/default/hot-restart-report.json"
smoke_timeout_seconds=120
app_dir_set=false
stage_dir_set=false
backup_dir_set=false

usage() {
  cat <<'USAGE'
Usage: scripts/dotta-dev-deploy.sh [options]

Build and deploy the Dotta development PR train in this fixed order:
database backup, production build, application swap/restart, smoke check.

Options:
  --manifest PATH              Train manifest (default: .paperclip/dotta-dev-manifest.json)
  --source-ref REF             dev/dotta ref to build (default: origin/dev/dotta)
  --stage-dir PATH             New application staging directory
  --backup-dir PATH            Database backup directory
  --health-url URL             Post-restart health endpoint
  --hot-restart-report PATH    Hot-restart continuity report
  --smoke-timeout-seconds N    Restart smoke timeout (default: 120)
  --dry-run                    Build and swap only in explicit scratch paths; never restart systemd
  --app-dir PATH               Scratch application directory; accepted only with --dry-run
  -h, --help                   Show this help

Authenticated live instances must expose the full health response to the smoke
check. Set PAPERCLIP_API_KEY in the environment; the value is used only as a
bearer header and is never written to disk or printed.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

canonical_path() {
  realpath -m -- "$1"
}

paths_overlap() {
  local first="${1%/}"
  local second="${2%/}"
  [[ "$first" == "$second" || "$first" == "$second/"* || "$second" == "$first/"* ]]
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "required command not found: sha256sum or shasum"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      [[ $# -ge 2 && -n "$2" ]] || die "--manifest requires a path"
      manifest_path="$2"
      shift 2
      ;;
    --source-ref)
      [[ $# -ge 2 && -n "$2" ]] || die "--source-ref requires a ref"
      source_ref="$2"
      shift 2
      ;;
    --stage-dir)
      [[ $# -ge 2 && -n "$2" ]] || die "--stage-dir requires a path"
      stage_dir="$2"
      stage_dir_set=true
      shift 2
      ;;
    --backup-dir)
      [[ $# -ge 2 && -n "$2" ]] || die "--backup-dir requires a path"
      backup_dir="$2"
      backup_dir_set=true
      shift 2
      ;;
    --health-url)
      [[ $# -ge 2 && -n "$2" ]] || die "--health-url requires a URL"
      health_url="$2"
      shift 2
      ;;
    --hot-restart-report)
      [[ $# -ge 2 && -n "$2" ]] || die "--hot-restart-report requires a path"
      hot_restart_report="$2"
      shift 2
      ;;
    --smoke-timeout-seconds)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || die "--smoke-timeout-seconds requires a positive integer"
      smoke_timeout_seconds="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --app-dir)
      [[ $# -ge 2 && -n "$2" ]] || die "--app-dir requires a path"
      app_dir="$2"
      app_dir_set=true
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command find
require_command git
require_command install
require_command jq
require_command mktemp
require_command mv
require_command pnpm
require_command realpath
require_command tar

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this script inside a git worktree"
backup_script="$repo_root/scripts/backup-db.sh"
[[ -x "$backup_script" ]] || die "database backup script is not executable: $backup_script"

if [[ "$source_ref" != "dev/dotta" && "$source_ref" != "origin/dev/dotta" ]]; then
  die "--source-ref must name dev/dotta (local or origin)"
fi
if [[ "$dry_run" == false && "$source_ref" != "origin/dev/dotta" ]]; then
  die "live deploys require --source-ref origin/dev/dotta"
fi

if [[ "$dry_run" == true ]]; then
  [[ "$app_dir_set" == true && "$stage_dir_set" == true && "$backup_dir_set" == true ]] ||
    die "--dry-run requires explicit --app-dir, --stage-dir, and --backup-dir scratch paths"
  [[ "$(canonical_path "$app_dir")" != "$LIVE_APP_DIR" ]] ||
    die "--dry-run refuses to use the live application directory"
elif [[ "$app_dir_set" == true ]]; then
  die "--app-dir is a scratch-only option; live deploys always target $LIVE_APP_DIR"
fi

app_dir="$(canonical_path "$app_dir")"
backup_dir="$(canonical_path "$backup_dir")"
manifest_path="$(canonical_path "$manifest_path")"
hot_restart_report="$(canonical_path "$hot_restart_report")"
if [[ "$stage_dir_set" == true ]]; then
  stage_dir="$(canonical_path "$stage_dir")"
else
  stage_dir="$(dirname "$app_dir")/app-next-dotta-dev-$(date -u +'%Y%m%dT%H%M%SZ')"
fi

[[ "$app_dir" != "/" && "$stage_dir" != "/" && "$backup_dir" != "/" ]] ||
  die "application, stage, and backup paths must not be filesystem root"
if paths_overlap "$app_dir" "$stage_dir" ||
  paths_overlap "$app_dir" "$backup_dir" ||
  paths_overlap "$stage_dir" "$backup_dir"; then
  die "application, stage, and backup paths must be distinct and must not contain each other"
fi

backup_marker=""
app_backup=""
failed_app=""
swapped=false
deploy_succeeded=false

restore_previous_app() {
  [[ "$swapped" == true && -n "$app_backup" && -d "$app_backup" ]] || return 0

  failed_app="$(dirname "$app_dir")/app-failed-dotta-dev-$(date -u +'%Y%m%dT%H%M%SZ')"
  echo "Deploy failed after the swap; restoring $app_backup" >&2
  if [[ -d "$app_dir" ]]; then
    mv -- "$app_dir" "$failed_app"
  fi
  mv -- "$app_backup" "$app_dir"
  swapped=false

  if [[ "$dry_run" == false ]]; then
    systemctl restart "$LIVE_SERVICE" || true
  fi
  echo "Previous application restored. Failed candidate: ${failed_app:-not preserved}" >&2
}

cleanup() {
  local status=$?
  if [[ -n "$backup_marker" && -e "$backup_marker" ]]; then
    rm -f -- "$backup_marker"
  fi
  if [[ $status -ne 0 && "$deploy_succeeded" == false ]]; then
    restore_previous_app
  fi
}
trap cleanup EXIT

# The backup invocation is intentionally the first state-changing operation.
# Every later validation/build failure therefore still leaves a current escape hatch.
echo "[1/4] Backing up the live database"
mkdir -p -- "$backup_dir"
backup_marker="$(mktemp "$backup_dir/.dotta-dev-deploy-start.XXXXXX")"
backup_prefix="dotta-dev-deploy"
"$backup_script" \
  --dir "$backup_dir" \
  --filename-prefix "$backup_prefix" \
  --retention-days 30

fresh_backup=""
while IFS= read -r -d '' candidate; do
  fresh_backup="$candidate"
done < <(
  find "$backup_dir" -maxdepth 1 -type f \
    -name "$backup_prefix-*.sql.gz" -newer "$backup_marker" -size +0c -print0
)
rm -f -- "$backup_marker"
backup_marker=""
[[ -n "$fresh_backup" ]] ||
  die "backup command returned successfully but produced no fresh non-empty $backup_prefix backup"
echo "Fresh database backup: $fresh_backup"

[[ -f "$manifest_path" && ! -L "$manifest_path" ]] || die "manifest is missing or not a regular file: $manifest_path"
if ! jq -e \
  --arg generator "$MANIFEST_GENERATOR" \
  --arg branch "$TRAIN_BRANCH" \
  'type == "object" and
   .schemaVersion == 1 and
   .generatedBy == $generator and
   .branch == $branch and
   (.baseMasterSha | type == "string" and test("^[0-9a-f]{40}$")) and
   (.trainCommitSha | type == "string" and test("^[0-9a-f]{40}$")) and
   (.dryRun | type == "boolean") and
   (.included | type == "array") and
   all(.included[];
     (.number | type == "number" and . > 0 and floor == .) and
     (.headSha | type == "string" and test("^[0-9a-f]{40}$")) and
     (.migrations | type == "boolean"))' \
  "$manifest_path" >/dev/null; then
  die "manifest does not match the $MANIFEST_GENERATOR schema"
fi
if [[ "$dry_run" == false ]] && [[ "$(jq -r '.dryRun' "$manifest_path")" != "false" ]]; then
  die "live deploy requires a non-dry-run train manifest"
fi

manifest_hash="$(sha256_file "$manifest_path")"
[[ "$manifest_hash" =~ ^[0-9a-f]{64}$ ]] || die "could not compute manifest SHA-256"

if [[ "$source_ref" == "origin/dev/dotta" ]]; then
  git -C "$repo_root" fetch --force origin \
    "+refs/heads/dev/dotta:refs/remotes/origin/dev/dotta"
fi
source_commit="$(git -C "$repo_root" rev-parse "$source_ref^{commit}" 2>/dev/null)" ||
  die "source ref is not available: $source_ref"
manifest_train_commit="$(jq -r '.trainCommitSha' "$manifest_path")"
[[ "$manifest_train_commit" == "$source_commit" ]] ||
  die "manifest trainCommitSha does not match $source_ref ($manifest_train_commit != $source_commit)"

base_master_sha="$(jq -r '.baseMasterSha' "$manifest_path")"
git -C "$repo_root" merge-base --is-ancestor "$base_master_sha" "$source_commit" ||
  die "manifest baseMasterSha is not an ancestor of $source_ref"
while IFS= read -r head_sha; do
  git -C "$repo_root" merge-base --is-ancestor "$head_sha" "$source_commit" ||
    die "manifest included head $head_sha is not an ancestor of $source_ref"
done < <(jq -r '.included[].headSha' "$manifest_path")

included_prs="$(jq -r '[.included[].number | tostring] | join("-")' "$manifest_path")"
if [[ -z "$included_prs" ]]; then
  included_prs="none"
fi
build_version="dotta-dev.prs-${included_prs}.manifest-sha256-${manifest_hash}.git-${source_commit:0:12}"

echo "[2/4] Building $source_ref at $source_commit"
[[ ! -e "$stage_dir" && ! -L "$stage_dir" ]] || die "stage path already exists: $stage_dir"
mkdir -p -- "$(dirname "$stage_dir")"
mkdir -- "$stage_dir"
git -C "$repo_root" archive "$source_commit" | tar -x -C "$stage_dir"
install -m 0644 "$manifest_path" "$stage_dir/.paperclip-dotta-dev-manifest.json"
printf '%s\n' "$source_commit" >"$stage_dir/.paperclip-build-commit"
printf '%s\n' "$build_version" >"$stage_dir/.paperclip-build-version"
printf '%s\n' "$fresh_backup" >"$stage_dir/.paperclip-deploy-db-backup"

(
  cd "$stage_dir"
  CI=true NODE_ENV=development pnpm install --frozen-lockfile --force --prod=false
  NODE_ENV=production pnpm build
)
[[ -f "$stage_dir/server/dist/index.js" ]] || die "production build did not create server/dist/index.js"
[[ "$(<"$stage_dir/.paperclip-build-version")" == "$build_version" ]] || die "staged version stamp mismatch"

old_pid=""
if [[ "$dry_run" == false ]]; then
  require_command curl
  require_command systemctl
  [[ "$(systemctl is-active "$LIVE_SERVICE")" == "active" ]] || die "$LIVE_SERVICE is not active"
  old_pid="$(systemctl show "$LIVE_SERVICE" -p MainPID --value)"
  [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] || die "could not resolve the current $LIVE_SERVICE main PID"
fi

echo "[3/4] Swapping the staged application"
[[ -d "$app_dir" ]] || die "current application directory does not exist: $app_dir"
app_backup="$(dirname "$app_dir")/app-prev-dotta-dev-$(date -u +'%Y%m%dT%H%M%SZ')"
[[ ! -e "$app_backup" && ! -L "$app_backup" ]] || die "application backup path already exists: $app_backup"
mv -- "$app_dir" "$app_backup"
swapped=true
mv -- "$stage_dir" "$app_dir"
printf '%s\n' "$app_backup" >"$app_dir/.previous-app-backup-PAP-service-rebuild"

if [[ "$dry_run" == false ]]; then
  # Write the intent only after both moves succeed. A failed swap must not
  # leave the still-running old service with an unconsumed restart marker.
  restart_window_started_epoch="$(date -u +%s)"
  (
    cd "$app_dir"
    pnpm --filter @paperclipai/server exec tsx ../scripts/request-hot-restart.ts --server-pid "$old_pid"
  )
fi

echo "[4/4] Running the post-swap smoke check"
if [[ "$dry_run" == true ]]; then
  [[ -f "$app_dir/server/dist/index.js" ]] || die "scratch smoke could not find server/dist/index.js"
  [[ "$(<"$app_dir/.paperclip-build-version")" == "$build_version" ]] || die "scratch smoke saw the wrong version stamp"
  [[ "$(sha256_file "$app_dir/.paperclip-dotta-dev-manifest.json")" == "$manifest_hash" ]] ||
    die "scratch smoke saw the wrong manifest"
  echo "Scratch smoke passed. No service was restarted."
else
  systemctl restart "$LIVE_SERVICE"

  curl_args=(-fsS --max-time 5 -H "Accept: application/json")
  if [[ -n "${PAPERCLIP_API_KEY:-}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${PAPERCLIP_API_KEY}")
  fi

  deadline=$((SECONDS + smoke_timeout_seconds))
  health_body=""
  new_pid=""
  while (( SECONDS < deadline )); do
    new_pid="$(systemctl show "$LIVE_SERVICE" -p MainPID --value 2>/dev/null || true)"
    if [[ "$(systemctl is-active "$LIVE_SERVICE" 2>/dev/null || true)" == "active" ]] &&
      [[ "$new_pid" =~ ^[1-9][0-9]*$ ]] && [[ "$new_pid" != "$old_pid" ]]; then
      health_body="$(curl "${curl_args[@]}" "$health_url" 2>/dev/null || true)"
      if jq -e --arg version "$build_version" \
        '.status == "ok" and (.serverVersion // .version) == $version' \
        <<<"$health_body" >/dev/null 2>&1; then
        break
      fi
    fi
    sleep 2
  done

  [[ "$new_pid" =~ ^[1-9][0-9]*$ && "$new_pid" != "$old_pid" ]] ||
    die "$LIVE_SERVICE did not start with a new main PID"
  jq -e --arg version "$build_version" \
    '.status == "ok" and (.serverVersion // .version) == $version' \
    <<<"$health_body" >/dev/null ||
    die "health smoke did not report the deployed version (set PAPERCLIP_API_KEY for authenticated mode)"
  jq -e \
    --arg version "$build_version" \
    --argjson oldPid "$old_pid" \
    --argjson newPid "$new_pid" \
    --argjson restartWindowStartedEpoch "$restart_window_started_epoch" \
    'def epoch:
       if type == "string" then sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 else error("not an ISO timestamp") end;
     .version == 1 and
     .previousServerPid == $oldPid and
     .newServerPid == $newPid and
     .newServerVersion == $version and
     (.requestedAt | epoch) >= $restartWindowStartedEpoch and
     (.completedAt | epoch) >= (.requestedAt | epoch) and
     (.lostRunIds | type == "array" and length == 0)' \
    "$hot_restart_report" >/dev/null ||
    die "hot-restart continuity report is missing, stale, or contains lost runs: $hot_restart_report"
  echo "Live smoke passed with main PID $new_pid."
fi

deploy_succeeded=true
echo
echo "Dotta development train deploy complete"
echo "  Source:          $source_ref @ $source_commit"
echo "  Included PRs:    $included_prs"
echo "  Manifest SHA-256: $manifest_hash"
echo "  Version:         $build_version"
echo "  Database backup: $fresh_backup"
echo "  Previous app:    $app_backup"
