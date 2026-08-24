---
title: Support Case Assessment — Self-Service Onboarding (v0.5.0)
summary: One-click company creation with default agents, goal, project, and starter task
version: v0.5.0
commit: e42b2d6e1ce0887611e7bcb581937031a57b9037
last_updated: 2026-08-18
---

# Support Case Assessment: Self-Service Onboarding (v0.5.0)

## Feature Overview

The Self-Service Onboarding endpoint (`POST /api/start`) allows authenticated board users to create a complete company workspace with a single API call. It creates the company, sets up owner membership and grants, hires requested default agents, seeds a company-level goal, an "Onboarding" project, and a starter task assigned to the first (CEO) agent. The feature was added in v0.5.0, commits `e42b2d6e1c` and `ad6c5f5248`.

### What it does

- Creates a company with an owner membership for the authenticated user
- Hires 1-10 agents (default: CEO, CTO, PM)
- Sets up monthly budget if specified
- Creates a company-level "Scale {CompanyName}" goal
- Creates an "Onboarding" project linked to the goal
- Creates a starter task ("Hire your first engineer and create a hiring plan") assigned to the CEO
- Materializes default agent instructions bundles for supported adapters

### What it does NOT do

- Does not install knowledge starter packs (coming in a separate phase)
- Does not configure billing or Stripe (separate flow)
- Does not invite other users (separate membership management)

## Authorization

The endpoint requires board-level access. The caller must be one of:
- A **local implicit user** (`local_implicit` source) — typically in development environments
- An **instance admin** — full admin access
- An **authenticated board user** with a valid user session — the standard self-service path

Unauthenticated users receive a `403 Forbidden`.

## Known Limitations

| Limitation | Description | Workaround |
|------------|-------------|------------|
| No knowledge packs | Industry knowledge starter packs are not automatically installed | Use the Knowledge API to install packs manually or wait for the automated flow |
| Maximum 10 agents | The endpoint accepts at most 10 agent items | Hire additional agents via the Agents API after onboarding |
| Instructions bundle non-fatal | If default instructions materialization fails, the agent is created without managed instructions | The agent works with adapter defaults; instructions can be set up later |
| No company template support | This is a fresh start, not a template-based deploy | Use Company Templates for pre-configured company setups |

## Troubleshooting

### Problem: Onboarding returns 403 Forbidden

1. The caller is not authenticated or is not a board user
2. Verify the caller has a valid user session or API key with board-level access
3. Instance admin or local implicit auth is required for unauthenticated onboarding

### Problem: Agent creation fails

1. The endpoint creates agents sequentially; if one fails, the entire request fails
2. Check server logs for agent creation errors (e.g., adapter type not found)
3. Common cause: specifying an `adapterType` that is not registered on the server

### Problem: Instructions bundle not materialized

1. This is non-fatal by design — the agent is created but without managed instructions
2. Check server logs for materialization errors (logged as warnings)
3. Instructions bundles are only applied for adapters that support managed instructions (adapter's `supportsInstructionsBundle`)
4. Legacy adapters (acpx_local, claude_local, codex_local, etc.) have hardcoded support

## Support Escalation Path

| Issue | First Response | Escalation |
|-------|---------------|------------|
| Permissions (403) | Verify caller authentication and role | Engineering: check authz logic |
| Agent creation failure | Check adapter type registration | Engineering: verify adapter availability |
| Instructions not materialized | Non-fatal; note supported adapter types | Engineering: verify instructions bundle paths |

## Related Documentation

- [Onboarding API Reference](/api/onboarding)
- [Agent Marketplace API Reference](/api/marketplace)
- [Companies API Reference](/api/companies)
- [Agents API Reference](/api/agents)
- [Goals and Projects API Reference](/api/goals-and-projects)

## Version History

| Version | Date | Changes |
|---------|------|---------|
| v0.5.0 | 2026-08-18 | Initial self-service onboarding support — commits `e42b2d6e1c`, `ad6c5f5248` |