# SUP-18 — MCP propagation through claude_local adapter

**Status:** Draft for board approval
**Owner:** CEO → Lead Engineer (after approval)
**Date:** 2026-05-07
**Parent issue:** SUP-18

## Problem

Agent heartbeats spawned by the `claude_local` adapter currently expose only the MCPs that the Claude Code SDK ships natively (claude.ai connectors: Gmail, Calendar). The Linear MCP that Brad has on his laptop in `/paperclip/.claude.json` does not propagate. Today the CEO must call `api.linear.app/graphql` directly with a personal API key (SUP-17 fallback). The Linear API key is also sitting world-readable in plaintext on disk.

Acceptance criteria from SUP-18:

1. A `ToolSearch` from a heartbeat returns at least one `mcp__linear__*` tool.
2. The Linear token is no longer plaintext in any checked-in / world-readable file.
3. An agent can read ENG-2696 without manual GraphQL.

## Scope

**In scope (this spec):**
- Per-agent MCP server propagation through the `claude_local` adapter.
- Secret-store migration of the existing Linear API key.
- Smoke validation from the CEO heartbeat (read ENG-2696 via `mcp__linear__*`).

**Out of scope (follow-up):**
- Linear API key rotation to a read-only / restricted scope.
- Switching from `mcp-linear` stdio to the official `mcp.linear.app/mcp` HTTP MCP.
- Company-level MCP registry (one shared definition reused across agents).
- UI editor for MCP servers in `AgentConfigForm` (initial configuration via API/DB is fine; UI can come later).

## Design choices

### 1. Per-agent config (not company-level registry)

MCP servers are declared per-agent under `adapterConfig.mcpServers`, mirroring the shape Claude Code already uses in `.claude.json`:

```json
{
  "mcpServers": {
    "linear": {
      "type": "stdio",
      "command": "mcp-linear",
      "args": [],
      "env": {
        "LINEAR_API_KEY": { "type": "secret_ref", "secretId": "<uuid>", "version": "latest" }
      }
    }
  }
}
```

**Why:** the company has 4 agents; only CEO and Lead Engineer need Linear. Reusing the existing `agents.adapterConfig` JSONB column, the existing zod validator (`/app/packages/shared/src/validators/agent.ts:34`), the existing `secretService.normalizeAdapterConfigForPersistence()` recursion, and the existing `AgentConfigForm` editor avoids ~all new schema, table, and route code. A company-level registry can be layered on later without breaking changes if the same shape is used.

### 2. `--mcp-config <file>` (not patched seed `.claude.json`)

The adapter writes an ephemeral `mcp-config.json` to the per-run working directory and passes `--mcp-config <path>` to the `claude` CLI. The seed dir (`prepareClaudeConfigSeed`) is unchanged.

**Why:** the seed dir is shared across runs and the per-project key in `.claude.json` depends on the cwd; mutating it risks cross-run state leaks. `--mcp-config` is the documented Claude CLI contract, ephemeral by construction, and trivially testable.

### 3. Secret-store migration in scope; rotation is a follow-up

The current key (the `lin_api_…` value already on disk in `/paperclip/.claude.json`) gets stored as a company secret, and the agent config references it via `secret_ref`. The `/paperclip/.claude.json` plaintext copy is removed. Rotation to a read-only scope and switching to the HTTPS MCP go to a separate child issue.

**Why:** the acceptance criterion is "no plaintext on disk" — moving the existing key to the encrypted store satisfies that. Generating a new restricted key is a separate manual Linear-side action; bundling it would push this beyond a one-shot delivery.

## Architecture

```
┌─────────────────────────────────────────┐
│ Paperclip control plane (server)        │
│                                         │
│ agents.adapterConfig (JSONB)            │
│   └── mcpServers: { linear: { …,        │
│         env: { LINEAR_API_KEY:          │
│           { type: "secret_ref", … } } } │
│                                         │
│ secretService                           │
│   .normalizeAdapterConfigForPersistence │
│   .resolveBindingsForRuntime            │
│     └── recurses into mcpServers.*.env  │
└──────────────────┬──────────────────────┘
                   │ adapter execute()
                   ▼
┌─────────────────────────────────────────┐
│ claude_local adapter                    │
│                                         │
│ execute.ts buildClaudeArgs()            │
│   ├── existing args                     │
│   └── if mcpServers present:            │
│       1. write <runDir>/mcp-config.json │
│       2. push --mcp-config <path>       │
│                                         │
│ env injection: existing path resolves   │
│   secret_refs in adapterConfig.env BUT  │
│   must also walk mcpServers.*.env       │
└──────────────────┬──────────────────────┘
                   │ spawn
                   ▼
┌─────────────────────────────────────────┐
│ claude CLI process                      │
│   mcp-linear (stdio)                    │
│     env: LINEAR_API_KEY=<resolved>      │
└─────────────────────────────────────────┘
```

## Components changed

### A. Validator — `/app/packages/shared/src/validators/agent.ts`

Add an optional `mcpServers` field to the claude_local adapter config schema. Shape mirrors Claude Code's `.claude.json`:

- `type`: `"stdio"` | `"sse"` | `"http"`
- `command` (stdio only): string
- `args` (stdio only): string[]
- `url` (sse / http only): string
- `env`: `Record<string, EnvBinding>` — reuses the existing `envConfigSchema` so `secret_ref` works out-of-the-box.
- `headers` (sse / http only): `Record<string, EnvBinding>` for things like `Authorization`.

### B. Secret normalization — `/app/server/src/services/secrets.ts`

Extend `normalizeAdapterConfigForPersistence` (and the runtime resolution counterpart) to recurse into `adapterConfig.mcpServers.*.env` and `.headers`, not just top-level `env`. One small change in the recursion entry point.

### C. Adapter execute — `/app/packages/adapters/claude-local/src/server/execute.ts`

In `buildClaudeArgs` (around lines 606-631), after secret resolution:

1. If `config.mcpServers` is non-empty, write `<runDir>/mcp-config.json` containing `{ mcpServers: <resolved> }`.
2. Push `--mcp-config <path>` to `args`.
3. The file is cleaned up by the existing `terminalResultCleanup` of the run dir.

### D. Adapter doc — `/app/docs/adapters/claude-local.md`

Document the new `mcpServers` field with an example using `secret_ref`.

### E. Initial Linear secret + agent config

Operator action (one-time): via the Lead Engineer running curl/admin script, not committed code:
1. `POST /api/companies/{id}/secrets` to create the `linear-api-key` secret with the existing value.
2. `PATCH /api/agents/{ceo-id}` and `/api/agents/{lead-engineer-id}` to add `mcpServers.linear` referencing the secret.
3. Remove the plaintext key from `/paperclip/.claude.json` (manual file edit on host).

### F. Tests

- Unit: validator accepts well-formed `mcpServers`, rejects missing `command` for stdio, rejects missing `url` for sse/http.
- Unit: `normalizeAdapterConfigForPersistence` resolves `secret_ref` inside `mcpServers.*.env`.
- Integration: `buildClaudeArgs` produces `--mcp-config <path>` and the file content matches the resolved config.

No live Linear MCP integration test — that's the smoke step.

## Data flow at runtime

1. CEO heartbeat triggered.
2. Server loads agent record → `adapterConfig` with `mcpServers.linear.env.LINEAR_API_KEY` as `secret_ref`.
3. `secretService.resolveBindingsForRuntime` decrypts the secret and returns a fully-resolved config (recurses into `mcpServers.*.env`).
4. `claude_local` adapter writes `<runDir>/mcp-config.json` with the resolved env, pushes `--mcp-config` to args, spawns `claude`.
5. `claude` reads `mcp-config.json`, spawns `mcp-linear` as a child stdio process with `LINEAR_API_KEY` in env.
6. Heartbeat sees `mcp__linear__*` tools in `ToolSearch`.

## Error handling

- Validator rejects malformed MCP entries at `PATCH /api/agents/:id` time.
- If a `secret_ref` resolution fails (deleted secret, wrong version), the adapter run fails fast with a clear error before spawning claude — same as the existing `env` path. No partial config.
- If the MCP child process crashes inside claude, that is claude's concern; we do not add supervision.

## Testing plan (smoke)

After the Lead Engineer ships the change and configures the secret + CEO agent config:

1. The Lead Engineer wakes the CEO heartbeat (via a comment on SUP-18 or any benign issue).
2. The CEO heartbeat lists `mcp__linear__*` in its deferred tools surface.
3. The CEO calls `mcp__linear__getIssue` (or equivalent) on `ENG-2696` and reports back the title in a comment.
4. SUP-18 closes as `done`. A child issue tracks rotation + HTTPS MCP migration.

## Risks

- **Bigger blast-radius if a stdio MCP misbehaves.** The `mcp-linear` package runs as a child process under claude — if it leaks the API key in logs, that's now in run telemetry. Mitigated by switching to the HTTPS MCP in the follow-up (server-side delegation, no key in subprocess env).
- **Schema drift with Claude Code's `.claude.json`.** Claude's MCP config shape may evolve; we mirror it manually. Mitigated by keeping the validator permissive on unknown fields (passthrough) and only enforcing the discriminator (`type`).
- **Secret resolution recursion bug.** Touching `normalizeAdapterConfigForPersistence` is delicate. Mitigated by unit tests on the recursion path before any live secret touches the new code.

## Non-goals (not in this spec)

- A UI form for editing `mcpServers` in `AgentConfigForm`. The initial config can be set via `PATCH /api/agents/:id`. UI work can be a separate ticket once the shape stabilizes.
- A company-level MCP registry. Per-agent for now; if Brad later wants Linear on every new agent by default, we add a registry then.
- Connector-style claude.ai HTTP MCP propagation. Out of scope; that path is owned by the Claude Code SDK runtime, not Paperclip.
