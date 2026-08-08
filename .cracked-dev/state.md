# cracked-dev state

Repo: paperclipai/paperclip · default branch: `master` · pkg mgr: pnpm (workspaces)
Owner note: **public OSS repo (MIT), not Twenty Four's** — push/PR to origin is human-gated.
This branch (`cracked-dev/memlawb-pilot`) is local-only, not pushed.

## Conventions learned (adopt these)
- Verify gates: `pnpm --filter <pkg> typecheck`; tests via `pnpm --filter <pkg> exec vitest run <name>`.
- MCP is **data-plane**, delivered per-agent via `tool_connections` proxied through the tool-gateway
  (`server/src/services/tool-gateway.ts`), NOT adapter config. Transports: `mcp_remote` (HTTP,
  auto-injected at `heartbeat.ts` `buildPaperclipRuntimeMcpServers`), `local_stdio` (spawned
  server-side by the gateway, `tool-gateway.ts` `spawn(...)`), `rest_api`.
- Built-in stdio templates: `BUILTIN_LOCAL_STDIO_RUNTIME_TEMPLATES` in tool-gateway.ts; env for a
  stdio process comes from `localStdioEnvironment` (connection `config.env` for declared envKeys +
  PATH passthrough). `--strict-mcp-config` means in-sandbox stdio MCP entries are ignored — managed
  gateway is the only channel.
- Secrets→runtime-env: company secret (`secret_ref`) bound via a target's envVars → resolved in
  `heartbeat.ts` `resolveExecutionRunAdapterConfig` → agent env. (Note: this feeds the AGENT sandbox,
  not the gateway stdio spawn — so a local_stdio passphrase must come from config.env/host env.)
- Feature flags: `instanceExperimentalSettingsSchema` (shared) + `INSTANCE_FEATURE_CATALOG` +
  `normalizeExperimentalSettings` (compile-locked lockstep). `PAPERCLIP_*` env for kill-switches.
- bun is NOT in any image; `local_stdio` refused in authenticated+public without
  `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST`. Migrations: `drizzle-kit generate` is broken here — hand-author.

## Cycle log

### 2026-08-08 — memlawb memory pilot (Phase-1 DEPEND)
- **Did:** Understand-workflow mapped MCP/secrets/runtime/flags (3 readers). Built the minimal,
  on-pattern pilot: (1) built-in `paperclip.memlawb-memory` local_stdio template in tool-gateway.ts;
  (2) `bun@latest` + `@gitlawb/memlawb@0.1.0` in the server Dockerfile (with PATH asserts);
  (3) operator runbook `docs/integrations/memlawb-memory-pilot.md`. No feature flag (built-in
  templates are inert until a company creates a connection).
- **Verify:** `@paperclipai/server` typecheck clean; tool-gateway tests 66/66 pass.
- **Self-audit (sr-security-auditor):** 0 CRITICAL/0 HIGH. 1 MEDIUM (ZK passphrase at rest in
  connection config.env, inherent to the stdio pattern — deferred to Phase-2 secret resolution),
  2 LOW (unpinned bun in crypto path; early crypto dep), 1 INFO (ZK holds vs storage backend, not
  vs Paperclip — documented). No injection: spawn is not shell:true.
- **Result:** wire-complete, runtime-unverified (needs a live instance + bun-in-image + a connection).
- **Fence:** stopped before push. Target is the public paperclipai repo; change touches spawn+secrets
  surface → RISKY + outward-facing. Handed go/no-go to human.

## Ruled out (do not re-litigate)
- SCM migration to gitlawb; $GITLAWB token/staking/bounties (human money decision).
- opencode-local as pilot target (no MCP path). Adding memlawb as an in-sandbox stdio entry
  (blocked by `--strict-mcp-config`). A new feature flag (built-in template is inert by default).

## Next candidates (need human go)
1. Push this branch / open PR to paperclipai (outward-facing — human).
2. Phase-2: vendor memlawb's `client/crypto.ts`; resolve passphrase from secrets system (fixes the MEDIUM).
3. Pin bun to a known-good version (LOW integrity win).
