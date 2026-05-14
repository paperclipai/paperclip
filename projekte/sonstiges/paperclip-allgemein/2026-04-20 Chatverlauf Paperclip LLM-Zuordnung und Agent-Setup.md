# 2026-04-20 · Paperclip LLM-Zuordnung und Agent-Setup

## Ausgangslage

Walter wollte für seine 19 WHITESTAG-Paperclip-Agenten testen, welche lokalen und Cloud-LLMs am besten geeignet sind. Zur Verfügung:

- **Cloud:** Claude Opus 4.7, Sonnet 4.6, Haiku 4.5
- **Mac M4 Max (LM Studio localhost:1234):** qwen2.5-32b-instruct-mlx, google/gemma-4-26b-a4b, mistral-small-3.2-24b-instruct-2506, qwen/qwen3.6-35b-a3b
- **Windows (LM Studio 192.168.2.181:1234):** qwen/qwen3.6-35b-a3b

Der Obsidian-Vault liegt auf `/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault/`.

## Was wurde gemacht

### 1. LLM-Empfehlungen + initiale Zuordnung
- [LLM-Empfehlungen Paperclip-Agenten.md](LLM-Empfehlungen Paperclip-Agenten.md) erstellt
- Initial: 7 Claude-Agenten (CEO Opus, Drehbuch Opus, 5 × Sonnet) + 12 lokale Agenten
- Im Verlauf: Walter testete lokale Modelle, war zufrieden, ersetzte 5 weitere C-Level-Rollen durch qwen3.6-35b-a3b
- Finaler Stand: Nur noch Drehbuch auf Claude Opus 4.7, alle anderen 18 lokal

### 2. Drei Adapter-Patches (paperclip-adapter-lmstudio)

**Commit [1ac325c8](.) `fix: mint run JWT and load instructionsFilePath`:**
- `supportsLocalAgentJwt: true` — Fix für 401-Errors bei Paperclip-Tool-Calls
- `instructionsFilePath`-Feld liest AGENTS.md und injiziert Persona in System-Prompt

**Commit [afb469bc](.) `fix: add wallclock run deadline`:**
- `maxRunSeconds` (Default 300s) — verhindert runaway-Tool-Schleifen, die stundenlang LM Studio belasten

**Commit (allowedWriteRoots) `feat: allowedWriteRoots config`:**
- `safePath()` akzeptiert zusätzliche erlaubte Schreib-Wurzeln neben cwd
- +3 Security-Tests (Prefix-Match-Safety)
- Ermöglicht direktes Schreiben in externen Obsidian-Vault

### 3. 19 Agent-Personas geschrieben
- Vorher: 18 von 19 Agenten hatten nur einen 339-Byte-Default-Stub, CEO einen englischen Text
- Alle 19 AGENTS.md ersetzt durch rollenspezifische deutsche Personas (je 1-2 KB)
- Enthält: Rolle, Reporting, Verantwortung, Arbeitsweise, Sprachregel (DE), WHITESTAG-Kontext, Verweise auf Custom-Skills

### 4. Obsidian-Vault-Struktur aufgebaut
- Versehentlich unter `Dokumente/` platzierter leerer Paperclip-Ordner entfernt
- Neue Struktur im Vault-Root:
  ```
  Paperclip/
  ├── _INBOX/
  ├── Projekte/WHITESTAG.{AI,FILM}/
  ├── Recherche/{Markt,Wettbewerb,Technologie,Foerdermittel}/
  ├── Vorlagen/{Angebote,Posts,Projekt-Briefings}/
  └── _Meta/
  Finanzen/
  ├── Vermögen/
  ├── Firma/
  └── Steuer/
  ```
- 7 `_README.md` mit Ablage-Regeln pro Ordner

### 5. Agent-Regeln für Ablage und Frontmatter
Jede der 19 AGENTS.md um drei Blöcke erweitert:
- **Dokument-Ablage**: agent-spezifischer Zielordner im Vault
- **Dokument-Frontmatter (Pflicht)**: YAML-Template (paperclip_issue_id, _title, _agent, _status, _created_at, type, tags)
- **KRITISCH: Pfade bei fs_write_file IMMER absolut** (nach Zwischenfall mit dem CEO, der relative Pfade nutzte)

### 6. Alle 18 lokalen Agenten konfiguriert
- `allowedWriteRoots: /Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault` gesetzt
- Cleanup von claude_local-Restfeldern (unter anderen, die die UI doppelte Modellfelder zeigen ließen — Kosmetik-Fix)

### 7. Canary-Tests
- **Buchhalter WHI-35:** Antwortete auf Deutsch, Frontmatter korrekt, Fallback zu `paperclip-inbox/` (weil zu dem Zeitpunkt `allowedWriteRoots` noch nicht deployed war). Manuell nach `Finanzen/Steuer/` verschoben.
- **CEO WHI-33:** Schrieb in relativen Pfad `server/Paperclip/_Meta/` statt in Vault. Manuell nach `Paperclip/_Meta/` im Vault verschoben, phantom-Ordner entfernt. Führte zur absolute-Path-Regel in allen AGENTS.md.

### 8. Zwischenfall: 45.000-Token-Zombie
- Bei Qwen3.6-Test lief LM Studio 34+ Minuten ohne aktiven Paperclip-Task
- Ursache: Retry-Continuation-Logic von Paperclip erzeugte hängende Heartbeat-Runs
- Zunächst fälschlich als isolierter Child-Prozess diagnostiziert → Paperclip-Hauptprozess mit-gekillt, musste neu gestartet werden
- Langfristiger Fix: Wallclock-Deadline (Commit afb469bc)

### 9. Anleitung erstellt
- [Paperclip-Anleitung.md](Paperclip-Anleitung.md) mit Alltags-Kommandos, Heartbeat-Steuerung, Notfall-Checkliste, Pfaden, API-Endpoints

## Geänderte / neue Dateien

### Im Paperclip-Repo
- `paperclip-adapter-lmstudio/src/server/execute.ts` — JWT-Fix, instructionsFilePath-Loader, Wallclock-Deadline, allowedWriteRoots
- `paperclip-adapter-lmstudio/src/server/index.ts` — neue Schema-Felder (instructionsFilePath, maxRunSeconds, allowedWriteRoots) + supportsLocalAgentJwt
- `paperclip-adapter-lmstudio/src/server/path-safety.ts` — allowedWriteRoots-Parameter
- `paperclip-adapter-lmstudio/src/server/fs-tools.ts` — Durchreichung von allowedWriteRoots
- `paperclip-adapter-lmstudio/src/server/tool-executor.ts` — dispatchTool-Signatur erweitert
- `paperclip-adapter-lmstudio/tests/path-safety.test.ts` — +3 neue Tests
- `LLM-Empfehlungen Paperclip-Agenten.md` — mehrfach aktualisiert
- `Paperclip-Anleitung.md` — neu

### Im Obsidian-Vault
- `Paperclip/` (komplette neue Struktur, 7 READMEs)
- `Finanzen/{Vermögen,Firma,Steuer}/` (neu mit README)
- `Finanzen/Vermögen/anlagestrategie-100k-eur.md` (vom CFO, mit nachgerüstetem Frontmatter)
- `Finanzen/Steuer/EÜR_Abgabe_2026_Kurzdoku.md` (vom Buchhalter)
- `Paperclip/_Meta/Tax_Strategie_Fiat_zu_Kia.md` (vom CEO)

### In den AGENTS.md-Instructions
- 19 Dateien in `~/.paperclip/instances/default/companies/<COMPANY_ID>/agents/<AGENT_ID>/instructions/AGENTS.md`
- Von je ~339 Bytes (Stub) auf je ~3,5–4,4 KB gewachsen mit vollständigen Personas

## Commits (lokal, nicht gepusht)
- `655cb960…` (Ausgangsbasis)
- `1ac325c8 fix(adapter-lmstudio): mint run JWT and load instructionsFilePath`
- `afb469bc fix(adapter-lmstudio): add wallclock run deadline to prevent runaway loops`
- `(letzter) feat(adapter-lmstudio): allowedWriteRoots config for out-of-cwd writes`

## Offene Punkte

1. **Agent-cwd außerhalb des Paperclip-Repos.** Aktuell läuft jeder Agent mit cwd = `~/Desktop/Claude Code/Paperclip/server/`, daher triggert jede Agent-Fehlablage den tsx-Watch-Banner „RESTART REQUIRED". Lösung: pro Agent `~/paperclip-workspace/<agent-id>/` setzen — ~10 Minuten Arbeit, noch nicht umgesetzt.

2. **Upstream-PR für die drei Adapter-Fixes.** Walter will perspektivisch einen PR gegen `paperclipai/paperclip` einreichen — vorher will er das Setup eine Weile im Alltag testen.

3. **Drehbuch bleibt auf Claude Opus 4.7** — einzige Cloud-Nutzung. Wenn der lokale Qwen3.6 beim CEO im Alltag überzeugt, könnte Drehbuch ebenfalls lokal getestet werden.

4. **Canary-Dokumente** müssen bei echten Kundenprojekten noch validiert werden — bisher nur interne Test-Issues (WHI-25, WHI-31, WHI-33, WHI-35, WHI-36).

5. **UI-Kosmetik:** Doppel-Modellfelder bei einigen Agenten sind vermutlich noch in der UI zu sehen (Claude-Schema-Leftovers), rein optisch — Adapter nutzt korrekt `defaultModel`.
