# 2026-04-20 · Chiefs Delegation und Adapter-Fix

## Ausgangslage

Walter beobachtete, dass der CMO mehrere Tasks gleichzeitig selbst bearbeitete (u.a. LinkedIn-Kanal-Aufbau), statt an den Social Media Specialist zu delegieren. Untersuchung ergab:

- **CMO-Status**: `error` — Adapter-URL zeigte auf `http://192.168.2.181:1234`, aber LM Studio läuft tatsächlich auf `192.168.2.191:1234`.
- **CMO hatte 4 Issues gleichzeitig gestartet** (WHI-38/39/40/42), alle ohne Subtasks, alle in `blocked` gelandet.
- **AGENTS.md der Chiefs enthielten keine konkrete Delegations-Regel** — nur Bullet-Points wie „Koordination von Social Media Specialist …", ohne Subtask-/`blockedByIssueIds`-Flow.
- **Marken-Spezialist** hing unter CPO, obwohl der CMO-Prompt ihn als seinen Untergebenen beschrieb.
- **CFO-URL** zeigte ebenfalls auf das tote `.181`.

## Was wurde gemacht

### 1. CMO-Diagnose und -Fix
- Adapter-URL: `192.168.2.181` → `192.168.2.191`
- Status: `error` → `idle`
- Qwen3.6-Zugriff auf `.191` verifiziert (`qwen/qwen3.6-35b-a3b` antwortet, Reasoning-Modell)
- `Marken-Spezialist` (`ea38630c-…`) über `reportsTo` unter CMO (`bbf38291-…`) umgehängt
- 4 blocked Issues (WHI-38/39/40/42) zurück auf `todo` mit Kommentar

### 2. CMO-AGENTS.md erweitert
Neuer Abschnitt **`## Delegation (Pflicht)`** zwischen „Deine Verantwortung" und „Arbeitsweise":
- Routing-Tabelle (LinkedIn/Social → Social Media Specialist, Web → Web-Design, Branding → Marken-Spezialist, Bewegtbild → Creative Director, Recherche → Online-Recherche) — jeweils mit Agent-ID
- Konkreter Flow: Subtask anlegen mit `parentId` + `goalId` + `assigneeAgentId`, Parent auf `blocked` mit `blockedByIssueIds`
- Parallel-Arbeits-Limit: max. 1 Issue pro Heartbeat als Eigenarbeit

### 3. Gleiches Pattern auf alle anderen Chiefs angewendet
Delegations-Block + agent-spezifische Routing-Tabelle in:

| Chief | Direct Reports in Routing-Tabelle |
|---|---|
| **CTO** | VP Engineering |
| **CFO** | Buchhaltung, Vermögensverwaltung |
| **CRO** | Online-Recherche |
| **CPO** | Produktentwicklung (+ Hinweis: Positionierung läuft über CMO, nicht direkt an Marken-Spezialist) |
| **Creative Director** | Drehbuch, Blender, Adobe, Mistika VR |

### 4. CFO-Adapter-Fix
- URL: `.181` → `.191`
- Status: `idle`

### 5. CPO-AGENTS.md bereinigt
Stale Verweis auf Marken-Spezialist entfernt (hängt jetzt unter CMO), ersetzt durch explizite Regel: „Positionierung/Verpackung läuft über den CMO".

## Geänderte Dateien

AGENTS.md-Dateien unter `/Users/walterschoenenbroecher.de/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents/<agent-id>/instructions/`:

- `bbf38291-…` (CMO) — +Delegationsblock
- `5b7cb8a7-…` (CTO) — +Delegationsblock
- `408f7e88-…` (CFO) — +Delegationsblock
- `aa036cf5-…` (CRO) — +Delegationsblock
- `d4bdef1a-…` (CPO) — +Delegationsblock, Marken-Spezialist-Referenz bereinigt
- `4920b0be-…` (Creative Director) — +Delegationsblock

## Paperclip-State-Änderungen

- `agent/bbf38291` (CMO): adapterConfig.url, status `idle`
- `agent/408f7e88` (CFO): adapterConfig.url
- `agent/ea38630c` (Marken-Spezialist): reportsTo → CMO
- Issues WHI-38, WHI-39, WHI-40, WHI-42: status → `todo` (mit Delegations-Hinweis im Kommentar)

## Offene Punkte

- **Beobachten, ob der CMO beim nächsten Heartbeat tatsächlich delegiert** statt wieder in Parallel-Eigenarbeit zu fallen. Falls das Qwen3.6-Modell die neue Regel ignoriert, evtl. den Block an Position ganz nach oben im Prompt schieben oder noch prominenter („MUSS" statt „Pflicht") formulieren.
- Übrige Spezialisten (Buchhaltung, Vermögensverwaltung, Produktentwicklung, Drehbuch, Blender, Adobe, Mistika VR, Online-Recherche, Social Media Specialist, Web-Design Specialist, Marken-Spezialist) **sind selbst ausführende Rollen** — brauchen keinen Delegations-Block, nur ggf. mal einen URL-Check.
- Optional: Routing-Tabelle via Paperclip-API bei Personalwechseln (neuer Spezialist, Umhängung) automatisch aktuell halten — aktuell ist sie statisch in der AGENTS.md einkopiert.
