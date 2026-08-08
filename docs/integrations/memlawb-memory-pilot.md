# memlawb memory — pilot runbook

Zero-knowledge, end-to-end-encrypted **cross-session agent memory** for Paperclip, via
[memlawb](https://github.com/Gitlawb/memlawb) (`@gitlawb/memlawb`). This is a **pilot**:
it fills the gap between Paperclip's per-adapter session-resume and true "what the agent
learned" memory carried across runs.

## How it works (and the one nuance that matters)

memlawb ships a **stdio MCP server** (`memlawb mcp`) that holds your passphrase, encrypts
locally (scrypt + AES-256-GCM), and syncs ciphertext to a **crypto-blind** memlawb storage
server. Paperclip runs stdio MCP servers through its **tool-gateway**, which spawns the
process **on the paperclip-server host** (`tool-gateway.ts` → `spawn(...)`), not in the agent
sandbox.

> **Zero-knowledge placement.** Because the memlawb wrapper runs on the paperclip-server host,
> plaintext memory transits Paperclip. Zero-knowledge therefore holds **relative to the remote
> storage backend** (which only ever sees ciphertext), **not** relative to Paperclip itself.
> For a self-hosted Paperclip that *is* your trusted server, this is fine. If you need memory
> that even your orchestrator can't read, this pilot does not provide it (Paperclip's
> `--strict-mcp-config` + `mcp_remote`-only auto-injection prevent running the wrapper inside
> the sandbox).

## What the code change provides

- A built-in `local_stdio` template **`paperclip.memlawb-memory`** in `tool-gateway.ts`
  (`command: memlawb`, `args: ["mcp"]`, envKeys: `MEMLAWB_URL/API_KEY/PASSPHRASE/NAMESPACE/SCAN`).
- `bun` + `@gitlawb/memlawb@0.1.0` installed in the server image (`Dockerfile`) — memlawb needs bun.

There is **no feature flag**: the template is **inert until an operator creates a connection
that references it**. That connection creation is the activation switch.

## Prerequisites

1. Rebuild the server image (ships bun + memlawb). Confirm on the host: `bun --version`, `memlawb --help`.
2. **Deployment mode:** `local_stdio` is refused in `authenticated` + `public` deployments
   unless a trusted runtime host is set — `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST`
   (see `tool-runtime-supervisor.ts` `assertLocalStdioAvailable`). `local_trusted` works as-is.
3. Self-host a memlawb **storage server** (do NOT use `memory.gitlawb.com` for sensitive data):
   `STORE=fs|s3 DATA_DIR=… memlawb serve` (or the container). Note its URL.

## Activate (one pilot agent — data-plane, no code)

1. **Create the connection** (via the tools API / UI — never raw-INSERT; the service writes the
   required `toolProfiles`/binding rows). Use `transport: local_stdio`, templateKey
   `paperclip.memlawb-memory`, and `config.env`:
   ```json
   {
     "MEMLAWB_URL": "https://<your-memlawb-storage-host>",
     "MEMLAWB_PASSPHRASE": "<high-entropy generated passphrase>",
     "MEMLAWB_NAMESPACE": "agent:<companyId>/<agentId>",
     "MEMLAWB_SCAN": "block"
   }
   ```
   Namespace format is validated: **one scope prefix + one colon; slashes allowed, no second
   colon** — `agent:<companyId>/<agentId>` is valid; `company:x/agent:y` is rejected.
2. **Enable** it (`status: active`, `enabled: true`).
3. **Install it for the single pilot agent** (`toolConnectionInstalls`, targetType `agent`) and
   permit it in that agent's tool profile. Scoping install to one agent id = "one runtime."
4. Target a **claude-local / codex-local / gemini-local** agent (MCP-capable). **Not opencode**
   (no MCP path).

## Passphrase handling (read this)

- The passphrase is your **zero-knowledge key**. Generate a **high-entropy** value — memlawb
  derives the salt from the namespace (predictable), so the passphrase is the *sole* secret.
- **Lose it → memory is permanently unreadable.** Back it up / escrow it (and the escrow must
  not itself defeat zero-knowledge).
- `config.env` is stored in the `tool_connections` row. Ensure your DB is encrypted at rest, or
  (Phase 2) resolve the passphrase from the server host env / Paperclip secrets instead of
  connection config. **Never commit the passphrase.**

## Verify (needs a live instance)

1. Run the pilot agent once; have it call `memory_save` with a distinctive fact.
2. Run it again in a later heartbeat; confirm `recall` returns the fact (cross-session memory).
3. On the storage host, `grep -r "<the fact>" <DATA_DIR>` → **must find nothing** (ciphertext only).
4. Try saving a fake credential (`sk-...`) → memlawb's `MEMLAWB_SCAN=block` scanner must refuse it.

## Rollback

- **Disable/delete the connection** — the template is inert again; no other agent is affected.
- Revert the two code/infra changes: the `paperclip.memlawb-memory` template entry in
  `tool-gateway.ts` and the bun/memlawb lines in `Dockerfile`.
- No schema migration is introduced by this pilot.

## Ceiling / next step

Pilot ADOPT-style is DEPEND. If it proves out, the ADOPT plan's Phase 2 is to **vendor the
~80-line MIT `client/crypto.ts`** into a Paperclip memory module and resolve the passphrase
through the secrets system — removing the DB-plaintext-config gap and the dependency on an
early, fast-moving upstream. See `scratchpad/gitlawb/03-memlawb-spike-and-adopt-plan.md`.
