#!/bin/sh
set -e

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
elif [ "$(stat -c '%u:%g' /paperclip)" != "$PUID:$PGID" ]; then
    chown node:node /paperclip
fi

# Seed a default config.json on a fresh volume so first-run admin bootstrap
# (paperclipai auth bootstrap-ceo) works without manual setup. Sources values
# from env vars so the same image works for any deployment.
INSTANCE_ID=${PAPERCLIP_INSTANCE_ID:-default}
CONFIG_PATH=${PAPERCLIP_CONFIG:-/paperclip/instances/$INSTANCE_ID/config.json}
if [ ! -f "$CONFIG_PATH" ]; then
    INSTANCE_DIR=$(dirname "$CONFIG_PATH")
    mkdir -p "$INSTANCE_DIR/db" "$INSTANCE_DIR/logs" "$INSTANCE_DIR/data/backups" "$INSTANCE_DIR/data/storage" "$INSTANCE_DIR/secrets"
    cat > "$CONFIG_PATH" <<EOF
{
  "\$meta": { "version": 1, "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)", "source": "onboard" },
  "database": {
    "mode": "embedded-postgres",
    "embeddedPostgresDataDir": "$INSTANCE_DIR/db",
    "embeddedPostgresPort": 54329,
    "backup": { "enabled": true, "intervalMinutes": 60, "retentionDays": 30, "dir": "$INSTANCE_DIR/data/backups" }
  },
  "logging": { "mode": "file", "logDir": "$INSTANCE_DIR/logs" },
  "server": {
    "deploymentMode": "${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}",
    "exposure": "${PAPERCLIP_DEPLOYMENT_EXPOSURE:-public}",
    "bind": "custom",
    "host": "${HOST:-0.0.0.0}",
    "port": ${PORT:-3100},
    "allowedHostnames": [],
    "serveUi": true,
    "customBindHost": "${HOST:-0.0.0.0}"
  },
  "auth": {
    "baseUrlMode": "${PAPERCLIP_AUTH_BASE_URL_MODE:-explicit}",
    "disableSignUp": false,
    "publicBaseUrl": "${PAPERCLIP_AUTH_PUBLIC_BASE_URL:-}"
  },
  "telemetry": { "enabled": true },
  "storage": {
    "provider": "local_disk",
    "localDisk": { "baseDir": "$INSTANCE_DIR/data/storage" },
    "s3": { "bucket": "paperclip", "region": "us-east-1", "prefix": "", "forcePathStyle": false }
  },
  "secrets": {
    "provider": "local_encrypted",
    "strictMode": false,
    "localEncrypted": { "keyFilePath": "$INSTANCE_DIR/secrets/master.key" }
  }
}
EOF
    chown -R node:node "$INSTANCE_DIR"
    echo "Seeded default config at $CONFIG_PATH"
fi

# Optional SSH access. Started ONLY when the workspace was launched with a
# public key (jade injects it as SSH_AUTHORIZED_KEY) — no key means no
# daemon and no listening port. Key-only auth, node user only, no root,
# no passwords. Host keys are baked into the image at build (ssh-keygen -A).
if [ -n "${SSH_AUTHORIZED_KEY:-}" ]; then
    SSH_HOME=${PAPERCLIP_HOME:-/paperclip}
    mkdir -p "$SSH_HOME/.ssh"
    printf '%s\n' "$SSH_AUTHORIZED_KEY" > "$SSH_HOME/.ssh/authorized_keys"
    chmod 700 "$SSH_HOME/.ssh"
    chmod 600 "$SSH_HOME/.ssh/authorized_keys"
    chown -R node:node "$SSH_HOME/.ssh"
    mkdir -p /run/sshd
    echo "Starting sshd (key-only, user 'node')"
    /usr/sbin/sshd \
        -o PasswordAuthentication=no \
        -o PermitRootLogin=no \
        -o PubkeyAuthentication=yes \
        -o AllowUsers=node \
        -o X11Forwarding=no
fi

exec gosu node "$@"
