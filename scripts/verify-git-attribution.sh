#!/usr/bin/env bash
set -euo pipefail

forbidden_identity='paperclip|noreply@paperclip[.]ing|codex|openai|agent([+._ -]|@)|runtime([+._ -]|@)|tool([+._ -]|@)'
attribution_trailer='^[[:space:]]*(co-authored-by|authored-by|committed-by|signed-off-by|generated-by|assisted-by)[[:space:]]*:'

reject_value() {
  local label=$1 value=$2
  if printf '%s\n' "$value" | grep -Eiq "$forbidden_identity"; then
    printf 'ERROR: forbidden automation identity in %s: %s\n' "$label" "$value" >&2
    return 1
  fi
}

validate_current_identities() {
  local author committer
  author=$(git var GIT_AUTHOR_IDENT)
  committer=$(git var GIT_COMMITTER_IDENT)
  reject_value author "$author"
  reject_value committer "$committer"
}

validate_message_file() {
  local message_file=$1 line
  while IFS= read -r line; do
    if printf '%s\n' "$line" | grep -Eiq "$attribution_trailer" && \
       printf '%s\n' "$line" | grep -Eiq "$forbidden_identity"; then
      printf 'ERROR: forbidden automation attribution trailer: %s\n' "$line" >&2
      return 1
    fi
  done < "$message_file"
}

reject_commit() {
  local commit=$1 author committer signature_status signer message
  author=$(git show -s --format='%an <%ae>' "$commit")
  committer=$(git show -s --format='%cn <%ce>' "$commit")
  signature_status=$(git show -s --format='%G?' "$commit")
  signer=$(git show -s --format='%GS <%GK>' "$commit")
  message=$(mktemp)
  git show -s --format='%B' "$commit" > "$message"

  local failed=0
  reject_value "author of $commit" "$author" || failed=1
  reject_value "committer of $commit" "$committer" || failed=1
  if [ "$signature_status" != "N" ] && [ -n "${signer//[ <>]/}" ]; then
    reject_value "signature of $commit" "$signer" || failed=1
  fi
  validate_message_file "$message" || failed=1
  rm -f "$message"
  return "$failed"
}

verify_range() {
  local commit failed=0
  while IFS= read -r commit; do
    [ -n "$commit" ] || continue
    reject_commit "$commit" || failed=1
  done
  return "$failed"
}

case "${1:-}" in
  --current-identities)
    [ "$#" -eq 1 ] || exit 2
    validate_current_identities
    ;;
  --message-file)
    [ "$#" -eq 2 ] || exit 2
    validate_message_file "$2"
    ;;
  --range)
    [ "$#" -eq 2 ] || exit 2
    git rev-list "$2" | verify_range
    ;;
  --pre-push)
    [ "$#" -eq 3 ] || exit 2
    remote_name=$2
    failed=0
    while read -r local_ref local_sha remote_ref remote_sha; do
      [ "$local_sha" != "0000000000000000000000000000000000000000" ] || continue
      if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
        if [ -n "$remote_name" ] && git remote get-url "$remote_name" >/dev/null 2>&1; then
          git rev-list "$local_sha" --not --remotes="$remote_name" | verify_range || failed=1
        else
          git rev-list "$local_sha" | verify_range || failed=1
        fi
      else
        git rev-list "$remote_sha..$local_sha" | verify_range || failed=1
      fi
    done
    exit "$failed"
    ;;
  *)
    printf 'usage: %s --current-identities | --message-file <path> | --range <revision-range> | --pre-push <remote-name> <remote-url>\n' "$0" >&2
    exit 2
    ;;
esac
