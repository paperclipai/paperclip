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

# Fix ownership where possible (NFS mounts may reject chown — that's OK)
chown -R node:node /paperclip 2>/dev/null || true

# --- SSH server setup (persistent keys on volume) ---
SSH_DIR="/paperclip/.ssh"
mkdir -p "$SSH_DIR"

# Generate host keys on first run (persisted across restarts via bind mount)
if [ ! -f "$SSH_DIR/ssh_host_ed25519_key" ]; then
    echo "Generating SSH host keys (first run)..."
    ssh-keygen -t ed25519 -f "$SSH_DIR/ssh_host_ed25519_key" -N "" -q
    ssh-keygen -t rsa -b 4096 -f "$SSH_DIR/ssh_host_rsa_key" -N "" -q
fi

# Configure sshd: custom port, use persistent host keys, allow node user
mkdir -p /run/sshd
cat > /etc/ssh/sshd_config.d/paperclip.conf << SSHCONF
Port 2222
HostKey $SSH_DIR/ssh_host_ed25519_key
HostKey $SSH_DIR/ssh_host_rsa_key
AuthorizedKeysFile $SSH_DIR/authorized_keys
PermitRootLogin no
AllowUsers node
PasswordAuthentication no
PrintMotd no
AcceptEnv LANG LC_* PAPERCLIP_* CLAUDE_* ANTHROPIC_* OPENAI_* GITHUB_*
SSHCONF

# Set up authorized_keys from volume (persisted)
if [ ! -f "$SSH_DIR/authorized_keys" ]; then
    touch "$SSH_DIR/authorized_keys"
fi
chmod 700 "$SSH_DIR"
chmod 600 "$SSH_DIR/authorized_keys" "$SSH_DIR/ssh_host_"* 2>/dev/null || true
chown -R node:node "$SSH_DIR" 2>/dev/null || true

# Set node user shell to bash
usermod -s /bin/bash node 2>/dev/null || true

# Create node user's .ssh symlink so standard SSH paths work
mkdir -p /paperclip/.ssh_user
ln -sf "$SSH_DIR/authorized_keys" /paperclip/.ssh_user/authorized_keys
# Also ensure ~/.ssh works for the node user
su -s /bin/sh node -c "mkdir -p /paperclip/.ssh && ln -sf $SSH_DIR/authorized_keys /paperclip/.ssh/authorized_keys" 2>/dev/null || true

# Start sshd in background (runs as root, sessions drop to node via AllowUsers)
/usr/sbin/sshd -e 2>&1 &
echo "SSH server started on port 2222"

exec gosu node "$@"
