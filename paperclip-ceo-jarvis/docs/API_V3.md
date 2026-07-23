# JARVIS v3 API Additions

Base URL: `http://localhost:8000`

Authenticated endpoints require `X-Jarvis-Key` unless running development defaults.

## Mission Control

### `POST /mission-control/command`

Triage a CEO command.

```json
{
  "command": "Should we launch Jarvis publicly after adding Gmail and Calendar?",
  "context": {},
  "autonomous": false
}
```

Returns risk level, recommended playbook, selected agents, swarm synthesis, approval need, and optional workflow run.

### `GET /mission-control/playbooks`

List available workflow templates.

### `POST /mission-control/workflows`

Start a workflow.

```json
{
  "template_key": "strategic_decision_wargame",
  "title": "Public Jarvis launch decision",
  "owner": "CEO",
  "input_payload": { "source": "dashboard" }
}
```

### `GET /mission-control/workflows?status=all`

List workflow runs.

### `GET /mission-control/workflows/{run_id}`

Get workflow details.

### `POST /mission-control/workflows/{run_id}/advance`

Advance the current workflow step.

```json
{
  "status": "completed",
  "output": { "decision": "Continue with narrower beta" }
}
```

### `GET /mission-control/daily-ritual`

Generate the daily CEO ritual.

### `GET /mission-control/next-best-actions`

Return ranked operational next actions.

### `GET /mission-control/sops`

List SOP documents.

### `POST /mission-control/sops`

Create an SOP.

### `GET /mission-control/notifications?status=queued`

List queued notifications.

### `POST /mission-control/notifications`

Create dashboard notification.

## Capabilities

### `GET /capabilities`

List tool capability registry.

### `GET /capabilities/readiness`

Return readiness report and production-readiness guidance.

### `PATCH /capabilities/{capability_id}`

Enable/disable or update a capability health status.

```json
{
  "enabled": true,
  "health_status": "ready"
}
```
