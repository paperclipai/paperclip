# Backup-Wächter

Prüft täglich um **09:00**, ob die Sicherungen noch laufen. launchd-Job
`de.whitestag.backup-waechter`.

**Warum es das gibt:** Das DB-Backup schickt bei einem Abbruch eine Fehlermail.
Das deckt aber nur „läuft und scheitert" ab — **nicht** „läuft gar nicht mehr".
Ein Skript, das nie startet, meldet auch keinen Fehler. Genau so sind hier
schon Dienste wochenlang unbemerkt tot gewesen.

## Was geprüft wird

| Sicherung | Quelle | Läuft | Grenze |
|---|---|---|---|
| Datenbank (NAS) | jüngste `paperclip-*.dump` (mtime) | tägl. 02:30 | **30 Stunden** |
| Datenbank (Nextcloud) | restic-Snapshot, Schlagwort `paperclip-db` | tägl. 05:00 | **30 Stunden** |
| Claude-Code-Ordner | restic-Snapshot, Schlagwort `claude-code` | tägl. 05:00 | **30 Stunden** |
| Vault (Nextcloud) | restic-Snapshot, Schlagwort `obsidian-vault` | So 03:30 | **9 Tage** |

30 Stunden lassen einen verspäteten Lauf durch, schlagen aber an, sobald eine
Nacht ausfällt. Der Vault geht nur sonntags raus, deshalb die großzügigere
Grenze.

Seit dem 21.08.2026 liegen alle drei Nextcloud-Datensätze im **selben** Repo,
getrennt durch Schlagworte. Deshalb wird der Stand je Schlagwort ermittelt und
nicht als „jüngster Snapshot" — sonst verdeckte ein frischer
`claude-code`-Snapshot ein längst totes Vault-Backup.

Geprüft wird die **mtime**, nicht das Datum im Dateinamen: gefragt ist, wann
zuletzt tatsächlich geschrieben wurde. Ein Name lässt sich vergeben, ohne dass
Daten fließen.

## Die wichtigste Regel: unbekannt ≠ gesund

Kann der Wächter einen Stand nicht ermitteln — NAS weg, restic stumm, Ordner
leer — dann ist das **immer ein Alarm**, nie ein stilles „alles gut". Ein
Wächter, der bei fehlender Auskunft schweigt, ist schlimmer als keiner: er
erzeugt Vertrauen, das nichts trägt. Dieselbe Regel wie `None` statt `0` in
`pricing.py`.

## Meldungen

- **Alarm** (jederzeit, wenn etwas nicht stimmt): Mail von `cto@` an `ws@` mit
  Befund und Altersangaben im Klartext.
- **Lebendmeldung** (montags, wenn alles grün ist): kurze Statusmail.
  Der Wächter kann selbst sterben — das einzige verlässliche Gegenmittel ist
  eine erwartete Nachricht, deren **Ausbleiben** auffällt. Kommt montags nichts,
  ist der Wächter tot.

## Der Umweg über node — nicht wegoptimieren

launchd startet **`/opt/homebrew/bin/node run-waechter.js`**, das
`waechter.py` aufruft. Grund wie bei `tools/paperclip-db-backup`:

> macOS verweigert einem launchd-Job aus zsh/bash/python den Zugriff auf
> SMB-Freigaben — der Mount ist sichtbar, Lesen scheitert mit
> **„Operation not permitted"** (TCC). node hat die Berechtigung und vererbt
> sie an Kindprozesse.

## Aufbau

- `pruefung.py` — die Bewertung als **reine Funktionen**, ohne NAS, ohne
  restic, ohne Mail. Nur so sind die Fälle prüfbar, die im Ernstfall zählen
  und die man sonst nie zu Gesicht bekommt.
- `waechter.py` — Stände holen, bewerten, melden.
- `run-waechter.js` — Türöffner für launchd, ohne Logik.

## Bedienung

```bash
./deploy.sh                                   # Repo -> Live, Diff-Prüfung, Tests
python3 waechter.py --kein-versand            # prüfen, ohne zu mailen
python3 waechter.py --heartbeat-erzwingen     # Lebendmeldung sofort schicken
python3 waechter.py --nas /Volumes/GIBTSNICHT # Alarmfall proben
python3 -m pytest -q                          # 19 Tests
```

Log: `~/.paperclip/logs/backup-waechter.log`,
Stand: `~/.paperclip/logs/backup-waechter-last.json`.

## Fallstricke

- **`restic snapshots --latest 1` liefert nicht den jüngsten Snapshot.**
  Es liefert den jüngsten **pro Gruppe** (Host + Pfade). Im Repo liegt neben
  dem Vault-Backup noch ein `setup-test`-Snapshot vom 24.05.2026 — wer blind
  das erste Listenelement nimmt, meldet das Vault-Backup als 89 Tage alt.
  Genau so passiert am 21.08.2026. Deshalb: alle Snapshots holen und **nach
  Tag** auswählen. „Jüngster von allen" wäre ebenfalls falsch — käme ein
  zweites Backup ins Repo, verdeckte dessen frischer Snapshot ein totes
  Vault-Backup.
- **Zeitstempel nicht mit `split('.')[0]` kürzen.** Das schneidet auch den
  Zonenversatz `+02:00` ab und legt die Zeit stillschweigend als Ortszeit aus.
  Nur die Sekundenbruchteile entfernen.
- **Zukunftszeitstempel** (Uhrzeitversatz Mac ↔ NAS) dürfen keinen Fehlalarm
  auslösen — das Alter wird bei 0 gedeckelt.
- **Python 3.9** (launchd fährt `/usr/bin/python3`): kein `X | None`.
