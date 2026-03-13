# Sandboxed Agent Adapter

Paperclip now includes a `sandbox` adapter type for running CLI agents inside a remote sandbox instead of directly on the Paperclip host.

## Providers

- `cloudflare`
- `e2b`
- `opensandbox`

Cloudflare uses a small gateway Worker that wraps Cloudflare Sandbox and exposes a stable HTTP API back to Paperclip.
E2B and OpenSandbox connect directly from the Paperclip server through their SDKs.

Reference implementation:
- [`examples/cloudflare-sandbox-gateway/README.md`](../examples/cloudflare-sandbox-gateway/README.md)

## Adapter config shape

Top-level fields:
- `providerType`
- `sandboxAgentType`
- `keepAlive`
- `providerConfig.baseUrl` (Cloudflare)
- `providerConfig.namespace` (Cloudflare)
- `providerConfig.instanceType` (Cloudflare)
- `providerConfig.template` (E2B)
- `providerConfig.domain` (E2B/OpenSandbox)
- `providerConfig.image` (Cloudflare/OpenSandbox)

Inner CLI fields follow the same general shape as the local adapters:
- `cwd`
- `instructionsFilePath`
- `promptTemplate`
- `bootstrapPrompt`
- `bootstrapCommand`
- `command`
- `model`
- `extraArgs`
- `env`

Provider auth:
- set `env.CLOUDFLARE_GATEWAY_TOKEN` to the same bearer token configured on the gateway
- for E2B, prefer `env.E2B_API_KEY`; `env.E2B_ACCESS_TOKEN` is also supported as a fallback/alternate auth path
  - the adapter reads `providerConfig.apiKey`, `providerConfig.token`, and `env.E2B_API_KEY` for API-key auth
  - it separately reads `providerConfig.accessToken` and `env.E2B_ACCESS_TOKEN` for access-token auth
  - if both are present, both are forwarded to the SDK connection config
  - example: `env: { "E2B_API_KEY": { "type": "secret_ref", "secretId": "..." } }`
- set `env.OPEN_SANDBOX_API_KEY` for OpenSandbox

## Session behavior

- `keepAlive=true`: Paperclip stores sandbox ID plus inner agent session ID and attempts resume on the next heartbeat
- `keepAlive=false`: Paperclip destroys the sandbox after the run and clears the stored session

## UI behavior

The board UI exposes `sandbox` as a normal adapter type in the existing agent create/edit form.

- default path is now managed-first:
  - E2B is the recommended managed preset
  - OpenSandbox is the recommended self-hosted preset
  - Cloudflare is presented as advanced
- provider credentials have dedicated setup fields in the sandbox form
- those credentials can be saved into Paperclip secrets from the same form
- raw provider fields live under advanced sandbox settings
- Cloudflare advanced fields show gateway URL, namespace, instance type, and image
- E2B advanced fields show optional API domain
- OpenSandbox advanced fields show optional API domain and image

The rest of the sandbox section stays shared: inner CLI runtime, keep-alive policy, bootstrap command, instructions file, command/model/env controls, and environment testing.

For the `sandbox` adapter, `instructionsFilePath` is read from inside the sandbox filesystem after workspace sync/bootstrap, not from the Paperclip host filesystem. Relative paths resolve from the sandbox working directory.

## Notes from live validation

- E2B `codex` and `opencode` templates are reachable with the provider key and include those CLIs on path.
- The adapter now creates the remote working directory before bootstrap/exec.
- Default sandbox cwd is provider-aware:
  - E2B defaults to `/home/user/workspace`
  - Cloudflare/OpenSandbox default to `/workspace`
