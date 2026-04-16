# Executor Tools

## Paperclip API (http://localhost:3100)
- Full read/write access to all endpoints
- GET/POST/PATCH/PUT/DELETE on companies, agents, issues, goals, projects
- Agent config updates: PATCH /api/agents/{id}
- Issue management: PATCH /api/issues/{id}, POST /api/issues/{id}/comments

## Terminal
- curl for API calls
- File system operations for skill files and instruction files
- Access to Paperclip's embedded Postgres if needed

## Usage Rules
- Only make changes specified in Pre-planner's execution prompt
- Always verify before and after
- Never exceed the scope of the assigned task

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
