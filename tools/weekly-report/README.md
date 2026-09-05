# Wochenbericht Claude-Code-Arbeit

Erzeugt einen nach Wochentagen sortierten Wochenbericht aus dem WHITESTAG-Vault
und mailt ihn an `ws@whitestag.ai`.

## Was es macht

- Liest pro Tag `~/Obsidian/WHITESTAG-Vault/Tagesprotokolle/yyyy-mm-tt.md`,
  Abschnitt **`## Claude Code`**.
- Ordnet jedem Punkt den passenden Chatverlauf zu
  (`~/Obsidian/WHITESTAG-Vault/Claude Code/<Projekt>/yyyy-mm-tt Chatverlauf *.md`,
  Token-Overlap auf Titel/Tags/Zusammenfassung).
- **Headline** = `HH:MM — Stichwort` (Uhrzeit = Datei-mtime des Chatverlaufs).
- **Subline** = dreizeilige Zusammenfassung des Chatverlaufs, erzeugt vom
  lokalen LM Studio (`gemma-4-31b-it-mlx`, `http://localhost:1234`).
  Fallback bei LLM-Fehler: Frontmatter-`zusammenfassung` → Punkt-Detailtext.
- Versand über `send-walter-report.sh` der Sekretärin (fest an ws@whitestag.ai).

## Nutzung

```bash
# Vorschau (Vorwoche bis gestern), nichts versenden:
python3 weekly_claude_report.py --dry-run

# Bestimmte Woche (7 Tage endend am --end) in Datei:
python3 weekly_claude_report.py --end 2026-06-14 --dry-run --out /tmp/wb.md

# Echter Versand:
python3 weekly_claude_report.py --end 2026-06-14 --send
```

Ohne `--end` = gestern (Montag-Lauf ⇒ Mo–So der Vorwoche).

## Tests

```bash
python3 -m pytest -q
```

## Paperclip-Routine

Wird wöchentlich (Mo 12:00 Europe/Berlin) von der **Sekretärin** ausgeführt
(Projekt „Sekretärin Routinen"). Die Routine weckt die Sekretärin mit dem
Auftrag, `weekly_claude_report.py --send` auszuführen.

## Voraussetzungen

- LM Studio läuft auf `:1234` mit geladenem `gemma-4-31b-it-mlx`
  (sonst greift die Fallback-Kette).
- n8n-Mailhub läuft (für den Versand via `send-walter-report.sh`).
