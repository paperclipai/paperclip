# Hermes in sandbox environments (TECH-8174)

Status: stage 1 implemented (this PR). Stages 2-4 follow as separate PRs.
The full design review (options, security review, rollout) is the TECH-8174 design note. This page lists what the code requires.

## How a sandbox run works

`execute()` reads the execution target first. A remote target goes to `execute-sandbox.ts`. Everything else stays on the existing host path, unchanged.

- **SSH targets** are refused. Hermes is a sandbox-only adapter (`environment-support.ts`: drivers `local` and `sandbox`). It runs only on the Kubernetes provider, the one provider that keeps exec env values out of the exec command (env over stdin). Other sandbox providers are not offered, and the run refuses them.
- **HERMES_HOME**: built on the host in a throwaway directory with host isolation forced on (no host `~/.hermes` config, `.env`, auth or skills). Paperclip skills are reconciled into it, and it is shipped as the `hermesHome` asset. `HERMES_HOME`, `HOME`, `XDG_*` and `TMPDIR` point under `<workspace>/.paperclip-runtime/hermes/`, which workspace sync-back excludes. Both are deleted from the sandbox after the run.
- **Prompt**: written to `<runtime>/query.txt` over exec stdin and passed as `--query-file`. Argv carries only flags and paths, because argv becomes the Kubernetes exec URI and lands in the audit log.
- **System prompt and secrets**: passed in env (`HERMES_EPHEMERAL_SYSTEM_PROMPT`, the agent's provider key). The Kubernetes provider delivers env over stdin (#415). The 131040-byte maximum is tested end to end through the real shell wrapper.
- **Paperclip API**: through the callback bridge only. The run JWT never enters the sandbox (#416); the bridge env supplies `PAPERCLIP_API_URL`/`PAPERCLIP_API_KEY`, and the prompt uses the bridge URL.
- **Env**: agent env plus Paperclip ids plus bridge env plus sandbox paths. The host process env, host `PATH`, forbidden DB variables, Router endpoint overrides and `RAMP_ROUTER_API_KEY` are never included.
- **Instructions bundle**: a Paperclip-managed bundle directory is shipped whole as the `instructions` asset. An external instructions file is shipped alone, never its directory. Symlinks are not followed. The prompt note names the sandbox path.
- **Command**: always the image's `/opt/hermes/bin/hermes`. A custom `hermesCommand` is refused.
- **Sessions**: none, as on hosted runs today. Every run has a fresh home, returns `clearSession: true`, and never passes `--resume`.
- **Output**: the same parser, redaction and stderr classification as the host path. Output streams through the run-log tail.
- **Workspace**: synced in and restored by `prepareAdapterExecutionTargetRuntime`. A run with no workspace stages an empty directory, never the server's cwd.
- **Cancellation and timeout**: `timeoutSec`/`graceSec` through `runAdapterExecutionTargetProcess`, the same as Pi.
- **Not available in the sandbox**: live progress from `state.db` (disabled) and the host memory import probe (not reached).
- **Environment test**: `hermes --version` runs in the sandbox, not on the host.

## Refused in stage 1 (clear error before anything is staged)

| Config | Why | Stage that lifts it |
|---|---|---|
| Ramp Router provider | Readiness probe must run in the pod; key delivery | 2 |
| `adapterConfig.memoryProvider` (mem0 over `MEM0_HOST`/`MEM0_PROXY`) | The tailnet memory service and the ECS proxy sidecar (`127.0.0.1:1055`) are unreachable from a pod | 3 (memory broker via bridge, decision D-1) |
| Paperclip runtime memory (`mem0.json` with Postgres credentials) | Pods must never get DB credentials | never |
| `PAPERCLIP_HERMES_COMMAND_SCAN=required` | Launcher trust is checked on host files | later |
| Managed AI connections (`managedAiRouting`/`managedAiConnection`) | Connection testing and routing are host-local today | later |
| Runtime MCP servers | Not refused: dropped with a stdout warning. All are Paperclip URLs, and one uses the run JWT | 4 (bridge routes with host-held credentials, decision D-2) |

## Environment config (ops, not code)

The Kubernetes plugin needs an `adapters[]` entry for `hermes_local`: `runtimeImage` (the server image digest), `allowFqdns` (the provider's API host), `envKeys: []` (keys come from the agent's own binding over stdin), and `probeCommand: ["/opt/hermes/bin/hermes", "--version"]`.

## Open questions

- Hermes writes under a read-only root filesystem: everything Hermes writes should land in `HOME`/`HERMES_HOME`/`TMPDIR`, all under `/workspace`. This is unverified until the first live run.
- Egress beyond the provider API (model metadata, auxiliary models, web tools) is unknown. Watch Hubble drops on the first live runs.
