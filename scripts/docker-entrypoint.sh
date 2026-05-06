#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

CLAUDE_OAUTH_ENV_FILE=/paperclip/.claude/oauth-token.env
CLAUDE_WRAPPER_DIR=/paperclip/.local/bin
CLAUDE_WRAPPER_PATH=$CLAUDE_WRAPPER_DIR/claude
CUSTOM_CLAUDE_WRAPPER_PATH=${PAPERCLIP_CLAUDE_LOCAL_WRAPPER_PATH:-/paperclip/claude-local/claude-paperclip.sh}

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

needs_volume_fix=0
if ! gosu node sh -c 'mkdir -p /paperclip/.permission-check >/dev/null 2>&1 && rmdir /paperclip/.permission-check >/dev/null 2>&1'; then
    needs_volume_fix=1
fi

if [ "$changed" = "1" ] || [ "$needs_volume_fix" = "1" ]; then
    echo "Ensuring /paperclip is writable by node"
    chown -R node:node /paperclip
fi

install_claude_oauth_wrapper() {
    real_claude_bin=$(command -v claude || true)
    if [ -z "$real_claude_bin" ]; then
        return 0
    fi

    mkdir -p "$CLAUDE_WRAPPER_DIR"
    cat > "$CLAUDE_WRAPPER_PATH" <<EOF
#!/bin/sh
set -e
if [ -f "$CLAUDE_OAUTH_ENV_FILE" ]; then
  # shellcheck disable=SC1091
  . "$CLAUDE_OAUTH_ENV_FILE"
fi
unset ANTHROPIC_API_KEY CLAUDE_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_AUTH_TOKEN
export MINDWORKERS_CLAUDE_PROVIDER=anthropic
export CLAUDE_CODE_PROVIDER=anthropic
export ANTHROPIC_BASE_URL=https://api.anthropic.com
exec "$real_claude_bin" "\$@"
EOF
    chmod 755 "$CLAUDE_WRAPPER_PATH"
    chown node:node "$CLAUDE_WRAPPER_PATH"

    case ":$PATH:" in
        *":$CLAUDE_WRAPPER_DIR:"*) ;;
        *) export PATH="$CLAUDE_WRAPPER_DIR:$PATH" ;;
    esac
}

repair_custom_claude_wrapper() {
    if [ ! -f "$CUSTOM_CLAUDE_WRAPPER_PATH" ]; then
        return 0
    fi

    custom_wrapper_dir=$(dirname "$CUSTOM_CLAUDE_WRAPPER_PATH")
    echo "Ensuring custom Claude wrapper is executable at $CUSTOM_CLAUDE_WRAPPER_PATH"
    chown node:node "$custom_wrapper_dir" "$CUSTOM_CLAUDE_WRAPPER_PATH" || true
    chmod 700 "$custom_wrapper_dir" || true
    chmod 755 "$CUSTOM_CLAUDE_WRAPPER_PATH" || true
}

if [ -f "$CLAUDE_OAUTH_ENV_FILE" ]; then
    echo "Configuring Claude OAuth wrapper from $CLAUDE_OAUTH_ENV_FILE"
    install_claude_oauth_wrapper
else
    rm -f "$CLAUDE_WRAPPER_PATH"
fi

repair_custom_claude_wrapper

exec gosu node "$@"
