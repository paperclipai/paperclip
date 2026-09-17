# Experimental durable exe.dev environments

Enable **exe.dev Environments** in Instance → Experimental, install this bundled
plugin, and create a sandbox environment using **exe.dev VM (experimental)**.
Daytona remains the preferred Cloud default. Cloud installs this plugin only for
releases and stacks explicitly opted into `enableExeEnvironments` with `exe-dev`
selected in the release-validated bundled plugin list.

An environment owns one named VM. Each agent/workspace lease has a separate home,
working directory, socket, and systemd cgroup on that VM. Agents sharing a VM must
trust each other: these directories are not security boundaries. A VM cannot be
bound to two Paperclip companies or environments.

## Credentials and creation

Register an SSH public key with exe.dev; save its matching private key in a
Paperclip company secret using the environment form. Management commands and VM
execution both use SSH, so an exe.dev HTTPS API token is unnecessary. An operator
may instead configure an absolute `sshIdentityFile`, or use
`EXE_DEV_SSH_PRIVATE_KEY` / `EXE_DEV_SSH_KEY_FILE` on a self-hosted controller.
Credentials remain on the controller and are never forwarded to the VM.
For a private image registry, set `registryAuth` to a company secret containing
`username:token` (or `EXE_DEV_REGISTRY_AUTH` for the explicit live harness). exe.dev
uses this credential to pull the image; agent commands do not receive it.

- **Attach:** specify `vmName` for an existing compatible VM.
- **Create:** specify an immutable `image@sha256:…` published from
  `docker/exe-dev-runner/Dockerfile`. A stable name is derived from the company and
  environment unless `vmName` is supplied. Retrying an uncertain create reconciles
  that name. A connection test validates the account; the first run provisions
  and verifies the image. An attached VM is inspected without modification.

Arbitrary images and boot-time package installation are unsupported. The image
contains Node, systemd, the execution supervisor, the Rust runner, its matching
provider pack, and the supported legacy CLIs. Missing runtimes fail with an image
compatibility error. Existing 0.1 per-run configurations require explicit migration
to a compatible named VM; upgrading the plugin never deletes those old VMs.

SSH uses a dedicated identity, disables agent forwarding, and rejects changed
host keys. `accept-new` persists first-use keys in
`~/.ssh/paperclip-exe-known_hosts`. For preverified keys, supply `knownHosts` entries
for both `exe.dev` and the VM; this forces strict checking.

## Lifetime and concurrency

Normal release retains the VM and reusable lease. Cancellation or lease destruction
stops only that lease's cgroup, waits for confirmation, and leaves files intact.
An SSH disconnection is not a termination receipt. A requested lease deadline
limits its systemd service; it never deletes the VM. Controller restart reattaches
to the same VM identity and disk. Missing or replaced VMs fail closed and require
explicit recovery into a new environment.

The controller stores the resource identity in reserved environment metadata,
independently of run leases. Concurrent acquisitions must agree on that identity.
A durable marker on the VM detects replacement even if its DNS name is reused.
There is no automatic VM deletion, disk reclamation, or in-place image upgrade.
Disconnecting an environment retains its VM; delete it explicitly in exe.dev when
its data is no longer needed.

Reusable directories are scoped to the agent and project workspace, or to the
agent and task when no project workspace exists. Concurrent runs receive distinct
leases; a retained lease can be reused only after its previous run releases it.

Agent homes and workspaces live under `/var/lib/paperclip-exe/<scope>/<lease>/`.
Use the normal isolated-workspace policy for concurrent task work. Separate Git
worktrees avoid two agents modifying the same checkout. This feature does not add
a service registry or port allocator. Start a persistent web server as a separate
systemd service if it must survive agent cancellation; choose its port explicitly.

VM previews must remain private and use exe.dev's own HTTPS sharing/authentication.
Native runners connect outward to a reachable `PAPERCLIP_RUNNER_PUBLIC_URL=wss://…`.
Cloud derives this origin from the stack's canonical hostname. Paperclip does not
proxy exe.dev preview pages.

## Files and backups

The first run seeds the remote workspace. Later runs adopt its persisted files;
legacy initialization is marked only after a successful seed. Completion uses the
existing baseline-based Git/file copyback pipeline. Unrelated host edits survive,
but a changed remote file takes precedence when the same file also changed on the
host. Use isolated worktrees for concurrent editing; this is not a conflict merge.
Native runs additionally use
the existing verified harness/session checkpoint and restart-recovery contract.
OpenCode checkpoints preserve its session database and history while excluding
disposable launch homes (including npm caches),
regenerated configuration (including launch credentials and npm executable
aliases) and caches. Codex launch credentials and scratch aliases are also excluded.
The existing exclusions still apply, including dependencies, generated/cache
folders, ignored files, and runtime scratch.

This is the same backup coverage as Daytona, not a disk image or continuous mirror
into object storage. In Cloud, copyback and native checkpoints under `PAPERCLIP_HOME`
land on the tenant's persistent volume, which has daily/weekly/monthly provider
backups. Explicitly uploaded artifacts use the separate object-storage path.
Files outside copied paths, live process memory, database consistency, ignored
files, and VM-wide state are not included. A controller filesystem outside the
backed-up volume needs its own backup policy. Restore is explicit and must be tested
against the data classes the application actually needs.

## Build and verification

```sh
pnpm --dir packages/plugins/sandbox-providers/exe-dev install --ignore-workspace
pnpm --dir packages/plugins/sandbox-providers/exe-dev build
pnpm --dir packages/plugins/sandbox-providers/exe-dev test
node cli/node_modules/tsx/dist/cli.mjs scripts/build-exe-dev-image.ts --push --metadata-file /tmp/exe-image.json
```

The manual **Experimental exe.dev image** workflow publishes a content-addressed
Linux amd64 image and an immutable digest artifact. Production builds require a
clean checkout and frozen dependencies. `PAPERCLIP_IMAGE_ALLOW_DIRTY=1` is only for
explicit local development builds.

Run the explicit paid browser matrix and provider stress campaign:

```sh
pnpm test:e2e:runner -- --suite exe-compatibility
pnpm test:e2e:runner -- --suite exe-recovery
pnpm test:e2e:runner -- --suite exe-warm-continuity
EXE_DEV_LIVE_SMOKE=1 node cli/node_modules/tsx/dist/cli.mjs tests/exe-dev-live/stress.ts
```

Both require `EXE_DEV_SSH_PRIVATE_KEY` and `PAPERCLIP_E2E_EXE_IMAGE`; browser cells
also require their model credentials. Native browser cells need an externally
reachable WSS origin. Native OpenCode/ACPX also require
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` pointing to a build-owned Linux amd64
provider pack on the controller. The Cloud image builds and configures this pack;
self-hosted controllers must export `/opt/paperclip-runner/provider-pack` from the
matching exe image and configure its local path (including on macOS). Never use a
macOS provider pack for a Linux VM. For local testing, set `PAPERCLIP_E2E_RUNNER_TUNNEL_BIN` to an
installed `cloudflared` binary. The harness exposes only authenticated runner
WebSocket upgrades; all ordinary HTTP requests and board API paths return 404.
The matrix has seven profiles × three workflows. Stress
covers eight shared leases, concurrent commands, UTF-8/stdin, copyback, restart,
SSH loss, VM reboot, large output, escaped descendant cancellation, timeout,
cancellation isolation, and a separate private HTTP service. Set
`EXE_DEV_SOAK_MS` for an explicit idle soak. Campaign cleanup deletes only
campaign-owned VMs; production provider hooks never delete VMs.

The native Codex message cell additionally runs two native and one legacy agent
concurrently on its VM and checks distinct homes/workspaces. The four-cell
recovery suite covers structured question/resume with and without a controller
restart for legacy and native Codex. The two-cell warm suite checks three turns
on one workspace and stable native runner/process/session identity.
For longer campaigns, accountless Cloudflare tunnels can rate-limit new endpoints.
Use a single operator-owned WSS relay instead: run `tests/exe-dev-live/relay.ts`
with `PAPERCLIP_E2E_RUNNER_RELAY_REGISTRY` set to a private local directory, and
forward its loopback listener through a TLS endpoint. Set the same registry path
and `PAPERCLIP_E2E_RUNNER_RELAY_URL=wss://your-relay.example` in the E2E process.
Each harness registers its own random route and removes it on shutdown. The relay
forwards only registered runner WebSocket upgrades, retains the runner's capability
authentication, and returns 404 for ordinary HTTP and board APIs. Its TLS/SSH
endpoint is test infrastructure and must be removed after qualification.

`tests/exe-dev-live/preview.ts` provides an
interactive private Vite fixture with `create`, `cancel`, `edit`, and `cleanup`
commands; it deliberately keeps its VM until cleanup so a signed-in browser can
verify HMR and an idle soak.
