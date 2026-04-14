#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Write Claude Code OAuth credentials if provided via environment.
# Writes both:
#   - credentials.json  (read by Paperclip adapter for quota tracking)
#   - ~/.claude.json    (read by claude CLI binary for authentication)
# Both files must be owned by the node user so claude CLI can read them.
if [ -n "$CLAUDE_CREDENTIALS_JSON" ]; then
    mkdir -p /paperclip/.claude

    # Write credentials.json for the Paperclip adapter
    printf '%s' "$CLAUDE_CREDENTIALS_JSON" > /paperclip/.claude/credentials.json

    # Merge claudeAiOauth into ~/.claude.json for the claude CLI binary
    python3 - <<'PYEOF'
import json, os, sys

creds_str = os.environ.get("CLAUDE_CREDENTIALS_JSON", "{}")
creds = json.loads(creds_str)
oauth = creds.get("claudeAiOauth", {})
if not oauth:
    sys.exit(0)

claude_json_path = "/paperclip/.claude.json"
try:
    with open(claude_json_path) as f:
        cfg = json.load(f)
except Exception:
    cfg = {}

cfg["claudeAiOauth"] = oauth

with open(claude_json_path, "w") as f:
    json.dump(cfg, f)
print(f"[entrypoint] Claude OAuth merged into {claude_json_path}")
PYEOF

    # Fix ownership — files were written by root; claude CLI runs as node
    chown node:node /paperclip/.claude/credentials.json /paperclip/.claude.json 2>/dev/null || true
    chmod 600 /paperclip/.claude/credentials.json /paperclip/.claude.json 2>/dev/null || true

    # Derive CLAUDE_CODE_OAUTH_TOKEN from credentials if not already set.
    # claude CLI 2.1.x checks this env var first (bypasses Keychain lookup),
    # which is critical on Linux where no Keychain is available.
    if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
        _TOKEN=$(python3 -c "
import json, os, sys
try:
    d = json.loads(os.environ.get('CLAUDE_CREDENTIALS_JSON', '{}'))
    print(d['claudeAiOauth']['accessToken'])
except Exception:
    pass
" 2>/dev/null || true)
        if [ -n "$_TOKEN" ]; then
            export CLAUDE_CODE_OAUTH_TOKEN="$_TOKEN"
            echo "[entrypoint] CLAUDE_CODE_OAUTH_TOKEN derived from CLAUDE_CREDENTIALS_JSON"
        fi
        unset _TOKEN
    fi
fi

# Write Codex subscription auth if provided via environment.
# codex_local uses a Paperclip-managed CODEX_HOME seeded from ~/.codex/auth.json.
# In the container, the shared home is /paperclip/.codex, so this lets Codex
# run with ChatGPT subscription auth instead of requiring OPENAI_API_KEY.
if [ -n "$CODEX_AUTH_JSON" ]; then
    mkdir -p /paperclip/.codex
    printf '%s' "$CODEX_AUTH_JSON" > /paperclip/.codex/auth.json
    chown -R node:node /paperclip/.codex 2>/dev/null || true
    chmod 700 /paperclip/.codex 2>/dev/null || true
    chmod 600 /paperclip/.codex/auth.json 2>/dev/null || true
    echo "[entrypoint] Codex auth written to /paperclip/.codex/auth.json"
fi

# Write Gemini subscription auth if provided via environment.
# gemini_local uses the Gemini CLI, which reads Google account credentials
# from ~/.gemini in the runtime user's home directory.
if [ -n "$GEMINI_OAUTH_JSON" ]; then
    mkdir -p /paperclip/.gemini
    printf '%s' "$GEMINI_OAUTH_JSON" > /paperclip/.gemini/oauth_creds.json
    if [ -n "$GEMINI_GOOGLE_ACCOUNTS_JSON" ]; then
        printf '%s' "$GEMINI_GOOGLE_ACCOUNTS_JSON" > /paperclip/.gemini/google_accounts.json
    fi
    if [ -n "$GEMINI_PROJECTS_JSON" ]; then
        printf '%s' "$GEMINI_PROJECTS_JSON" > /paperclip/.gemini/projects.json
    fi
    if [ -n "$GEMINI_GOOGLE_PROJECT" ]; then
        export GOOGLE_CLOUD_PROJECT="$GEMINI_GOOGLE_PROJECT"
        export GOOGLE_CLOUD_PROJECT_ID="$GEMINI_GOOGLE_PROJECT"
    fi
    export GOOGLE_GENAI_USE_GCA="${GOOGLE_GENAI_USE_GCA:-true}"
    chown -R node:node /paperclip/.gemini 2>/dev/null || true
    chmod 700 /paperclip/.gemini 2>/dev/null || true
    chmod 600 /paperclip/.gemini/oauth_creds.json 2>/dev/null || true
    chmod 600 /paperclip/.gemini/google_accounts.json 2>/dev/null || true
    chmod 600 /paperclip/.gemini/projects.json 2>/dev/null || true
    echo "[entrypoint] Gemini auth written to /paperclip/.gemini"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Seed agent instruction files from the image into the persistent volume.
# The volume at /paperclip/instances is empty on first mount; this copies
# bundled AGENTS.md files so instructions survive without manual SFTP uploads.
# Existing files are NOT overwritten (volume edits take precedence).
SEED_SRC="/app/instances/default/agents"
SEED_DST="/paperclip/instances/default/agents"
if [ -d "$SEED_SRC" ]; then
    for agent_dir in "$SEED_SRC"/*/; do
        agent_id=$(basename "$agent_dir")
        for file in "$agent_dir"instructions/AGENTS.md; do
            [ -f "$file" ] || continue
            dst_file="$SEED_DST/$agent_id/instructions/AGENTS.md"
            if [ ! -f "$dst_file" ]; then
                mkdir -p "$(dirname "$dst_file")"
                cp "$file" "$dst_file"
                echo "[entrypoint] Seeded instructions for agent $agent_id"
            fi
        done
    done
fi

# Fly.io mounts persistent volumes as root. Paperclip runs as node and needs
# write access to instance logs, backups, managed agent homes, and auth homes.
chown -R node:node /paperclip

# Set up 6-hour backup cron job (runs as node user).
# The paperclip-backup script is bundled in the image at /usr/local/bin/.
if command -v crontab >/dev/null 2>&1 && [ -x /usr/local/bin/paperclip-backup ]; then
    # Write crontab for node user: run backup at 0,6,12,18 UTC every day
    echo "0 0,6,12,18 * * * nice -n 19 /usr/local/bin/paperclip-backup >> /paperclip/backup.log 2>&1" \
        | gosu node crontab -
    # Start cron daemon in background if not already running
    if command -v cron >/dev/null 2>&1 && ! pgrep -x cron >/dev/null 2>&1; then
        cron
        echo "[entrypoint] Cron daemon started for 6-hour backups"
    fi
fi

exec gosu node "$@"
