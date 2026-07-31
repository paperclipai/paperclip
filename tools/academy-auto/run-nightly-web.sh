#!/bin/zsh
# Nächtlicher academy-auto-Lauf für die Stufe-1-Marketing-Site (Astro).
# Wird von launchd über /bin/zsh aufgerufen (NICHT über das Executable-Bit —
# SynologyDrive flippt Dateimodi beim Sync, das brach schon das seo-geo-Audit).
#
# Läuft eine Stunde nach dem ki-kompass-Lauf, damit sich die beiden nicht um
# CPU und LM-Studio streiten.
set -u
cd "$HOME/.paperclip/scripts/academy-auto" || exit 1
echo "=== academy-auto-web Lauf $(date '+%Y-%m-%d %H:%M:%S') ==="
exec /usr/bin/python3 -m academy_auto.orchestrator --target web
