#!/usr/bin/env bash
set -Eeuo pipefail

export HOME=/home/ubuntu
export USER=ubuntu

export PAPERCLIP_HOME=/home/ubuntu/.paperclip
export PAPERCLIP_INSTANCE_ID=default

# Local trusted mode: loopback only. Access through SSH tunnel.
export HOST=127.0.0.1
export PORT=3100
export PAPERCLIP_API_URL=http://127.0.0.1:3100
export PAPERCLIP_RUNTIME_API_URL=http://127.0.0.1:3100

unset BETTER_AUTH_URL
unset BETTER_AUTH_BASE_URL
unset PAPERCLIP_AUTH_PUBLIC_BASE_URL

export NVM_DIR=/home/ubuntu/.nvm
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

export PATH=/home/ubuntu/.nvm/versions/node/v24.16.0/bin:/home/ubuntu/.local/bin:/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

cd /home/ubuntu/paperclip

case "$(pwd -P)" in
  /home/ubuntu/paperclip) ;;
  *) echo "Refusing to start from wrong checkout: $(pwd -P)" >&2; exit 1 ;;
esac

exec pnpm paperclipai run
