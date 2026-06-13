# n8n Auto-Recovery — Plan B Design: gestufte Reparatur (REST-Reaktivierung)

**Datum:** 2026-06-13
**Status:** Approved (Brainstorming)
**Vorgänger:** Plan A (live, `220cba485`) — Detektor→Issues + read-only Diagnose-Agent.
**Company:** WHITESTAG (`9cebf3cf-efe8-4597-a400-f06488900a87`)

## Ziel

Der Diagnose-Agent „n8n-Betriebsingenieur" erhält **eine** sichere, automatische
Selbstheilungs-Fähigkeit: einen fehlerhaften/trigger-toten Workflow per n8n-REST-API
**reaktivieren**. Alles Disruptive (Neustart, Credential-Sync, JSON-Edit) bleibt
**Vorschlag + menschliche Ausführung**. Damit wird aus dem read-only-Diagnostiker ein
konservativer Auto-Recovery-Agent mit genau einer mutierenden Aktion.

## Geklärte Entscheidungen (Brainstorming)

- **Steuerungsweg:** n8n **REST-API** (nicht CLI). Die Public-API ist bereits aktiviert
  (`/api/v1/workflows` → HTTP 401, nicht 404); es fehlt nur ein **API-Key**, der in der
  n8n-UI (Settings → API) **ohne Neustart** erzeugt wird. REST `POST /workflows/{id}/activate`
  registriert den Trigger auf der **laufenden** Instanz — die CLI (`update/publish:workflow`)
  schreibt nur die DB und greift i.d.R. erst nach Neustart.
- **Retry/Re-Run:** Ein sauberer REST-Retry existiert in 2.25.7
  (`POST /api/v1/executions/{id}/retry`, optional `{loadWorkflow: bool}`). Das eigentliche
  Risiko ist nicht Machbarkeit, sondern **Doppel-Seiteneffekte** (doppelte Mail/API-Calls).
  Entscheidung: `retry_execution` wird als getestetes Werkzeug gebaut, der **Agent ruft es
  aber NICHT selbst auf**. Er empfiehlt Retry nur bei `transient`-Fällen mit *geringem*
  Seiteneffekt-Risiko und liefert den fertigen Aufruf in der Eskalation mit; **ein Mensch
  führt aus**. Kein Auto-Retry (instruktions-basiertes Verbot wäre hier zu weich).
- **Autonomie konservativ (drei Stufen):**
  - 🟢 GRÜN (Agent führt selbst aus): **genau eine** Aktion — Workflow reaktivieren via REST.
  - 🟡 GELB (Agent empfiehlt, Mensch führt aus): Retry via REST — mit Seiteneffekt-Einschätzung
    + fertigem Aufruf in der Eskalation.
  - 🔴 ROT (Agent empfiehlt, Mensch führt aus): n8n-Neustart, Credential-Sync, Workflow-JSON-Edit
    → Approval/Eskalation an den CTO mit konkretem Schritt-Plan. Der Agent führt ROT- und
    GELB-Aktionen NIE selbst aus (auch nicht nach Approval).

## Architektur — was neu dazukommt

Neues kleines Toolkit unter `tools/n8n-workflow-watcher/recovery/`:

- `n8n_rest.py` — dünner, stdlib-only n8n-REST-Client:
  - `load_api_key()` — liest `N8N_API_KEY` aus der Umgebung, Fallback: Parsen von
    `~/.whitestag.env` (Zeile `N8N_API_KEY=...`). Gibt `""` zurück, wenn nicht gefunden.
  - `get_workflow(base, key, wf_id) -> dict` — `GET /api/v1/workflows/{id}` (Header
    `X-N8N-API-KEY`), liefert u.a. `active`.
  - `activate_workflow(base, key, wf_id) -> dict` — `POST /api/v1/workflows/{id}/activate`.
  - `deactivate_workflow(base, key, wf_id) -> dict` — `POST /api/v1/workflows/{id}/deactivate`
    (nur für den deactivate→activate-Fallback-Zyklus).
  - `retry_execution(base, key, exec_id, load_workflow=False) -> dict` —
    `POST /api/v1/executions/{id}/retry` (Body `{"loadWorkflow": bool}`). Werkzeug für die
    GELB-Stufe; vom Agenten NICHT automatisch aufgerufen.
  - Fehler (HTTP/Netz) → `N8nApiError`.
- `n8n_health.py` — read-only Diagnose-Helfer für die Klassifikation:
  - `healthz(base) -> bool` (`GET /healthz`).
  - `process_env_flags() -> dict` — liest aus dem laufenden n8n-Prozess (`ps eww`) die
    relevanten Flags (`N8N_BLOCK_ENV_ACCESS_IN_NODE`, `NODE_FUNCTION_ALLOW_BUILTIN`),
    um `env/restart`-Fälle zu erkennen. Rein lesend.

Der Agent erhält **Phase-B-Instructions** (Ersatz der read-only-AGENTS.md), die das
read-only-Verbot **ausschließlich** für die GRÜN-Reaktivierung lockern.

## Datenfluss (Agent je zugewiesenem Issue)

```
Diagnose (wie Plan A) → Kategorie?
├─ workflow-deaktiviert / transient mit Trigger-Bezug, Confidence hoch:
│     wf = n8n_rest.get_workflow(...)
│     n8n_rest.activate_workflow(...)            # ggf. deactivate→activate-Zyklus (s.u.)
│     verifizieren: get_workflow().active == true / Trigger registriert
│     ├─ ok  → Kommentar „reaktiviert", Issue schließen, Rollup-Eintrag „GRÜN: reaktiviert"
│     └─ fail→ lauter Alarm + Eskalation an CTO (Workflow-Zustand nennen!)
└─ alle anderen Kategorien (env/restart, credential, code/config-bug, unklar):
      wie Plan A — Diagnose + Empfehlung + Eskalation/Approval (menschliche Ausführung)
```

**Reaktivierungs-Semantik (in Plan-Phase live zu verifizieren, sobald Key existiert):**
Ob `POST /workflows/{id}/activate` bei einem bereits `active=1`-Workflow den Trigger
**neu registriert** (typischer Fall: IMAP-/Connection-Trigger still gestorben — z.B.
„E-Mails"-Workflows) oder no-op't, ist gegen die Live-Instanz zu prüfen. Falls no-op:
sicherer **deactivate→activate-Zyklus** als Fallback. In beiden Fällen gilt die
Nie-schlechter-zurücklassen-Regel (s. Fehlerbehandlung).

## Fehlerbehandlung & Sicherheit

- **API-Key**: aus `~/.whitestag.env` (`N8N_API_KEY`); **nie** loggen, **nie** in ein Issue
  oder einen Kommentar schreiben. Nur der Agent braucht ihn — der launchd-Detektor nicht.
- **Nie in schlechterem Zustand zurücklassen**: Wenn ein deactivate→activate-Zyklus nötig
  ist und das Re-Activate scheitert, **sofort** eskalieren mit explizitem Hinweis
  „Workflow X ist jetzt INAKTIV — manueller Eingriff nötig". Kein stiller Fehler.
- **Idempotenz / Begrenzung**: Reaktivieren eines bereits laufenden Triggers ist harmlos;
  **max. 1 Reaktivierungs-Versuch pro Issue**, danach Eskalation.
- **REST nicht erreichbar / 401 / fehlender Key**: GRÜN-Aktion entfällt, Kategorie bleibt,
  Eskalation mit Hinweis auf fehlenden/ungültigen Key.
- **Scope-Disziplin**: Der Agent führt unter KEINEN Umständen Neustart, Credential-Änderung
  oder JSON-Edit aus — auch nicht nach Approval. Diese bleiben menschlich.

## Testing

- `n8n_rest.py`: Unit-Tests mit gemocktem `urllib.request.urlopen` (Header `X-N8N-API-KEY`,
  korrekte activate/deactivate/retry-URLs + retry-Body, 401/HTTP-Fehler → `N8nApiError`,
  `load_api_key` aus Env und aus `~/.whitestag.env`-Fixture) — analog zum bewährten `paperclip_client`.
- `n8n_health.py`: Unit-Tests für das Parsen von `ps eww`-Output-Fixtures + `healthz`-Mock.
- **Live-Verifikation (Plan-Phase, nach Key-Erzeugung):** echte activate-Semantik gegen die
  laufende Instanz (re-register vs. no-op) an einem unkritischen Workflow.
- Agent: Trockenlauf gegen ein bekannt trigger-totes Workflow-Beispiel.

## Abgrenzung (YAGNI)

- Kein Auto-Retry; `retry_execution` existiert als Werkzeug (GELB), wird aber nur vom Menschen ausgelöst.
- Keine automatische Ausführung von Neustart, Credential-Sync oder JSON-Edit.
- Keine Erweiterung des Detektors (auto-deaktivierte `active=0`-Workflows bleiben außen vor —
  falls relevant, eigener späterer Schritt).
- Nur n8n-REST (kein CLI-Pfad in Plan B).

## Voraussetzungen (vor/zu Beginn der Plan-Phase durch Walter)

- n8n-API-Key in der UI erzeugen (Settings → API, kein Neustart) und als
  `N8N_API_KEY=...` in `~/.whitestag.env` hinterlegen.

## Offene Punkte für die Plan-Phase

- Live-Test der activate-Semantik (re-register vs. no-op) → entscheidet, ob der
  deactivate→activate-Zyklus standardmäßig nötig ist.
- Exaktes Feld in der `GET /workflows/{id}`-Antwort, das „Trigger registriert/aktiv" belegt
  (vermutlich `active`), gegen die installierte n8n-2.25.7 verifizieren.
- Wie die Phase-B-AGENTS.md sauber das Plan-A-Bundle ersetzt (managed-Bundle-Update +
  `EXCLUDE_NAMES` bleibt gesetzt).
