# Jarvis Cross-System Orchestration

## Goal
Make Jarvis the executive orchestrator for Paperclip, Hermes, Pi, and OpenCode so it can read, route, and execute approved work across all four with Paperclip as the durable record.

## Tasks
- [ ] Add shared orchestration config + adapter contract in `backend/app/config.py` and a new `backend/app/services/federation.py` so each system exposes `read`, `plan`, `execute`, and `report` plus trace IDs.
- [ ] Implement Paperclip, Hermes, Pi, and OpenCode adapters with HTTP/CLI fallback and a durable cross-system trace model in `backend/app/models.py` plus any needed seed data.
- [ ] Add orchestration endpoints in a new router and wire them into `backend/app/main.py`; update the existing agent/mission-control flows to use the new orchestration service.
- [ ] Update the dashboard in `frontend/index.html` and `frontend/app.js` so the operator can see system status, run a briefing, route work, and trigger approved execution.
- [ ] Update `.env.example`, `README.md`, and the API docs with required env vars, adapter modes, and safety rules.
- [ ] Add smoke/contract tests in `tests/` for summary, routing, approved execution, denylisted refusal, and audit persistence.

## Done When
- Jarvis can summarize across all four systems, route work to the right one, and execute approved actions.
- Paperclip stores the durable trace/approval/audit record.
- The UI exposes the orchestration controls.
- Verification passes with the repo’s smoke checks.
