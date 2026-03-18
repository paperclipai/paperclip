# Provider Credentials — Design

**Date:** 2026-03-18
**Status:** Approved

## Problem

Adding AI backends (Claude OAuth accounts, Qwen Coder keys) to Paperclip agents requires manual env var configuration (`CLAUDE_OAUTH_TOKEN`, `QWEN_API_KEY`) and shell script plumbing (`entrypoint.sh`). There is no UI to manage credentials, no way to have multiple OAuth accounts, and Qwen support is invisible to the board.

## Decision

Introduce a **provider credentials** system: a company-level credential store with a picker in the agent configuration UI. Claude Code remains the standard adapter; different backends (Claude, Qwen) are selected by choosing a credential.

## Data Model

### New table: `provider_credentials`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `company_id` | UUID FK → companies | |
| `name` | text | Display name, e.g. "Main Claude Account" |
| `type` | text (enum) | `claude_oauth`, `qwen_api_key` |
| `credential` | JSONB | Encrypted, type-specific config |
| `is_default` | boolean | Default credential for this type in this company |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

Unique constraint: `(company_id, name)`.

### Type-specific credential shapes

- `claude_oauth`: `{ accessToken: string }`
- `qwen_api_key`: `{ apiKey: string, model?: string }`

### Agents table change

Add nullable `credential_id UUID FK → provider_credentials`.

Agents without a `credential_id` fall back to the existing env var approach (backward compatible).

## API

```
GET    /api/companies/:companyId/credentials       — list all (credential field redacted)
POST   /api/companies/:companyId/credentials       — create
PATCH  /api/companies/:companyId/credentials/:id   — update
DELETE /api/companies/:companyId/credentials/:id   — delete (409 if agents reference it)
```

All endpoints require board-level access. Credential values are never returned in GET/list responses (write-only).

## UI

### Company Settings → Credentials tab

- Table of existing credentials (name, type, default badge, agent count)
- Add credential form: name, type selector, token/key input
- Edit: rename, replace token, toggle default
- Delete: blocked if any agents reference it

### Agent creation/edit form

- New "Credential" dropdown under adapter type
- Filtered to credentials compatible with the selected adapter
- Default credential auto-selected
- "(default)" badge shown on default credentials

## Runtime Behavior

When an agent with a `credential_id` starts, Paperclip resolves the credential and configures the environment:

| Type | Action |
|------|--------|
| `claude_oauth` | Write `.credentials.json` to agent's isolated HOME dir |
| `qwen_api_key` | Ensure qwen-proxy is running; set `ANTHROPIC_BASE_URL=http://localhost:{port}` and inject API key into proxy env |

## Migration & Backward Compatibility

- Existing env var approach (`CLAUDE_OAUTH_TOKEN`, `CLAUDE_OAUTH_AGENT_*`, `QWEN_API_KEY`) continues to work unchanged
- `entrypoint.sh` fallback preserved — DB-driven credentials take precedence when present
- No breaking changes to existing agents or deployments

## Future Extensions

- `gemini_api_key` type (via OpenRouter or direct)
- OAuth redirect flow for Claude (browser-based token acquisition)
- Credential health checks (test token validity)
