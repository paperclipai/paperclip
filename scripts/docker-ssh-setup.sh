#!/bin/sh
set -e

CONTAINER="${1:-paperclip-server-1}"
KEY_COMMENT="${2:-paperclip-agent}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEYDIR="$SCRIPT_DIR/../docker/.ssh"
TMPDIR=$(mktemp -d)

echo "Generating SSH key locally..."
ssh-keygen -t ed25519 -C "$KEY_COMMENT" -f "$TMPDIR/id_ed25519" -N ""

echo "Copying key into container '$CONTAINER'..."
docker exec "$CONTAINER" mkdir -p /paperclip/.ssh
docker cp "$TMPDIR/id_ed25519" "$CONTAINER:/paperclip/.ssh/id_ed25519"
docker cp "$TMPDIR/id_ed25519.pub" "$CONTAINER:/paperclip/.ssh/id_ed25519.pub"
docker exec -u root "$CONTAINER" chown -R paperclip:paperclip /paperclip/.ssh
docker exec "$CONTAINER" chmod 700 /paperclip/.ssh
docker exec "$CONTAINER" chmod 600 /paperclip/.ssh/id_ed25519
docker exec "$CONTAINER" sh -c "cat > /paperclip/.ssh/config <<'SSHEOF'
Host github.com
  IdentityFile /paperclip/.ssh/id_ed25519
  StrictHostKeyChecking accept-new
SSHEOF"
docker exec -u root "$CONTAINER" chown paperclip:paperclip /paperclip/.ssh/config
docker exec "$CONTAINER" chmod 600 /paperclip/.ssh/config

mkdir -p "$KEYDIR"
cp "$TMPDIR/id_ed25519" "$KEYDIR/id_ed25519"
cp "$TMPDIR/id_ed25519.pub" "$KEYDIR/id_ed25519.pub"
rm -rf "$TMPDIR"

echo ""
echo "Keys saved locally to docker/.ssh/"
echo ""
echo "Public key (add to GitHub):"
echo "---"
cat "$KEYDIR/id_ed25519.pub"
echo "---"
echo ""
echo "Add this key at: https://github.com/settings/ssh/new"
