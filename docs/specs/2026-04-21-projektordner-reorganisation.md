---
name: Projektordner-Reorganisation
description: Konzept zur Reorganisation des Paperclip-Root-Verzeichnisses nach Subprojekten
status: Entwurf zur Freigabe
---

# Projektordner-Reorganisation — Konzept

**Datum:** 2026-04-21
**Ziel:** Die lose im Root liegenden Dokumentationen, Chatverläufe und n8n-Workflows werden nach Subprojekten sortiert, ohne den Upstream-Paperclip-Code zu berühren.

## Ausgangslage

Im Root-Verzeichnis liegen aktuell vermischt:

- **Upstream-Paperclip-Dateien** (Fork aus Original-Repo): `cli/`, `doc/`, `docker/`, `docs/`, `evals/`, `packages/`, `server/`, `tests/`, `ui/`, `package.json`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `Dockerfile`, `LICENSE`, `SECURITY.md`, `tsconfig*.json`, `vitest.config.ts`, `pnpm-*`, `.github/`, `.env.example` usw. → **bleiben unangetastet** (sonst Merge-Konflikte mit Upstream).
- **Eigene Code-Pakete** mit eigenen Ordnern: `paperclip-adapter-lmstudio/`, `paperclip-dpo/`, `paperclip-i18n/` → **bleiben unangetastet**.
- **11 Chatverläufe** (`2026-04-17…` bis `2026-04-21…`)
- **6 Konzept-/Planungs-Markdowns** (`DSGVO Agent.md`, `LLM-Empfehlungen Paperclip-Agenten.md`, `Obsidian-Paperclip-Integration.md`, `Paperclip-Anleitung.md`, `Paperclip-Anpassungen.md`, `adapter-plugin.md`)
- **4 n8n-Workflow-JSONs** (Luna Voice V10, Paperclip CEO V1/V2/V3)
- **1 SQL-Dump** (`paperclip_chat_memory.sql`)
- **1 Artefakt** `smb:/` (zu prüfen und ggf. entfernen)

## Zielstruktur (Variante C: Hybrid)

```
Paperclip/
│
├── [Upstream-Paperclip]            ← unangetastet
│   ├── cli/  doc/  docker/  docs/  evals/
│   ├── packages/  server/  tests/  ui/
│   ├── README.md  AGENTS.md  CONTRIBUTING.md
│   └── package.json  tsconfig*.json  …
│
├── paperclip-adapter-lmstudio/     ← eigener Code (inkl. Fallback-Logik)
├── paperclip-dpo/                  ← eigener Code (DSGVO-Agent)
├── paperclip-i18n/                 ← eigener Code (de-Übersetzungen)
│
├── projekte/                       ← NEU: alles Nicht-Code, nach Subprojekt sortiert
│   ├── adapter-lmstudio/
│   │   ├── README.md
│   │   ├── adapter-plugin.md
│   │   ├── 2026-04-17 Chatverlauf Eindeutschung und LM Studio Adapter.md
│   │   └── 2026-04-21 Chatverlauf LM Studio Fallback-LLM.md
│   │
│   ├── dpo/
│   │   ├── README.md
│   │   ├── DSGVO Agent.md
│   │   └── 2026-04-21 Chatverlauf DPO Agent.md
│   │
│   ├── i18n/
│   │   └── README.md
│   │
│   ├── obsidian/
│   │   ├── README.md
│   │   ├── Obsidian-Paperclip-Integration.md
│   │   └── 2026-04-20 Chatverlauf Obsidian-Brain.md
│   │
│   ├── spracheingabe/
│   │   ├── README.md
│   │   └── 2026-04-21 Chatverlauf Spracheingabe Mac PC.md
│   │
│   ├── n8n-workflows/
│   │   ├── README.md
│   │   ├── Luna Voice + Telegram V10.json
│   │   ├── Paperclip CEO - Voice & Telegram V1.json
│   │   ├── Paperclip CEO - Voice & Telegram V2.json
│   │   ├── Paperclip CEO - Voice & Telegram V3.json
│   │   ├── 2026-04-19 Chatverlauf Paperclip Telegram + Luna.md
│   │   ├── 2026-04-21 Chatverlauf Cloudflare-Umstellung und V3-Fixes.md
│   │   └── proben/                 ← bisher Root-Ordner n8n-Proben/
│   │
│   └── sonstiges/
│       ├── README.md
│       ├── cloudflare/
│       │   ├── 2026-04-17 Chatverlauf Cloudflare-Whitepaper.md
│       │   └── 2026-04-19 Chatverlauf Cloudflare-Umzug und Access.md
│       ├── paperclip-allgemein/
│       │   ├── Paperclip-Anleitung.md
│       │   ├── Paperclip-Anpassungen.md
│       │   ├── LLM-Empfehlungen Paperclip-Agenten.md
│       │   ├── 2026-04-17 Chatverlauf Modell-Zuordnung Doku.md
│       │   ├── 2026-04-20 Chatverlauf Paperclip LLM-Zuordnung und Agent-Setup.md
│       │   └── 2026-04-20 Chatverlauf Chiefs Delegation und Adapter-Fix.md
│       └── archiv/
│           └── paperclip_chat_memory.sql
│
├── Angebotsvorlagen/               ← bleibt (Kundenvorlagen WHITESTAG.AI/FILM)
├── Dokumente/                      ← bleibt (Kundendokumente WHITESTAG.AI/FILM)
└── skills/                         ← bleibt (Custom Skills)
```

## Die sechs Subprojekte

| Subprojekt | Code-Paket | Nicht-Code-Ordner | Inhaltsfokus |
|---|---|---|---|
| Paperclip Adapter LM Studio | [paperclip-adapter-lmstudio/](paperclip-adapter-lmstudio/) | `projekte/adapter-lmstudio/` | Adapter-Plugin + Fallback-Endpoint |
| Paperclip DPO | [paperclip-dpo/](paperclip-dpo/) | `projekte/dpo/` | DSGVO-Agent |
| Paperclip i18n | [paperclip-i18n/](paperclip-i18n/) | `projekte/i18n/` | Deutsche Übersetzungen |
| Paperclip Obsidian | — | `projekte/obsidian/` | Obsidian-Brain-Integration |
| Spracheingabe PC und Mac | — | `projekte/spracheingabe/` | Diktier-Input Mac/PC |
| n8n-Workflows | — | `projekte/n8n-workflows/` | Luna-/CEO-Telegram-Voice-Flows |
| (Sammelordner) | — | `projekte/sonstiges/` | Cloudflare, Paperclip-Allgemein, Archiv |

## README-Template (pro Subprojekt-Ordner)

Jeder `projekte/<name>/`-Ordner bekommt eine kurze `README.md` nach diesem Muster:

```markdown
# <Subprojektname>

**Worum geht's:** <1-2 Sätze>

**Zugehöriger Code:** [paperclip-xyz/](../../paperclip-xyz/)   ← falls vorhanden, sonst weglassen

**Inhalt dieses Ordners:**
- Konzepte/Planungsdokumente
- Chatverläufe (Session-Zusammenfassungen)
- Workflow-Exporte/Konfigs (falls relevant)

**Verwandte Skills:** <z.B. whitestag-dsgvo, falls relevant>
```

## Anpassung der Globalregel (`~/.claude/CLAUDE.md`)

Aktuelle Regel: *"Session-Ende – Chatverlauf erstellen … Speicherort: Wurzelverzeichnis des aktuellen Projekts"*.

**Vorgeschlagene Änderung:** Speicherort = passender `projekte/<subprojekt>/`-Ordner — basierend auf dem Schlagwort des Verlaufs. Wenn unklar oder themenübergreifend: `projekte/sonstiges/`. Wenn gar nichts passt, Fallback auf Projekt-Wurzel (wie bisher) und in der nächsten Session einsortieren.

Ich empfehle, diese Regel nach Freigabe des Konzepts zu aktualisieren, damit künftige Chatverläufe direkt am richtigen Platz entstehen.

## Migrations-Schritte (Reihenfolge)

1. `projekte/`-Grundstruktur anlegen (alle Ordner inkl. Unterordner unter `sonstiges/`).
2. Dateien per `git mv` verschieben (damit Git die Historie als Rename erkennt). Da die meisten losen Dateien **untracked** sind, werden sie per normalem `mv` verschoben und anschließend committet.
3. `n8n-Proben/` → `projekte/n8n-workflows/proben/` verschieben.
4. README pro Subprojekt-Ordner anlegen.
5. `smb:/` prüfen — wenn leer/unnötig, entfernen.
6. `~/.claude/CLAUDE.md` anpassen (Chatverlauf-Speicherort).
7. Commit: `chore: Projektordner nach Subprojekten reorganisieren`.

## Nicht-Ziele (YAGNI)

- **Kein** Anfassen von Upstream-Paperclip-Dateien.
- **Kein** Umbau der bestehenden Code-Pakete `paperclip-adapter-lmstudio/`, `paperclip-dpo/`, `paperclip-i18n/`.
- **Kein** Umbau von `Angebotsvorlagen/`, `Dokumente/`, `skills/` (die haben bereits eine klare eigene Struktur nach WHITESTAG.AI/FILM bzw. Skill-Namen).
- **Keine** Zusammenführung von `projekte/adapter-lmstudio/` und einem separaten "LLM-Fallback"-Ordner — Fallback bleibt thematisch beim Adapter.

## Offene Punkte zur Freigabe

1. Ist die Zuordnung aller Dateien aus der Tabelle oben so korrekt?
2. Soll `smb:/` sofort gelöscht werden oder erst nach deiner Sichtprüfung?
3. Soll die Migration in einem einzigen Commit laufen oder lieber in Schritten (erst Struktur, dann je Subprojekt ein Commit)?
