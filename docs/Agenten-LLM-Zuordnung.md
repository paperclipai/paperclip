# Agenten-LLM-Zuordnung

**Stand:** 2026-07-18 · Quelle: Paperclip-DB (`agents.adapter_config`, Postgres :54329) + `lms ps`
· **Korrektur 2026-07-11:** PII-/Model-Router-Classifier läuft seit 2026-07-06 auf einem **dedizierten `google/gemma-4-12b`** (Studio), nicht mehr auf dem 31B; das `gemma-4-31b` lädt aktuell auf dem MacBook (LM-Link-Placement dynamisch).
· **Änderung 2026-07-18 (LLM-Advisor-Empfehlung umgesetzt):** **CMO** von `qwen3.6-35b-a3b-mlx` → **`gemma-4-31b-it-mlx`** (weg vom MoE-XML-Tool-Call-Bug, 12,6 % Fehlerrate), Fallback → `google/gemma-4-12b` (always-on Studio, 0 extra RAM). **VP Engineering & Produktentwicklung** waren auf `qwen3.6-35b-a3b` (RTX-Q8) abgedriftet → zurück auf **`qwen/qwen3-coder-next`** (RTX), Fallback **`qwen/qwen3-coder-30b`** (statt bisher General-Reasoner als Fallback). **CTO & SEO/GEO-Spezialist** waren ebenfalls auf GGUF (`qwen3.6-35b-a3b`, RTX-Q8) abgedriftet (CTO fail_rate 0,67 / 29 llm_errors) → zurück auf **`qwen3.6-35b-a3b-mlx`** (nativer Tool-Call-Parser), Fallback `gemma-4-31b-it-mlx` — jetzt in Linie mit CEO/CPO/CRO. `qwen3.6-35b-a3b-mlx` bleibt Flotten-Reasoner der übrigen ~23 Agenten.
· **Nacht-Architektur + Schleifen-Fix (2026-07-18):** Analyse ergab: der Advisor-„MoE-XML-Tool-Call-Bug" existiert nicht — die 42 CMO-`llm_error` sind **RAM-Guardrail** („insufficient system resources", Modell lädt nicht). Fleet-weit (14 T): **570 max_iterations** (qwen3.6 auf simplen Admin-Tasks dreht Kreise), 552 Claude-Cloud (249× PII-Classifier weg), 201 RAM-Guardrail, 200 entladen/unreachable. **Prinzip (korrigiert):** Mac Studio (`Local`) **und** MacBook M5 Max sind BEIDE 24/7 always-on + caffeinate-wach (MacBook nur ~1×/Monat unterwegs weg; belegt: 21 T nur 1 nächtlicher Mac-„unloaded"-Fehler) → Modelle bewusst auf beide verteilt (256 GB). **Einziges echtes Nacht-Geräteloch = RTX (nachts AUS)** → nur Coder brauchen Mac-Fallback. **Block 1:** (a) Coder-Nacht-Fallback verifiziert — Fallback triggert, greift bei RTX-aus auf `qwen3-coder-30b` (auf Studio gepinnt via `n8n.sh`-Preload, war schon korrekt); (b) 8 gemma-Primär-Agenten hatten Selbst-Fallback (=keinen) → `google/gemma-4-12b` (Studio-resident). Ein Zwischenschritt (ganzes Reasoner-Set auf Studio zwängen) wurde zurückgenommen (falsche „MacBook-mobil"-Prämisse). **Block 2 (Schleifen-Killer):** 14 Simple-Admin-Agenten qwen3.6-35b → **gemma-4-31b** (maxIter 8, Fallback gemma-12b); verbleibende 10 Reasoning-Agenten maxIter 20 → 12. Offen: `justInTimeModelLoading:true` (JIT-Risiko coder-next auf Studio) — härten sobald Resident-Set komplett; PII-Classifier-Verfügbarkeit (249 Cloud-Blocks, reine Infra).
· **LLM-Advisor-State bereinigt (2026-07-18):** Pending-Backlog 76 → 32; 12 als `implemented` (durch heutige Änderungen gedeckt), 32 als `rejected` (13 unbekannte Agenten, 16 nicht-verfügbare Modelle/Download-Spekulation, 3 kaputt/absurd). Offen bleiben v.a. **10× Admin→gemma-4-31b** (Soll-Zuordnung Gruppe 1, separate Runde). Root-Cause: Routine hat kein Dedup/Verfall → Backlog wächst sonst nächtlich neu.

· **Mistral-Admin-Pilot (2026-07-20):** **Sekretärin** (WHITESTAG) und **Office & Admin** (Clara) von `gemma-4-31b-it-mlx` → **`mistral-small-3.2-24b-instruct-2506-mlx`** (MacBook, 20,03 GB, ctx 131k), Fallback **`google/gemma-4-12b`** (Studio-resident, echte Geräte-Redundanz, 0 extra RAM). Begründung: Mistral 3.2 ist **non-reasoning** mit deutlich verbessertem Function-Calling und reduzierter Repetition → adressiert direkt die 570 `max_iterations`-Fälle bei simplen Admin-Tasks, bei 24B statt 31B (weniger Guardrail-Risiko). Mistral war bisher **nur JIT** (n8n-Newsletter, Overflow auf Studio) und damit nicht neustart-fest → jetzt im `n8n.sh`-Preload auf dem MacBook gepinnt. MacBook-Belegung danach 97,3/128 GB. **Offen:** `defaultModel` und `modelProfiles.cheap` beider Agenten stehen weiter auf `gemma-4-31b` (bewusst belassen — Cheap-Profil braucht kein Mistral). Nach ~1 Woche `max_iterations`/`llm_error`-Rate gegen die gemma-Admin-Gruppe vergleichen; bei Erfolg zweite Welle (Buchhaltung, Vermögensverwaltung, Vault-Maintainer, DPO).

## Cluster-Topologie (LM Link, 3 Geräte)
| Gerät | Typ | Modelle | Rolle |
|---|---|---|---|
| **Mac Studio M4** (128 GB, always-on) | Apple/MLX | `google/gemma-4-12b` (PII-Classifier), `qwen/qwen3-coder-30b` (ctx 128k, **warm-resident**), `bge-m3` | always-on Basis: **PII-/Model-Router-Classifier :4711** + Embeddings + **warmer Coder-Fallback** |
| **MacBook M5 Max** (128 GB, mobil) | Apple/MLX | `qwen3.6-35b` (ctx 128k, parallel 8), `gemma-4-31b`, `openbiollm-8b`, `gpt-oss-120b` | Workhorse (24 Agenten) + Agent-Fallback (`gemma-4-31b`) |
| **RTX Pro 6000** (always-on) | NVIDIA/CUDA | `qwen3-coder-next` | Coder für Programmier-Agenten |

## Zuordnungslogik
- **qwen3.6-35b (MacBook)** → 24 Agenten (Standard-Reasoner). Der große Load liegt bewusst auf dem MacBook, NICHT auf der Studio (sonst OOM-Crash).
- **gemma-4-31b** → 7 Kreativ/PR-Rollen (Primärmodell) + **Fallback aller lokalen Agenten** (greift wenn qwen3.6-MacBook mobil/aus). Lädt aktuell auf dem MacBook (Device-Spalten „Mac Studio" in den Tabellen unten = LM-Link-Placement, dynamisch).
- **google/gemma-4-12b (Studio, :4711)** → **dedizierter PII-/Model-Router-Classifier**, seit 2026-07-06 (löste das 31B ab: 36%→0% Ausfall im Last-Test). Kein Agent-Primär-/Fallback-Modell — reine Anonymisierungs-Infrastruktur, deshalb der einzige dauerhaft aktive Gemma.
- **qwen3-coder-next (RTX)** → Programmier-Agenten (VP Engineering, Produktentwicklung), Fallback `qwen/qwen3-coder-30b` falls RTX aus. Seit 2026-07-11 **warm-resident auf dem Studio** (ctx 128k, 17 GB, kein TTL) → greift ohne JIT-Ladeverzögerung/Guardrail. Preload in `~/Desktop/n8n.sh` (lädt via kurzem preferred-device-Umschalten gezielt auf „Local"/Studio, nicht MacBook).
- **openbiollm-8b (MacBook)** → Dr-Knowledge. **Cloud/claude_local** → 6 Recherche/PR/Ops-Rollen.
- gpt-oss-120b: NICHT im Agent-Pfad (zu langsam für Multi-Turn-Runs auf dieser HW), bleibt für manuelle MacBook-Nutzung.

**Verteilung (Stand 2026-07-18 nach Umbau):** qwen3.6-35b-mlx: 10 (nur Reasoning: CEO/CTO/CPO/CRO/CHO/Büroleitung/SEO-GEO/Blender/Schlaf-+Trainingscoach) · gemma-4-31b: 22 · qwen3-coder-next: 2 · claude-sonnet-4-6: 7 · openbiollm-8b: 1

## Clara Sound  (10 Agenten)

| Agent | Rolle | Status | Modell | Gerät | Fallback | Cheap |
|---|---|---|---|---|---|---|
| Büroleitung | ceo | error | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Social Media & Community | cmo | idle | claude-sonnet-4-6 | Claude Cloud | — | — |
| Creative Assistant | designer | error | gemma-4-31b | Mac Studio | gemma-4-31b | — |
| Link-Detektor | general | idle | — | — | — | — |
| Office & Admin | general | idle | **mistral-small-3.2-24b** | MacBook M5 Max | gemma-4-12b | gemma-4-31b |
| Redaktion & PR | general | idle | gemma-4-31b | Mac Studio | gemma-4-31b | — |
| Vault-Maintainer | general | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Akquise & Booking | pm | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Label Manager | pm | error | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Recherche | researcher | idle | claude-sonnet-4-6 | Claude Cloud | — | — |

## Health Insights  (5 Agenten)

| Agent | Rolle | Status | Modell | Gerät | Fallback | Cheap |
|---|---|---|---|---|---|---|
| CHO | agent | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Dr-Knowledge | agent | error | openbiollm-8b | MacBook M5 Max | gemma-4-31b | — |
| Schlafcoach | agent | error | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Trainingscoach | agent | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Vitals-Monitor | agent | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |

## WHITESTAG  (25 Agenten)

| Agent | Rolle | Status | Modell | Gerät | Fallback | Cheap |
|---|---|---|---|---|---|---|
| CEO | ceo | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| CMO | cmo | idle | gemma-4-31b | Mac Studio | gemma-4-12b | — |
| CTO | cto | running | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Adobe | designer | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Bild & Video | designer | error | claude-sonnet-4-6 | Claude Cloud | — | — |
| Blender | designer | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Creative Director | designer | idle | gemma-4-31b | Mac Studio | gemma-4-31b | — |
| Web-Design Specialist | designer | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Produktentwicklung | engineer | idle | qwen3-coder-next | RTX Pro 6000 | qwen3-coder-30b | gemma-4-31b |
| VP Engineering | engineer | running | qwen3-coder-next | RTX Pro 6000 | qwen3-coder-30b | gemma-4-31b |
| n8n-Betriebsingenieur | engineer | running | — | — | — | — |
| Buchhaltung | general | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| CFO | general | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| DPO | general | error | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Drehbuch | general | idle | gemma-4-31b | Mac Studio | gemma-4-31b | — |
| Link-Detektor | general | idle | gemma-4-31b | Mac Studio | gemma-4-31b | — |
| Marken-Spezialist | general | idle | gemma-4-31b | Mac Studio | gemma-4-31b | — |
| Mistika VR | general | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Sekretärin | general | idle | **mistral-small-3.2-24b** | MacBook M5 Max | gemma-4-12b | gemma-4-31b |
| Social Media Specialist | general | idle | gemma-4-31b | Mac Studio | gemma-4-31b | — |
| Vault-Maintainer | general | error | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| Vermögensverwaltung | general | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| CPO | pm | idle | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | gemma-4-31b |
| CRO | researcher | error | qwen3.6-35b | MacBook M5 Max | gemma-4-31b | — |
| Online-Rechercheur | researcher | error | claude-sonnet-4-6 | Claude Cloud | — | — |

---

# Empfehlung: Soll-Zuordnung (2026-07-06)

> Analyse, **kein** DB-Stand. Ist-Tabellen oben unverändert. Umsetzung agentweise per Entscheidung.

## Kernbefund
Das Problem ist nicht „falsches Modell pro Agent", sondern **Über-Konzentration**: 24 Agenten
hängen am selben verbose-denkenden `qwen3.6-35b` auf *einem* MacBook. Diese Kombination
(viele Qwen-Thinker @ `maxIterations`) ist die dokumentierte Wurzel der Recovery-Kaskaden
und ein Single-Point-of-Failure, wenn der MacBook mobil ist. Viele der 24 machen aber
**keine Mehrschritt-Reasoning-Arbeit**, sondern simple, strukturierte, deutschsprachige
Verwaltung — dafür ist qwen3.6 das falsche Werkzeug (schleifenanfällig, verpufft bei knappem
Budget im englischen Thinking).

## Modellwahl nach Task-Archetyp
| Archetyp | Beste Wahl | Warum |
|---|---|---|
| Mehrschritt-Reasoning + Tools (C-Suite, PM, Strategie) | qwen3.6-35b | Thinking + MoE-Tempo, dafür gebaut |
| Simple strukturierte Admin-Tasks | **gemma-4-31b** | direkt, deutsch, budgetsicher, kein Loop |
| Kreativ/PR/Text | gemma-4-31b | bereits korrekt |
| Coding | qwen3-coder-next | bereits korrekt |
| Web-Recherche | claude cloud | echte Tools + Reasoning |
| Tool-Calling-Worker, mittlere Komplexität | mistral-small-3.2-24b *(Eval offen)* | knapp, zuverlässige Function-Calls |
| Bild *als Input* bewerten | qwen3-vl-30b-a3b *(Eval offen)* | derzeit kein lokales Vision |

## Konkrete Umzugs-Kandidaten (Confidence absteigend)
**Gruppe 1 — qwen3.6 → gemma-4-31b** (kein neues Setup; gemma ist bereits Fallback + always-on):
- WHITESTAG: Buchhaltung, CFO, Vermögensverwaltung, Sekretärin, Vault-Maintainer
- Clara: Office & Admin, Vault-Maintainer
- Health: Vitals-Monitor (reine Datenauslese)

→ Entlastet den MacBook und entschärft die Kaskaden-Quelle direkt, ohne Infrastruktur.

**Bewusst lassen:** C-Suite/CTO/CPO/CRO auf qwen3.6 (echtes Reasoning), Coder auf coder-next,
Dr-Knowledge auf openbiollm, Researcher auf Cloud, Kreativ/PR auf gemma.

## Verfügbar, aber (noch) nicht im Agent-Pfad
| Modell | Ort | Einordnung |
|---|---|---|
| `mistral-small-3.2-24b` (q4/q8) | RTX + MacBook | Middle-Tier-Kandidat für loopende Tool-Agenten — **A/B-Eval offen** |
| `ornith-1.0-35b` | RTX | qwen35moe-Derivat, **unbekannt — erst charakterisieren** |
| `qwen3-vl-30b-a3b`, `qwen2.5-vl-72b`, `internvl3-78b` | RTX | Vision; nur wenn Designer Bilder wirklich als Input *bewerten* |
| `gpt-oss-120b/20b` | MacBook/Local | bleibt raus (Timeouts, siehe Memory) |

