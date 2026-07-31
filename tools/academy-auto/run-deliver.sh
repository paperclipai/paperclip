#!/bin/zsh
# Morgendliche Zustellung des Academy-Auto-Digests (Telegram).
# Wird von launchd über /bin/zsh aufgerufen (NICHT über das Executable-Bit —
# SynologyDrive flippt Dateimodi beim Sync, das brach schon das seo-geo-Audit).
set -u
cd "$HOME/.paperclip/scripts/academy-auto" || exit 1
echo "=== academy-auto Zustellung $(date '+%Y-%m-%d %H:%M:%S') ==="
exec /usr/bin/python3 -m academy_auto.deliver
