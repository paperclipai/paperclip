# Cloud-runtime adapter coverage

The Kubernetes execution target ships a per-adapter runtime image for each
local adapter Paperclip supports. The image is selected at run time by
`adapter-defaults.ts:getAdapterDefaults()`, which also lists which env keys
the driver exposes from the per-Job Secret and which FQDNs the tenant
NetworkPolicy + Cilium baseline must permit egress to.

| Adapter type      | Runtime image                                           | Env keys                                          | Default allowed FQDNs                                                  |
|-------------------|---------------------------------------------------------|---------------------------------------------------|------------------------------------------------------------------------|
| `claude_local`    | `ghcr.io/paperclipai/agent-runtime-claude`              | `ANTHROPIC_API_KEY`                               | `api.anthropic.com`                                                    |
| `codex_local`     | `ghcr.io/paperclipai/agent-runtime-codex`               | `OPENAI_API_KEY`                                  | `api.openai.com`                                                       |
| `gemini_local`    | `ghcr.io/paperclipai/agent-runtime-gemini`              | `GEMINI_API_KEY`, `GOOGLE_API_KEY`                | `generativelanguage.googleapis.com`                                    |
| `acpx_local`      | `ghcr.io/paperclipai/agent-runtime-acpx`                | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`             | `api.anthropic.com`, `api.openai.com`                                  |
| `opencode_local`  | `ghcr.io/paperclipai/agent-runtime-opencode`            | `OPENAI_API_KEY`                                  | `api.openai.com`                                                       |
| `pi_local`        | `ghcr.io/paperclipai/agent-runtime-pi`                  | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | `api.anthropic.com`, `api.openai.com`, `api.x.ai`                  |
| `hermes_local`    | `ghcr.io/paperclipai/agent-runtime-hermes` (stub)       | _(none — upstream binary not yet wired)_          | _(none — operators set via tenant policy)_                             |

Unknown adapter types fall back to `agent-runtime-base` with `envKeys=[]`
and `allowFqdns=[]` — a deliberate fail-closed default.

## Env-key filtering at the driver

The per-Job env Secret is populated by the server from company secrets, but
the driver materializes only the keys declared in the adapter's
`envKeys` list into the container environment. Extra keys passed by the
server are silently dropped as a defence-in-depth measure: a misconfigured
secret resolver cannot leak unrelated provider credentials into a pod that
has no business reading them. See
`packages/adapters/kubernetes-execution/src/driver.ts`.

## Per-tenant overrides

### Extending the FQDN allow-list

The tenant policy carries an `additionalAllowFqdns: string[]` field that is
merged on top of the adapter defaults; the resulting NetworkPolicy + Cilium
baseline allows BOTH. This field is set through the tenant-policy service
(server-side); operators tightening egress per-tenant typically use the
Cilium DSL instead — see `docs/k8s-execution/cilium-recipes.md`:

```bash
# Restrict a tenant to Anthropic + an internal git server.
paperclip cluster set-cilium-policy \
  --cluster <id> --company <id> \
  --cilium-dns "api.anthropic.com" \
  --cilium-cidrs "10.42.0.0/16"
```

The Cilium DSL emits a *second* CiliumNetworkPolicy that intersects with
the adapter baseline; the effective egress is strictly tighter, never
looser.

### Restricting image choices

Operators can also restrict which runtime images a cluster will pull via a
per-cluster image allow-list (prefix match):

```bash
paperclip cluster set-image-allowlist \
  --cluster <id> \
  --prefixes "ghcr.io/paperclipai/,registry.acme.internal/paperclip/"
```

An empty `--prefixes ""` clears the allow-list (default behaviour: no
restriction). Rationale and threat model are in
`docs/k8s-execution/security-model.md`.

## Building the runtime images

The full set of runtime images is built via Docker buildx bake:

```bash
docker buildx bake --file docker/agent-runtime/buildx-bake.hcl \
  --set "*.platforms=linux/amd64,linux/arm64" \
  default
```

Individual targets: `base`, `claude`, `codex`, `gemini`, `acpx`,
`opencode`, `pi`, `hermes`.

## Adding a new adapter

1. Add a `Dockerfile.<adapter>` under `docker/agent-runtime/` extending
   `agent-runtime-base`.
2. Add the bake target in `docker/agent-runtime/buildx-bake.hcl` and
   include it in `group "default"`.
3. Add a `<adapter>_local: { runtimeImage, envKeys, allowFqdns }` entry to
   `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.ts`.
4. Add a unit test in
   `packages/adapters/kubernetes-execution/src/orchestrator/adapter-defaults.test.ts`
   and a smoke test in
   `packages/adapters/kubernetes-execution/test/integration/<adapter>-smoke.test.ts`.
5. Update the table above.
