# LLM-Nutzungs-Report

Täglicher Report über die LLM-Nutzung der Paperclip-Agenten: eine Mail an
`ws@whitestag.ai` mit 7-Tage-Excel im Anhang, plus eine Tagesnotiz im
Obsidian-Vault. Rein deterministisch, kein LLM beteiligt.

Läuft als launchd-Job `de.whitestag.llm-usage-digest` täglich um **08:00** für
den **Vortag**.

## Datenquelle und Grenzen

Ausschließlich `cost_events` der Paperclip-DB (embedded Postgres auf `:54329`),
Zeitzone Europe/Berlin. **Nicht** erfasst: n8n-AI-Nodes, PII-Proxy,
LM-Studio-Direktnutzung und Claude Code selbst.

Kosten werden aus den Token gerechnet (`pricing.py`), **nicht** aus
`cost_events.cost_cents` — diese Spalte füllt Paperclip für Anthropic-Modelle
nicht, sie steht dort immer auf 0. Grundregel gegen stille Untererfassung:
lokale Modelle kosten 0, ein unbekanntes `claude-*`-Modell kostet `None` und
taucht im Report als „Preis nicht hinterlegt" auf.

## Module

| Datei | Zweck |
| --- | --- |
| `query.py` | Alle SQL-Abfragen gegen `cost_events` |
| `pricing.py` | Preistabelle inkl. Einführungspreisen mit Ablaufdatum |
| `digest.py` | Tagesmail (HTML) + Anstoß für Excel und Vault-Notiz |
| `build_xlsx.py` | 7-Tage-Excel mit Detailtabellen und Grafiken |
| `vault_note.py` | Baut die Obsidian-Tagesnotiz (rein, ohne I/O) |
| `vault_writer.py` | Schreibt Notiz und kumulative CSV in den Vault |
| `backfill.py` | Zieht Vault-Notizen für vergangene Tage nach |
| `run.sh` | Einstiegspunkt für launchd |

## Vault-Export

Ziel: `WHITESTAG-Vault/Analysen/LLM-Nutzung/`

- `LLM-Nutzung <datum>.md` — eine Notiz je Tag. Tagessummen als nackte Zahlen
  im Frontmatter (Dataview-auswertbar), im Body Tabellen je Modell, je Agent
  und Agent × Modell.
- `_daten/llm-nutzung.csv` — kumulativ, eine Zeile je Tag/Agent/Modell.
  Dataview kommt an Body-Tabellen nicht heran; Agenten-Auswertungen über
  längere Zeiträume laufen deshalb über diese Datei.
- `LLM-Nutzung.md` — Index mit fertigen Dataview-Abfragen.

Der Dateiname lautet `LLM-Nutzung <datum>.md` und nicht `<datum>.md`, weil es
unter `Tagesprotokolle/` bereits Notizen dieses Namens gibt und Obsidian-Links
sonst zweideutig wären.

**Warum das existiert:** Der E-Mail-Spiegel im Vault trägt nur den Betreff —
`digest.py` setzt `"text": subject`, die Zahlen stecken allein im HTML-Teil.
Im Vault war deshalb nichts auswertbar. Zugleich ist diese Notizreihe die
einzige Kopie der Kostenhistorie außerhalb der Paperclip-DB: die hat keinen
Backup-Job, und das Löschen eines Mandanten nimmt dessen `cost_events` mit
(`server/src/services/companies.ts`).

## Bedienung

```bash
./deploy.sh                              # Repo -> Live, mit Diff-Prüfung und Tests
python3 digest.py --dry-run              # Mail zeigen, nichts senden, nichts schreiben
python3 digest.py --day 2026-08-19       # bestimmten Tag nachfahren (sendet!)
python3 backfill.py --dry-run            # zeigen, welche Tage nachgezogen würden
python3 backfill.py --von 2026-07-01     # Vault-Notizen nachziehen, ohne Mail
python3 -m pytest -q                     # 35 Tests
```

`--dry-run` schreibt weder Mail noch Vault. `backfill.py` verschickt nie etwas.
Beide Schreibwege sind idempotent: ein wiederholter Lauf überschreibt die Notiz
und ersetzt die CSV-Zeilen des Tages, statt sie zu verdoppeln.

## Fallstricke

- **Python 3.9.** launchd fährt `/usr/bin/python3` — kein `X | None`, kein
  `match`. PyYAML ist dort nicht installiert, das Frontmatter wird deshalb von
  Hand gebaut.
- **`state/` nicht deployen.** Dort liegt das XLSX-Archiv; `deploy.sh` schließt
  es aus, `--delete` würde es sonst löschen.
- **Tests gehören mitdeployt.** Ein Deploy ohne `test_*.py` nimmt dem
  Live-Stand die Fähigkeit zu merken, dass ihm etwas fehlt.
- **Neues Anthropic-Modell?** Preis in `pricing.py` ergänzen, sonst weist der
  Report zu wenig aus — sichtbar an `kosten_unvollstaendig: true` im
  Frontmatter und am roten Hinweis in der Mail.
