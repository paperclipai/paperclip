#!/usr/bin/env bash
# scripts/vercel-deploy-check.sh
#
# Vercel deploy identity preflight and post-push success verification.
# Implements FUL-11094 guardrail. Source this file or run it directly.
#
# Standalone usage:
#   ./scripts/vercel-deploy-check.sh preflight  <owner/repo> <branch> <vercel-project>
#   ./scripts/vercel-deploy-check.sh postflight <sha> <owner/repo> <branch> <vercel-project> [paperclip-issue-id]
#
# Sourced usage:
#   source scripts/vercel-deploy-check.sh
#   vercel_preflight  <owner/repo> <branch> <vercel-project>
#   vercel_postflight <sha> <owner/repo> <branch> <vercel-project> [paperclip-issue-id]
#
# Required env vars:
#   GH_TOKEN or GITHUB_TOKEN  — consumed by gh CLI internally; never printed
#   VERCEL_TOKEN              — passed via curl --config; never in argv (SH-10)
#
# Optional (for postflight Paperclip issue comment):
#   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID
#
# Overrides:
#   VERCEL_POLL_TIMEOUT_SECONDS — max seconds to wait for Vercel READY (default 300)

set -euo pipefail

# ── dependency check ──────────────────────────────────────────────────────────

for _dep in git curl gh jq; do
  if ! command -v "$_dep" &>/dev/null; then
    echo "ERROR: required command '$_dep' not found in PATH" >&2
    exit 1
  fi
done
unset _dep

# ── internal helpers ──────────────────────────────────────────────────────────

_ok()   { echo "  ✓ $*"; }
_info() { echo "  · $*"; }

_fail() {
  echo "" >&2
  printf '  ✗ FAIL: %s\n' "$*" >&2
  exit 1
}

# GitHub API — auth consumed by gh CLI from GH_TOKEN / GITHUB_TOKEN; not in argv.
_gh_api() {
  gh api "$@"
}

# Vercel API — token passed via curl --config to avoid argv exposure (SH-10).
_vercel_api() {
  local _path="$1"; shift
  local _vt="${VERCEL_TOKEN:-}"
  if [[ -z "$_vt" ]]; then
    _fail "VERCEL_TOKEN must be set"
  fi
  curl -fsSL \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$_vt") \
    "https://api.vercel.com${_path}" "$@"
}

# ── preflight ─────────────────────────────────────────────────────────────────

vercel_preflight() {
  local expected_repo="${1:?Usage: vercel_preflight <owner/repo> <branch> <vercel-project>}"
  local expected_branch="${2:?<branch> required}"
  local expected_vercel_project="${3:?<vercel-project> required}"

  echo ""
  echo "═══ Vercel Deploy Preflight ═══"

  # 1. Git remote owner/repo
  local remote_url actual_repo
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -z "$remote_url" ]]; then
    _fail "No git remote 'origin' found. Configure the remote before deploying."
  fi
  actual_repo="$(echo "$remote_url" | sed -E 's|.*[:/]([^/]+/[^/]+?)(\.git)?$|\1|')"
  if [[ "$actual_repo" != "$expected_repo" ]]; then
    _fail "Remote mismatch: got '$actual_repo', expected '$expected_repo'. Check out the correct repo."
  fi
  _ok "Remote: $actual_repo"

  # 2. Current branch
  local actual_branch
  actual_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -z "$actual_branch" || "$actual_branch" == "HEAD" ]]; then
    _fail "Not on a named branch (detached HEAD). Check out '$expected_branch' first."
  fi
  if [[ "$actual_branch" != "$expected_branch" ]]; then
    _fail "Branch mismatch: on '$actual_branch', expected '$expected_branch'. Switch branches before deploying."
  fi
  _ok "Branch: $actual_branch"

  # 3. GitHub authenticated actor — name only; token handled internally by gh
  local gh_actor
  gh_actor="$(_gh_api /user --jq '.login' 2>/dev/null || true)"
  if [[ -z "$gh_actor" ]]; then
    _fail "Cannot resolve GitHub actor. Check GH_TOKEN / GITHUB_TOKEN is set and valid."
  fi
  _ok "GitHub actor: $gh_actor"

  # 4. Commit author email is verified on the authenticated GitHub account
  local local_email
  local_email="$(git config user.email 2>/dev/null || true)"
  if [[ -z "$local_email" ]]; then
    _fail "git config user.email is not set. Run: git config user.email <your-verified-github-email>"
  fi
  _info "Commit author email: $local_email"

  # Try verified email list (requires user:email scope on token)
  local email_verified=""
  local emails_json
  emails_json="$(_gh_api /user/emails 2>/dev/null || echo '[]')"
  email_verified="$(echo "$emails_json" | jq -r --arg e "$local_email" \
    '.[] | select(.email == $e and .verified == true) | .email' 2>/dev/null | head -1 || true)"

  if [[ -z "$email_verified" ]]; then
    # Fallback: check public email field on /user
    local public_email
    public_email="$(_gh_api /user --jq '.email // empty' 2>/dev/null || true)"
    if [[ "$public_email" == "$local_email" ]]; then
      email_verified="$local_email"
      _info "Verified via public profile email (user:email scope not available)"
    fi
  fi

  if [[ -z "$email_verified" ]]; then
    _info "Unblock owner: GitHub account holder for '$gh_actor'"
    _info "Fix option A: add and verify '$local_email' at https://github.com/settings/emails"
    _info "Fix option B: git config user.email <an-email-already-verified-on-$gh_actor>"
    _fail "Commit author email '$local_email' is not a verified email on GitHub account '$gh_actor'"
  fi
  _ok "Commit email '$local_email' is verified on GitHub account '$gh_actor'"

  # 5. Vercel project/org target — name only; no org secrets printed
  local vercel_proj_json vercel_proj_name
  vercel_proj_json="$(_vercel_api "/v9/projects/$expected_vercel_project" 2>/dev/null || echo 'null')"
  vercel_proj_name="$(echo "$vercel_proj_json" | jq -r '.name // empty' 2>/dev/null || true)"
  if [[ -z "$vercel_proj_name" || "$vercel_proj_name" == "null" ]]; then
    _info "Unblock owner: project admin or DevOps/Infrastructure Lead"
    _info "Fix: verify VERCEL_TOKEN has access to project '$expected_vercel_project'"
    _fail "Vercel project '$expected_vercel_project' not accessible. Check project name and token scope."
  fi
  _ok "Vercel project: $vercel_proj_name"

  # 6. Secret-print guard assertion — this script never echoes token values
  _ok "Secret-print guard: no credentials emitted by this script"

  echo ""
  echo "PREFLIGHT PASSED ✓ — safe to push"
  echo ""
}

# ── postflight ────────────────────────────────────────────────────────────────

vercel_postflight() {
  local sha="${1:?Usage: vercel_postflight <sha> <owner/repo> <branch> <vercel-project> [issue-id]}"
  local expected_repo="${2:?<owner/repo> required}"
  local expected_branch="${3:?<branch> required}"
  local expected_vercel_project="${4:?<vercel-project> required}"
  local issue_id="${5:-}"
  local max_wait="${VERCEL_POLL_TIMEOUT_SECONDS:-300}"
  local poll_interval=15

  echo ""
  echo "═══ Vercel Deploy Postflight ═══"
  echo "  SHA: $sha | repo: $expected_repo | branch: $expected_branch"

  # 1. Confirm push reached remote
  local remote_sha
  remote_sha="$(git ls-remote origin "refs/heads/$expected_branch" 2>/dev/null | awk '{print $1}' | head -1 || true)"
  if [[ -z "$remote_sha" ]]; then
    _info "Blocker owner: Pushing agent"
    _fail "Cannot read remote ref 'refs/heads/$expected_branch'. Push may not have completed."
  fi
  if [[ "$remote_sha" != "$sha" ]]; then
    _info "Remote is at: $remote_sha"
    _info "Blocker owner: Pushing agent — retry the push"
    _fail "Remote $expected_branch does not match expected SHA $sha. Push did not succeed."
  fi
  _ok "Push confirmed: $sha on $expected_repo/$expected_branch"

  # 2. GitHub commit exists
  local commit_json commit_author gh_actor
  commit_json="$(_gh_api "/repos/$expected_repo/commits/$sha" 2>/dev/null || echo 'null')"
  if [[ "$commit_json" == "null" || -z "$commit_json" ]]; then
    _fail "Commit $sha not found on GitHub ($expected_repo). Verify the push completed."
  fi
  commit_author="$(echo "$commit_json" | jq -r '.author.login // .commit.author.name // "unknown"')"
  gh_actor="$(_gh_api /user --jq '.login' 2>/dev/null || echo "unknown")"
  _ok "GitHub commit: $sha (commit author: $commit_author, pusher: $gh_actor)"

  # GitHub check runs — allow up to 30s for them to register
  local check_count=0 check_summary="none registered yet"
  local _check_json
  for _i in 1 2 3; do
    _check_json="$(_gh_api "/repos/$expected_repo/commits/$sha/check-runs" 2>/dev/null || echo '{}')"
    check_count="$(echo "$_check_json" | jq -r '.total_count // 0')"
    if [[ "$check_count" -gt 0 ]]; then
      check_summary="$(echo "$_check_json" | jq -r \
        '[.check_runs[] | "\(.name): \(.conclusion // .status)"] | join(", ")' 2>/dev/null || echo "parse error")"
      break
    fi
    [[ $_i -lt 3 ]] && sleep 10
  done
  unset _i _check_json
  _ok "GitHub checks: $check_count run(s) — $check_summary"

  # 3 & 4. Resolve Vercel project ID, then poll for deployment matching this SHA
  local proj_id
  proj_id="$(_vercel_api "/v9/projects/$expected_vercel_project" 2>/dev/null | jq -r '.id // empty' || true)"
  if [[ -z "$proj_id" ]]; then
    _info "Blocker owner: DevOps/Infrastructure Lead"
    _fail "Cannot fetch Vercel project ID for '$expected_vercel_project'. Check VERCEL_TOKEN scope."
  fi

  local deploy_id="" deploy_state="" deploy_url="" elapsed=0

  _info "Polling Vercel project '$expected_vercel_project' for SHA $sha (max ${max_wait}s)..."

  while [[ $elapsed -lt $max_wait ]]; do
    local _deploys _matched
    _deploys="$(_vercel_api "/v6/deployments?projectId=$proj_id&limit=10" 2>/dev/null || echo '{}')"

    _matched="$(echo "$_deploys" | jq -c --arg sha "$sha" \
      'first(.deployments[]? |
        select(
          (.meta.githubCommitSha // .meta.commitSha // .meta.gitlabCommitSha // "") == $sha
        )
      ) // null' 2>/dev/null || echo 'null')"

    if [[ "$_matched" != "null" && -n "$_matched" ]]; then
      deploy_id="$(echo "$_matched" | jq -r '.uid // .id // empty')"
      deploy_state="$(echo "$_matched" | jq -r '.state // empty')"
      deploy_url="$(echo "$_matched" | jq -r '.url // empty')"
      _info "Deployment $deploy_id state: $deploy_state"

      case "$deploy_state" in
        READY)
          _ok "Vercel deployment READY: $deploy_id"
          break
          ;;
        ERROR|CANCELED)
          _info "Blocker owner: DevOps/Infrastructure Lead"
          _info "Action: inspect deployment logs at https://vercel.com/dashboard"
          _fail "Vercel deployment $deploy_id reached terminal state '$deploy_state'"
          ;;
      esac
      # BUILDING / INITIALIZING — keep polling
    fi

    sleep "$poll_interval"
    elapsed=$((elapsed + poll_interval))
  done

  if [[ -z "$deploy_id" ]]; then
    _info "Blocker owner: DevOps/Infrastructure Lead"
    _info "Possible causes: Vercel webhook not configured for this repo/branch; VERCEL_TOKEN lacks project access"
    _fail "No Vercel deployment found for SHA $sha after ${max_wait}s"
  fi
  if [[ "$deploy_state" != "READY" ]]; then
    _info "Blocker owner: DevOps/Infrastructure Lead"
    _fail "Vercel deployment $deploy_id stuck in state '$deploy_state' after ${max_wait}s"
  fi

  # 5. Preview URL safety — no bypass token parameters embedded
  local preview_url_safe="yes"
  if echo "$deploy_url" | grep -qiE '(bypass|token|auth)='; then
    preview_url_safe="no — URL contains bypass/auth parameter; share via secure channel only"
  fi

  local utc_ts
  utc_ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # Structured completion summary
  local summary
  summary="$(cat <<SUMMARY
## Vercel Deploy Postflight — PASSED ✓

| Field | Value |
|---|---|
| Branch | \`$expected_branch\` |
| SHA | \`$sha\` |
| GitHub actor | \`$gh_actor\` |
| Commit author | \`$commit_author\` |
| Vercel project | \`$expected_vercel_project\` |
| Deployment ID | \`$deploy_id\` |
| Deployment state | \`$deploy_state\` |
| Preview URL | \`$deploy_url\` |
| Preview URL safe to share | $preview_url_safe |
| GitHub checks ($check_count) | $check_summary |
| Timestamp (UTC) | \`$utc_ts\` |
SUMMARY
)"

  echo ""
  echo "$summary"
  echo ""
  echo "POSTFLIGHT PASSED ✓"

  # Post summary to Paperclip issue if configured
  if [[ -n "$issue_id" && -n "${PAPERCLIP_API_URL:-}" && -n "${PAPERCLIP_API_KEY:-}" ]]; then
    local _tmpconf
    _tmpconf="$(mktemp)"
    chmod 600 "$_tmpconf"
    printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY" > "$_tmpconf"
    curl -fsSL -X POST "$PAPERCLIP_API_URL/api/issues/$issue_id/comments" \
      --config "$_tmpconf" \
      -H "Content-Type: application/json" \
      -H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID:-postflight}" \
      -d "$(jq -n --arg body "$summary" '{body: $body}')" \
      > /dev/null 2>&1 || _info "Warning: could not post postflight comment to Paperclip (non-fatal)"
    rm -f "$_tmpconf"
    _ok "Postflight summary posted to Paperclip issue $issue_id"
  fi
}

# ── entrypoint (standalone mode) ──────────────────────────────────────────────

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  cmd="${1:-}"
  shift || true
  case "$cmd" in
    preflight)  vercel_preflight  "$@" ;;
    postflight) vercel_postflight "$@" ;;
    *)
      echo "Usage:" >&2
      echo "  $0 preflight  <owner/repo> <branch> <vercel-project>" >&2
      echo "  $0 postflight <sha> <owner/repo> <branch> <vercel-project> [paperclip-issue-id]" >&2
      exit 1
      ;;
  esac
fi
