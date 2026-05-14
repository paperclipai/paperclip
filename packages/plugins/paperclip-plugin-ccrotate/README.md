# @kkroo/paperclip-plugin-ccrotate

Paperclip **sandbox provider** plugin that runs agent commands through a
[ccrotate](https://github.com/somersby10ml/ccrotate)-managed Claude or Codex
account pool over SSH, with rotation at lease acquisition and automatic
mid-run rotation when output trips a rate-limit pattern.

This package is bundled into the paperclip server image. It is **not**
published to npm — auto-install reads it from
`packages/plugins/paperclip-plugin-ccrotate` inside the image at boot.

## Architecture

```
┌─────────────────────────────────┐         ┌─────────────────────────────┐
│  paperclip pod (k8s)            │         │  ccrotate host (devbox)     │
│                                 │         │                             │
│  plugin worker                  │         │  ccrotate CLI               │
│  ├─ acquireLease ──────────── ssh user@host ccrotate next -y ──────────▶│
│  ├─ realizeWorkspace ──────── rsync localPath/ user@host:remoteCwd/ ───▶│
│  ├─ execute ────────────────── ssh user@host <command> ────────────────▶│
│  │   (on rate-limit:           ssh user@host ccrotate next -y           │
│  │    + respawn execute)       ssh user@host <command>)                 │
│  └─ destroyLease ──────────── ssh user@host rm -rf <remoteCwd> ────────▶│
└─────────────────────────────────┘         └─────────────────────────────┘
```

### What lives where

| Component                              | Location                                     |
|----------------------------------------|----------------------------------------------|
| Plugin worker process                  | paperclip pod                                |
| `ssh` client                           | paperclip pod (Dockerfile installs)          |
| `rsync`                                | paperclip pod (Dockerfile installs)          |
| SSH private key                        | paperclip pod (mount via k8s secret)         |
| `ccrotate` binary                      | ccrotate host                                |
| `~/.ccrotate/profiles-{claude,codex}.json` | ccrotate host                            |
| `~/.{claude,codex}` credentials         | ccrotate host                                |
| `claude` / `codex` CLI                 | ccrotate host                                |

The pod does **not** need ccrotate, claude, or codex installed. All rotation
state and credentials live on the ccrotate host.

## Auto-install

`server/src/index.ts` installs this plugin from
`process.cwd() + "/packages/plugins/paperclip-plugin-ccrotate"` on every
boot if `kkroo.ccrotate` is not already in the registry. The build runs
`pnpm --filter @kkroo/paperclip-plugin-ccrotate build` in the Dockerfile
build stage so `dist/` is present when the server boots.

## Configuring an environment

After the pod boots and the plugin auto-installs, an instance admin creates
a Sandbox-kind environment whose `provider` is `ccrotate`. Provide:

```jsonc
{
  "ssh": {
    "host": "devbox.example.com",
    "user": "oramadan",
    "port": 22,
    "identityFile": "/var/secrets/ccrotate-host/id_ed25519",
    "strictHostKeyChecking": true
  },
  "target": "claude",
  "remoteWorkspaceRoot": "/home/oramadan/paperclip-runs",
  "midRunRetries": 1
}
```

`identityFile` must be readable by the plugin worker process inside the pod.
The recommended pattern is a Kubernetes secret mounted into the deployment;
point `identityFile` at the mount path.

`remoteWorkspaceRoot` is created with `mkdir -p` on the host — must be
writable by the SSH user.

## Behavior notes

- **Rotation at acquireLease.** Each new run rotates to a fresh account
  before the run starts.
- **Mid-run rotation is post-hoc and respawns.** The plugin scans the
  full stdout/stderr after a command finishes; if any `rateLimitPatterns`
  string matches, it runs `ccrotate next` on the host and respawns the same
  command. The respawn IS the relaunch — codex/claude re-read
  `~/.{codex,claude}` credentials at process startup, so a fresh ssh exec
  with the same command picks up rotated auth automatically. Bounded by
  `midRunRetries` (default 1).
- **Streaming/long-lived sessions are not rotated mid-stream.** The current
  implementation does not interrupt running processes; pattern detection
  happens after the command exits. For one-shot agent tool calls this is
  sufficient.
- **Concurrent leases share host state.** Multiple leases against the same
  target rotate the same `~/.{claude,codex}` credentials file — this is the
  same property as the manual `ccrotate next` workflow.

## Pre-requisites on the ccrotate host

- `ccrotate >= 1.1.0` on `PATH` (introduced `--target`).
- At least two saved accounts via `ccrotate snap` for the chosen target.
- Pod can SSH in (key-based, BatchMode-friendly, the configured user can
  write `~/.{claude,codex}` and read/write `~/.ccrotate`).

## Building from source (in monorepo)

```bash
pnpm install
pnpm --filter @kkroo/paperclip-plugin-ccrotate build
```

Or from the Dockerfile build stage — runs automatically.
