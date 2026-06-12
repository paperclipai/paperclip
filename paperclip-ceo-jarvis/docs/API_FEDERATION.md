# Jarvis Cross-System Orchestration API

Jarvis coordinates Paperclip, Hermes, Pi, and OpenCode through a shared orchestration layer.

## Endpoints

- `GET /federation/systems`
- `POST /federation/briefing`
- `POST /federation/route`
- `POST /federation/execute`
- `GET /federation/traces`
- `GET /federation/traces/{trace_id}`

## Request shapes

### POST /federation/briefing
```json
{ "focus": "What should I do next?", "include_sources": ["paperclip", "hermes", "pi", "opencode"] }
```

### POST /federation/route
```json
{ "task": "Implement the next CEO workflow slice", "preferred_system": "auto", "allow_execution": true, "context": {} }
```

### POST /federation/execute
```json
{ "task": "Create a Paperclip task and summarize it in Jarvis", "target_system": "auto", "approved": true, "context": {} }
```

Optional Paperclip write fields are forwarded when `target_system` is `paperclip`:

```json
{ "issueId": "issue-123", "title": "Update issue", "description": "...", "status": "in_progress", "priority": "high" }
```

## Environment variables

Optional remote/CLI adapters:

- `PAPERCLIP_BASE_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`
- `HERMES_BASE_URL`, `HERMES_API_KEY`, `HERMES_COMMAND` (default: `hermes -z`)
- `PI_BASE_URL`, `PI_API_KEY`, `PI_COMMAND` (default: `pi -p --mode json --tools read,bash,edit,write,grep,find,ls`)
- `OPENCODE_BASE_URL`, `OPENCODE_API_KEY`, `OPENCODE_COMMAND` (default: `opencode run --format json`)

When `PAPERCLIP_BASE_URL` is set, Jarvis talks to the remote Paperclip REST API (`/api/...`) for reads, plans, and approved writes. If no Paperclip API URL is configured, the service falls back to local deterministic behavior and still records traces.
