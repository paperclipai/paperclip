# Hermes in sandbox environments (TECH-8174)

Status: stages 1 (sandbox execution) and 2 (Ramp Router) implemented. Stages 3-4 wait on decisions D-1/D-2.
The full design review (options, security review, rollout) is the TECH-8174 design note. This page lists what the code requires.

## How a sandbox run works

`execute()` reads the execution target first. A remote target goes to `execute-sandbox.ts`. Everything else stays on the existing host path, unchanged.

- **SSH targets** are refused. Hermes is a sandbox-only adapter (`environment-support.ts`: drivers `local` and `sandbox`). It runs only on the Kubernetes provider, the one provider that keeps exec env values out of the exec command (env over stdin). Other sandbox providers are not offered, and the run refuses them.
- **HERMES_HOME**: built on the host in a throwaway directory with host isolation forced on (no host `~/.hermes` config, `.env`, auth or skills). Paperclip skills are reconciled into it, and it is shipped as the `hermesHome` asset. `HERMES_HOME`, `HOME`, `XDG_*` and `TMPDIR` point under `<workspace>/.paperclip-runtime/hermes/`, which workspace sync-back excludes. Both are deleted from the sandbox after the run.
- **Prompt**: written to `<runtime>/query.txt` over exec stdin and passed as `--query-file`. Argv carries only flags and paths, because argv becomes the Kubernetes exec URI and lands in the audit log. The launch exec writes the file (and creates the run home) before it execs Hermes, so staging costs no separate exec; a staging failure stops the run with "Could not stage the Hermes prompt in the sandbox." and Hermes never starts.
- **System prompt and secrets**: passed in env (`HERMES_EPHEMERAL_SYSTEM_PROMPT`, the agent's provider key). The Kubernetes provider delivers env over stdin (#415). The 131040-byte maximum is tested end to end through the real shell wrapper.
- **Paperclip API**: through the callback bridge only. The run JWT never enters the sandbox (#416); the bridge env supplies `PAPERCLIP_API_URL`/`PAPERCLIP_API_KEY`, and the prompt uses the bridge URL.
- **Env**: agent env plus Paperclip ids plus bridge env plus sandbox paths. The host process env, host `PATH`, forbidden DB variables, and Router endpoint overrides are never included. `RAMP_ROUTER_API_KEY` is included only for a Ramp Router run (see below).
- **Instructions bundle**: a Paperclip-managed bundle directory is shipped whole as the `instructions` asset. An external instructions file is shipped alone, never its directory. Symlinks are not followed. The prompt note names the sandbox path.
- **Command**: always the image's `/opt/hermes/bin/hermes`. A custom `hermesCommand` is refused.
- **Sessions**: none, as on hosted runs today. Every run has a fresh home, returns `clearSession: true`, and never passes `--resume`.
- **Output**: the same parser, redaction and stderr classification as the host path. Output streams through the run-log tail.
- **Workspace**: synced in and restored by `prepareAdapterExecutionTargetRuntime`. A run with no workspace stages an empty directory, never the server's cwd.
- **Cancellation and timeout**: `timeoutSec`/`graceSec` through `runAdapterExecutionTargetProcess`, the same as Pi.
- **Not available in the sandbox**: live progress from `state.db` (disabled) and the host memory import probe (not reached).
- **Environment test**: `hermes --version` runs in the sandbox, not on the host.

## Memory in the sandbox (stage 3, TECH-8908)

`adapterConfig.memoryProvider: "mem0"` works in a pod. Hermes keeps its native mem0 provider, recall and sync; only the network path changes. The pod sets `MEM0_HOST` to `<bridge origin>/api/agent-memory-relay` and `MEM0_API_KEY` to the per-run bridge token (not a memory token). `MEM0_PROXY` and the agent's memory token are stripped from the pod env. The server relays four fixed routes (`POST /search`, `POST /memories`, `PUT /memories/:id` with a UUID id, `DELETE /memories/:id`) to its own `PAPERCLIP_AGENT_MEMORY_URL`, with the calling agent's own `agent_memory.<agentId>` secret chosen from the run JWT. The agent's adapter-config `MEM0_HOST` is never used, the body is forwarded unchanged, and no query string, redirect or header other than `content-type` is passed. Gate before relying on it: measure p50/p95 recall round trip from a live pod against Hermes's 3 s automatic recall budget.

## Ramp Router (stage 2)

- **Key**: only the agent's own `RAMP_ROUTER_API_KEY` binding (company secret reference), delivered in the exec env (over stdin on Kubernetes). It is never in argv, never in a shipped file, and never in the plugin's `envKeys` Secret: keep `envKeys: []` for `hermes_local`. It is redacted from all output.
- **Gates**: the same as on the host. A missing key or `extraArgs` refuses the run. Endpoint overrides (`RAMP_ROUTER_*`, aliases, `OPENAI_BASE_URL`/`OPENAI_API_BASE`) and Python import-path overrides (`PYTHONPATH`/`PYTHONHOME`/`PYTHONUSERBASE`) are dropped from the env Paperclip sends. The fixed names are also unset at launch (`env -u`), so the pod's own environment cannot reintroduce them.
- **Readiness**: verified inside the sandbox, never on the host. One exec checks that `/opt/hermes/bin/hermes` is the venv's own entrypoint (not a symlink, venv-interpreter shebang). It then runs the same sealed registry probe as the host, with `env -i` (no credentials) in a fresh per-probe home that is deleted afterwards. The environment test runs the same probe.
- **Egress**: allow-list `api.router.com` for the environment.

## Still refused (clear error before anything is staged)

| Config | Why | Stage that lifts it |
|---|---|---|
| Paperclip runtime memory (`mem0.json` with Postgres credentials) | Pods must never get DB credentials | never |
| `PAPERCLIP_HERMES_COMMAND_SCAN=required` | Launcher trust is checked on host files | later |
| Managed AI connections (`managedAiRouting`/`managedAiConnection`) | Connection testing and routing are host-local today | later |
| Runtime MCP servers | Relayed: Hermes gets `${PAPERCLIP_API_URL}/paperclip-relay/mcp/<server>` routes; the host injects each server's credential and applies a per-route deadline (the gateway tool timeout plus 5 s). GET and DELETE on a route answer 405, as the stateless gateway does. Servers without a declared timeout get a 30 s deadline. The server URL interpolates `${PAPERCLIP_API_URL}` (unverified against Hermes until the live run). On the file transport each route is registered as a TECH-8907 route policy (own lane, in-pod deadline 5 s above the relay's); the duplex transport ignores policies and uses the relay deadline alone. No MCP token or run JWT in the pod | 4 (done, decision D-2) |

## Environment config (ops, not code)

The Kubernetes plugin needs an `adapters[]` entry for `hermes_local`: `runtimeImage` (the server image digest), `allowFqdns` (the provider's API host), `envKeys: []` (keys come from the agent's own binding over stdin), and `probeCommand: ["/opt/hermes/bin/hermes", "--version"]`.

## Open questions

- Hermes writes under a read-only root filesystem: everything Hermes writes should land in `HOME`/`HERMES_HOME`/`TMPDIR`, all under `/workspace`. This is unverified until the first live run.
- Egress beyond the provider API (model metadata, auxiliary models, web tools) is unknown. Watch Hubble drops on the first live runs.
