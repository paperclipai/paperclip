# Paperclip CEO Jarvis v5

A self-hostable, always-on AI chief-of-staff for the Paperclip CEO role. It is inspired by the “Jarvis” operating style you described: loyal, witty, anticipatory, protective, and executive-grade — but implemented with safe, auditable, permission-based access instead of fantasy unrestricted access.

## v5 upgrade highlights

v5 turns the v4 executive operating room into a governed company operating system. It adds constitutional AI, zero-trust access, carbon-aware routing, continuous evaluation, context engineering, workforce marketplace, predictive company health, advisory board voting, team proposal engine, R&D lab, compliance automation, culture intelligence, and the engineering catalog.

- **Mission-Control command layer**: classify CEO commands, detect risk, select agents, recommend a playbook, and optionally start a workflow.
- **Playbook workflow engine**: repeatable workflow templates, workflow runs, workflow steps, approval-gated steps, audit logs, and notifications.
- **Default operating playbooks**: Daily CEO Operating Loop, Strategic Decision War-game, Product Launch Room, Incident Response Room, Authorized Integration Onboarding, Weekly Strategy Review.
- **Capability readiness registry**: track which tools are enabled, approval-gated, configured, degraded, or missing environment variables.
- **SOP library**: seeded governance, credential, decision-journal, and swarm-delegation SOPs.
- **Notification queue**: dashboard notifications for workflow starts, blocked steps, and readiness issues.
- **Daily CEO ritual**: one endpoint combining briefing, 14-day execution view, opportunity windows, debt, risks, and next-best actions.
- **Cross-system orchestration**: Jarvis briefs, routes, and executes across Paperclip, Hermes, Pi, and OpenCode with trace IDs.
- **Upgraded dashboard**: Mission Control, Federation, and Capabilities tabs added.

## v2 foundations still included

- God View executive dashboard
- Transparent rationale engine with scenario branches and causal links
- Knowledge document ingestion and search
- Decision journal and prediction calibration
- Agent federation: Hermes, OpenClaw, Pi, Minerva, Analyst, Counselor, Compliance
- Swarm modes: parallel, serial, consensus, red-team
- Approval-request workflow for high-impact actions
- Runtime pause/resume flag
- Temporal intelligence: execution timeline, opportunity windows, promise/technical debt, predictions
- Risk register and secret-pattern scanner
- Integration registry for Gmail, Calendar, Drive, GitHub, Slack, Supabase/Postgres, Stripe, Analytics, and Local LLM
- Executive content generator for investor updates, team updates, press releases, pitch decks, and blogs

## Guardrails by design

This assistant can only access systems you explicitly connect. It cannot bypass authentication, invade private systems, or take irreversible actions without policy checks. That is not weakness; that is how you build a CEO-grade assistant that survives reality, compliance, and trust.

## Quick start

```bash
cd paperclip-ceo-jarvis/backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Open the dashboard:

```bash
cd ../frontend
python -m http.server 5173
```

Then visit `http://localhost:5173`.

Backend API docs are at `http://localhost:8000/docs`.

Optional federation adapters can be wired through env vars such as `PAPERCLIP_BASE_URL=http://paperclip-host/api`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, `HERMES_COMMAND=hermes -z`, `PI_COMMAND=pi -p --mode json`, and `OPENCODE_COMMAND=opencode run --format json`. When `PAPERCLIP_BASE_URL` is set, Jarvis reads and writes against the remote Paperclip API instead of the local fallback state.

## Jarvis2 import

The archived `jarvis2.zip` package is mirrored in `docs/jarvis2/` and surfaced in the frontend as the new **Command Center** tab: dashboard, portfolio, decisions, agents, analytics, and briefing views.

Imported docs:
- [Quick Start](docs/jarvis2/JARVIS_QUICK_START.md)
- [System Spec](docs/jarvis2/jarvis_system_spec.md)
- [Agent Orchestration](docs/jarvis2/jarvis_agent_orchestration.md)
- [Deployment Playbooks](docs/jarvis2/jarvis_deployment_playbooks.md)
- [Command Center Source](docs/jarvis2/jarvis_command_center.jsx)

## Local LLM mode

The backend supports any OpenAI-compatible endpoint. For local use, run Ollama or another local server that exposes `/v1/chat/completions`, then set:

```env
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=llama3.1:8b
```

If no LLM is configured, the assistant still runs with deterministic fallback responses for planning, briefings, simulations, dashboards, swarms, workflows, and readiness checks.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

The API runs on port `8000`; the dashboard runs on port `5173`.

## Production hardening checklist

1. Change `JARVIS_API_KEY`.
2. Put the API behind HTTPS.
3. Use Postgres instead of SQLite for multi-user production.
4. Add Alembic migrations before evolving schemas further.
5. Enable backups for the DB and uploaded files.
6. Add real integrations one at a time: Gmail, Calendar, Slack, GitHub, Paperclip DB, finance, analytics.
7. Keep destructive, financial, production, and public actions behind approval gates.
8. Review the audit log daily until the assistant is trusted.
9. Add monitoring: uptime, latency, queue depth, failed jobs, high-risk blocked actions.
10. Use a secrets manager or encrypted vault for production credentials.
11. Start with read-only connector permissions; add writes only after approval gates are tested.

## Useful calls

```bash
curl http://localhost:8000/health

curl -H 'X-Jarvis-Key: dev-change-me' http://localhost:8000/dashboard/god-view

curl -H 'X-Jarvis-Key: dev-change-me' http://localhost:8000/mission-control/daily-ritual

curl -H 'X-Jarvis-Key: dev-change-me' http://localhost:8000/capabilities/readiness

curl -H 'X-Jarvis-Key: dev-change-me' http://localhost:8000/federation/systems

curl -X POST http://localhost:8000/federation/briefing \
  -H 'Content-Type: application/json' \
  -H 'X-Jarvis-Key: dev-change-me' \
  -d '{"focus":"What should I do next across Paperclip, Hermes, Pi, and OpenCode?","include_sources":["paperclip","hermes","pi","opencode"]}'

curl -X POST http://localhost:8000/mission-control/command \
  -H 'Content-Type: application/json' \
  -H 'X-Jarvis-Key: dev-change-me' \
  -d '{"command":"Should we launch Jarvis publicly after adding Gmail and Calendar connectors?","autonomous":false}'

curl -X POST http://localhost:8000/mission-control/workflows \
  -H 'Content-Type: application/json' \
  -H 'X-Jarvis-Key: dev-change-me' \
  -d '{"template_key":"strategic_decision_wargame","title":"Public Jarvis launch decision","owner":"CEO","input_payload":{"source":"curl"}}'
```

## Repo structure

```text
backend/app/
  main.py                  FastAPI entrypoint
  config.py                environment settings
  db.py                    SQLite/Postgres-ready database layer
  models.py                SQLAlchemy models, including workflow/capability and federation trace tables
  schemas.py               Pydantic API schemas
  security.py              API key + action risk gates
  system_prompt.py         Jarvis/Paperclip CEO operating prompt
  scheduler.py             always-on background watch loop
  routers/                 HTTP APIs
  services/                business logic
  services/workflows.py    mission-control workflows and daily ritual
  services/federation.py   cross-system orchestration and trace persistence
  services/capabilities.py v4 tool capability registry and readiness checks
  agents/                  CEO and employee agents
frontend/                  executive cockpit UI
frontend/app.js            API calls for the dashboard
docs/                      architecture, safety model, roadmap, API map, upgrade analysis, playbooks, Jarvis2 import
ops/                       deployment templates
tests/smoke_test.py        API smoke test
```

## The correct philosophy

Paperclip CEO Jarvis should not be “unlimited.” It should be decisive within authorized scope. Real power comes from memory, permissions, integrations, automation, and excellent judgment — not pretending to be omniscient.


## v4 Additions

- Autonomy Kernel: evaluates actions before execution and creates approval requests when needed.
- Proactive Watch Rules: detects approval pressure, overdue debt, high-risk work, overloaded people, stale predictions, and missing capability config.
- System Insights: persistent operational findings generated by watch cycles.
- Enchantment Lab: 40+ structured upgrade cards across cognitive, memory, agents, execution, personality, temporal, dashboard, safety, and growth categories.
- Implementation Planner: turns the upgrade backlog into phased build plans.
- Maturity Audit: scores Jarvis readiness across operational tiers and highlights gaps.
- Dashboard tabs for Autonomy and Enchantments.

Useful v4 endpoints:

```text
GET  /autonomy/policies
POST /autonomy/evaluate
POST /autonomy/watch-cycle
GET  /autonomy/insights
GET  /enchantments/backlog
GET  /enchantments/brainstorm
POST /enchantments/plan
GET  /enchantments/audit
```


## v5 additions

Useful endpoints:

```text
GET  /v5/audit
POST /v5/constitutional/check
POST /v5/zero-trust/decision
POST /v5/carbon/choose-route
POST /v5/evaluation/run
POST /v5/context/bundle
POST /v5/collaboration/start
GET  /v5/workforce/marketplace
GET  /v5/company/ecosystem
GET  /v5/company/health-forecast
POST /v5/board/vote
POST /v5/teams/propose
GET  /v5/meta-learning
POST /v5/agents/propose-generation
GET  /v5/rnd/lab
GET  /v5/engineering/catalog
GET  /v5/deployment/regions
GET  /v5/compliance/automation
GET  /v5/culture/intelligence
```

v5 still does not pretend that connectors are magically connected. Real external access needs credentials, consent, scoped permissions, and production deployment hardening.
