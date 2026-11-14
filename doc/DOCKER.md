# Docker Quickstart

Run Paperclip in Docker without installing Node or pnpm locally.

All commands below assume you are in the **project root** (the directory containing `package.json`), not inside `docker/`.

## Building the image

```sh
docker build -t paperclip-local .
```

The Dockerfile installs common agent tools (`git`, `gh`, `curl`, `wget`, `ripgrep`, `python3`) and the Claude, Codex, and OpenCode CLIs.

Build arguments:

| Arg | Default | Purpose |
|-----|---------|---------|
| `USER_UID` | `1000` | UID for the container `node` user (match your host UID to avoid permission issues on bind mounts) |
| `USER_GID` | `1000` | GID for the container `node` group |
| `CLI_TOOLS_CACHE_EPOCH` | empty | Refresh the CLI-install layer; CI supplies the current ISO week |
| `PAPERCLIP_BUILD_VERSION` | empty | Runtime version when Git metadata is unavailable |
| `PAPERCLIP_BUILD_COMMIT` | empty | Source commit written into the server build stamp and runtime environment |
| `PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST` | empty | Inputs digest of the published Runner image a build was given as `runner-artifacts`; the build fails on any other Runner. Leave it empty for a build that makes its own Runner |

Changing the build version or commit preserves the CLI-install cache. The
tool layer refreshes when its weekly epoch, base image, installation command,
or earlier build inputs change. Local builds can set a new epoch explicitly
to refresh tools without clearing the entire build cache.

```sh
docker build -t paperclip-local \
  --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) .
```

The image starts the server from a runtime bundle, `server/dist-runtime/index.mjs`,
with plain `node`. The build creates it from the server's `tsc` output with
`pnpm --filter @paperclipai/server build:runtime` (`server/scripts/bundle-runtime.mjs`),
compiling in the workspace packages that otherwise load as TypeScript source.
This avoids transpiling them through the tsx loader on every boot. To check a
build boots, run `scripts/server-boot-smoke.sh node server/dist-runtime/index.mjs`;
PR CI runs the same check after `pnpm build`.

## Standard images and downstream composition

The Docker workflow publishes the standard `production` target for Linux AMD64
and ARM64. Canonical master pushes also publish
`ghcr.io/paperclipai/paperclip:sha-<FULL_SHA>` and a GitHub/Sigstore attestation
for its immutable multi-platform digest. Downstream services can compose their
own images from this public base without rebuilding Core.

Stamped standard images include the build-owned remote provider pack at
`/opt/paperclip-runner/provider-pack` and set
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` to that directory. Downstream
compositions and the explicit `cloud` target inherit both. The pack is required
on the controller for remote OpenCode and ACPX runs, even when the sandbox has
preinstalled providers; setting the environment variable alone cannot repair an
image that omits the pack. Rebuild and redeploy from a standard image containing
the pack if runs fail with `runner_remote_provider_artifact_incompatible`.

Local Docker builds must supply a full `PAPERCLIP_BUILD_COMMIT` to include a
qualified pack. Unstamped builds remain usable for local adapters and skip pack
generation. The pack stays root-owned and readable by remapped runtime UIDs.

The legacy recurring public `-cloud` publisher is retired. Master pushes,
release tags, and manual `Docker` dispatches no longer build that variant.
Existing `-cloud` tags and digests remain in the registry for rollback; their
release-channel aliases no longer advance. This change deletes no images,
cache tags, or migrator artifacts.

The `cloud` Dockerfile target remains available for explicit
[preview builds](preview-release-artifacts.md). Those requests still publish a
full-SHA `-cloud` tag when needed. They do not advance a release channel or
replace downstream private composition.

A published image alone does not prove source tests or migration compatibility.
Downstream deployment tooling must verify [source proof](cloud-build-readiness.md),
the standard image attestation, the exact-source migrator, and its own composed
image before rollout. Resolve immutable digests instead of deploying mutable tags.

## Runner image

The `runner-artifacts` target builds the Runner alone: the daemon, the Runner
package's build output, the remote provider pack and its transport archives.
The `runner-artifacts-slim` target is the same image without the transport
archives. Neither depends on the server or UI build.
`.github/workflows/runner-image.yml` builds and checks
both on pull requests, for Linux AMD64 and ARM64, and publishes them from
`master` as `ghcr.io/paperclipai/paperclip-runner`. See
[`doc/runner-image-contract.md`](runner-image-contract.md) for the layout, the
identity rules and how to consume the image.

The application image takes its Runner from the `runner-artifacts` stage. It
has no Runner build of its own, no Rust toolchain and no C compiler. Every
build of the `production` or `cloud` target builds that stage itself, once,
unless it is given a published Runner image in its place (see "The Runner of
the application image" below):

- The `build` stage copies the Runner's build output and its build stamp into
  `packages/paperclip-runner`. It sets `PAPERCLIP_RUNNER_VENDOR_REQUIRE_CURRENT=1`,
  so the server build vendors that output and fails when the stamp does not
  match the source tree. It never builds the Runner again.
- The `runner-provider-pack` stage copies the pack and its transport archives
  out of `runner-artifacts` and moves the pack's large files to a tree of their
  own. The image keeps its paths under `/opt/paperclip-runner/` and its layers.

The daemon in the application image is therefore the stripped binary compiled
on Debian bookworm, and the pack's Node is the pinned bookworm build. The
build runs the steps of the Runner's `build` script that write output, not its
drift checks; repository CI runs those. See "The application image" in the
contract for the rules a consumer of the application image can rely on.

The Runner stages install with a frozen lockfile, so `docker build` fails when
`pnpm-lock.yaml` is behind the manifests they read: the root `package.json`,
`packages/paperclip-runner` and `packages/paperclip-eval-kernel`. The
`runner-lockfile` stage makes that check from those manifests and the lockfile
alone, so it runs as soon as the `base` stage is built. The `deps` stage starts
from it, so the application's dependency install cannot start before the check
passes. A stale lockfile fails the build within seconds of the check running,
with a message that names the command below. The Runner's own frozen install
fails on the same lockfile, but it comes after the daemon compile. Stages that
do not depend on the check can already be running when it fails: the Runner's
toolchain download and daemon compile, and the tool layer of the `production`
stage. The failed check stops the build and cancels them. The `deps` stage
still resolves every other manifest change inside the image. Refresh the
lockfile in the checkout, then build again. Do not commit the result (see
"Dependency Lockfile Policy" in `doc/DEVELOPING.md`):

```sh
pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile
```

### The Runner of the application image

An application image either makes its own Runner in its build (inline) or
copies the published Runner image of the same inputs. A local build, a fork,
a pull request and the merge-queue build are always inline.
`.github/workflows/docker.yml` in this repository copies the published image
when the repository variable `RUNNER_IMAGE_CONSUME_ENABLED` is exactly `true`
and the image of the commit's inputs is published and its attestation
verifies. On a `master` push it waits for the commit's own run of
`runner-image.yml`, at most 40 minutes from the push. In every other case the
build is inline, with a notice: no state of the Runner image fails an
application image build. A build that copies the published image builds the
committed `pnpm-lock.yaml`: the workflow does not refresh it first, and the
`deps` stage resolves the other packages' manifests inside the image.

An image that copied the published Runner has the labels
`io.paperclip.runner.image` (`ghcr.io/paperclipai/paperclip-runner@sha256:<digest>`)
and `io.paperclip.runner.inputs-digest`. An image without them made its own
Runner and is as complete. To go back to inline builds everywhere, set the
variable to another value or delete it; nothing needs a revert. See "The
Runner of the application image" in
[`doc/runner-image-contract.md`](runner-image-contract.md).

`.github/workflows/docker.yml` builds the application image on `master` and on
tags only. `.github/workflows/docker-app-check.yml` builds the `build` and
`runner-provider-pack` stages on a pull request that changes the `Dockerfile`,
`.dockerignore` or the step that vendors the Runner into the server, so a
change to how the application image gets its Runner fails before it merges.
It refreshes the lockfile before the build, as `docker.yml` does. It holds no
credential: it reads the build cache that `docker.yml` writes on `master`
anonymously, never writes it, and exports and publishes nothing.

## One-liner (build + run)

```sh
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -e PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Open: `http://localhost:3100`

Data persistence:

- Embedded PostgreSQL data
- uploaded assets
- local secrets key
- local agent workspace data

All persisted under your bind mount (`./data/docker-paperclip` in the example above).

## Docker Compose

### Persistent signing secrets

Before the first launch, generate two independent values with `openssl rand -hex 32`
and save them in `docker/.env`. Keep any existing deployment's values unchanged:

```dotenv
BETTER_AUTH_SECRET=<session-signing-secret>
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=<tool-action-signing-secret>
```

Restrict this file to its owner (`chmod 600 docker/.env`) and keep it out of version
control. Compose reads it for both commands below. Reuse the values on every
restart. Rotate the tool-action secret only after outstanding approvals are
resolved, because pending signatures use the previous value.

### Quickstart (embedded SQLite)

Single container, no external database. Data persists via a bind mount.

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Defaults:

- host port: `3100`
- persistent data dir: `./data/docker-paperclip`

Optional overrides:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

If you change host port or use a non-local domain, set `PAPERCLIP_PUBLIC_URL` to the external URL you will use in browser/auth flows.

Pass `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` to enable local adapter runs.

### Full stack (with PostgreSQL)

Paperclip server + PostgreSQL 17. The database is health-checked before the server starts.

```sh
docker compose -f docker/docker-compose.yml up --build
```

PostgreSQL data persists in a named Docker volume (`pgdata`). Paperclip data persists in `paperclip-data`.

Both Compose files pass `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` to the server.
When configured, keep it independent from `BETTER_AUTH_SECRET`. When unset,
the server derives a separate signing key from its persisted secrets master key.
Keep that key with database backups, and share the signing key or master key
across processes serving the same instance. Approvals fail closed if valid key
material cannot be loaded; rotating it can invalidate approvals and retry matching.

### Untrusted PR review

Isolated container for reviewing untrusted pull requests with Codex or Claude, without exposing your host machine. See `doc/UNTRUSTED-PR-REVIEW.md` for the full workflow.

```sh
docker compose -f docker/docker-compose.untrusted-review.yml build
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
```

## Authenticated Compose (Single Public URL)

For authenticated deployments, set one canonical public URL and let Paperclip derive auth/callback defaults:

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

`PAPERCLIP_PUBLIC_URL` is used as the primary source for:

- auth public base URL
- Better Auth base URL defaults
- bootstrap invite URL defaults
- hostname allowlist defaults (hostname extracted from URL)

For fresh `authenticated/private` Docker or appliance-style installs, the first
admin can now be claimed entirely from the browser after sign-in. Open the
Paperclip URL, sign in or create an account, then choose `Claim this instance`
on the setup screen. This browser claim is disabled for `authenticated/public`;
public deployments should run the high-entropy CLI invite fallback instead:

```sh
pnpm paperclipai auth bootstrap-ceo
```

Granular overrides remain available if needed (`PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `PAPERCLIP_ALLOWED_HOSTNAMES`).

Set `PAPERCLIP_ALLOWED_HOSTNAMES` explicitly only when you need additional hostnames beyond the public URL host (for example Tailscale/LAN aliases or multiple private hostnames).

### Optional Vercel Connect credentials

Vercel Connect's backend integration is retained for controlled testing and
existing Vercel-backed connections, but its new-connection UI is currently
withheld from **Apps → Browse**. Setting
`PAPERCLIP_VERCEL_CONNECT_ENABLED=true` does not expose a customer-facing setup
entry. Native provider setup screens remain unchanged. Vercel-hosted deployments use the
workload OIDC token Vercel injects. Other hosted and self-hosted deployments
can provide `PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN` as a deployment bootstrap
secret only when that token type is accepted by the live Connect API:

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_VERCEL_CONNECT_ENABLED: "true"
      PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN: ${PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN}
```

Do not save that access token in a company secret or connection config. It is
instance bootstrap authority for the operator-selected Vercel account. A token's
long expiry and broad Vercel scope do not prove Connect compatibility; validate
it with connector metadata before rollout. Workload OIDC takes precedence when
both authorities are present. Turning the feature flag off hides new
Vercel-backed setup; existing connections keep resolving while workload OIDC or
the bootstrap token remains available. Missing or invalid authority fails
closed. See the [Vercel Connect operator guide](./connections/VERCEL-CONNECT.md).

## Claude + Codex Local Adapters in Docker

The image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)
- `python3` (used to run local subscription sign-in in a pseudo-terminal)

Start the container, then open **Apps → Connections** to connect a Claude or
Codex subscription in your browser. You can also enter a provider API key there.
You do not run a shell command or configure a CLI home.

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Notes:

- The image provides the CLI and Python prerequisites for local subscription sign-in.
- Adapter environment checks in Paperclip surface missing authentication or CLI prerequisites.

## Podman Quadlet (systemd)

The `docker/quadlet/` directory contains unit files to run Paperclip + PostgreSQL as systemd services via Podman Quadlet.

| File | Purpose |
|------|---------|
| `docker/quadlet/paperclip.pod` | Pod definition — groups containers into a shared network namespace |
| `docker/quadlet/paperclip.container` | Paperclip server — joins the pod, connects to Postgres at `127.0.0.1` |
| `docker/quadlet/paperclip-db.container` | PostgreSQL 17 — joins the pod, health-checked |

### Setup

1. Build the image (see above).

2. Copy quadlet files to your systemd directory:

   ```sh
   # Rootless (recommended)
   cp docker/quadlet/*.pod docker/quadlet/*.container \
     ~/.config/containers/systemd/

   # Or rootful
   sudo cp docker/quadlet/*.pod docker/quadlet/*.container \
     /etc/containers/systemd/
   ```

3. Create a secrets env file (keep out of version control):

   ```sh
   cat > ~/.config/containers/systemd/paperclip.env <<EOL
   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
   PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)
   POSTGRES_USER=paperclip
   POSTGRES_PASSWORD=paperclip
   POSTGRES_DB=paperclip
   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5432/paperclip
   # OPENAI_API_KEY=sk-...
   # ANTHROPIC_API_KEY=sk-...
   EOL
   ```

4. Create the data directory and start:

   ```sh
   mkdir -p ~/.local/share/paperclip
   systemctl --user daemon-reload
   systemctl --user start paperclip-pod
   ```

### Quadlet management

```sh
journalctl --user -u paperclip -f        # App logs
journalctl --user -u paperclip-db -f     # DB logs
systemctl --user status paperclip-pod    # Pod status
systemctl --user restart paperclip-pod   # Restart all
systemctl --user stop paperclip-pod      # Stop all
```

### Quadlet notes

- **First boot**: Unlike Docker Compose's `condition: service_healthy`, Quadlet's `After=` only waits for the DB unit to *start*, not for PostgreSQL to be ready. On a cold first boot you may see one or two restart attempts in `journalctl --user -u paperclip` while PostgreSQL initialises — this is expected and resolves automatically via `Restart=on-failure`.
- Containers in a pod share `localhost`, so Paperclip reaches Postgres at `127.0.0.1:5432`.
- PostgreSQL data persists in the `paperclip-pgdata` named volume.
- Paperclip data persists at `~/.local/share/paperclip`.
- For rootful quadlet deployment, remove `%h` prefixes and use absolute paths.

## Onboard Smoke Test (Ubuntu + npm only)

Use this when you want to mimic a fresh machine that only has Ubuntu + npm and verify:

- `npx paperclipai onboard --yes` completes
- the server binds to `0.0.0.0:3100` so host access works
- onboard/run banners and startup logs are visible in your terminal

Build + run:

```sh
./scripts/docker-onboard-smoke.sh
```

Open: `http://localhost:3131` (default smoke host port)

Useful overrides:

```sh
HOST_PORT=3200 PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
SMOKE_DETACH=true SMOKE_METADATA_FILE=/tmp/paperclip-smoke.env PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Notes:

- Persistent data is mounted at `./data/docker-onboard-smoke` by default.
- Container runtime user id defaults to your local `id -u` so the mounted data dir stays writable while avoiding root runtime.
- Smoke script defaults to `authenticated/private` mode so `HOST=0.0.0.0` can be exposed to the host.
- Smoke script defaults host port to `3131` to avoid conflicts with local Paperclip on `3100`.
- Smoke script also defaults `PAPERCLIP_PUBLIC_URL` to `http://localhost:<HOST_PORT>` so bootstrap invite URLs and auth callbacks use the reachable host port instead of the container's internal `3100`.
- In authenticated mode, the smoke script defaults `SMOKE_AUTO_BOOTSTRAP=true` and drives the real bootstrap path automatically: it signs up a real user, runs `paperclipai auth bootstrap-ceo` inside the container to mint a real bootstrap invite, accepts that invite over HTTP, and verifies board session access.
- Run the script in the foreground to watch the onboarding flow; stop with `Ctrl+C` after validation.
- Set `SMOKE_DETACH=true` to leave the container running for automation and optionally write shell-ready metadata to `SMOKE_METADATA_FILE`.
- Set `SMOKE_CONTAINER_NAME` to fix the container's name up front. Automation that has to collect diagnostics when the script *fails* needs a name it already knows, rather than one it can only read back out of a successful run. Defaults to the image name.
- The container's logs are dumped to `SMOKE_LOG_FILE` (default `$TMPDIR/<container name>.log`) before the script tears the container down, so a run that never became ready still leaves its logs behind.
- The image definition is in `docker/Dockerfile.onboard-smoke`.

## General Notes

- The `docker-entrypoint.sh` adjusts the container `node` user UID/GID at startup to match the values passed via `USER_UID`/`USER_GID`, avoiding permission issues on bind-mounted volumes.
- Before it drops privileges, the entrypoint makes sure `PAPERCLIP_HOME` is owned by the `node` user. Each boot checks only the home directory and its first three levels. The first boot (and any boot after a UID/GID change) also checks the full tree, and then writes `PAPERCLIP_HOME/.paperclip-ownership-verified`. While that marker is current, later boots skip the full-tree walk, which can take minutes on homes with many files. A mismatch triggers a recursive `chown`. If files deep in the tree get the wrong owner (for example, after a restore as root), delete the marker and restart to force a full check. If a check fails (for example, with an I/O error), the entrypoint does not write the marker, so the next boot checks again.
- The entrypoint writes timestamped lines when it starts, around the full ownership check or any repair (with the duration), and just before it starts the server, so you can measure the pre-start time from the container log.
- Paperclip data persists via Docker volumes/bind mounts (compose) or at `~/.local/share/paperclip` (quadlet).

## Native Runner build cache

The image compiles the native Runner once, in the `runner-artifacts-runnerd`
stage, with the package-owned Rust compiler, the release profile and locked
Cargo dependencies. That stage reads only the files Cargo reads.

Ordinary server, UI or Runner TypeScript changes can reuse the entire native
build through the existing registry cache (`mode=max`). A change to Rust
source, embedded protocol inputs, a dependency manifest, the Cargo lockfile or
the compiler compiles the daemon and its dependencies again. Each platform
gets its own native build; no cross-architecture binary is reused. No
additional GitHub Actions cache is created.

The `runner-artifacts-build` stage takes the build commit as an argument, so
every stamped build runs it: the frozen install, the Runner's TypeScript
build and the provider pack. Cargo finds the compiled daemon current there.

Cloud builds import one registry cache: the first available full-SHA cache in
the current commit's ten-entry first-parent ancestry, with the legacy cache
as a final fallback. Each build still exports its own SHA cache with
`mode=max`. In fresh-builder checks, importing several historical manifests
missed native layers that a single matching manifest reused. The selector
inspects metadata after Docker login, stops at the first available cache, and
permits a cold build if no cache can be read.

Rust input file times are normalized in both stages so fresh checkouts do not
force Cargo to rebuild unchanged source. The application build runs no Cargo
command. Cache misses only cost compilation time.
