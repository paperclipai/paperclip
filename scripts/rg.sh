#!/bin/sh
# rg wrapper — prevents ripgrep from consuming unbounded memory.
# Enforces --max-filesize (skip huge files) and --max-columns (skip long lines).
# The real binary lives at /usr/local/lib/paperclip/rg-real.
exec /usr/local/lib/paperclip/rg-real \
  --max-filesize 10M \
  --max-columns 10000 \
  --max-columns-preview \
  --max-count 500 \
  "$@"
