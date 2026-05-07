#!/bin/sh
set -e

# Configurar o open code com api key da z.zi
mkdir -p /paperclip/.local/share/opencode
if [ -n "$ZAI_API_KEY" ]; then
  cat > /paperclip/.local/share/opencode/auth.json <<EOF
{
  "z-ai": {
    "apiKey": "$ZAI_API_KEY"
  }
}
EOF
  chown -R node:node /paperclip/.local
fi

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

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

exec gosu node "$@"
