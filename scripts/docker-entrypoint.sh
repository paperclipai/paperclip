#!/bin/sh
set -e

# Hugging Face Docker Spaces stability guard.
# HF Space Variables can override Dockerfile ENV. Stale values like:
# PORT=7860, PAPERCLIP_BIND=lan, PAPERCLIP_DEPLOYMENT_EXPOSURE=private
# can make HF show Running while the public UI stays stuck on Application loading.
if [ "${PAPERCLIP_DISABLE_HF_RUNTIME_GUARD:-false}" != "true" ]; then
  export PORT=8080
  export HOST=0.0.0.0
  export SERVER_HOST=0.0.0.0
  export SERVE_UI=true
  export PAPERCLIP_BIND=public
  export PAPERCLIP_DEPLOYMENT_MODE=authenticated
  export PAPERCLIP_DEPLOYMENT_EXPOSURE=public
  export PAPERCLIP_MIGRATION_AUTO_APPLY=true
  export HEARTBEAT_SCHEDULER_ENABLED=false
  export PAPERCLIP_DB_BACKUP_ENABLED=false
  export PAPERCLIP_FAST_START=true
fi

# Render runs this image as the non-root node user because the Dockerfile has USER node.
# In that case, switching again with gosu causes: failed switching to "node": operation not permitted.
# If the container is ever started as root, keep the old safe behavior and drop to node.
if [ "$(id -u)" = "0" ]; then
  PUID=${USER_UID:-1000}
  PGID=${USER_GID:-1000}
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
fi

exec "$@"
