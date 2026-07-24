#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  publish.sh <dir> [--slug slug] [--update] [--dry-run]

Publishes a static directory with a root index.html to the configured Paperclip
pages bucket and prints the public URL and S3 prefix.

Required environment for live publish:
  PAPERCLIP_PAGE_BUCKET, PAPERCLIP_PAGE_BASE_URL, AWS_REGION, AWS credentials

Optional environment:
  PAPERCLIP_PAGE_DEFAULT_PREFIX, PAPERCLIP_PAGE_AWS_PROFILE

Options:
  --slug SLUG   Lowercase URL slug. Allowed: a-z, 0-9, hyphen.
  --update      Additively overwrite an owned existing prefix. Never deletes.
  --dry-run     Validate and print the planned target without AWS writes.
  --help, -h    Show this help.
EOF
}

die() {
  printf 'paperclip-page: %s\n' "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "missing required command: $1"
  fi
}

normalize_base_url() {
  local value="$1"
  value="${value%/}"
  [[ "$value" == https://* ]] || die "PAPERCLIP_PAGE_BASE_URL must be an https URL"
  [[ ! "$value" =~ [[:space:]] ]] || die "PAPERCLIP_PAGE_BASE_URL cannot contain whitespace"
  printf '%s\n' "$value"
}

validate_segment() {
  local value="$1"
  local label="$2"

  [[ -n "$value" ]] || die "$label cannot be empty"
  [[ "${#value}" -le 64 ]] || die "$label is too long; max length is 64 characters"
  [[ "$value" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "$label must use lowercase letters, digits, and hyphens only"
  [[ "$value" != "." && "$value" != ".." ]] || die "$label cannot be a dot segment"
}

normalize_slug() {
  local value="$1"

  value="${value#/}"
  value="${value%/}"
  [[ "$value" != *"/"* ]] || die "slug must be one path segment, not a nested path"
  validate_segment "$value" "slug"
  case "$value" in
    404|404-html|index|index-html|root|assets)
      die "slug '$value' is reserved"
      ;;
  esac
  printf '%s\n' "$value"
}

derive_slug() {
  local source_dir="$1"
  local base

  base="$(basename "$source_dir")"
  base="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g')"
  if [[ -z "$base" ]]; then
    base="paperclip-page"
  fi
  printf '%.48s\n' "$base" | sed -E 's/-+$//'
}

random_suffix() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 3
  else
    od -An -N3 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

normalize_default_prefix() {
  local raw="${1:-}"
  local segment
  local normalized=""

  raw="${raw#/}"
  raw="${raw%/}"
  [[ "$raw" != *"//"* ]] || die "PAPERCLIP_PAGE_DEFAULT_PREFIX cannot contain empty path segments"
  if [[ -z "$raw" ]]; then
    printf '\n'
    return
  fi

  IFS='/' read -r -a segments <<<"$raw"
  for segment in "${segments[@]}"; do
    validate_segment "$segment" "prefix segment"
    if [[ -z "$normalized" ]]; then
      normalized="$segment"
    else
      normalized="$normalized/$segment"
    fi
  done
  printf '%s\n' "$normalized"
}

join_prefix() {
  local default_prefix="$1"
  local slug="$2"

  if [[ -n "$default_prefix" ]]; then
    printf '%s/%s/\n' "$default_prefix" "$slug"
  else
    printf '%s/\n' "$slug"
  fi
}

aws_base_args=()

aws_cli() {
  aws "${aws_base_args[@]}" "$@"
}

object_exists() {
  local bucket="$1"
  local prefix="$2"
  local key

  key="$(aws_cli s3api list-objects-v2 \
    --bucket "$bucket" \
    --prefix "$prefix" \
    --max-keys 1 \
    --query 'Contents[0].Key' \
    --output text)"
  [[ "$key" != "None" && -n "$key" ]]
}

assert_safe_source_tree() {
  local source_dir="$1"
  local found

  [[ ! -L "$source_dir" ]] || die "source directory must not be a symlink"
  [[ -f "$source_dir/index.html" ]] || die "source directory must contain root index.html"

  found="$(find "$source_dir" -type l -print -quit)"
  [[ -z "$found" ]] || die "found symlink in source tree: $found"

  found="$(
    cd "$source_dir"
    find . -mindepth 1 \
      \( -path './.paperclip-page' -o -path './.paperclip-page/*' \) -prune -o \
      \( -name '.*' -o -path '*/.*' \) -print -quit
  )"
  [[ -z "$found" ]] || die "hidden files and dot paths are not allowed in published content: $found"
}

read_state_value() {
  local state_file="$1"
  local expression="$2"
  jq -r "$expression // empty" "$state_file"
}

assert_update_ownership() {
  local source_dir="$1"
  local bucket="$2"
  local prefix="$3"
  local state_file="$source_dir/.paperclip-page/state.json"
  local state_bucket
  local state_prefix

  [[ -f "$state_file" ]] || die "update of an existing prefix requires ownership state at $state_file"
  state_bucket="$(read_state_value "$state_file" '.bucket')"
  state_prefix="$(read_state_value "$state_file" '.prefix')"

  [[ "$state_bucket" == "$bucket" ]] || die "state bucket does not match target bucket"
  [[ "$state_prefix" == "$prefix" ]] || die "state prefix does not match target prefix"
}

compute_source_hash() {
  local source_dir="$1"

  if ! command -v sha256sum >/dev/null 2>&1; then
    printf 'unavailable\n'
    return
  fi

  (
    cd "$source_dir"
    find . -type f ! -path './.paperclip-page/*' -print0 |
      LC_ALL=C sort -z |
      while IFS= read -r -d '' path; do
        sha256sum "$path"
      done
  ) | sha256sum | awk '{print $1}'
}

write_state() {
  local source_dir="$1"
  local bucket="$2"
  local prefix="$3"
  local slug="$4"
  local url="$5"
  local base_url="$6"
  local source_hash="$7"
  local state_dir="$source_dir/.paperclip-page"
  local state_file="$state_dir/state.json"
  local temp_file

  mkdir -p "$state_dir"
  temp_file="$(mktemp "$state_dir/state.json.tmp.XXXXXX")"
  jq -n \
    --arg bucket "$bucket" \
    --arg prefix "$prefix" \
    --arg slug "$slug" \
    --arg url "$url" \
    --arg baseUrl "$base_url" \
    --arg publishedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --arg sourceHash "$source_hash" \
    '{
      bucket: $bucket,
      prefix: $prefix,
      slug: $slug,
      url: $url,
      baseUrl: $baseUrl,
      publishedAt: $publishedAt,
      sourceHash: $sourceHash,
      version: 1
    }' >"$temp_file"
  mv "$temp_file" "$state_file"
}

source_arg=""
slug_arg=""
update=0
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)
      slug_arg="${2:-}"
      shift 2
      ;;
    --update)
      update=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      die "unknown argument: $1"
      ;;
    *)
      if [[ -n "$source_arg" ]]; then
        die "unexpected positional argument: $1"
      fi
      source_arg="$1"
      shift
      ;;
  esac
done

[[ -n "$source_arg" ]] || {
  usage >&2
  exit 1
}

require_command jq
require_command find
require_command sed

[[ -d "$source_arg" ]] || die "source path is not a directory: $source_arg"
source_dir="$(cd "$source_arg" && pwd -P)"
assert_safe_source_tree "$source_dir"

bucket="${PAPERCLIP_PAGE_BUCKET:-}"
base_url="${PAPERCLIP_PAGE_BASE_URL:-}"
region="${AWS_REGION:-}"
default_prefix="$(normalize_default_prefix "${PAPERCLIP_PAGE_DEFAULT_PREFIX:-}")"

[[ -n "$bucket" ]] || die "PAPERCLIP_PAGE_BUCKET is required"
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "PAPERCLIP_PAGE_BUCKET does not look like a valid S3 bucket name"
[[ -n "$base_url" ]] || die "PAPERCLIP_PAGE_BASE_URL is required"
base_url="$(normalize_base_url "$base_url")"

explicit_slug=0
if [[ -n "$slug_arg" ]]; then
  explicit_slug=1
  slug="$(normalize_slug "$slug_arg")"
else
  slug="$(normalize_slug "$(derive_slug "$source_dir")")"
fi

if [[ "$dry_run" == "0" ]]; then
  require_command aws
  require_command curl
  [[ -n "$region" ]] || die "AWS_REGION is required for live publish"
  aws_base_args=(--region "$region")
  if [[ -n "${PAPERCLIP_PAGE_AWS_PROFILE:-}" ]]; then
    aws_base_args+=(--profile "$PAPERCLIP_PAGE_AWS_PROFILE")
  fi
fi

prefix="$(join_prefix "$default_prefix" "$slug")"
target_exists=0

if [[ "$update" == "1" ]]; then
  assert_update_ownership "$source_dir" "$bucket" "$prefix"
fi

if [[ "$dry_run" == "0" ]]; then
  if object_exists "$bucket" "$prefix"; then
    target_exists=1
  fi

  if [[ "$target_exists" == "1" && "$update" == "0" ]]; then
    if [[ "$explicit_slug" == "1" ]]; then
      die "slug already exists: $slug. Use --update from the owning source directory or choose a new slug."
    fi

    for _ in 1 2 3 4 5; do
      candidate="${slug}-$(random_suffix)"
      candidate="$(printf '%.64s' "$candidate" | sed -E 's/-+$//')"
      validate_segment "$candidate" "generated slug"
      candidate_prefix="$(join_prefix "$default_prefix" "$candidate")"
      if ! object_exists "$bucket" "$candidate_prefix"; then
        slug="$candidate"
        prefix="$candidate_prefix"
        target_exists=0
        break
      fi
    done

    [[ "$target_exists" == "0" ]] || die "could not find an unused generated slug after 5 attempts"
  fi
fi

url="${base_url}/${prefix}"
mode="publish"
if [[ "$update" == "1" ]]; then
  mode="update"
fi

if [[ "$dry_run" == "1" ]]; then
  cat <<EOF
paperclip-page dry run
mode: $mode
source: $source_dir
bucket: $bucket
prefix: $prefix
url: $url
EOF
  exit 0
fi

aws_cli s3 sync "$source_dir/" "s3://$bucket/$prefix" \
  --no-follow-symlinks \
  --exclude '.paperclip-page/*' \
  --cache-control 'public,max-age=60' \
  --only-show-errors

source_hash="$(compute_source_hash "$source_dir")"
write_state "$source_dir" "$bucket" "$prefix" "$slug" "$url" "$base_url" "$source_hash"

curl -fsSIL --max-time 20 "$url" >/dev/null

cat <<EOF
paperclip-page published
mode: $mode
url: $url
bucket: $bucket
prefix: $prefix
state: $source_dir/.paperclip-page/state.json
EOF
