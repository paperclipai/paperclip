# Vault-Spiegel auf die NAS

Spiegelt täglich um **04:00** den Obsidian-Vault auf die NAS.
launchd-Job `de.whitestag.vault-nas-sync`.

**Warum es das gibt:** Der Vault lag als **einzige** Kopie außerhalb des Macs
in der Hetzner-Nextcloud. Die vermeintliche NAS-Spiegelung existierte nicht —
unter `/Volumes/WHITESTAG-ARCHIV/Obsidian/` lag nur ein 212-KB-Torso aus der
Migration vom Mai 2026. Synology Drive spiegelt ausschließlich
`~/Library/CloudStorage/SynologyDrive-Mac/`, und `~/Obsidian` liegt außerhalb
davon. Aufgefallen ist das erst am 22.08.2026, drei Monate später.

| | |
|---|---|
| Quelle | `~/Obsidian/WHITESTAG-Vault` |
| Ziel | `/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault` |
| Umfang | 47.568 Dateien, 5,1 GB |

## Ein Spiegel ist kein Backup

rsync zieht Löschungen nach: was im Vault verschwindet, verschwindet beim
nächsten Lauf auch auf der NAS. Deshalb wandert alles, was **ersetzt oder
gelöscht** wird, in einen datierten Auffangordner `_geloescht/<datum>/`, statt
zu verschwinden. Erst das macht den Spiegel gegen Fehlgriffe und
Verschlüsselung brauchbar.

Zusätzlich hat die NAS-Freigabe einen eigenen Papierkorb (`#recycle`).

## Schutz vor dem gefährlichsten Fall

Ein `rsync --delete` mit nicht eingehängter oder leerer Quelle würde das Ziel
**leerräumen**. Dagegen zwei Sperren, beide **vor** dem ersten Schreibzugriff:

1. Quelle muss existieren.
2. Quelle muss mehr als `MINDEST_DATEIEN` (100) Dateien haben.

`--mindest` senkt die Schwelle nur für Tests; im Betrieb bleibt es bei 100.

## Fallstricke, teuer gelernt

**`/usr/bin/rsync` ist openrsync, kein GNU rsync.** macOS liefert dort Apples
Nachbau aus („rsync version 2.6.9 compatible"). Der ignoriert `--delete`
zusammen mit `--backup-dir` **stillschweigend** — kein Fehler, kein Hinweis,
es passiert einfach nichts. Der Spiegel hätte nie etwas entfernt und nie etwas
aufgefangen; aufgefallen wäre es erst bei der Wiederherstellung. Das Skript
benutzt deshalb `/opt/homebrew/bin/rsync` und **prüft beim Start**, dass es
echtes GNU rsync ≥ 3 vor sich hat.

**`--partial` ist die falsche Wahl, `--partial-dir` die richtige.** `--partial`
lässt Bruchstücke am Zielort liegen. Der nächste Versuch hält sie für echten
Inhalt, schiebt sie in den Auffangordner und überträgt neu — nach drei
Fehlversuchen standen so 7.900 Bruchstücke (455 MB) in `_geloescht/`, und der
Auffangordner war als Diagnosewerkzeug wertlos.

**SMB reißt unter Dauerlast ab.** Die Fehler wandern: erst `.git/index`, dann
`.state.json`, dann eine Rechnung — jeweils „Input/output error" oder
„Operation timed out", und jede Datei ließ sich einzeln anstandslos kopieren.
Deshalb `--partial-dir` plus **drei Anläufe** mit 20 s Pause. Ein dauerhaft
kaputtes Ziel bricht nach dem dritten Versuch ab, statt bis zum Morgen zu
kreisen.

**Die volle rsync-Ausgabe gehört ins Log.** Welche *einzelnen* Dateien
scheitern, steht nur in `~/.paperclip/logs/vault-nas-sync-rsync.log`. Ohne die
ist ein Fehlschlag nicht diagnostizierbar — genau daran hing die Fehlersuche
am 22.08.2026 stundenlang fest.

## Erstbefüllung

Für den ersten Lauf ist dieses Skript das **falsche** Werkzeug: `--delete` und
`--backup` auf einem noch unvollständigen Ziel erzeugen nur Aufruhr, und bei
47.568 Dateien am Stück reißt SMB zuverlässig ab. Statt dessen **ordnerweise**
befüllen, ohne `--delete` und ohne `--backup`:

```bash
cd ~/Obsidian/WHITESTAG-Vault
for E in .* *; do
  case "$E" in .|..|_geloescht|.rsync-partial|.trash) continue ;; esac
  /opt/homebrew/bin/rsync -a --partial-dir=.rsync-partial \
    --exclude ".DS_Store" --exclude "._*" --exclude ".trash/" \
    --exclude ".obsidian/workspace*.json" --exclude ".obsidian/cache/" \
    --exclude "_geloescht/" --exclude ".rsync-partial/" \
    "$PWD/$E" "/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault/"
done
```

So lief es am 22.08.2026 durch: 54 Ordner, **null Fehler**. Monolithisch
scheiterte derselbe Vorgang dreimal hintereinander.

## Was ausgeschlossen wird

`.DS_Store`, `._*`, `.trash/`, `.obsidian/workspace*.json`, `.obsidian/cache/`.
**`.obsidian/` selbst bleibt** (Einstellungen und Plugins), ebenso `.git/`
(179 MB Historie).

## Bedienung

```bash
./deploy.sh                                    # Repo -> Live, Diff-Prüfung, Tests
bash vault-nas-sync.sh --kein-versand          # Lauf ohne Fehlermail
bash vault-nas-sync.sh --probe                 # Trockenlauf
python3 -m pytest -q                           # 10 Tests
```

Log: `~/.paperclip/logs/vault-nas-sync.log`,
rsync-Details: `…-rsync.log`, Stand: `…-last.json`.

Der Wächter (`tools/backup-waechter`) liest die Statusdatei und schlägt Alarm,
wenn länger als 30 Stunden kein **erfolgreicher** Lauf gemeldet wurde. Ein
gescheiterter Lauf zählt ausdrücklich nicht als frisch, auch wenn sein
Zeitstempel jung ist.
