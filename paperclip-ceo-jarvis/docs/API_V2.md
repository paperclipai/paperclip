# JARVIS v2 API Map

## Executive
- `GET /ceo/morning-briefing`
- `POST /ceo/decisions/simulate`
- `GET /ceo/opportunities`
- `GET /ceo/alignment`
- `GET /ceo/board-pack`
- `POST /ceo/communication/draft`
- `POST /ceo/meeting/optimize`

## Dashboard
- `GET /dashboard/snapshot`
- `GET /dashboard/god-view`

## Intelligence
- `POST /intelligence/reason`
- `POST /intelligence/knowledge`
- `POST /intelligence/knowledge/search`
- `GET /intelligence/context`
- `POST /intelligence/decision-journal`
- `GET /intelligence/calibration`

## Agents
- `GET /agents`
- `POST /agents/swarm`

## Governance
- `GET /governance/status`
- `POST /governance/approvals`
- `GET /governance/approvals`
- `POST /governance/approvals/{id}/approve`
- `POST /governance/approvals/{id}/reject`
- `POST /governance/pause`
- `POST /governance/resume`
- `GET /governance/audit`

## Temporal
- `GET /temporal/timeline`
- `GET /temporal/opportunity-windows`
- `GET /temporal/debt`
- `POST /temporal/debt`
- `POST /temporal/predictions`
- `GET /temporal/predictions`
- `POST /temporal/predictions/{id}/resolve`

## Risk
- `GET /risk`
- `POST /risk`
- `POST /risk/scan-secrets`

## Content
- `POST /content/generate`

## Integrations
- `GET /integrations`
- `PATCH /integrations/{id}`
