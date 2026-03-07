#!/bin/sh
set -e

# Fix ownership of the data volume if it was created by a previous root run
if [ "$(id -u)" = "0" ]; then
  chown -R paperclip:paperclip /paperclip
  exec gosu paperclip "$@"
else
  exec "$@"
fi
