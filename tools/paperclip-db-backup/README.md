# Paperclip-DB-Backup

Tägliche Sicherung der Paperclip-Datenbank auf die NAS. launchd-Job
`de.whitestag.paperclip-db-backup`, täglich **02:30**.

**Warum es das gibt:** Die Paperclip-Datenbank (embedded Postgres 18.1 auf
`:54329`, rund 2,7 GB) hatte bis zum 21.08.2026 **kein Backup** — kein
launchd-Job, kein Dump, nichts. Dort liegen Agenten, Issues, Projekte, Ziele,
Heartbeat-Läufe und die komplette Kostenhistorie. Der Vault wird wöchentlich
per restic nach Hetzner gesichert, die Datenbank lief ungesichert mit.

## Der Umweg über node — nicht wegoptimieren

launchd startet **`/opt/homebrew/bin/node run-backup.js`**, das seinerseits
`backup-db.sh` aufruft. Das sieht überflüssig aus, ist es aber nicht:

> macOS verweigert einem launchd-Job aus zsh/bash den Zugriff auf
> SMB-Freigaben. Der Mount ist sichtbar, `ls` und Schreiben scheitern mit
> **„Operation not permitted"** (TCC). Am 21.08.2026 mit einer Sonde unter
> launchd nachgemessen.

`node` hat die Berechtigung und **vererbt sie an Kindprozesse** — ebenfalls
nachgemessen. node ist reiner Türöffner und enthält bewusst keine Logik.
Dasselbe Muster nutzt `sync-clara-mirror.js` für `/Volumes/homes`.

## Ablauf

1. `pg_dump -Fc` lokal nach `~/.paperclip/backups/db/` (rund 350 MB, 21 s).
   Lokal und nicht direkt auf die NAS: schneller, und ein SMB-Aussetzer kann
   so keine halbe Datei im Zielordner hinterlassen.
2. `pg_dumpall --globals-only` — Rollen und Rechte. Ohne sie lässt sich der
   Dump lesen, aber nicht sauber in eine frische Instanz einspielen.
3. **Verifikation** des lokalen Dumps (`verifiziere.sh`).
4. Kopie auf die NAS unter der Endung `.teil`.
5. **Verifikation der Kopie am Ziel** — nicht des Originals. SMB reißt unter
   Last ab, und eine halb übertragene Datei sieht im Verzeichnis vollständig aus.
6. Erst jetzt Umbenennen auf den endgültigen Namen.
7. **Erst danach** Aufbewahrung (`prune.sh`). Eine kaputte Sicherung darf
   niemals eine heile ersetzen, und ein Fehlschlag löscht nie etwas.

## Verifikation — zwei Stufen, beide nötig

`verifiziere.sh` prüft mit `pg_restore --list` **und** mit
`pg_restore -f /dev/null`. Die zweite Stufe ist nicht optional:

> Das Inhaltsverzeichnis des custom-Formats steht am **Anfang** der Datei.
> Ein **abgeschnittener** Dump besteht `--list` deshalb anstandslos. Erst das
> vollständige Auslesen fällt durch. Kostet beim 350-MB-Dump 1,9 s.

## Aufbewahrung

`prune.sh <verzeichnis> <täglich> <monatlich>` — 30 tägliche Sicherungen plus
die 24 jüngsten **Monatsersten**, also rund zwei Jahre Historie für ~19 GB.
Angefasst wird ausschließlich das Muster `paperclip-<datum>.dump` samt
zugehöriger `paperclip-globals-<datum>.sql`; alles andere im Zielordner bleibt
unberührt.

Das ist der einzige Teil, der **löscht** — deshalb steht er als eigenes,
gegen echte Dateien getestetes Skript da.

## Ziel und Zeitplan

- NAS: `/Volumes/WHITESTAG-ARCHIV/Backup Mac Studio M4 Max/paperclip-db/`
- Lokal: `~/.paperclip/backups/db/` (die letzten 2, für schnelle Wiederherstellung)
- Log: `~/.paperclip/logs/paperclip-db-backup.log`
- Stand: `~/.paperclip/logs/paperclip-db-backup-last.json`
- 02:30 — frei zwischen Vault-Tagger (00:00) und Vault-Backup (03:30)

## Alarm

Jeder Abbruch geht als Mail von `cto@` an `ws@` über den n8n-Mailhub, mit den
letzten 25 Logzeilen. Der Versand selbst wird mitgeloggt (`HTTP 200`) — ein
Alarm, von dem man nicht weiß, ob er ankam, ist keiner.

**Restvorbehalt:** Das deckt „Job läuft und scheitert" ab, **nicht** „Job
feuert gar nicht mehr". Dafür bräuchte es einen zweiten Wächter, der das Alter
der jüngsten Sicherung prüft. Bewusst nicht gebaut.

## Wiederherstellung

Am 21.08.2026 einmal vollständig durchgespielt: 98 Tabellen, 23 s, keine
Fehler; Zeilenzahlen stimmten bei allen geprüften Tabellen mit der Live-DB
überein (die eine Abweichung in `activity_log` war der normale Zeitversatz
eines Schnappschusses einer laufenden Datenbank).

```bash
export PGPASSWORD=paperclip
D="/Volumes/WHITESTAG-ARCHIV/Backup Mac Studio M4 Max/paperclip-db/paperclip-<datum>.dump"
psql  -h 127.0.0.1 -p 54329 -U paperclip -d postgres -c "CREATE DATABASE wiederher;"
# Rollen zuerst, sonst fehlen Eigentümer und Rechte:
psql  -h 127.0.0.1 -p 54329 -U paperclip -d postgres -f paperclip-globals-<datum>.sql
pg_restore -h 127.0.0.1 -p 54329 -U paperclip -d wiederher --jobs=4 "$D"
```

Einzelne Tabellen lassen sich **nicht** sinnvoll isoliert zurückspielen — die
Fremdschlüssel der übrigen 96 Tabellen schlagen dann zu. Immer vollständig
wiederherstellen und danach herauskopieren, was gebraucht wird.

## Bedienung

```bash
./deploy.sh                                    # Repo -> Live, Diff-Prüfung, Tests
bash backup-db.sh --kein-versand               # Lauf ohne Fehlermail (zum Testen)
bash backup-db.sh --ziel /tmp/probe            # in einen anderen Ordner sichern
python3 -m pytest -q                           # 15 Tests
launchctl kickstart -k gui/$UID/de.whitestag.paperclip-db-backup
```

## Fallstricke

- **Nie per bash/zsh in launchd eintragen.** Siehe oben — der Zugriff auf die
  NAS scheitert dann still an TCC.
- **`set -o pipefail` und `grep -q` vertragen sich nicht.** `grep -q` steigt
  beim ersten Treffer aus, `echo` bekommt SIGPIPE und endet mit 141, und
  `pipefail` reicht die 141 durch — die Prüfung schlägt fehl, **weil** sie
  erfolgreich war. Trat am 21.08. genau so auf und nur bei großen Archiven,
  weil `echo` bei kurzer Ausgabe fertig schreibt, bevor `grep` aussteigt.
  Deshalb Here-String statt Pipe.
- **Die NAS steht im selben Gebäude wie der Mac.** Gegen Feuer oder Einbruch
  hilft nur ein Ziel außer Haus (das Hetzner-Repo, in dem schon der Vault
  liegt). Bewusst noch nicht angebunden.
