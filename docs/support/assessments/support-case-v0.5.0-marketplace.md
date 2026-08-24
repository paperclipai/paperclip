---
title: Support Case Assessment — Agent Marketplace (v0.5.0)
summary: Browse and one-click hire marketplace agents — what it does, auth rules, known issues, troubleshooting
version: v0.5.0
commit: cd7f9d21db
last_updated: 2026-08-18
---

# Support Case Assessment: Agent Marketplace (v0.5.0)

## Feature Overview

The Agent Marketplace allows board operators to browse a curated catalog of pre-configured agents and hire them into their company with a single API call. Each marketplace agent comes with a default role, adapter type, adapter configuration, permissions, budget, and required catalog skills. The feature was added in v0.5.0 via commits `e42b2d6e1c` / `87da3d374a` / `ad6c5f5248` / `cd7f9d21db` (auth hardening).

### What it does

- **Browse** — list all available marketplace agents with optional filters (category, role, free-text search)
- **View details** — get a single marketplace agent by id, key, or slug
- **One-click hire** — create an agent in the company from a marketplace entry, installing all required catalog skills

### What it does NOT do

- It does not create a pending approval — companies with `requireBoardApprovalForNewAgents` enabled must use the standard approval flow
- It does not verify that the agent catalog is installed; if the `@paperclipai/agents-catalog` package is missing, the browse endpoint returns an empty list and hire returns 404

## Authorization

The hire endpoint enforces two layers of authorization:

1. **`agents:create` permission** — the caller must have the `agents:create` grant on the target company. This is the same check used by the standard agent creation route. Without it, the user gets a `403 Forbidden`.
2. **Board approval gate** — if `requireBoardApprovalForNewAgents` is enabled on the company, the endpoint returns `409 Conflict`. The caller must use the agent-hire approval workflow instead.

Browse endpoints (`GET /marketplace/agents`, `GET /marketplace/agents/:ref`) are app-level and do not require a company context.

## Known Limitations

| Limitation | Description | Workaround |
|------------|-------------|------------|
| Catalog dependency | The marketplace requires the `@paperclipai/agents-catalog` package to be installed. Without it, browse returns empty and hire returns 404 | Install the agents-catalog package or use the development fallback at `packages/agents-catalog/generated/catalog.json` |
| Skill installation failures | If a required catalog skill fails to install, the hire succeeds but a warning is logged and returned in the response | Check the `warnings` array in the hire response and install the skill manually |
| Override mismatch | Callers can override `adapterType` and `adapterConfig` — if the override is incompatible with the agent's role, the agent may fail to start | Ensure overrides are compatible; use catalog defaults when in doubt |

## Troubleshooting

### Problem: Marketplace returns empty list

1. Verify the `@paperclipai/agents-catalog` package is installed (`npm ls @paperclipai/agents-catalog`)
2. Check server logs for `Agent marketplace catalog unavailable` warnings
3. If using the development fallback, confirm `packages/agents-catalog/generated/catalog.json` exists
4. If the catalog is present but your deployment isn't picking it up, restart the server

### Problem: Hire returns 403 Forbidden

1. The caller lacks `agents:create` permission on the company
2. Verify the caller's API key or user session has the required grant
3. Board operators can check the company's grant settings from the web UI
4. Agent keys from a different company also get 403 — verify the key's `companyId` matches

### Problem: Hire returns 409 Conflict

1. The company has `requireBoardApprovalForNewAgents` enabled
2. Use `POST /api/companies/:companyId/agent-hires` to create a pending hire approval
3. The board must approve the hire before the agent is created

### Problem: Skill installation warnings

1. Check the `warnings` array in the hire response for details on which skills failed
2. Common causes: catalog skill key not found, permission denied, skill already installed with conflicts
3. Skills can be installed manually via the company skills API or web UI

## Support Escalation Path

| Issue | First Response | Escalation |
|-------|---------------|------------|
| Catalog unavailable / empty marketplace | Check agents-catalog package installation | Engineering: verify catalog packaging |
| Permission errors (403) | Verify caller's grants and company membership | Engineering: check access.decide() audit logs |
| Board approval gate (409) | Direct caller to use agent-hires approval flow | COO: board approval workflow configuration |
| Skill installation failures | Check warnings array and install manually | Engineering: verify skill catalog entries |

## Related Documentation

- [Marketplace API Reference](/api/marketplace)
- [Onboarding API Reference](/api/onboarding)
- [Agents API Reference](/api/agents)
- [Approvals API Reference](/api/approvals)

## Version History

| Version | Date | Changes |
|---------|------|---------|
|| v0.5.0 | 2026-08-18 | Initial marketplace support (browse + hire) — commits `e42b2d6e1c`, `87da3d374a`, `ad6c5f5248`, `cd7f9d21db` (auth hardening: agents:create gate + board approval check) |