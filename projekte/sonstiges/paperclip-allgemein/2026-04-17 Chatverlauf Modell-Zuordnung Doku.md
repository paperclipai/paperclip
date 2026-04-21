# 2026-04-17 Chatverlauf: Dokumentation Modell-Zuordnung

## Ausgangslage

Walter wollte wissen, wo man in Paperclip einem Agenten ein anderes LLM zuordnen kann. Daraus entstand der Wunsch, eine Dokumentation dazu zu schreiben.

## Was wurde gemacht

### 1. Recherche: Wie funktioniert die Modellzuordnung?

- **Datenbank-Schema** (`packages/db/src/schema/agents.ts`): Jeder Agent hat `adapterType` (welcher Provider) und `adapterConfig` (JSON mit `model`-Feld)
- **UI**: `AgentConfigForm.tsx` mit `ModelDropdown`-Komponente, liest/schreibt `adapterConfig.model`
- **API**: PATCH `/agents/:id` mit `adapterConfig.model` im Body
- **Verfügbare Adapter**: claude_local, codex_local, gemini_local, opencode_local, cursor, pi_local, openclaw_gateway
- **Lokale Modelle**: pi_local Adapter liefert Modellliste dynamisch von LM Studio

### 2. Brainstorming: Dokumentationsstruktur

Entscheidungen:
- **Zielgruppe**: Board Operator + Entwickler (beides)
- **Sprache**: Deutsch
- **Speicherort**: `docs/guides/modell-zuordnung.md`
- **Format**: Alles in einer Datei (Option A) — erst praxisorientiert (UI + API), dann technische Referenz

### Geplante Gliederung

1. Überblick — Agent → adapterType → adapterConfig.model
2. Modell über die UI zuordnen (Schritt-für-Schritt)
3. Modell über die API zuordnen (curl/JSON-Beispiel)
4. Verfügbare Adapter und ihre Modelle (Tabelle)
5. Lokale Modelle (LM Studio / pi_local)
6. Adapter-spezifische Zusatzfelder (effort, variant, mode)
7. Troubleshooting

## Geänderte Dateien

- Keine Code-Änderungen in dieser Session

## Offene Punkte

- [ ] Dokumentation `docs/guides/modell-zuordnung.md` schreiben (Gliederung steht, Inhalt noch nicht erstellt)
- [ ] Walter hat die Gliederung und Option A (eine Datei) bestätigt — kann in der nächsten Session direkt umgesetzt werden
