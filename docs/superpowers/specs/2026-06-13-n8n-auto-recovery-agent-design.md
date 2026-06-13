# n8n Auto-Recovery Agent — Design

**Datum:** 2026-06-13
**Status:** Approved (Brainstorming)
**Company:** WHITESTAG (`9cebf3cf-efe8-4597-a400-f06488900a87`)

## Ziel

Ein Paperclip-Agent unterhalb des CTO überwacht die n8n-Workflows, diagnostiziert Fehler
und behebt sie — sichere Fälle automatisch, riskante nur nach Freigabe. Er löst die heutige
reine Morgen-Meldung des Wächters ab: aus „Meldung" wird „Diagnose + Reparatur + Tagesreport".

## Anforderungen (geklärt)

- **Umfang:** Auto-Recovery (Fehlererkennung + automatische Korrektur-Versuche).
- **Priorität:** Alle Errors (kein Filter nach Wiederholung/Kritikalität).
- **Reaktionszeit:** Nächtlich (03:30, wie bisher) — die Kadenz kommt vom Detektor.
- **Autonomie:** Gestuft — sichere Fixes automatisch, riskante nur mit Freigabe.
- **Übergabe/Reporting:** Detektor legt **nur noch Paperclip-Tasks** an (keine Morgen-Mail
  mehr); der Überblick kommt aus dem Tagesreport, den der Agent in Paperclip pflegt.

## Ausgangslage

Der heutige Wächter (`tools/n8n-workflow-watcher/n8n_workflow_watcher.py`, Laufkopie unter
`~/.paperclip/scripts/n8n-workflow-watcher.py`) ist ein **reiner Detektor**:

- Liest `~/.n8n/database.sqlite` read-only (`mode=ro`).
- Findet aktive Workflows (`workflow_entity.active = 1`), deren **jüngste** Execution
  (`execution_entity`, MAX `startedAt`, `deletedAt IS NULL`, Fenster 14 Tage) Status
  `error` oder `crashed` hat (`FAIL_STATUSES = {"error","crashed"}`).
- Meldet per Mailhub-Webhook (`POST http://127.0.0.1:5678/webhook/mailhub/send`,
  Header `X-Mailhub-Secret`) an `ws@whitestag.ai`; Dedup max. 1 Mail/Tag.
- Läuft 03:30 via launchd (`~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist`).
- State: `~/.paperclip/instances/default/state/n8n-workflow-watcher.json`.

Wichtige Plattform-Randbedingungen:
- macOS launchd kann `~/Library/CloudStorage/SynologyDrive…` **nicht** lesen → Skripte laufen
  aus `~/.paperclip/scripts/` (Source of Truth bleibt im Repo, wird zur Laufzeit kopiert).
- Lokale LM-Studio-Agenten können **nur Text generieren** — kein Bash/DB/API. Echtes
  Recovery braucht daher zwingend einen `claude_local`-Agenten mit Tool-Zugriff.
- Paperclip-Control-Plane lokal auf `:3100`; Board-Token in `~/.paperclip/auth.json`.

## Architektur

Drei klar getrennte, einzeln testbare Einheiten:

### 1. Detektor (Weiterentwicklung des Wächters)

Python-Skript in `~/.paperclip/scripts/` (Repo-Quelle `tools/n8n-workflow-watcher/`),
läuft weiter 03:30 via launchd.

- **Erkennung:** unverändert (sqlite RO, aktive Workflows, jüngste Execution
  `error`/`crashed`).
- **Neu — Übergabe statt Mail:** legt pro **neuem** Fehler-Execution eine Paperclip-Task an:
  `POST /api/companies/9cebf3cf…/tasks`, zugewiesen an den Recovery-Agenten. Authentifizierung
  über Board-Token aus `~/.paperclip/auth.json`.
- **Idempotenz:** State-JSON wird um die Menge bereits als Task gemeldeter `exec_id` erweitert;
  derselbe Fehler erzeugt keine zweite Task.
- **Task-Inhalt:** Workflow-Name + `wf_id`, `exec_id`, Status, `startedAt`, sowie ein erster
  Auszug der Fehlermeldung (aus `execution_data`, falls günstig zugänglich) als Kontext.
- **Meta-Monitoring (Fallback):** Kann der Detektor die Paperclip-API **nicht** erreichen,
  fällt er auf **eine einzige** Mailhub-Fehler-Mail an `ws@whitestag.ai` zurück, damit kein
  blinder Fleck entsteht. Im Normalbetrieb wird **nicht** gemailt.

### 2. Recovery-Agent „n8n-Betriebsingenieur"

- `companyId` = WHITESTAG `9cebf3cf-efe8-4597-a400-f06488900a87`
- `reportsTo` = CTO
- `adapterType` = `claude_local` (Bash/Tool-Zugriff erforderlich)
- `capabilities`: „Überwacht n8n-Workflows, diagnostiziert Fehler aus execution_data, behebt
  sichere Fälle automatisch (Retry, Reaktivieren), eskaliert riskante via Approval an den CTO."
- **Wake-Mechanismus:** Die Task-Zuweisung durch den Detektor löst einen **Task-Wake-Heartbeat**
  aus → kein separater Zeitplan nötig; die nächtliche Kadenz ergibt sich aus dem Detektor-Lauf.
- **Anlage:** über `POST /api/companies/{id}/agent-hires` + Board-`approve`
  (`requireBoardApprovalForNewAgents=true` ⇒ direktes `POST /agents` würde mit 409 scheitern).
- **Instructions (AGENTS.md/SOUL.md):** Playbook-Katalog, Autonomie-Stufen, Reportformat,
  Eskalationsregeln (siehe unten).

### 3. Recovery-Toolkit

Kleine, deterministische CLI-Helfer (Python) in `~/.paperclip/scripts/n8n-recovery/`
(Repo-Quelle im `tools/`-Baum), je mit genau einer Aufgabe — der Agent ruft sie per Bash auf:

- `n8n_read_execution.py <exec_id>` — dumpt aus `execution_data` den fehlgeschlagenen Node,
  die Fehlermeldung und den Stacktrace (read-only).
- `n8n_retry_execution.py <exec_id>` — 🟢 Retry der Execution über die n8n-REST-API.
- `n8n_reactivate_workflow.py <wf_id>` — 🟢 Workflow reaktivieren.
- `n8n_health.py` — read-only Diagnose: n8n-Prozess, relevante Env-Vars
  (`N8N_BLOCK_ENV_ACCESS_IN_NODE`, `NODE_FUNCTION_ALLOW_BUILTIN`), `healthz`.

Riskante Aktionen werden **bewusst nicht** als Ein-Klick-Helfer bereitgestellt — sie laufen
über den Approval-Pfad (siehe Stufen).

## Autonomie-Stufen (harte Guardrails)

- 🟢 **GRÜN (automatisch):** Diagnose lesen, Execution-Retry (**max. 1×** pro Execution),
  Workflow reaktivieren.
- 🔴 **ROT (Approval erforderlich):** n8n-Neustart, Credential-Sync/-Rotation aus
  `~/.whitestag.env`, Workflow-JSON-Edit, alles was die laufende Instanz stört oder Secrets
  berührt. Der Agent erstellt eine Paperclip-**Approval an den CTO** (Eskalation an Walter über
  die CTO-Kette) mit konkretem Plan/Diff und führt **erst nach Freigabe** aus.

Die ROT-Liste deckt exakt die wiederkehrenden Incident-Typen aus den Projekt-Memories ab
(Orphan-n8n ohne korrekte Env, blockierte `$env`-Zugriffe, abgelaufene Telegram-/Mailhub-Tokens)
— die sind disruptiv und daher korrekt gated.

## Datenfluss

```
03:30 launchd
  → Detektor liest sqlite (RO)
  → neue Fehler-Executions (nicht in State)
  → pro Execution: POST Paperclip-Task an Recovery-Agent (idempotent über exec_id)
  → Task-Wake weckt Agent
  → Agent je Task:
       n8n_read_execution → klassifizieren gegen Playbook
       ├─ 🟢 GRÜN: Retry (max 1×) / Reaktivieren → Ergebnis als Kommentar
       ├─ 🔴 ROT: Approval an CTO mit Plan/Diff → nach Freigabe ausführen
       └─ nicht behebbar: Diagnose + Eskalation als Subtask an CTO
  → Agent aktualisiert Rollup-Task „n8n Ops Nightly <Datum>"
```

## Reporting

Kein Mail-Push. Der Agent pflegt eine **Rollup-Task „n8n Ops Nightly `<Datum>`"** mit:
gefunden / auto-behoben / Approval offen / an CTO eskaliert. Das ist der Tagesreport in
Paperclip. Eskalationen werden Subtasks an den CTO; die Einzel-Fehler-Tasks werden mit
Diagnose + Maßnahme geschlossen.

## Fehlerbehandlung & Grenzen

- **Retry-Cap:** max. 1 Auto-Retry pro Execution; scheitert auch der → eskalieren, keine Schleife.
- **n8n komplett tot:** kein „Hineinretten" möglich → ROT/Eskalation.
- **Nicht behebbar** (Code-Bugs, fehlende/ungültige API-Keys): saubere Diagnose + Eskalation,
  kein Blindversuch.
- **Detektor-Ausfall:** API nicht erreichbar → einmalige Fallback-Mail an Walter (Meta-Monitoring).
- **Doppelarbeit:** Idempotenz über `exec_id` im Detektor verhindert Mehrfach-Tasks; der Agent
  ignoriert bereits geschlossene Tasks.

## Testing

- **Detektor:** Unit-Test der SQL→Task-Abbildung und der Idempotenz gegen eine Fixture-sqlite.
- **Toolkit:** jeder Helfer einzeln gegen eine Wegwerf-n8n-Instanz oder gemockte REST-API.
- **Agent:** Trockenlauf gegen einen bekannten historischen Fehler (z.B. ein „access to env
  vars denied"-Fall) — prüft Klassifikation, GRÜN/ROT-Entscheidung, Reportformat.

## Abgrenzung (YAGNI)

- Keine Echtzeit-/Minuten-Pollung — bewusst nächtlich.
- Kein eigener Mail-Versand des Agenten — Report lebt in Paperclip.
- Keine Ein-Klick-Helfer für riskante Aktionen — diese laufen ausschließlich über Approval.
- Keine Filter-/Priorisierungslogik nach Workflow-Kritikalität — „alle Errors".

## Offene Punkte für die Plan-Phase

- Genaues Paperclip-Task-API-Schema (Felder für Assignee, Parent/Subtask, Approval-Erzeugung)
  am Live-System verifizieren.
- n8n-REST-Endpunkte für Retry/Reaktivieren gegen die installierte n8n-Version (2.25) prüfen.
- Entscheidung, ob der bestehende `n8n-workflow-watcher.py` in-place erweitert oder als
  versioniertes Nachfolge-Skript geführt wird.
