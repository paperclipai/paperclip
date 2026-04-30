# Paperclip Routine Checks — Migration aus Hermes/Openclaw

**Status:** Draft (rev 3 — addresses spec-review)
**Date:** 2026-04-30
**Owner:** marco
**Scope:** paperclip-Server, hermes-agent, openclaw workspace

## Problem

Routine-Checks für paperclip-Domäne (Workspace-Drift, Subscription-Shadow-Sync, Creative-Lint, Drive-Marker, Approved-Freshness) liegen aktuell verteilt:

- **hermes** `~/.hermes/cron/jobs.json` enthält paperclip-Domänenlogik als Prompt-Strings (SQL inline, nicht versioniert/getestet)
- **openclaw** `~/.openclaw/workspace/scripts/paperclip-*.sh` enthält Shell-Scripts für paperclip-Subscriptions
- **paperclip** Skill `paperclip-creative` führt nur PostToolUse-Hook-Lints, keine Routine-Checks

Probleme:

1. **Ownership** — paperclip-Domänenlogik in Hermes-Prompts und openclaw-Shell-Scripts statt im paperclip-Repo
2. **Dedup** — Workspace-Lint überlappt zwischen `nightly_workspace_consistency_audit.sh` und PostToolUse-Hook
3. **Versionierung/Test** — Hermes-Prompt-SQL hat keine Tests, keine Code-Review, keine Migrations-Pfade bei Schema-Änderungen
4. **Reichweite** — alle Findings gehen via Telegram an Marco; keine UI/DB-Persistenz, kein Dashboard, kein historischer Trend

## Goals

- Paperclip-Domänenlogik wandert ins paperclip-Repo (versioniert, getestet, code-reviewed)
- Hermes wird Delivery-Layer (Telegram-Webhook + Adhoc + nicht-paperclip Cron)
- Openclaw bleibt workspace-meta + Host-Health, kein paperclip-spezifischer Code mehr
- Findings persistiert in paperclip-DB, sichtbar in UI
- Notify-Channel pro Check konfigurierbar: `silent | threshold | telegram`

## Non-Goals

- Migration der nicht-paperclip Hermes-Jobs (ai-rate-limit-watch bleibt)
- Migration von Workspace-Meta-Audits (nightly_workspace_consistency_audit, openclaw-spec-validator bleiben in openclaw)
- Migration von Host-Health-Checks (infra/disk/cert/load bleiben in openclaw)
- UI-Redesign — Findings-View wird in einem Folge-Spec separat designed

## Architecture

```
┌─────────────────────┐    ┌──────────────────────┐    ┌────────────────────┐
│ paperclip server    │    │ openclaw scripts     │    │ hermes             │
│ ├ services/cron.ts  │    │ ├ nightly_audit.sh   │    │ ├ cron/jobs.json   │
│ ├ routine-checks/   │    │ ├ spec-validator.sh  │    │ │  (only delivery  │
│ │ ├ runner.ts       │    │ └ infra/disk/cert    │    │ │   + ad-hoc)      │
│ │ ├ registry.ts     │    └──────────────────────┘    │ └ webhook handler  │
│ │ ├ notify.ts       │              ▲                 │   /paperclip/notify│
│ │ └ checks/         │              │                 └─────────┬──────────┘
│ │   ├ workspace-drift-guard.ts     │                  Telegram │
│ │   ├ subscription-shadow-sync.ts  │                  ─────────▼──────────
│ │   ├ creative-lint-nightly.ts     │                  Marco Telegram
│ │   ├ drive-marker-ttl.ts          │
│ │   └ approved-freshness.ts        │
│ └ DB routine_check_runs            │
└──────────┬──────────────────────────┘
           │ POST /paperclip/notify
           └──────────────────────────────────────────────► hermes
```

**Prinzipien:**

- **paperclip** = Domain-Logik + Scheduler + Persistenz
- **openclaw** = workspace-meta + Host-Health (kein paperclip-Code)
- **hermes** = Delivery-Layer (Telegram-Webhook) + Adhoc + nicht-paperclip Cron

## Modul-Struktur

```
server/src/services/routine-checks/
├── runner.ts              # cron tick → run check → persist → dispatch notify
├── registry.ts            # Map<name, CheckDef>
├── notify.ts              # silent | threshold | telegram dispatcher
├── checks/
│   ├── workspace-drift-guard.ts
│   ├── subscription-shadow-sync.ts
│   ├── creative-lint-nightly.ts
│   ├── drive-marker-ttl.ts
│   └── approved-freshness.ts
└── __tests__/
```

### CheckDef Schema

```ts
interface CheckDef {
  name: string;                                // 'workspace-drift-guard'
  schedule: string;                            // cron expr '0 9,18,22 * * *'
  notify: 'silent' | 'threshold' | 'telegram';
  thresholdSeverity?: 'warn' | 'error';
  run(ctx: CheckCtx): Promise<CheckResult>;
}

interface CheckResult {
  status: 'ok' | 'warn' | 'error';
  findings: number;
  payload: Record<string, unknown>;
  summary: string;                             // 1-Zeile für Telegram
}

interface CheckCtx {
  db: DrizzleDb;
  fs: typeof import('node:fs/promises');
  now: () => Date;
  logger: Logger;
}
```

### DB-Tabelle (drizzle migration)

```sql
CREATE TABLE routine_check_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_name      text NOT NULL,
  scheduled_for   timestamptz NOT NULL,    -- soll-Zeitpunkt aus cron-expression
  run_at          timestamptz NOT NULL,    -- ist-Start (kann durch catch-up != scheduled_for sein)
  status          text NOT NULL,           -- ok | warn | error
  findings        int  NOT NULL,
  notify_channel  text NOT NULL,           -- silent | threshold | telegram
  payload_json    jsonb NOT NULL,
  notified        bool NOT NULL DEFAULT false,
  duration_ms     int,
  error_text      text,
  UNIQUE (check_name, scheduled_for)        -- verhindert Doppel-Insert bei Runner-Doppelfeuer
);
CREATE INDEX ON routine_check_runs(check_name, run_at DESC);
CREATE INDEX ON routine_check_runs(check_name, status, run_at DESC);  -- "letzter Fehler"
```

### Catch-up-Policy

Beim Boot des paperclip-Servers (oder nach längerer Downtime) iteriert der Runner pro Check und vergleicht `max(scheduled_for)` in DB mit der erwarteten Schedule-Sequenz. Wenn ein Slot fehlt (Differenz > 1 schedule period + 60s grace):

1. Catch-up nur für **letzten** verpassten Slot (kein Bulk-Replay um Telegram-Spam zu vermeiden)
2. Catch-up-Run setzt `run_at = NOW()`, `scheduled_for = <missed slot>`
3. Notify-Dispatcher rechnet Catch-up wie normalen Run, aber mit Suffix `(catch-up)` im Summary

Boot-Hook in `services/cron.ts` ruft `routineCheckRunner.catchUpAll()` einmalig nach Schedule-Registrierung.

**Race-Schutz (Boot-Catch-up vs regulärer Tick):** Insert verwendet ON-CONFLICT-Strategie:

```sql
INSERT INTO routine_check_runs (check_name, scheduled_for, run_at, status, ...)
VALUES ($1, $2, NOW(), 'running', ...)
ON CONFLICT (check_name, scheduled_for) DO NOTHING
RETURNING id
```

Runner führt Check-Logik nur aus wenn `RETURNING id` eine Row liefert (Insert hat geklappt). Bei 0 Rows → anderer Worker hat den Slot schon, skip. Verhindert dass Boot-Catch-up und regulärer Tick denselben `scheduled_for` doppelt verarbeiten.

### Notify-Dispatcher

Vor jedem Dispatch berechnet Runner `previousStatus`:

```sql
SELECT status FROM routine_check_runs
 WHERE check_name = $1 AND id <> $current_id
 ORDER BY scheduled_for DESC
 LIMIT 1
```

`stateChange = previousStatus !== null && previousStatus !== currentStatus`.

Channel-Regeln:

- `silent` → INSERT only. **Ausnahme:** wenn `stateChange && (previousStatus IN ('warn','error') && currentStatus === 'ok')` → POST mit recovery-Präfix. (Stable-Status keine Notify, Recovery aus warn/error pflicht — sonst sieht Marco nie "Drift weg".)
- `threshold` → INSERT. POST wenn `currentStatus >= thresholdSeverity` ODER `stateChange`. State-change in beide Richtungen (warn↔ok).
- `telegram` → INSERT. POST wenn `findings > 0` ODER `stateChange`.

**Klarstellung:** "silent" heißt "no notify on stable status (success oder Wiederholung)", nicht "no notify ever". State-change-Recovery ist Pflicht für alle Channels.

**Recovery-Präfix:** Notify-Payload `summary` bekommt Präfix `✅ recovery — ` wenn `previousStatus IN ('warn','error') && currentStatus === 'ok'`.

### Webhook-Payload (paperclip → hermes)

```json
{
  "check": "workspace-drift-guard",
  "status": "warn",
  "previous_status": "ok",
  "findings": 3,
  "summary": "HAPPYGANG: 3 cwd outside prefix, TechOps: clean",
  "content_hash": "sha256-of-summary+findings+top-3-examples",
  "scheduled_for": "2026-04-30T09:00:00+02:00",
  "details_hint": "paperclip checks history workspace-drift-guard --limit 1"
}
```

**Kein `details_url`** bis UI-Findings-View Spec live ist. Dann Folge-PR ergänzt URL und Telegram-Template wird auf Link umgestellt.

**Auth:** `Authorization: Bearer <PAPERCLIP_NOTIFY_TOKEN>` Pflicht. Hermes 401 bei Fehlen/Mismatch.

**Dedupe (hermes-side):** SQLite `~/.hermes/cron/paperclip_notify_dedupe.db` mit Tabelle `(check_name, content_hash, last_sent_at)`. Persistiert über Hermes-Restart. Kein TTL-Window — Key `(check_name, content_hash)`. Reihenfolge:

1. POST kommt rein, validate Bearer
2. Compute key = `(check_name, content_hash)`
3. Wenn Key existiert UND `previous_status == status` (kein state-change): 200 noop, kein Telegram
4. Sonst: Telegram-Send, INSERT/UPDATE Dedupe-Row, 200 ok

Damit:
- 3×/Tag drift-guard mit selbem Drift → 1 Telegram, weitere stumm bis Drift-Set sich ändert
- state-change ok→warn oder warn→ok → immer durch
- Inhalts-Änderung (anderes Beispiel-Path) → neue Telegram (neuer hash)

### CLI

```
paperclip checks list                 # alle registrierten Checks + nächster Run-Zeitpunkt
paperclip checks run <name>           # manuell triggern, Output ohne Notify
paperclip checks history <name> --limit 20
```

## Migration pro Check

### 1. workspace-drift-guard.ts

- **Ersetzt:** hermes job `d2c9532bbc77`
- **Schedule:** `0 9,18,22 * * *`
- **Notify:** `threshold` (warn = ≥1 Drift-Indikator > 0)
- **Logik:** Bestehende SQL aus Hermes-Prompt 1:1 portiert. 4 Indikatoren pro Company:
  - `local_agent_cwd_outside` (cwd außerhalb `/Users/marco/.openclaw/workspace`)
  - `active_exec_ws_outside`
  - `open_issues_without_project_workspace`
  - `run_event_context_cwd_outside_24h`
- **Findings:** Σ aller 4 Indikatoren über alle Companies
- **Payload:** `{ companies: [{name, indicators}], examples: string[] }`

### 2. subscription-shadow-sync.ts

- **Ersetzt:** hermes job `673c5760a64a` + openclaw `paperclip-subscription-shadow-sync.sh`
- **Schedule:** `*/30 * * * *`
- **Notify:** `silent` für Normalbetrieb (Inserts sind erwartet, ~48 Runs/Tag); status `error` mit threshold-notify nur bei: SQL-Failure, DB-Connection-Loss, ODER `inserted_shadow_events > P95_baseline * 3` (Spike-Detection).
- **Threshold-Konfig:** `P95_baseline` als ENV `PAPERCLIP_SHADOW_SYNC_P95=<int>`, default 50. Spec Sub-Issue: nach 1 Woche Telemetrie aus `routine_check_runs` neu kalibrieren.
- **Logik:** Shell-Script-Body in TS portiert (DB-Query + insert), DB-Zugriff via vorhandener drizzle-Connection des paperclip-Servers (gleiche DB)
- **Payload:** `{ inserted_shadow_events: int, utilization: [{company, used, limit}], spike: bool }`
- **Openclaw-Stub:** Shell-Script wird zu `exec paperclip checks run subscription-shadow-sync` (1 Woche Backwards-Compat, dann löschen)

### 3. creative-lint-nightly.ts

- **Neu** (aktuell nur PostToolUse-Hook, kein Nightly-Lauf)
- **Schedule:** `30 2 * * *`
- **Notify:** `silent`
- **Logik:** Iteriert `~/.openclaw/workspace/projects/happygang/<slug>/`, ruft `node /Users/marco/Code/paperclip/scripts/creative-workspace/lint.mjs <project>` auf, sammelt Exit-Code + Violations
- **Findings:** Σ violations über alle Projekte
- **Payload:** `{ projects: [{slug, exit, errors, warnings}] }`

### 4. drive-marker-ttl.ts

- **Neu**
- **Schedule:** `*/15 * * * *`
- **Notify:** `silent`
- **Klassifikation:** Marker ist Bestandteil der paperclip-creative Drive-Upload-Policy (siehe `~/.agents/skills/paperclip-creative/SKILL.md` "Drive-Uploads"). TTL-Enforcement gehört zur Skill-Domäne, nicht zur openclaw-Workspace-Meta. Pfad liegt zwar unter `~/.openclaw/workspace/projects/happygang/...`, aber Semantik (60-min-Drive-Approval) ist paperclip-creative.
- **Logik:** Glob `~/.openclaw/workspace/projects/happygang/**/.drive-approved-*`, mtime > 60min → unlink
- **Findings:** Anzahl entfernter Marker (informativ, nicht warn)
- **Payload:** `{ removed: string[] }`

### 5. approved-freshness.ts

- **Neu**
- **Schedule:** `0 7 * * 1` (Montag morgens)
- **Notify:** `threshold` (warn = ≥1 stale Item)
- **Logik:** Pro Projekt alle `assets/*/04-approved/<item>/APPROVAL.md` parsen, Sign-off-Zeile `✅ sign-off marco YYYY-MM-DD HH:MM` extrahieren, age vs Freigabe-Datum prüfen
- **Findings:** Anzahl Items älter als 14 Tage ohne erneuten Sign-off
- **Payload:** `{ stale_items: [{project, item, age_days}] }`

## Was NICHT migriert wird

- `paperclip_phase0_check.sh` — One-Shot Phase-Audit, obsolet → **löschen** (Script + LaunchAgent)
- `nightly_workspace_consistency_audit.sh` — workspace-meta, bleibt openclaw; paperclip-spezifische Teile rauswerfen falls vorhanden (kein Doppel-Check)
- `openclaw-spec-validator.sh` — workspace-meta, bleibt openclaw
- `infra-healthcheck.sh`, `disk-space-check.sh`, `cert-expiry-check.sh` — Host, bleibt openclaw
- Hermes-Job `a79c2315a3cf` (ai-rate-limit-watch) — provider-agnostisch, bleibt hermes

## Cutover (Big-Bang)

Eine atomare Session, ~30 min Implementierung + 5 min Cutover.

### Reihenfolge

1. **paperclip-Repo:**
   - DB-Migration `routine_check_runs` (drizzle generate + migrate)
   - Module `services/routine-checks/` + 5 Checks + Tests
   - CLI `paperclip checks {list|run|history}`
   - Registry-Eintrag in `services/cron.ts` Boot-Hook
   - `pnpm test` grün, `pnpm build` grün

2. **paperclip-Server smoke:**
   - `pnpm dev` Server hochfahren
   - `paperclip checks run workspace-drift-guard` → Output mit Hermes-Run vergleichen
   - `paperclip checks run subscription-shadow-sync` → Output mit letztem Hermes-Run vergleichen
   - `paperclip checks run creative-lint-nightly` → Violations matchen aktuellen Lint-State

3. **Hermes-Webhook:**
   - `/paperclip/notify` POST-Handler in Hermes deployen (FastAPI, Telegram-Send-Logik wie bisheriger cronjob_tools)
   - Bearer-Auth via `PAPERCLIP_NOTIFY_TOKEN` ENV (in beiden Repos), bind localhost-only
   - SQLite-Dedupe-Tabelle `paperclip_notify_dedupe` initial leer
   - Tests: `curl ohne Token → 401`, `curl mit Token → 200 + Telegram`, `zweiter curl mit gleichem hash → 200 noop`
   - LaunchAgent `de.marcoschmid.paperclip-server.plist` prüfen/erstellen — KeepAlive=true, RunAtLoad=true (Pre-Cutover Voraussetzung, Blocker wenn nicht da)

4. **Cutover (5min Fenster):**
   - paperclip-Cron enablen via ENV `PAPERCLIP_ROUTINE_CHECKS=1` (in `de.marcoschmid.paperclip-server.plist` EnvironmentVariables, Server-Reload)
   - Hermes-Jobs `d2c9532bbc77` + `673c5760a64a` **pausieren** (nicht löschen!) via `hermes cron pause <id>` mit reason `migrated-to-paperclip-2026-04-30`
   - Nach 7 Tagen stabilem Lauf: Jobs löschen via separatem Cleanup-Schritt
   - Openclaw-Script `paperclip-subscription-shadow-sync.sh` → 1-Zeilen Stub
   - Openclaw `paperclip_phase0_check.sh` + LaunchAgent löschen
   - Openclaw `paperclip-heartbeat-check.sh` deployen + LaunchAgent registrieren (siehe Heartbeat-Section unten)

5. **Verification (1h später):**
   - `paperclip checks history workspace-drift-guard --limit 3` → Run um nächstem geplanten Slot gelaufen
   - `SELECT count(*) FROM routine_check_runs WHERE run_at > NOW()-INTERVAL '24 hours'`
   - Telegram-Inbox: erwartete Drift-Alarme

### Pre-Cutover Snapshots

```bash
cp ~/.hermes/cron/jobs.json ~/.hermes/cron/jobs.json.pre-paperclip-migration
git -C ~/Code/paperclip tag pre-paperclip-routine-migration
git -C ~/Code/hermes-agent tag pre-paperclip-routine-migration
```

### Rollback

Während 7-Tage-Pausenfenster (warm rollback):

1. paperclip-Cron disablen: `unset PAPERCLIP_ROUTINE_CHECKS` in plist + `launchctl unload/load` ODER nur Server-Restart mit Flag aus
2. Hermes-Jobs reaktivieren: `hermes cron resume d2c9532bbc77 && hermes cron resume 673c5760a64a`
3. Verify: `hermes cron list` zeigt beide Jobs als `scheduled` mit nächstem Run
4. Recovery ~2min, kein Datenverlust

Nach 7-Tage-Cleanup (cold rollback, wenn Jobs schon gelöscht):

1. paperclip-Cron disablen wie oben
2. Snapshot-Restore: `cp ~/.hermes/cron/jobs.json.pre-paperclip-migration ~/.hermes/cron/jobs.json`
3. Hermes-Service-Reload (cron-Scheduler liest jobs.json neu)
4. Verify: `hermes cron list` zeigt beide Jobs
5. Recovery ~5min

(`git show <commit>:.hermes/cron/jobs.json` ist KEIN Pfad — `~/.hermes/` liegt nicht in einem Git-Repo. Snapshot-File ist die einzige Quelle.)

### Heartbeat-Check (in openclaw)

Da paperclip-Server nun Single-Point-of-Failure für 5 Routine-Checks ist, neuer openclaw-Check:

```bash
# ~/.openclaw/workspace/scripts/paperclip-heartbeat-check.sh
# Cron via LaunchAgent: alle 30 min
# Query: SELECT max(scheduled_for) FROM routine_check_runs WHERE check_name = 'subscription-shadow-sync'
# Wenn max(scheduled_for) < NOW() - INTERVAL '90 minutes' → Telegram-Alarm "paperclip-cron stuck"
#
# scheduled_for (nicht run_at) damit Catch-up nach Restart Heartbeat-False-Positive vermeidet:
# wenn Server 35min down war und dann Slot 09:00 catch-up um 09:35 läuft, ist
# scheduled_for=09:00 (Soll), run_at=09:35 (Ist) — Heartbeat-Schwelle 90min vergibt 3 Schedule-Perioden
```

Begründung: subscription-shadow-sync läuft alle 30min, also wenn 70min keine Row → Server tot oder Cron broken. Heartbeat in openclaw, nicht paperclip — sonst könnte ausgefallener paperclip nicht selber Alarm schlagen.

## Tests

### Unit (vitest, paperclip-Repo)

```
services/routine-checks/__tests__/
├── runner.test.ts
├── notify.test.ts
├── registry.test.ts
└── checks/
    ├── workspace-drift-guard.test.ts
    ├── subscription-shadow-sync.test.ts
    ├── creative-lint-nightly.test.ts
    ├── drive-marker-ttl.test.ts
    └── approved-freshness.test.ts
```

Coverage-Ziel: 80% pro Check, 100% notify-dispatcher (alarm-kritisch).

### Integration

- Real Postgres in test-container (drizzle migration apply, fixtures, run check, assert `routine_check_runs` row)

### Hermes-Webhook (pytest)

- POST `/paperclip/notify` ohne Bearer → 401, Telegram-Mock NICHT aufgerufen
- POST `/paperclip/notify` mit ungültigem Token → 401
- POST mit `{check, status: warn, content_hash: 'abc'}` + Token → 200, Telegram-Mock aufgerufen
- POST gleicher payload zweite Anfrage → 200 noop (Dedupe greift), Telegram-Mock genau 1× aufgerufen
- POST mit `{previous_status: 'warn', status: 'ok'}` (state-change) → 200, Telegram-Mock aufgerufen mit "✅ recovery —" prefix, auch wenn content_hash existiert
- POST mit `status: warn` aber neuer content_hash → 200, Telegram aufgerufen (Inhalt geändert)
- SQLite-Dedupe-DB persistiert über Hermes-Restart: Test-Restart, gleicher hash → noop

### SQL-Schema-Drift (integration)

- Drift-guard fixtures gegen reale paperclip-DB-Migration mit allen referenzierten Spalten (`agents.adapter_config`, `execution_workspaces.provider_ref`, `issues.project_id`, `heartbeat_run_events.payload`). Test failt early wenn Spalte umbenannt/entfernt — verhindert silent breakage.

## Akzeptanzkriterien

| Kriterium | Wie geprüft |
|---|---|
| Alle 5 Checks haben ≥1 erfolgreichen Run in DB innerhalb erwartetem Fenster | `SELECT check_name, max(run_at) FROM routine_check_runs GROUP BY 1` |
| workspace-drift-guard liefert gleichen Drift-Count wie letzter Hermes-Run am Cutover-Tag | manueller diff |
| subscription-shadow-sync `inserted_shadow_events` matcht ±1 letzten Hermes-Run | manueller diff |
| Telegram-Drift-Alarm kommt bei warn-Status, nicht bei silent | Telegram-Inbox check |
| Webhook-Auth: POST ohne Bearer → 401 | `curl -i -X POST localhost:<port>/paperclip/notify -d '{}'` |
| Webhook-Dedupe: zweiter POST mit gleichem `content_hash` → 200 noop, kein Telegram | curl 2× + Telegram-Inbox |
| Webhook-State-change: `previous_status=warn → status=ok` → Telegram mit `✅ recovery —` Präfix | scripted POST + Telegram-Inbox |
| Hermes-Jobs `d2c9532bbc77` + `673c5760a64a` haben `state=paused` mit reason `migrated-to-paperclip-2026-04-30` | `hermes cron list` |
| Nach 7 Tagen Cleanup: keine Hermes-Jobs mit `paperclip-` Prefix | `jq '.jobs[].name' ~/.hermes/cron/jobs.json \| grep ^paperclip` → empty |
| `paperclip_phase0_check.sh` + LaunchAgent weg | `ls ~/.openclaw/workspace/scripts/paperclip_phase0_check.sh` → no such file |
| `paperclip checks list` zeigt 5 Einträge mit nächstem Run-Zeitpunkt | manueller call |
| `nightly_workspace_consistency_audit.sh` ohne paperclip-spezifische Logik | `grep paperclip ~/.openclaw/workspace/scripts/nightly_workspace_consistency_audit.sh` → empty |
| Heartbeat-Check `paperclip-heartbeat-check.sh` läuft alle 30min via LaunchAgent | `launchctl list \| grep paperclip-heartbeat` |
| paperclip-Server LaunchAgent KeepAlive=true, RunAtLoad=true | `plutil -p ~/Library/LaunchAgents/de.marcoschmid.paperclip-server.plist` |
| Catch-up: Server-Stop für 35min während scheduled-slot, nach Restart genau 1 catch-up-row in DB | scripted: `launchctl unload`, sleep 35m, `launchctl load`, query DB |
| Race-Schutz: Catch-up + regulärer Tick auf gleichem Slot ergibt genau 1 row | concurrent runner-call mit gleichem `scheduled_for`, `SELECT count(*) WHERE scheduled_for=$1` → 1 |
| State-change recovery `silent` Check: error→ok sendet Telegram mit `✅ recovery —` Präfix | DB-Manipulation: vorletzten run auf status=error, aktuellen auf ok → Mock-Telegram check |

## Risiken

| Risiko | Mitigation |
|---|---|
| paperclip-Server crasht → keine Checks laufen | LaunchAgent KeepAlive=true (Voraussetzung Pre-Cutover); openclaw `paperclip-heartbeat-check.sh` (alle 30min); Catch-up-Policy beim Boot rekonstruiert letzten verpassten Slot |
| Webhook-Endpoint unerreichbar bei Cutover | Pre-Cutover Step 3 testet mit curl + Auth + Dedupe; Rollback via 7-Tage-paused-Hermes-Jobs (warm) oder Snapshot-Restore (cold) |
| DB-Migration kollidiert mit anderen Drizzle-Migrationen | Migration in eigenem Branch zuerst auf staging-DB, dann main; reservierter Migration-Slot vorab via `db:generate --review` |
| Schedule-Drift (paperclip-Cron timing ≠ Hermes-Cron) | beide Schedules identisch übernommen; Verification 24h nach Cutover via DB-Query |
| paperclip-DB-Schema-Drift bricht drift-guard SQL silent | Integration-Test exercises real schema; CI-Job blockt PR wenn referenzierte Spalten umbenannt werden ohne Spec-Update |
| Hermes-SQLite-Dedupe-DB korrupt | Bei `sqlite3.DatabaseError` im Dedupe-Lookup: log error, Telegram trotzdem senden, dedupe-write skippen. False-positive Duplicate ist OK, false-negative Miss ist nicht OK. |
| `PAPERCLIP_NOTIFY_TOKEN` leak via process-list/env-dump | Token aus `~/.paperclip/secrets/notify-token`, gelesen via fs (nicht ENV exportieren); Hermes-Side gleiches Pattern |

## Decisions (formerly Open Questions)

- **Hermes-Webhook-Auth:** Bearer Token via Shared Secret. Localhost-bind (`127.0.0.1:<port>`), kein mTLS — Single-User, Single-Host Setup. Token in File `~/.paperclip/secrets/notify-token` (mode 0600), beide Repos lesen daraus.
- **paperclip-Server Boot-Reliability:** Pre-Cutover Voraussetzung — LaunchAgent muss vor Cutover existieren mit KeepAlive=true, RunAtLoad=true. Falls aktuell nur `pnpm dev` läuft, vorab plist erstellen (außerhalb dieses Specs, aber Cutover-Blocker).
- **Catch-up bei missed runs:** Boot-Hook in `services/cron.ts` ruft `runner.catchUpAll()`, holt nur **letzten** verpassten Slot pro Check.
- **shadow-sync DB-Connection:** Vorhandene drizzle-Connection des paperclip-Servers wiederverwenden (gleiche DB, gleicher Pool). Kein zweiter Connection-String.
- **Feature-Flag-Pattern:** Neue ENV `PAPERCLIP_ROUTINE_CHECKS=1`, gelesen in `services/cron.ts` Boot-Hook. Wenn `0`/unset, Registry skippt Schedule-Registrierung. Default `0` für Tests, in production-plist `1`.
- **creative-lint-nightly Eskalation:** Bleibt `silent` solange UI fehlt. Sobald UI-Findings-View live (separater Spec), Upgrade auf `threshold` mit Schwelle "violations > 0 für > 3 Tage in Folge".

## Open (für Folge-Spec)

- **UI-Findings-View** für `routine_check_runs` (Liste, Filter, Letztes-Result-pro-Check) — separater Spec
- **paperclip-Server LaunchAgent** plist-Definition — separater Spec wenn nicht bereits existent

## References

- Hermes cron jobs: `~/.hermes/cron/jobs.json` (jobs `d2c9532bbc77`, `673c5760a64a`)
- Openclaw scripts: `~/.openclaw/workspace/scripts/paperclip-*.sh`, `paperclip_phase0_check.sh`
- Paperclip skill: `~/.agents/skills/paperclip-creative/SKILL.md`
- Existing paperclip cron infra: `server/src/services/cron.ts`, `server/src/services/plugin-job-scheduler.ts`
