# Design: Selbstheilung & LLM-Härtung für Paperclip-Agenten

- **Datum:** 2026-07-24
- **Status:** Entwurf zur Freigabe
- **Auslöser:** Wiederkehrendes „die LLMs laufen ins Leere" — Agenten fallen bei LLM-Störungen in `error` und bleiben dort dauerhaft liegen. Am 24.07. standen 11 Agenten über alle drei Companies tot auf `error`, davon der SEO/GEO-Spezialist seit 6 Tagen, obwohl das LM-Studio-Endpoint die ganze Zeit erreichbar war.

## 1. Problem & Wurzelursache

Ein Agent wird auf `status='error'` gesetzt, sobald ein Heartbeat-Run mit Ausgang `failed`/`timed_out` endet und kein weiterer Run läuft (`server/src/services/heartbeat.ts:6152` `finalizeAgentStatus`, error-Zweig `:6169`).

Der Rückweg ist rein **implizit**: Es gibt **keinen** dedizierten „error → aktiv"-Reset. Ein Agent verlässt `error` nur, wenn sein *nächster* Run zufällig `succeeded`/`cancelled` liefert, oder per manuellem `resume()` (`server/src/services/agents.ts:459`).

Das eigentliche Loch: Wenn ein Run wiederholt scheitert, verschiebt der Recovery-Service das gestrandete Issue auf `blocked` und eskaliert es an einen Manager (z.B. CTO). Danach hat der **Ur-Agent kein aktives Issue mehr → nichts weckt ihn → er sitzt für immer in `error`**. Verschärfend: der Eskalations-Empfänger (CTO) ist selbst einer der häufigsten `max_iterations`-Toten — die Rettung stirbt mit.

### Fehlerklassen (heartbeat_runs, letzte 3 Tage, alle Agenten)

| Klasse | Signatur | Häufigkeit | Charakter |
|---|---|---|---|
| Kreisdrehen | `Max iterations reached` | 171 | Agent erreicht LLM, konvergiert nicht |
| PII/Content | `400 … blocked` | 148 | überwiegend deterministisch |
| Endpoint weg | `fetch failed` | 79 | transient (Tages-Contention) |
| Timeout | `timed out` | 44 | transient / überlastet |
| RAM-Guardrail | `insufficient resources` | 8 | transient |

Die `fetch failed`/Timeouts ballen sich **tagsüber** (Peak 14:00/11:00/12:00) → RAM-/Last-Contention bei paralleler Agentenlast, **kein** Nacht-/Sleep-Muster (Keep-Awake `de.whitestag.keep-awake` greift bereits).

## 2. Ziele / Nicht-Ziele

**Ziele**
- Kein Agent bleibt nach einer *transienten* LLM-Störung dauerhaft tot. Sobald das Endpoint gesund ist, kommt er automatisch wieder hoch.
- Nicht selbst heilbare Störungen werden **ursachengerecht** behandelt (eskaliert), nicht stumpf wiederholt.
- Die häufigsten *Auslöser* (transiente `fetch failed`) werden im Adapter abgefangen, bevor ein Agent überhaupt in `error` fällt.
- Keine neuen Fehler-/Budget-Kaskaden durch die Heilung selbst.

**Nicht-Ziele (bewusst ausgeklammert)**
- Aufräumen des bestehenden Recovery-Kaskadenbergs (~218 blockierte „Recover stalled…"-Issues, v.a. Clara/Büroleitung). Separater Cleanup.
- Grundsanierung der `max_iterations`-Ursache „vage Routinen" (Prompt-/Routinen-Qualität). Wir heben Caps punktuell an und eskalieren sauber; die inhaltliche Sanierung ist Folgearbeit.
- PII/Content-`400`-Fälle inhaltlich lösen. Der Wächter eskaliert sie nur, statt sie totzuschleifen.

## 3. Architektur — drei Bausteine

### Baustein A — Selbstheilungs-Wächter *(Fundament, Monorepo)*

Neues Modul `server/src/services/recovery/agent-self-heal.ts`, eingehängt in den bestehenden Scheduler-Tick (`server/src/index.ts:722`, 30 s), hinter Flag `AGENT_SELF_HEAL_ENABLED` (Default `true`) mit eigenem internen Cooldown (nicht jeder 30-s-Tick handelt).

Pro Durchlauf:

1. **Scan.** Agenten mit `status='error'` laden (join `agent_runtime_state` für `last_run_status`, `last_error`, `updated_at`). `paused`/`terminated`/`pending_approval` überspringen (spiegelt den early-return in `finalizeAgentStatus:6159`).
2. **Klassifikation** von `last_error` in:
   - `infra_transient` — matcht `fetch failed`, `timed out`/`timeout`, `insufficient resources`/`resources`, Connection-Reset.
   - `convergence` — matcht `max_iterations`.
   - `deterministic` — matcht `400`/`blocked`, `parse`, `authenticate`.
   - `unknown` — Rest → wie `deterministic` behandeln (konservativ eskalieren, nicht blind retryen).
3. **Endpoint-Health-Gate** (heute nicht existent). Für `infra_transient`: das LLM-Endpoint des Agenten via `/v1/models` pingen **und** prüfen, ob das konfigurierte Modell (bzw. Fallback) geladen ist. Für `claude_local`-Agenten ein leichter Reachability-Check gegen den Anthropic/PII-Proxy-Pfad; im Zweifel als „gesund" werten (kein lokales Modell-Listing möglich).
4. **Wiederbelebungs-Politik** mit Versuchs-Ledger (§4) und exponentiellem Cooldown (5 min → 15 min → 60 min):
   - `infra_transient` **&& Endpoint gesund && Modell geladen** → Agent auf `idle` (`agentService.resume`-Pfad wiederverwenden, nicht direkt patchen), gestrandetes Issue entblocken/wecken via `heartbeat.wakeup`. Nach `MAX_INFRA_REVIVES` (z.B. 3) im Fenster → an Mensch eskalieren.
   - `infra_transient` && Endpoint **down** → diesen Tick nichts (nächster eligible Tick erneut). Ist das Endpoint länger als `ENDPOINT_DOWN_ALERT_MS` down → **einmalig** alarmieren (nicht pro Tick).
   - `convergence` → **nicht** blind neu starten. Einmal an den Vorgesetzten aus `chainOfCommand`/`reports_to` eskalieren. **Manager-tot-Schutz:** ist der Zielmanager selbst `error`/`terminated`, eine Ebene höher; ganz oben an den Menschen (Mail/Board). Ledger verhindert Mehrfach-Eskalation derselben Störung.
   - `deterministic`/`unknown` → sofort an Menschen eskalieren (Board-Approval/Mail), kein Auto-Retry.
5. **Protokollierung.** Jede Aktion in `activity_log` (`action: "agent.self_heal.*"`) — Klasse, Entscheidung, Endpoint-Status, Versuchszähler.

**Anti-Sturm-Garantien:** rührt **nur** `error`-Agenten an (nie gesunde); Ledger-Cooldown; `MAX_CONCURRENT_REVIVES` pro Tick; Eskalationen idempotent pro (Agent, Fehler-Fingerprint).

**Weck-Kanal (verifiziert):** `agent_wakeup_requests`-Zeilen werden von `enqueueWakeup()` **beim Einfügen** verarbeitet (Coalescing + Run-Erzeugung) — ein Roh-DB-Insert wird **nicht** eingesammelt und bleibt `queued`. Der Wächter ruft daher in-process `heartbeat.wakeup(agentId, …)` auf (dieselbe Funktion, die die Route `POST /api/agents/:id/wakeup` nutzt).

### Baustein B — Adapter-Härtung *(Auslöser senken)*

Im externen Adapter `opensource/paperclip-adapter-lmstudio` (TypeScript-Plugin, registriert als `lmstudio_local`):

1. **Retry/Backoff auf dem Completion-Call.** Heute retryt nur der Endpoint-Probe (`src/server/endpoint-resolver.ts:34`), **nicht** der eigentliche Chat-Completion-Call (`src/server/llm-client.ts:91` und `:142`) — der wirft bei `fetch failed` sofort. Bounded Retry (3 Versuche, exp. Backoff 0,5/1,5/4 s) für Connection-Level-Fehler (`fetch failed`, `ECONNRESET`, `socket hang up`) und `503`/overloaded. Fängt die Tages-Contention ab, **bevor** der Agent in `error` fällt. Nicht-transiente Fehler (echte 4xx via `classifyHttpError`) bleiben unverändert → Fallback-Modell-Logik greift wie gehabt.
2. **`max_iterations` (`src/server/execute.ts`).** (a) Cap der Manager-Agenten (CTO/CEO), die legitim mehrschrittig arbeiten, prüfen/anheben; (b) den Terminal-Ausgang „weich" machen — Teilergebnis + Eskalationssignal zurückgeben statt hartem `errorCode:"max_iterations"`, damit nicht jede Nicht-Konvergenz als Agent-Tod endet. Den harten Kreisdreh-Fall fängt zusätzlich der `convergence`-Zweig aus Baustein A.

## 4. Datenmodell — Versuchs-Ledger

Neue Tabelle `agent_self_heal_ledger` (Drizzle-Migration in `packages/db`):

| Spalte | Typ | Zweck |
|---|---|---|
| `agent_id` | uuid FK | betroffener Agent |
| `error_class` | text | `infra_transient`/`convergence`/`deterministic`/`unknown` |
| `error_fingerprint` | text | normalisierter `last_error` (Dedup pro Störung) |
| `attempt_count` | int | Wiederbelebungs-/Eskalationsversuche im Fenster |
| `last_action` | text | `revived`/`escalated_manager`/`escalated_human`/`waited_endpoint_down` |
| `next_eligible_at` | timestamptz | Cooldown-Gate |
| `resolved_at` | timestamptz | gesetzt, sobald ein Run wieder `succeeded` |
| `created_at`/`updated_at` | timestamptz | |

Unique auf `(agent_id, error_fingerprint)` solange `resolved_at IS NULL`.

## 5. Konfiguration (env, `server/src/config.ts`)

| Flag | Default | Zweck |
|---|---|---|
| `AGENT_SELF_HEAL_ENABLED` | `true` | Wächter an/aus |
| `AGENT_SELF_HEAL_MAX_INFRA_REVIVES` | `3` | Wiederbelebungen je Störung, dann Mensch |
| `AGENT_SELF_HEAL_COOLDOWN_MS` | `300000` | Basis-Cooldown (exp. Backoff) |
| `AGENT_SELF_HEAL_ENDPOINT_DOWN_ALERT_MS` | `1800000` | Endpoint-Down-Alarmschwelle |
| Adapter: `retryBackoffMs`, `maxCompletionRetries` | `500`, `3` | Completion-Retry |

## 6. Testing

- **Baustein A (Unit/Integration, vitest, `server`):** Klassifikation je Fehler-Signatur; Health-Gate blockt Revive bei Endpoint-down / fehlendem Modell; Cooldown/Ledger verhindert Sturm; convergence eskaliert an lebenden Manager, überspringt toten; deterministic eskaliert an Mensch ohne Retry; `resolved_at` wird bei Folgeerfolg gesetzt. Endpoint-Probe und `heartbeat.wakeup` gemockt.
- **Baustein B (Adapter, vitest):** Completion-Retry greift bei `fetch failed`/`ECONNRESET`/`503` und gibt nach Erfolg im 2./3. Versuch sauber zurück; echte 4xx werden **nicht** geretryt (Fallback-Pfad bleibt); `max_iterations` liefert weichen Ausgang.
- **Regression:** bestehende Recovery-Tests (`server/src/services/recovery/*.test.ts`) bleiben grün.

## 7. Deploy

- **Baustein A** in den launchd-Dev-Server `:3100` — **niemals** in den Watch-Tree mergen; sauber via `launchctl kickstart -k …ing.paperclip.dev` (siehe Memory „Paperclip Dev-Server launchd"). DB-Migration vor Kickstart einspielen.
- **Baustein B** in den Adapter → `pnpm build` im Adapter-Repo, dann Adapter-Reload (Plugin neu laden / Server-Kickstart, damit `dist/` neu gezogen wird).
- Rollout hinter Default-an-Flags; bei Auffälligkeit `AGENT_SELF_HEAL_ENABLED=false` + Kickstart als Not-Aus.

## 8. Sofort-Stopgap (bereits ausgeführt 2026-07-24)

Unabhängig vom Bau wurden die 11 toten Agenten wiederbelebt: `error → idle` (DB), SEO/GEO-Issue `WHI-2624` entblockt, und alle 11 via `POST /api/agents/:id/wakeup` (Board-Token) sauber angestoßen. Verifikation der Run-Ausgänge separat protokolliert. Der Wächter (Baustein A) macht diesen manuellen Eingriff künftig überflüssig.
