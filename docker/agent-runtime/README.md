# Agent Runtime Image Family

Paperclip publishes container images for remote agents. Images are named `agent-runtime-{adapterType}:{paperclipVersion}` and distributed via `ghcr.io/paperclipai/`.

## Image Lineup

- **`agent-runtime-base`**: Foundation. Ubuntu 22.04 + Node 22 + git + tini + non-root user + shim + workspace-init.
- **`agent-runtime-claude`**: Extends base with `@anthropic-ai/claude-code` CLI globally installed.
- Future: Additional adapter-specific images follow the same pattern (e.g., `agent-runtime-go`, `agent-runtime-rust`).

## Base Image Contents

**OS & Runtime:**
- Ubuntu 22.04
- Node.js 22 (via NodeSource APT repo)
- git
- tini (PID-1 init, ensures signal propagation)
- Non-root user `paperclip` (uid/gid 1000)

**Paperclip Binaries:**
- `/usr/local/bin/paperclip-agent-shim` — Go binary compiled from `tools/agent-shim/`. Reads `/run/paperclip/runtime-command.json` and `syscall.Exec`s the adapter CLI.
- `/usr/local/bin/paperclip-workspace-init` — Node script entry point. Used by init container to bootstrap the workspace.

**Defaults:**
- `USER`: 1000:1000 (paperclip, non-root)
- `WORKDIR`: `/workspace` — PVCs are mounted here
- `ENTRYPOINT`: `/usr/bin/tini --` (PID-1 reaper, forwards signals)
- `CMD`: `/usr/local/bin/paperclip-agent-shim`

## Building Locally

### Multi-architecture (amd64 + arm64)

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --push
```

### Host-only (faster iteration)

Replace the architecture with your machine's native platform:

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl \
  --set "*.platforms=linux/$(uname -m | sed s/x86_64/amd64/)" \
  --load
```

### Custom tag or registry

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl \
  --set "*.tags=myregistry/agent-runtime-base:mytag" \
  --load
```

## Quickstart Smoke Test

Build and verify the `agent-runtime-claude` image runs locally:

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl \
  --set "*.platforms=linux/$(uname -m | sed s/x86_64/amd64/)" \
  --load
docker run --rm ghcr.io/paperclipai/agent-runtime-claude:dev claude-code --version
```

## Init Container (workspace-init)

The init container prepares the workspace before the agent starts. It reads environment variables, bootstraps the workspace directory tree, and exits.

**Environment Variables:**
- `PAPERCLIP_WORKSPACE_REQUEST` — JSON serialized workspace request (required)
- `PAPERCLIP_WORKSPACE_ROOT` — Where to write workspace state (default: `/workspace`)
- `BOOTSTRAP_TOKEN` — Authentication token for workspace API (required)
- `PAPERCLIP_PUBLIC_URL` — Public endpoint for workspace callbacks (required)

**Failure Modes:**
Missing or invalid env vars → exit code 1. Pod init never repeats; failure blocks agent startup.

## Agent Container (paperclip-agent-shim)

The main agent runs as the shim process (PID 1 under tini). The shim:

1. Reads `/run/paperclip/runtime-command.json` — a JSON file mounted by the Job controller
2. Parses `{ command, args, ... }` — the adapter CLI and arguments
3. `syscall.Exec`s the adapter process, replacing itself
4. SIGTERM from kubelet propagates directly to the adapter (no process zombie)

**runtime-command.json Contract:**
```json
{
  "command": "claude-code",
  "args": ["--token", "xyz", "--workspace", "/workspace"]
}
```

The shim makes no assumptions about command structure; it is adapter-agnostic. Future adapters swap the command/args; the image remains the same.

## Security Model

- **Non-root execution** — user 1000:1000, no capability grant
- **PSS Restricted compatible** — no privileged containers, no host mounts, read-only filesystem (except `/workspace` + `/tmp`)
- **No secrets baked in** — API tokens, credentials come from per-Job ephemeral Secrets mounted as env vars or files
- **Image signing** — cosign keyless OIDC in CI (see Task 29)

## Versioning Policy

**agent-runtime-base:**
- Version tag `vX.Y.Z` published when the shim or workspace-init source changes
- Includes all base layer content (OS, Node, git, tini, non-root user)

**agent-runtime-claude:**
- Builds on top of base at the same version tag
- Version tag bumps independently when a new `@anthropic-ai/claude-code` release is pinned
- Currently uses `npm install @anthropic-ai/claude-code@latest` for the `dev` tag; CI workflow (Task 29) will pin exact semver versions per release

## Multi-arch Caveats

- Both amd64 and arm64 images are built in CI; local builds require `--load` on single-arch or `--push` for multi-arch
- Go shim cross-compilation is automatic via `GOARCH` (see Dockerfile.base Stage 1)
- Node modules are platform-agnostic; workspace-init rebuilds without issues across architectures
