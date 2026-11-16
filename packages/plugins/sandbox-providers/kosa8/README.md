# `@paperclipai/plugin-kosa8`

kosa8 sandbox provider for Paperclip. [kosa8](https://kosa8.com) runs each
sandbox as a microVM with its own kernel. This package lives alongside E2B,
Daytona, boxd and the other sandbox providers, outside the root pnpm workspace.
It calls the kosa8 Cloud REST API (`https://api.kosa8.com`) with `fetch` and has
no runtime dependencies. Paperclip's CI release pipeline publishes this plugin
to npm.

## Install from npm

Once a stable release is available, install the package from the Plugins page
by name, or use the CLI:

```sh
paperclipai plugin install @paperclipai/plugin-kosa8
```

Before the first stable release, the `latest` tag can still point to the
`0.0.0` bootstrap placeholder. That version reserves the package name and has
no plugin functionality. Check the published tags and choose a real release:

```sh
npm view @paperclipai/plugin-kosa8 dist-tags --json
paperclipai plugin install @paperclipai/plugin-kosa8 --version <published-version>
```

Replace `<published-version>` with the version shown for the desired tag, such
as `canary`. If no real release is available yet, use the local-path install
below. See the [publishing guide](../../../../doc/PUBLISHING.md) for the release
and bootstrap process.

## Build and install locally

Requires Node 24.11+, pnpm, and an installed Paperclip checkout.

```sh
cd packages/plugins/sandbox-providers/kosa8
pnpm install --ignore-workspace --no-lockfile
pnpm typecheck
pnpm test
pnpm build
```

From the Paperclip checkout, with your instance running:

```sh
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin install /absolute/path/to/paperclip/packages/plugins/sandbox-providers/kosa8
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin inspect paperclip.kosa8-sandbox-provider
```

## Configure an environment

Configure kosa8 under **Instance Settings -> Environments**, not from the
plugin page. Select the `kosa8` provider.

- `apiKey`: a kosa8 Cloud API key (`k8c_live_...`). Create one at
  https://app.kosa8.com. Each key belongs to one organization, and sandboxes
  are created in that organization. Paperclip saves a pasted key as a company
  secret. `KOSA8_API_KEY` on the Paperclip host is an optional fallback when
  the environment has no key.
- `reuseLease`: default `false`. With `false`, the plugin deletes the sandbox
  when the run ends. With `true`, the plugin puts the sandbox to sleep when the
  run ends, and the next run on the same issue wakes it. Disk, memory and
  running processes stay. The provider lease ID is the sandbox ID, so it stays
  the same across sleep and wake.
- `size`: `2x4` (default), `4x8`, `8x16` or `16x32`, as vCPU x GiB.
- `image`: optional OCI image. A blank value uses the kosa8 universal image
  (Ubuntu 24.04 with Node, Python, Go, `git`, `tar` and the common agent CLIs).
- `template`: optional kosa8 template key or kosa8 Store item. It keeps its own
  size and image.
- `snapshot`: optional snapshot ID (`snap_...`). Each run starts from this
  snapshot, for example a sandbox with your tools and repository in place. Take
  the snapshot from a persistent sandbox.
- `region`: optional region ID, such as `us-ash1` or `eu-hel1`.
- `egressAllow`: optional comma-separated hosts or CIDRs that the sandbox can
  reach. kosa8 enforces the list on the host and refuses all other outbound
  traffic. Include the API hosts of the agent CLIs that the run uses.
- `apiUrl`: optional API URL, for a self-hosted kosa8 Cloud control plane.
  `KOSA8_API_URL` on the Paperclip host is a fallback. The URL must use https,
  except for localhost.
- `namePrefix`: sandbox name prefix, `paperclip` by default.
- `timeoutMs`: default command timeout, 3600000 ms by default.

Sandboxes are created with `persistent: true`, so every command runs in the one
long-lived container of the sandbox. The home directory, installed packages and
background processes stay between commands. The default image meets
[the sandbox runtime requirements](../SANDBOX-REQUIREMENTS.md) without a setup
step.

The probe creates a sandbox with a 15-minute lifetime, prepares the workspace,
checks that `sh`, `tar` and `node` are on the PATH, and deletes the sandbox. It
uses real kosa8 resources. A probe whose sandbox could not be deleted reports a
failure.

## Implemented behavior

- Each sandbox is a separate microVM with its own kernel. The API key stays in
  the plugin worker and never enters the sandbox. kosa8 Cloud mounts no host
  path into a sandbox, and the sandbox holds no credential for the kosa8 API.
  The workspace and the staging directory are on the sandbox's own disk.
- Sandboxes carry the labels `paperclip-provider=kosa8`,
  `paperclip-environment=<id>` and `paperclip-run=<id>`. Use
  `GET /v1/sandboxes?label=paperclip-provider=kosa8` to find them.
- Commands run through `sh` in the workspace (`/workspace/paperclip-workspace`
  by default), with quoted arguments, per-command environment, stdin, and
  separate stdout and stderr. The command script and stdin go to the sandbox in
  environment variables of the exec request, not in its command line, so the
  kosa8 command log does not record them. Larger payloads go in 45 KB chunks.
  Each command uses a private directory under `/tmp/paperclip-kosa8` (mode 700),
  and the plugin removes it after the command.
- A command with a timeout of 85 s or less runs as one buffered exec request.
  A longer command runs as a kosa8 background command with `timeout_s`, and the
  plugin polls its state. Output larger than 600 KB is read back in chunks, so
  no output is lost. A timeout returns `timedOut: true`, and kosa8 ends the
  process group of the command (exit 143). On an older host that has no
  `timeout_s` or no stop for background commands, the plugin ends the process
  group itself. If the plugin cannot stop a command after a timeout, the
  command fails with an error and the plugin keeps it in its list of active
  commands.
- A command on a sleeping sandbox wakes it.
- A failed acquisition deletes its sandbox. If kosa8 cannot confirm the
  deletion, the plugin throws `PluginEnvironmentCreationCleanupError` with the
  sandbox ID, so the host records it and retries the teardown. The destroy hook
  checks that the sandbox's labels match before it deletes it.
- Release deletes the sandbox and returns a receipt only after kosa8 no longer
  lists it. With `reuseLease`, release puts the sandbox to sleep. Before a sleep,
  the plugin refuses new commands on the sandbox, stops the commands that it
  started, and waits until each command call ends. Then it puts the sandbox to
  sleep, so no output read wakes the sandbox again. If the sleep fails, the
  plugin deletes the sandbox.
- If an upload of a large script or stdin fails, the plugin removes the
  uploaded parts before it reports the error.
- `onEnvironmentStopLease` and `stop_and_retain` put the sandbox to sleep and
  return a `stopped` receipt after kosa8 reports the `sleeping` state.
  `onEnvironmentInspectLease` reads the sandbox state and does not change it.
- When the host requests a lease expiry, the plugin creates the sandbox with
  `delete_after` 5 s before that time and returns the expiry on the lease. kosa8
  needs the expiry to be at least 65 s away.

## Capability boundaries

Interactive login PTYs, template capture, native file sync, persistent
sessions, incremental output, duplex channels and runner ingress are not
advertised. Workspace transfer uses the host's base64-over-exec fallback.
`commandTimeoutMs` is not used. A process that the agent detaches from its
process group is not stopped by a release that cancels active work; the sleep
freezes it, and a later wake continues it.

## Opt-in live tests

Default tests use a fake kosa8 API that runs each command in a local shell, and
they do not contact kosa8. To run against kosa8 Cloud, export `KOSA8_API_KEY`
(and optionally `KOSA8_API_URL` or `KOSA8_SIZE`), then run:

```sh
KOSA8_LIVE_TEST=1 pnpm test
```

The live tests check:

- config validation, and a probe that deletes its sandbox (a bad API key
  returns a failed probe);
- stdin, env, the working directory, exit codes and stderr, and the agent tools
  on the PATH;
- a 2 MiB stdin and stdout round trip (the SHA-256 matches);
- a long command, and a buffered and a background timeout;
- sleep and wake with a file and a running process kept, and a sleep for
  `stop_and_retain`;
- a release without reuse, which deletes the sandbox, and a
  `requestedExpiresAt` lease;
- that resume after destroy reports an expired lease, and that no test
  sandboxes are left.

Each test deletes its sandboxes in `finally`. The tests print timings and no
credentials.

## Optional managed-image inclusion

The bundled catalog key is `kosa8`. Include the `kosa8` directory in the Docker
`CLOUD_BUNDLED_PLUGINS` build argument, then include `kosa8` in the managed
configuration's `plugins.autoInstall` list. The catalog entry does not
auto-install the plugin or change the default image.
