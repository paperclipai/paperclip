#!/bin/bash
# Wrapper to run the local fork's paperclipai with workspace-hoisted deps available
# Used by ~/Library/LaunchAgents/ing.paperclip.server.plist

# Set CWD to workspace root so node resolves @paperclipai/* and zod/got/etc from hoisted node_modules
cd /Users/homeoffice/code/paperclip-work/paperclip || exit 1

# Use the same node binary the npm install uses
exec /Users/homeoffice/.nvm/versions/node/v22.22.2/bin/node \
  /Users/homeoffice/code/paperclip-work/paperclip/cli/dist/index.js \
  "$@"
