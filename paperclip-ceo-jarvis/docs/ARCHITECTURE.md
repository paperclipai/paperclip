# Architecture

## Runtime layers

1. **Executive UI** — Web cockpit for chat, briefings, decisions, employee oversight, and opportunities.
2. **API Gateway** — FastAPI routes with API-key protection and audit logging.
3. **CEO Agent Layer** — Chief of Staff, Decision Simulator, Opportunity Radar, Alignment Monitor, Board Pack, Communication Assistant.
4. **Employee + Agent Layer** — Reputation, workload, career evolution, skill marketplace foundation, pair/co-creation support.
5. **Memory + Data Layer** — SQL database for companies, employees, objectives, tasks, decisions, alerts, audit logs, and memories.
6. **LLM Layer** — Optional OpenAI-compatible local/cloud LLM. Deterministic fallback keeps core features available.
7. **Background Watch Loop** — Runs continuously and turns risk/workload/task signals into alerts and briefing items.
8. **Connectors** — Authorized integrations only: email, calendar, Slack, GitHub, Paperclip DB, finance, analytics, document store.

## 24/7 model

The assistant is a continuously running service, not a magic process. Use Docker/systemd, restart policies, health checks, persistent DB storage, and monitoring.

## Capability philosophy

“Can access everywhere” becomes a connector registry with explicit credentials and scopes. Each connector declares:

- Auth method
- Read/write capabilities
- Risk level
- Approval requirement
- Audit fields
- Rate limits

This prevents one bad prompt, bug, or compromised token from becoming a company incident.
