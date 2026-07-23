# SOP: Microsoft Graph scope allowlist (per-agent, local_stdio MCP connections)

Applies to any `local_stdio` tool connection that reaches a live external API on an
agent's behalf — the Microsoft 365 Graph mail connection provisioned in SAG-7582 is
the reference case. The mechanism is generic Paperclip tool-access ACL
(`toolApplications` /
`toolConnections` / `toolProfiles` / `toolProfileEntries` / `toolProfileBindings` /
`toolConnectionInstalls`, see `packages/db/src/schema/tool_access.ts`), not anything
Hermes- or Graph-specific.

## Principles

- **One agent, one preset, per approving issue.** Every grant traces back to an
  issue that approved exactly that agent + exactly that scope. Don't widen an
  existing grant without a new approving issue.
- **Read-only by default.** Write scopes require an explicit CEO governance gate
  (see the "§4" write-scope gate referenced on SAG-7582) — do not enable a write
  preset or drop `--read-only` without that sign-off.
- **Fixed, non-overridable args.** The command/args/env-var-names for an approved
  scope live only in code, as a `BUILTIN_LOCAL_STDIO_RUNTIME_TEMPLATES` entry
  (`server/src/services/tool-gateway.ts`) with a matching `APPROVED_STDIO_TEMPLATES`
  entry (`server/src/services/tool-access.ts`). Nothing in a connection's `config`
  can widen what the spawned process is allowed to do — that's enforced structurally
  (`resolveLocalStdioRuntimeTemplate` always uses the template's own `args`, never
  `connection.config`), not by convention.
- **No literal secrets, anywhere.** Credential values are never stored in a
  connection's `config.env`, never appear in a diff/test fixture/log/comment. They
  are resolved at spawn time from the Paperclip server's own process env for any key
  listed in the template's `envKeys` (`localStdioEnvironment` in `tool-gateway.ts`).
  Set the real value only in the server's own env (e.g. the instance `.env` file
  the operator controls) — never in application code or DB seed data.

## Add an agent to a scope

1. Confirm (or add) the `BUILTIN_LOCAL_STDIO_RUNTIME_TEMPLATES` /
   `APPROVED_STDIO_TEMPLATES` entry for the exact preset needed. If the template
   doesn't exist yet, that's a code change requiring its own PR + review — the
   fixed args and env-var names are the entire security boundary for that preset.
2. Provision (or reuse) the connection and scope it to exactly the intended agent(s)
   via `toolAccessService.createConnection` + `refreshCatalog` +
   `putConnectionInstalls({ installs: [{ targetType: "agent", targetId }] })`. See
   `server/scripts/seed-sag7582-ms365-mail-cto-acl.ts` for a worked, idempotent
   example — copy its shape for a new scope/agent rather than hand-writing SQL.
   `putConnectionInstalls` replaces the full install set for that connection, so
   list every agent that should have access, not just the one being added.
3. Verify: `getEffectiveProfilesForAgent(companyId, agentId)` must include the
   connection for the newly-added agent, and must NOT include it for any agent not
   listed in step 2. This is exactly what
   `server/src/__tests__/sag-7582-ms365-mail-acl.test.ts` and
   `server/src/__tests__/heartbeat-runtime-mcp-servers.test.ts` assert — a
   non-allowlisted agent must get zero runtime MCP servers for that connection.

## Remove an agent from a scope

- **Preferred: drop the binding.** Re-run `putConnectionInstalls` with that agent
  left out of the `installs` array. This removes the `toolConnectionInstalls` row
  and, if no other agent still uses the connection's profile, leaves the profile
  binding orphaned (harmless — `getEffectiveProfilesForAgent` requires both an
  active binding and an install; dropping the install alone already denies access).
- **Full revoke: rotate the secret.** If the credential itself may have been
  exposed (not just "this agent should no longer have access"), rotate the
  underlying value in the server's env (e.g. `MS365_MCP_CLIENT_SECRET`) in addition
  to dropping the binding. Dropping the binding stops delivery to that agent; it
  does not invalidate the credential for anyone who already captured it out of band.

## Non-goals of this SOP

- This does not cover write-scope grants (§4 gate, CEO-owned, separate approval).
- This does not cover the underlying Hermes-side `~/.hermes/mcp-servers/*.json`
  files used by native Hermes chat/CLI agents — those are a different, inert (for
  Paperclip agents) delivery path. Paperclip-agent access is governed entirely by
  the ACL described here.
