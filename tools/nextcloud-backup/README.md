# Auswärts-Sicherung nach Hetzner/Nextcloud

Sichert täglich um **05:00** die Paperclip-Datenbank und den Ordner
`Claude Code MAC` in ein verschlüsseltes restic-Repo bei Hetzner.
launchd-Job `de.whitestag.nextcloud-backup`.

**Warum es das gibt:** Die NAS steht im selben Gebäude wie der Mac. Gegen
Feuer, Diebstahl oder Wasserschaden hilft nur ein Ziel außer Haus. Der
Obsidian-Vault ging dort schon hin, Datenbank und Quelltext nicht.

## Ziel

| | |
|---|---|
| Anbieter | Hetzner Storage Share (gehostetes Nextcloud) |
| Server | `nx92116.your-storageshare.de` |
| Nextcloud-Nutzer | `Obsidian` |
| Repo | `Backups/MacStudio-WHITESTAG/restic-mac-studio` |
| Schlüssel | `~/.restic/repo.pass` |

Es ist **dasselbe Repo wie für den Vault** — es heißt ohnehin nach dem ganzen
Mac. Ein Passwort, ein `prune`, ein `check`, eine Sache zum Überwachen.

## Schlagworte trennen die Datensätze

| Schlagwort | Inhalt | Läuft | Aufbewahrung |
|---|---|---|---|
| `obsidian-vault` | WHITESTAG-Vault | So 03:30 | 7 täglich, 8 wöchentlich, 12 monatlich |
| `paperclip-db` | Datenbank-Dump | tägl. 05:00 | 14 / 8 / 12 |
| `claude-code` | Claude Code MAC | tägl. 05:00 | 14 / 8 / 12 |

**Jeder Datensatz räumt selbst auf, immer mit `forget --tag`.** Ein `forget`
ohne Schlagwortfilter in einem geteilten Repo ist ein Minenfeld — deshalb
wurde am 21.08.2026 auch `~/.restic/backup-vault.sh` auf
`--tag obsidian-vault` umgestellt. Vorher hätte der wöchentliche Vault-Lauf
die Aufbewahrung aller drei Datensätze bestimmt.

## Der Dump ist absichtlich unkomprimiert

`pg_dump -Fc **-Z0**`, also 2,7 GB statt 350 MB. Das klingt verkehrt, ist aber
gemessen (21.08.2026, zwei Dumps, gleiche Zeitabstände):

| | im Repo nach Tag 1 | Zuwachs Tag 2 |
|---|---|---|
| `-Fc` (gzip) | 366 MB | 57,5 MB |
| `-Fc -Z0` (roh) | **287 MB** | **8,4 MB** |

Der rohe Dump ist im Repo **kleiner** — restics zstd schlägt pg_dumps gzip und
kann zusätzlich innerhalb des Dumps deduplizieren, was gzip verhindert. Und er
dedupliziert siebenmal besser. Bei gzip verwürfelt jede Änderung den Bytestrom
dahinter; der Zuwachs wächst dort mit dem Zeitabstand (150 s → 57 MB,
2 h → 163 MB), bei Tagesabstand bleibt praktisch nichts übrig.

Hochgerechnet: komprimiert ~110 GB im Jahr, roh eher 5–15 GB.

Die Sicherung auf der **NAS** bleibt komprimiert — dort sitzt kein restic
dazwischen, da ist Kompression reiner Gewinn.

## Der Umweg über node — nicht wegoptimieren

launchd startet **`/opt/homebrew/bin/node run-nextcloud-backup.js`**:

> macOS verweigert einem launchd-Job aus zsh/bash den Zugriff auf
> **CloudStorage (SynologyDrive)** und auf SMB-Freigaben — „Operation not
> permitted" (TCC). node hat die Berechtigung und vererbt sie an
> Kindprozesse. Am 21.08.2026 für beide Speicherorte unter launchd
> nachgemessen.

## Ausschlussliste

`ausschluss-claude-code.txt`. Grundsatz: raus, was sich aus dem Gesicherten
wiederherstellen lässt — `node_modules` (allein 7,7 GB), `venv`, `dist`,
`__pycache__`, Bauergebnisse, `.DS_Store`, große Binärdateien.

**Die `.git`-Verzeichnisse bleiben drin.** Dort steckt die Historie, und viele
Ordner unter `Claude Code MAC` sind entweder gar keine Repos oder haben kein
Remote — für die ist diese Sicherung die einzige.

`test_ausschluss.py` prüft die Liste gegen **restics echtes Verhalten**, nicht
gegen eine Nachbildung der Musterlogik: ein Miniaturbaum wird gesichert und
danach geschaut, was tatsächlich im Snapshot liegt.

## Zeitplan und Sperren

05:00 — nach der NAS-Sicherung (02:30) und mit Abstand zum Vault-Backup
(sonntags 03:30), das dasselbe Repo sperrt. Alle restic-Aufrufe laufen mit
`--retry-lock 30m`, eine Überschneidung wartet also, statt abzubrechen.

Dazu am **6. jedes Monats um 06:30** die Integritätsprüfung (siehe unten).

## Ist das Repo überhaupt noch heil?

Die tägliche Sicherung meldet nur, ob das **Schreiben** geklappt hat, und der
Wächter schaut ausschließlich auf das **Alter** der Snapshots. Beides bliebe
grün, während das Repo langsam verrottet — bemerkt hätte man es erst bei der
Wiederherstellung, also an dem Tag, an dem es zu spät ist. Bis zum 04.09.2026
hat das nie jemand geprüft.

`pruefe-repo.sh` (Dienst `de.whitestag.repo-pruefung`) macht das monatlich in
zwei Stufen:

1. **`restic check`** — Struktur und Metadaten: Sind alle Bäume und Blöcke,
   auf die ein Snapshot zeigt, vorhanden? Schnell, findet aber **keine**
   gekippten Bits, weil die Daten dabei nie gelesen werden.
2. **`restic check --read-data-subset=<monat>/12`** — liest die Blöcke wirklich
   und rechnet die Prüfsummen nach. Das ist der einzige Test, der stille
   Korruption findet.

Das **rotierende Zwölftel** ist der Kern: jeden Monat ein anderer Abschnitt,
nach zwölf Monaten ist das Repo einmal vollständig gelesen — bei rund 1 GiB
Verkehr pro Lauf statt über 12 GiB auf einmal.

Schlägt die Prüfung an, ist das **kein Betriebsfehler, sondern ein Befund am
Backup selbst**; die Alarmmail sagt das ausdrücklich und nennt als nächsten
Schritt `restic check --read-data` von Hand, dann `restic repair` — und vor
allem: nichts löschen, bevor der Umfang feststeht.

Der Wächter überwacht die Prüfung ihrerseits (Statusdatei, Grenze 45 Tage) —
sonst wäre der Prüfer selbst unbewacht. Eine Prüfung, die Schaden **gefunden**
hat, zählt dabei ausdrücklich nicht als „zuletzt geprüft".

## Bedienung

```bash
./deploy.sh                                     # Repo -> Live, Diff-Prüfung, Tests
bash nextcloud-backup.sh --nur-db               # nur die Datenbank
bash nextcloud-backup.sh --nur-code             # nur den Ordner
bash nextcloud-backup.sh --kein-versand         # ohne Fehlermail
bash pruefe-repo.sh --nur-struktur              # Schnellprüfung, ohne Lesen
bash pruefe-repo.sh --anteil 1/1                # alles lesen (dauert)
python3 -m pytest -q                            # 26 Tests
```

Log: `~/.paperclip/logs/nextcloud-backup.log`,
Stand: `~/.paperclip/logs/nextcloud-backup-last.json`.

## Wiederherstellung

```bash
export RESTIC_REPOSITORY="rclone:hetzner-nc:Backups/MacStudio-WHITESTAG/restic-mac-studio"
export RESTIC_PASSWORD_FILE="$HOME/.restic/repo.pass"
restic snapshots --tag claude-code
restic restore <id> --target /tmp/wiederher
```

Die Datenbank wird als **rohe Dumpdatei** gesichert; nach dem `restore` mit
`pg_restore` einspielen (siehe `tools/paperclip-db-backup/README.md` — dort
steht auch, dass einzelne Tabellen sich nicht isoliert zurückspielen lassen).

## Fallstricke

- **Nie `forget` ohne `--tag`** in diesem Repo. Drei Datensätze teilen es.
- **Nie per bash/zsh in launchd eintragen** — TCC.
- **Der Schlüssel liegt nur auf diesem Mac.** Ohne `~/.restic/repo.pass` ist
  das Auswärts-Backup gegen genau das Szenario wertlos, für das es gedacht
  ist. Er gehört in einen Passwortmanager außerhalb des Geräts.
- **Nextcloud-Passwort geändert?** Dann bricht `~/.config/rclone/rclone.conf`
  und alle Sicherungen in dieses Repo stehen still. Der Wächter meldet es
  nach spätestens 30 Stunden.
