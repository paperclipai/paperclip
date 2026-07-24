# LLM-Resident-Platzierung über drei Maschinen — Design

**Datum:** 2026-07-24
**Status:** Design (genehmigt, vor Planung)
**Kontext:** Nach dem Daily-Digest-Ausfall vom 2026-07-23 (JIT-Kaltstart von
`gemma-4-31b-it-mlx` riss den 180-s-Timeout). Gleiche Fehlerklasse wie der
Jarvis-Bot-Ausfall am selben Tag. Wurzel ist nicht ein einzelner Workflow,
sondern eine **nirgends deterministisch festgeschriebene Modell-Platzierung**
plus aktives JIT-Loading.

## Problem

- **Platzierungs-Drift:** Die Modell→Gerät-Zuordnung ist nur im
  `n8n.sh`-Preload (läuft nur bei n8n-Neustart) und in einer Doku
  (`docs/Agenten-LLM-Zuordnung.md`) festgehalten — beide driften vom Live-Stand
  ab. Belegt am 2026-07-24: `qwen3.6-35b` lag entgegen der Doku auf der Studio,
  `mistral-small-3.2-24b` war nirgends geladen, obwohl noch als Primärmodell
  geführt.
- **JIT-Loading aktiv** (`justInTimeModelLoading: true`): Fehlt/evictet ein
  Modell, lädt LM Studio es on-demand nach. Der Kaltstart großer Modelle
  (34–48 GB) sprengt regelmäßig Node-Timeouts (Digest 180 s, Bot 90 s) →
  Totalausfall statt Verzögerung.
- **Keine Selbstheilung:** Wird ein Modell mittags evictet oder crasht, lädt es
  niemand nach bis zum nächsten n8n-Neustart.
- **Verdeckte Nacht-Löcher:** Der PII-Classifier-Primär (`gemma-4-12b-qat`) und
  die Coder (`qwen3-coder-next`) liegen auf der **RTX, die nachts aus ist**.
  Ohne garantierten always-on-Fallback laufen abhängige Agenten nachts ins Leere.

## Ziel

Ein **fest definiertes, resident gehaltenes Modell-Set** über die drei Maschinen,
sodass (1) kein JIT-Load und kein Auto-Eviction mehr passiert, (2) **jeder**
Agent-Primär- **und** -Fallback (und ggf. cheap-Profil) auf ein garantiert
residentes Modell auflöst, und (3) die zwei einzigen Geräte-Löcher — RTX nachts
aus, MacBook ~1×/Monat mobil — immer von der always-present Studio aufgefangen
werden.

## Leitprinzip

**Die Studio verlässt nie das Haus → sie trägt alle Sicherheitsnetz-Modelle
(jeden Fallback).** Primär und Fallback liegen bewusst auf *verschiedenen*
Geräten. Damit fängt die Studio beide Löcher (RTX-Nacht, MacBook-mobil) ab.

## Resident-Set und Verteilung

### Studio (128 GB, always-present — das Sicherheitsnetz)

| Modell | Gewicht | ctx | parallel | Rolle |
|---|---|---|---|---|
| `gemma-4-31b-it-mlx` | 33,8 | 65k | 4 | Kreativ/Admin-Primär (22 Agenten) + Universal-Fallback |
| `google/gemma-4-12b` | 7,6 | 65k | 4 | PII-Nacht-Fallback + Agent-Light-Fallback + n8n/Digest |
| `qwen/qwen3-coder-30b` | 17,2 | 90k | 4 | Coder-Ultimativ-Backstop (RTX+MacBook zugleich weg) |
| `openbiollm-8b` | 5,7 | 8k | 4 | Dr-Knowledge (biomedizinisch spezialisiert) |
| `text-embedding-bge-m3` | 0,6 | 8k | — | Embeddings |

≈ 65 GB Gewichte + KV-Cache → reichlich Luft.

### MacBook (128 GB, Workhorse — läuft ausschließlich LM Studio)

| Modell | Gewicht | ctx | parallel | Rolle |
|---|---|---|---|---|
| `qwen3.6-35b-a3b-mlx` | 37,7 | 98k | 4 | Reasoner-Primär (10× C-Suite/PM/Strategie) |
| `qwen/qwen3-coder-next` | 48,5 | **65k** | 4 | Coder-**Nacht-Fallback** (bewusst 65k, nicht 131k) |

≈ 86 GB Gewichte + KV. **Empirisch zu verifizieren vor JIT-aus** (siehe Risiken).
Nur noch die zwei großen Modelle → mehr KV-Luft als in der Erstfassung
(openbiollm nach Studio verschoben).

### RTX Pro 6000 (96 GB VRAM, Tages-Boost, nachts aus)

| Modell | Gewicht | ctx | parallel | Rolle |
|---|---|---|---|---|
| `qwen/qwen3-coder-next` | 48,5 | 131k | 4 | Coder-Primär (VP Eng, Produktentwicklung) |
| `google/gemma-4-12b-qat` | 7,2 | 65k | 4 | PII-Classifier-Primär (schnell) |

≈ 56 GB Gewichte.

### Dreistufige Coder-Kette

`qwen/qwen3-coder-next` ist **ein** Modellname, den LM Link auf **zwei** Geräten
hält (RTX 131k + MacBook 65k). Ein Coder-Request routet tagsüber zur RTX, nachts
zur MacBook-Instanz. Agent-Config: `model = qwen3-coder-next`,
`fallbackModel = qwen3-coder-30b` (Studio, ultimativer Backstop).

- **Tag:** Request → coder-next → RTX (schnell).
- **Nacht (RTX aus):** Request → coder-next → MacBook-Instanz (volle Qualität, nur 65k).
- **Nacht + MacBook mobil:** coder-next unerreichbar → Fallback coder-30b (Studio).

**Verifikationspunkt:** LM Link muss einen `coder-next`-Request bei ausgefallenem
Primärgerät automatisch zur Zweitinstanz routen. Falls LM Link geräte-pinnt,
übernimmt das der Model-Router (Primär-URL/Device-Auswahl). In der Umsetzung als
erste Prüfung klären, bevor darauf gebaut wird.

### Redundanz-Nachweis

| Primär (Gerät) | Fallback (Gerät) | deckt Loch |
|---|---|---|
| `qwen3.6-35b` (MacBook) | `gemma-4-31b` (Studio) | MacBook-mobil |
| `coder-next` (RTX) | `coder-next` (MacBook) → `coder-30b` (Studio) | RTX-Nacht (+ MacBook-mobil) |
| `gemma-4-12b-qat` (RTX) | `gemma-4-12b` (Studio) | RTX-Nacht |
| `openbiollm-8b` (Studio) | `gemma-4-31b` (Studio) | Modell-Crash (Wärter heilt; Studio always-on) |
| `gemma-4-31b` (Studio) | `gemma-4-12b` (Studio) | Modell-Crash (Wärter heilt) |

### Aus dem Resident-Set entfernt

- `mistral-small-3.2-24b` — ungenutzt (Sekretärin/Office bereits am 2026-07-23
  auf qwen3.6 zurückgesetzt); spart ~20 GB.
- `gemma-4-31b-qat` auf der RTX (18,8 GB) — kein Agent referenziert es (Altlast).
- `qwen/qwen3-4b` (2,3 GB, Studio) — prüfen ob referenziert; sonst entfernen.

## Komponenten

### 1. `resident-set.json` — eine Wahrheitsquelle

Deklarative Soll-Liste, je Eintrag:
`{ ps_key, load_key, device, ctx, parallel, when }`
mit `when ∈ {always, day-only}`. `day-only` = RTX-Modelle (nur erzwungen, wenn
Gerät erreichbar). Alle abgeleiteten Orte (Wärter, n8n.sh-Preload) lesen **nur**
diese Datei — kein zweiter Platzierungs-Ort mehr.

Ablage: `~/.paperclip/scripts/model-warden/resident-set.json` (Entwicklung im
Repo unter `tools/model-warden/`, Deploy nach `~/.paperclip/scripts/`).

### 2. Modell-Wärter (launchd, self-healing)

- Python, stdlib-only (wie die anderen Wächter).
- launchd-Intervall ~180 s, 24/7 (beide Macs always-on).
- Ablauf je Lauf:
  1. Ist-Zustand via `lms ps` (JSON/Parse): geladene Modelle + Gerät + ctx.
  2. RTX-Erreichbarkeit prüfen (Ping/`lms`-Device-Liste).
  3. Für jeden Soll-Eintrag mit verfügbarem Gerät: fehlt es / falsches Gerät /
     falsche ctx → `lms load` mit festen Parametern nachladen. `day-only` bei
     nicht erreichbarer RTX überspringen (kein Fehler-Spam).
  4. Optional (später): Modelle **außerhalb** des Sets loggen (nicht automatisch
     entladen — konservativ).
- **Kein stilles Scheitern:** Schlägt ein `lms load` fehl (z.B. RAM-Guardrail),
  legt der Wärter ein Paperclip-Issue an (wie n8n-Wächter) + optional Mail.
- Geräte-gezieltes Laden über den bestehenden Mechanismus aus `n8n.sh`
  (preferred-device-Umschalten) — der Wärter kapselt die korrekte
  `lms load`-Beschwörung.

### 3. LM-Studio-Konfiguration

- `justInTimeModelLoading: false` in `http-server-config.json`.
- TTL aus: Laden ohne `--ttl` → kein Auto-Eviction (`lms ps` TTL-Spalte leer).
- **Gotcha:** LM-Studio-GUI kann die Server-Config bei Restart zurücksetzen →
  der Wärter re-asserted den Flag (oder dokumentierter manueller Check nach
  GUI-Neustart).

### 4. Agent-Config-Audit (kein Agent ins Leere)

DB-Audit über alle 40 lokalen Agenten (`agents.adapter_config`, Postgres :54329):
`model`, `fallbackModel`, `cheap`-Profil müssen **jeweils** ein
Resident-Set-Modell sein. Fixes:

- **Self-Fallbacks auflösen** (`model == fallbackModel == gemma-4-31b`):
  Creative Director, Drehbuch, Link-Detektor, Marken-Spezialist,
  Social-Media-Spezialist (WHITESTAG), Clara-Designer, Redaktion&PR →
  Fallback auf `google/gemma-4-12b` (Studio, device-redundant, schon resident).
- **mistral-Reste tilgen:** jeder verbliebene Verweis auf `mistral-small-3.2-24b`
  → Set-Modell.
- **Ergebnis:** Audit-Tabelle „Agent → Primär/Fallback/cheap → alle ✓ resident"
  als Beleg.
- Update-Weg: `PATCH /api/agents/:id` (adapterConfig merged; **nicht**
  `/companies/:cid/agents/:id` → 404).

## Datenfluss

```
resident-set.json  ──►  Modell-Wärter (launchd 180s)  ──►  lms load (Gerät/ctx)
        │                        │
        │                        └──► lms ps (Ist)  ──► Diff ──► Issue bei Fehler
        └──►  n8n.sh Preload (ruft nur noch Wärter, kein zweiter Ort)

Agent  ──► model/fallbackModel ──► (Audit garantiert: ∈ Resident-Set)
        └──► Request ──► LM Link routet zu Gerät mit residentem Modell
```

## Umsetzungsreihenfolge (verschärft das Problem nicht kurzzeitig)

1. `resident-set.json` definieren.
2. Set real laden + **empirisch RAM messen** (v.a. MacBook mit qwen3.6 + coder-next).
3. LM-Link-Auto-Routing für `coder-next` verifizieren.
4. Agent-Config-Audit + Fixes.
5. Wärter bauen (TDD), testen, launchd scharf.
6. **Zuletzt** JIT aus — erst wenn das Set nachweislich stabil resident steht.

## Risiken / offene Verifikationen

- **MacBook-RAM (Hauptrisiko):** qwen3.6-35b (98k) + coder-next (65k)
  ≈ 86 GB Gewichte + KV (openbiollm nach Studio verschoben → 5,7 GB + KV-Luft
  gewonnen). Ziel < ~115 GB. **Muss empirisch gemessen werden**, bevor JIT aus.
  Fällt es zu knapp aus: coder-next-ctx weiter senken oder qwen3.6-ctx senken.
- **LM-Link-Routing** bei Geräteausfall (Coder-Kette) — Punkt 3 oben.
- **GUI-Config-Reset** setzt JIT ggf. zurück — Wärter/Doku.
- **`lms ps`-Parsing** stabil gegen LM-Studio-Versionen (JSON-Flag prüfen).

## YAGNI (bewusst ausgelassen)

- Automatisches Entladen von Nicht-Set-Modellen (nur loggen).
- Dynamische Umplatzierung nach Last (feste Zuordnung genügt).
- gpt-oss-120b bleibt außerhalb des Agent-Pfads (nur manuell).

## Verwandte Memories

- `project_llm_night_architecture` (beide Macs always-on, RTX-Nacht-Loch)
- `project_lmstudio_startup_preload` (n8n.sh-Preload, wird abgelöst)
- `project_lmstudio_multimac_lmlink` (LM Link, JIT überschreibt CLI-Reloads,
  ctx nur in user-concrete-model-default-config festnagelbar)
- `project_ctx_stats_routine` (gepinnte ctx-Werte gemma 65k / qwen3.6 131k GRÜN)
- `project_pii_proxy_enforcement` (Classifier RTX-qat + gemma-12b-Fallback)
- `project_gptoss_fleet_rollout`, `project_recovery_cascade_root_cause`
