# Nightly LLM Advisor — Design

- **Datum:** 2026-06-14
- **Status:** Spec, genehmigt zur Planung
- **Engine:** Paperclip-Routine auf Agent „Online-Rechercheur" (`d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7`, Company `9cebf3cf-efe8-4597-a400-f06488900a87`)
- **Eigentümer der Modellauswahl:** CTO (`5b7cb8a7-945f-4861-b3a7-4ae84d242d1e`)

> **Engine-Entscheidung (2026-06-14):** Der Online-Rechercheur lief bisher
> `lmstudio_local` (`qwen3.6-35b-a3b-mlx`) — ohne Web, mit Vault-Write-Root.
> Für echte Web-Recherche + Reasoning wird er auf **`claude_local`** umgestellt
> (Vorlage: Agent „CTO 2", `349a14dc-…`). Das gibt ihm Claude-Code mit eingebautem
> WebSearch, Bash und ohne `allowedWriteRoots`-Beschränkung. Behebt zugleich den
> Drift zwischen dokumentierter und tatsächlicher Konfiguration.

## Zweck

Jede Nacht prüfen, ob die aktuelle LLM-Zuweisung über alle drei Companies
(WHITESTAG, WHITESTAG Health, Clara Sound) noch die geeignetste ist — gemessen an
realen Aufgaben und Fehlern, unter dem harten Limit von **110 GB LLM-Speicher**.
Neue, für LM Studio als **MLX** verfügbare Modelle werden gegen den Ist-Zustand
geprüft. Nur bei echtem, neuem Verbesserungspotenzial geht eine begründete Mail an
Walter (`ws@whitestag.ai`). Die Routine entscheidet nie selbst und ändert nie
automatisch eine Zuweisung.

## Architektur

Hybrid: **deterministische Skripte** sammeln Zahlen und führen Benchmarks aus;
der **Online-Recherche-Agent** (Claude + Web) übernimmt nur Recherche, Bewertung
und Begründung. Trennung nach Zweck: Zahlen sammeln ≠ Modelle bewerten.

```
Paperclip-Routine (nächtlich 04:30; wöchentliche Zusammenfassung So 04:30)
   │
   ├─▶ [1] collect-ist-zustand.py        → ist-zustand.json
   ├─▶ [2] Online-Recherche-Agent (Claude+Web): Recherche, Match, Bewertung
   ├─▶ [3] benchmark-candidate.sh <model>  (nur bei klarem Top-Kandidat)
   ├─▶ [4] State-Diff gegen llm-advisor-state.json
   ├─▶ [5] Mail an ws@whitestag.ai (build_walter_mail_html.py) + Issue an CTO
   └─▶ wöchentlich: Kurz-Zusammenfassung auch ohne Neuigkeit
```

**Ablageort aller Skripte/State:** `~/.paperclip/scripts/llm-advisor/`
— bewusst nicht in CloudStorage/SynologyDrive (launchd/Host-Jobs können
SynologyDrive nicht lesen — „Operation not permitted").

## Komponenten

### [1] collect-ist-zustand.py
Deterministisch, kein LLM. Erzeugt `ist-zustand.json` aus vier Signalen:

1. **Fehler-Telemetrie (Paperclip-DB, 7-Tage-Fenster), je Agent:**
   `llm_unreachable`-Vorfälle, erreichte `max_iterations`-Caps, Recovery-Cascades,
   abgebrochene/Timeout-Runs, Ø-Iterationen pro Task.
   Quelle: embedded Postgres (Port 54329, `paperclip:paperclip`) + n8n-Detektor-Issues.
2. **Aufgabenprofil je Agent:** Rolle (aus AGENTS.md) + aktuell zugewiesenes Modell
   (adapter_config) + abgeleitete Fähigkeitsklasse
   (Coding / Reasoning / Klassifikation / Tool-Use / Kontextlänge).
3. **Ressourcen-Effizienz:** `lms ls` und `lms ps`, geladene Modelle + RAM,
   Ladezeiten, Plattenbelegung gegen 110 GB, gleichzeitige Lade-Konflikte.
4. **Externer Benchmark-Abgleich:** wird in [2] live vom Agenten ergänzt (Web).

Ausgabe ist kompaktes JSON: pro Agent eine Zeile {company, agent, rolle,
fähigkeitsklasse, modell, quant, kontext, fehler-zähler}; global ein
Budget-Block (geladene Modelle, RAM, Platte, freie GB bis 110).

### [2] Online-Recherche-Agent (Claude + Web)
Liest `ist-zustand.json` und `llm-advisor-state.json`. Recherchiert per Web neue
`mlx-community`/LM-Studio-MLX-Modelle und öffentliche Benchmarks (MMLU, Coding,
Tool-Use). Matcht Kandidaten gegen Aufgabenprofile **und** das 110-GB-Budget.
Bewertet, ob ein Kandidat den aktuell zugewiesenen schlägt. Findet er einen
klaren Gewinner → löst [3] aus.

Zusätzliche Analysen (immer mitlaufen):
- **Drift-Erkennung:** Abweichung zwischen dokumentiertem/Memory-Stand und real
  zugewiesenen/geladenen Modellen.
- **Quantisierungs-Tuning:** anderer Quant (4bit↔8bit) desselben Modells als
  RAM-Hebel statt Modellwechsel.
- **Kontextlängen-Abgleich:** zugewiesener Kontext vs. real genutzter
  (verschwendeter KV-Cache-RAM bzw. Abschneiden).
- **Budget-Lade-Profil:** globaler Resident-Plan bei 110 GB (welche Modelle
  bleiben geladen, welche Agenten teilen sich eins; MoE-Effizienz beachten).
- **2–3 Gesamt-Szenarien gerankt:** „RAM-sparsam", „Qualität-maximal",
  „ausgewogen" — nicht nur Einzeltausch.

### [3] benchmark-candidate.sh <model>
Nur bei klarem Top-Kandidat. Lädt das Modell temporär (sofern es ins Budget passt),
fährt reale Agent-Testprompts, misst Tokens/s und Qualität, entlädt und räumt
Plattenplatz wieder auf. Liefert belastbare Zahlen für die Mail.

### [4] State + Rausch-Schutz — llm-advisor-state.json
Führt zuletzt vorgeschlagene Modelle und Walters Entscheidungen
(angenommen/abgelehnt + Datum). Mail nur bei **neuem** Kandidat **und** spürbarem
Nutzen. Abgelehnte Vorschläge werden nicht wiederholt — die Routine lernt aus
den Entscheidungen.

### [5] Mail + Issue
Mail über `lib/build_walter_mail_html.py` an `ws@whitestag.ai`. Aufbau je Vorschlag:
1. **TL;DR** — „Agent X: `Modell A` → `Modell B`, +Z % Reasoning / −W GB RAM".
2. **Begründung** — welches der 4 Signale triggert (z.B. „R5 erreicht 14×
   max_iterations/Woche → Modell zu schwach").
3. **Belege** — externe Benchmarks + ggf. Schatten-Benchmark, Modellkarte, Links.
4. **Budget-Wirkung** — neues Gesamt-Lade-Profil vs. 110 GB.
5. **Drift-/Quant-/Kontext-Hinweise**, falls vorhanden.
6. **Aktion** — konkrete `lms get …` / Adapter-Config-Änderung zum manuellen
   Übernehmen.

Parallel: Paperclip-Issue an CTO mit gleichem Inhalt (Nachverfolgbarkeit).
**Die Routine fasst nie automatisch an — reine Entscheidungsvorlage.**

## Zeitplan
- Nächtlich **04:30** (nach `agent-learning.*` und `nightly-anomaly`, im
  `keep-awake`-Fenster).
- Wöchentlich **So 04:30** Kurz-Status auch ohne Neuigkeit.

## Nicht-Ziele
- Keine automatische Modell-Installation oder Adapter-Änderung.
- Kein Dauer-Benchmark aller Modelle (nur Top-Kandidat, stufig).
- Keine Mail unterhalb der Neu-und-relevant-Schwelle.

## Fehlerverhalten
- DB/`lms` nicht erreichbar → Routine bricht sauber ab, schreibt Log, keine Mail
  mit Halbdaten; einmaliger Fehlerhinweis erst bei N aufeinanderfolgenden
  Fehlnächten (kein Nacht-Spam).
- Benchmark sprengt Budget → übersprungen, Vorschlag bleibt „nur Recherche"
  und wird in der Mail als solcher markiert.

## Verifizierte Fakten (Planungsgrundlage)
- **Telemetrie:** `heartbeat_runs.error_code` liefert real `max_iterations` (773×/14d),
  `timeout` (353), `llm_unreachable` (118), `llm_error` (41), `adapter_failed`,
  `process_lost`; join auf `agents` für Name/Rolle, `company_id` trennt die 3 Companies.
  Dauer = `finished_at − started_at`, Tokens = `usage_json`.
- **Modell-Zuweisung:** `agents.adapter_config->>'model'` (+ `adapter_type`
  `lmstudio_local` vs. `claude_local`). Nur `lmstudio_local`-Agenten zählen ins
  110-GB-Budget; `claude_local` ist Cloud-Kontext.
- **LM Studio:** `lms ls --json` / `lms ps --json` liefern modelKey, sizeBytes,
  quantization, architecture, params, loaded-Status.
- **Routinen:** `routines` + `routine_triggers` (kind=`schedule`, `cron_expression`,
  `timezone`) — Anlage über Paperclip-API.
- **Mail:** Mailhub-Webhook `http://127.0.0.1:5678/webhook/mailhub/send`
  (Secret `mailhub-…`), Renderer `companies/9cebf3cf…/lib/build_walter_mail_html.py`.

## Offene Punkte für die Planung
- Repräsentative Testprompts je Fähigkeitsklasse für den Schatten-Benchmark
  (werden im Plan als Fixtures definiert).
