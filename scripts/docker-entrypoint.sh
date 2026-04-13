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
fi

# Always fix ownership of project workspaces — they can be created as root
# at runtime (git clone, worktree ops) and would otherwise block agent writes.
if [ -d /paperclip/instances/default/projects ]; then
    chown -R node:node /paperclip/instances/default/projects
fi

# Fix ownership of agent instruction directories — created as root when new
# agents are provisioned via API, which would block subsequent writes.
if [ -d /paperclip/instances/default/companies ]; then
    chown -R node:node /paperclip/instances/default/companies
fi

# Ensure /app is writable by node. WORKDIR creates /app as root; the COPY
# --chown=node:node populates its contents correctly but leaves the directory
# itself root-owned, blocking runtime writes like /app/.paperclip (codex-home
# fallback). Fix it here so agents can run without a full image rebuild.
chown node:node /app
mkdir -p /app/.paperclip
chown -R node:node /app/.paperclip

# Sync Claude credentials from the host bind-mount (/root/.claude/) into the
# volume home (/paperclip/.claude/) so that agent runs — which use HOME=/paperclip
# — always start with up-to-date OAuth tokens after a host `claude login`.
mkdir -p /paperclip/.claude
for cred_file in .credentials.json credentials.json; do
    src="/root/.claude/$cred_file"
    dst="/paperclip/.claude/$cred_file"
    if [ -f "$src" ]; then
        cp "$src" "$dst"
        chown node:node "$dst"
        echo "Synced $cred_file from host to /paperclip/.claude/"
    fi
done

# Allow the node user to reach the Docker daemon socket (needed for hermes-docker wrapper).
# The socket is mounted from the host and may be owned by root:root with 0660 perms;
# opening it to 0666 lets any user in the container call docker CLI without sudo.
if [ -S /var/run/docker.sock ]; then
    chmod 666 /var/run/docker.sock
fi

exec gosu node "$@"
