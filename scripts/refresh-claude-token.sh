#!/bin/bash
# Reads fresh Claude Code OAuth credentials from macOS Keychain plus Codex
# ChatGPT and Gemini subscription auth from local auth files, then pushes them to Fly.io.
#
# Run this on your Mac before the access token expires (~every 24 hours).
# Best practice: install as a LaunchAgent that checks frequently and only syncs
# to Fly when credentials changed or the last successful sync is old.
#
# Setup (one-time):
#   chmod +x scripts/refresh-claude-token.sh
#   cp scripts/com.paperclip.refresh-claude-token.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.paperclip.refresh-claude-token.plist
#
# Manual run:
#   ./scripts/refresh-claude-token.sh

set -euo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

APP="${FLY_APP:-paperclip-holding}"
KEYCHAIN_SERVICE="Claude Code-credentials"
LOGFILE="$HOME/.paperclip-token-refresh.log"
STATE_FILE="$HOME/.paperclip-token-refresh-state.json"
BOARD_TOKEN_FILE="${PAPERCLIP_BOARD_TOKEN_FILE:-$HOME/.paperclip-board-token.json}"
REFRESH_THRESHOLD_MINUTES="${CLAUDE_REFRESH_THRESHOLD_MINUTES:-420}"
SYNC_INTERVAL_MINUTES="${PAPERCLIP_TOKEN_SYNC_INTERVAL_MINUTES:-360}"
GEMINI_GOOGLE_PROJECT="${GEMINI_GOOGLE_PROJECT:-gen-lang-client-0796541763}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

read_claude_creds() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true
}

credential_minutes_remaining() {
  echo "$1" | python3 -c "
import json, sys, time
d = json.load(sys.stdin)
ts = d['claudeAiOauth'].get('expiresAt', 0)
print(int((ts / 1000 - time.time()) / 60))
"
}

credential_expiry_utc() {
  echo "$1" | python3 -c "
import json, sys, datetime
d = json.load(sys.stdin)
ts = d['claudeAiOauth'].get('expiresAt', 0)
dt = datetime.datetime.utcfromtimestamp(ts / 1000)
print(dt.strftime('%Y-%m-%d %H:%M UTC'))
"
}

credential_expiry_ms() {
  echo "$1" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['claudeAiOauth'].get('expiresAt', 0))
"
}

token_sha() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

last_sync_age_minutes() {
  python3 - "$STATE_FILE" <<'PY'
import json, os, sys, time

path = sys.argv[1]
try:
    with open(path) as f:
        state = json.load(f)
    synced_at = int(state.get("syncedAt", 0))
except Exception:
    synced_at = 0

if synced_at <= 0:
    print(999999)
else:
    print(int((time.time() - synced_at) / 60))
PY
}

last_synced_auth_sha() {
  python3 - "$STATE_FILE" <<'PY'
import json, sys

try:
    with open(sys.argv[1]) as f:
        state = json.load(f)
    print(state.get("authSha") or state.get("tokenSha", ""))
except Exception:
    print("")
PY
}

write_sync_state() {
  python3 - "$STATE_FILE" "$1" "$2" <<'PY'
import json, os, sys, time

path, auth_sha, expires_at_ms = sys.argv[1], sys.argv[2], sys.argv[3]
state = {
    "syncedAt": int(time.time()),
    "authSha": auth_sha,
    "expiresAt": int(expires_at_ms or 0),
}

tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f)
os.replace(tmp, path)
os.chmod(path, 0o600)
PY
}

active_paperclip_runs_count() {
  python3 - "$BOARD_TOKEN_FILE" <<'PY'
import json, sys, urllib.request

path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
    api_base = cfg["apiBase"].rstrip("/")
    token = cfg["token"]
except Exception:
    print(-1)
    raise SystemExit(0)

try:
    req = urllib.request.Request(
        f"{api_base}/api/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        json.load(res)

    company_id = "752d12a0-c30a-45c0-ad18-a285ae5acf7a"
    req = urllib.request.Request(
        f"{api_base}/api/companies/{company_id}/live-runs?minCount=100",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        runs = json.load(res)
    active = [run for run in runs if run.get("status") in {"queued", "running"}]
    print(len(active))
except Exception:
    print(-1)
PY
}

refresh_local_claude_token() {
  if ! command -v claude >/dev/null 2>&1; then
    log "ERROR: claude CLI not found; cannot refresh local Claude credentials before Fly sync"
    exit 1
  fi

  log "Refreshing local Claude credentials via a minimal Claude request..."
  if ! claude -p "Reply exactly: TOKEN_REFRESH_OK" --output-format json >/tmp/paperclip-claude-token-refresh.json 2>/tmp/paperclip-claude-token-refresh.err; then
    log "ERROR: Claude local refresh request failed"
    tail -40 /tmp/paperclip-claude-token-refresh.err 2>/dev/null | tee -a "$LOGFILE"
    exit 1
  fi
}

log "Reading Claude credentials from Keychain (service: $KEYCHAIN_SERVICE)..."

# Read raw JSON from macOS Keychain
CREDS=$(read_claude_creds)

if [ -z "$CREDS" ]; then
  log "ERROR: No credentials found in Keychain under '$KEYCHAIN_SERVICE'"
  log "  Make sure you are logged in to Claude Code on this Mac."
  exit 1
fi

# Validate: must be JSON containing claudeAiOauth
if ! echo "$CREDS" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'claudeAiOauth' in d" 2>/dev/null; then
  log "ERROR: Keychain credentials do not contain 'claudeAiOauth' key"
  exit 1
fi

MINUTES_REMAINING=$(credential_minutes_remaining "$CREDS")
EXPIRES_AT=$(credential_expiry_utc "$CREDS")

if [ "$MINUTES_REMAINING" -lt "$REFRESH_THRESHOLD_MINUTES" ]; then
  log "Token expires too soon ($MINUTES_REMAINING min remaining; threshold $REFRESH_THRESHOLD_MINUTES min)."
  refresh_local_claude_token
  CREDS=$(read_claude_creds)
  MINUTES_REMAINING=$(credential_minutes_remaining "$CREDS")
  EXPIRES_AT=$(credential_expiry_utc "$CREDS")
fi

if [ "$MINUTES_REMAINING" -le 0 ]; then
  log "ERROR: Claude token is still expired after local refresh attempt (expires: $EXPIRES_AT)"
  exit 1
fi

log "Token valid until: $EXPIRES_AT ($MINUTES_REMAINING min remaining)"

# Extract raw accessToken for CLAUDE_CODE_OAUTH_TOKEN env var
# (claude CLI 2.1.x checks this env var first — works on Linux where no Keychain is available)
ACCESS_TOKEN=$(echo "$CREDS" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['claudeAiOauth']['accessToken'])
")

if [ -z "$ACCESS_TOKEN" ]; then
  log "ERROR: Could not extract accessToken from credentials"
  exit 1
fi

TOKEN_SHA=$(token_sha "$ACCESS_TOKEN")
EXPIRES_AT_MS=$(credential_expiry_ms "$CREDS")

CODEX_AUTH_JSON=""
if [ -f "$HOME/.codex/auth.json" ]; then
  if python3 -m json.tool "$HOME/.codex/auth.json" >/dev/null 2>&1; then
    CODEX_AUTH_JSON=$(cat "$HOME/.codex/auth.json")
    log "Codex auth found at ~/.codex/auth.json; including CODEX_AUTH_JSON."
  else
    log "WARNING: ~/.codex/auth.json exists but is not valid JSON; skipping CODEX_AUTH_JSON."
  fi
else
  log "WARNING: ~/.codex/auth.json not found; Codex agents may need manual login."
fi

GEMINI_OAUTH_JSON=""
if [ -f "$HOME/.gemini/oauth_creds.json" ]; then
  if python3 -m json.tool "$HOME/.gemini/oauth_creds.json" >/dev/null 2>&1; then
    GEMINI_OAUTH_JSON=$(cat "$HOME/.gemini/oauth_creds.json")
    log "Gemini OAuth found at ~/.gemini/oauth_creds.json; including GEMINI_OAUTH_JSON."
  else
    log "WARNING: ~/.gemini/oauth_creds.json exists but is not valid JSON; skipping GEMINI_OAUTH_JSON."
  fi
else
  log "WARNING: ~/.gemini/oauth_creds.json not found; Gemini agents may need manual login."
fi

GEMINI_GOOGLE_ACCOUNTS_JSON=""
if [ -f "$HOME/.gemini/google_accounts.json" ]; then
  if python3 -m json.tool "$HOME/.gemini/google_accounts.json" >/dev/null 2>&1; then
    GEMINI_GOOGLE_ACCOUNTS_JSON=$(cat "$HOME/.gemini/google_accounts.json")
    log "Gemini account metadata found at ~/.gemini/google_accounts.json; including GEMINI_GOOGLE_ACCOUNTS_JSON."
  else
    log "WARNING: ~/.gemini/google_accounts.json exists but is not valid JSON; skipping GEMINI_GOOGLE_ACCOUNTS_JSON."
  fi
fi

GEMINI_PROJECTS_JSON=""
if [ -f "$HOME/.gemini/projects.json" ]; then
  if python3 -m json.tool "$HOME/.gemini/projects.json" >/dev/null 2>&1; then
    GEMINI_PROJECTS_JSON=$(cat "$HOME/.gemini/projects.json")
    log "Gemini project metadata found at ~/.gemini/projects.json; including GEMINI_PROJECTS_JSON."
  else
    log "WARNING: ~/.gemini/projects.json exists but is not valid JSON; skipping GEMINI_PROJECTS_JSON."
  fi
fi

AUTH_SHA=$(printf '%s\0%s\0%s\0%s\0%s\0%s' "$ACCESS_TOKEN" "$CODEX_AUTH_JSON" "$GEMINI_OAUTH_JSON" "$GEMINI_GOOGLE_ACCOUNTS_JSON" "$GEMINI_PROJECTS_JSON" "${GEMINI_GOOGLE_PROJECT:-}" | shasum -a 256 | awk '{print $1}')
LAST_AUTH_SHA=$(last_synced_auth_sha)
LAST_SYNC_AGE_MINUTES=$(last_sync_age_minutes)

if [ "$AUTH_SHA" = "$LAST_AUTH_SHA" ] && [ "$LAST_SYNC_AGE_MINUTES" -lt "$SYNC_INTERVAL_MINUTES" ]; then
  log "Skipping Fly sync: auth bundle unchanged and last sync was ${LAST_SYNC_AGE_MINUTES} min ago (interval ${SYNC_INTERVAL_MINUTES} min)."
  exit 0
fi

ACTIVE_RUNS=$(active_paperclip_runs_count)
if [ "$ACTIVE_RUNS" -lt 0 ]; then
  log "Skipping Fly sync: could not verify active Paperclip runs from $BOARD_TOKEN_FILE."
  log "This avoids restarting Fly while agent work may be running. Re-run after the board token file is available."
  exit 0
fi
if [ "$ACTIVE_RUNS" -gt 0 ]; then
  log "Skipping Fly sync: $ACTIVE_RUNS Paperclip run(s) are queued/running. Will retry on the next LaunchAgent tick."
  exit 0
fi

log "Pushing credentials to Fly.io app: $APP ..."

SECRETS=(
  "CLAUDE_CREDENTIALS_JSON=$CREDS"
  "CLAUDE_CODE_OAUTH_TOKEN=$ACCESS_TOKEN"
)
if [ -n "$CODEX_AUTH_JSON" ]; then
  SECRETS+=("CODEX_AUTH_JSON=$CODEX_AUTH_JSON")
fi
if [ -n "$GEMINI_OAUTH_JSON" ]; then
  SECRETS+=("GEMINI_OAUTH_JSON=$GEMINI_OAUTH_JSON")
fi
if [ -n "$GEMINI_GOOGLE_ACCOUNTS_JSON" ]; then
  SECRETS+=("GEMINI_GOOGLE_ACCOUNTS_JSON=$GEMINI_GOOGLE_ACCOUNTS_JSON")
fi
if [ -n "$GEMINI_PROJECTS_JSON" ]; then
  SECRETS+=("GEMINI_PROJECTS_JSON=$GEMINI_PROJECTS_JSON")
fi
if [ -n "${GEMINI_GOOGLE_PROJECT:-}" ]; then
  SECRETS+=("GEMINI_GOOGLE_PROJECT=$GEMINI_GOOGLE_PROJECT")
  SECRETS+=("GOOGLE_CLOUD_PROJECT=$GEMINI_GOOGLE_PROJECT")
  SECRETS+=("GOOGLE_CLOUD_PROJECT_ID=$GEMINI_GOOGLE_PROJECT")
fi

# Set all secrets at once (single deploy trigger)
fly secrets set "${SECRETS[@]}" --app "$APP" 2>&1 | tee -a "$LOGFILE"

write_sync_state "$AUTH_SHA" "$EXPIRES_AT_MS"
log "Done. Credentials refreshed; Codex auth included: $([ -n "$CODEX_AUTH_JSON" ] && echo yes || echo no); Gemini auth included: $([ -n "$GEMINI_OAUTH_JSON" ] && echo yes || echo no)."
