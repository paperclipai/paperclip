# Pre-planner Tools

## Paperclip API (http://localhost:3100)
- GET /api/companies — list all companies
- GET /api/companies/{id}/agents — list agents with configs
- GET /api/agents/{id} — full agent details (promptTemplate, model, budget, heartbeat, adapterConfig)
- GET /api/companies/{id}/issues — list issues
- GET /api/issues/{id} — issue details
- PATCH /api/issues/{id} — reassign issue to Executor
- POST /api/issues/{id}/comments — post execution prompt

## Usage Rules
- GET for all subsidiary company data
- Only write to DickBot's own issues (comments and reassignment)

## Cross-Company Access (CRITICAL)

When querying subsidiary company data, you MUST omit the Authorization header from your curl requests. Your agent API key scopes you to DickBot only. Without the auth header, Paperclip's local_trusted mode grants full instance-admin board access across all companies.

Examples:
```
# WRONG — scoped to DickBot only
curl -H "Authorization: Bearer $AGENT_API_KEY" http://localhost:3100/api/companies

# CORRECT — full cross-company access
curl -s http://localhost:3100/api/companies
curl -s http://localhost:3100/api/companies/{subsidiaryCompanyId}/agents
curl -s http://localhost:3100/api/companies/{subsidiaryCompanyId}/issues
```

Only use your agent API key when you need to authenticate as yourself (e.g., updating your own issue status within DickBot). For all read operations across subsidiaries, use unauthenticated requests.
