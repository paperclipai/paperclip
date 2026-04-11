# Kaizai Workforce — Orchestrator

LangGraph-based execution engine for the Agentic Squad.

## Architecture

This orchestrator runs alongside Paperclip (the control plane).

- **Paperclip** manages agents, budgets, heartbeats, and the dashboard at `build.kaizai.co`
- **Orchestrator** handles workflow execution: routing, tool calls, LLM reasoning, state management
- **GitHub** is the system of record for project data (issues, PRs, Projects V2)

## Agents

| Agent | Role | Status |
|---|---|---|
| Scrum Master | Orchestrator, human interface | Active |
| Code Operator | Claude Code job dispatch | Active |
| Architect | Strategic PR review (high-risk only) | Active |
| Test Lead | AC validation, test execution | Active |
| Product Owner | Roadmap decomposition | Paused (Phase 3) |
| Infrastructure Lead | Deployment, health verification | Paused (Phase 3) |

Agent identity defined in `agents/<name>/SOUL.md`.
Heartbeat protocol defined in `agents/<name>/HEARTBEAT.md`.

## Target Project

Configured in `config/kaizai.yaml` to work on `stepan-korec/trading-agent`.

## Running

See `deploy/vps/` for Docker Compose deployment alongside Paperclip.
