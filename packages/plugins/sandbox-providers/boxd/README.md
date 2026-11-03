# `@paperclipai/plugin-boxd`

boxd sandbox provider for Paperclip. [boxd](https://boxd.sh) runs each sandbox
as an isolated KVM microVM. This package lives alongside E2B, Daytona and the
other sandbox providers, outside the root pnpm workspace. It uses the
[`@boxd-sh/sdk`](https://www.npmjs.com/package/@boxd-sh/sdk) package. The
package is not published yet; use a local-path install. Its release manifest
entry has `publishFromCi: false` until a maintainer bootstraps the first npm
publish.

## Build and install locally

Requires Node 24.11+, pnpm, and an installed Paperclip checkout.

```sh
cd packages/plugins/sandbox-providers/boxd
pnpm install --ignore-workspace --no-lockfile
pnpm typecheck
pnpm test
pnpm build
```

From the Paperclip checkout, with your instance running:

```sh
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin install /absolute/path/to/paperclip/packages/plugins/sandbox-providers/boxd
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin inspect paperclip.boxd-sandbox-provider
```

## Configure an environment

Configure boxd under **Instance Settings -> Environments**, not from the
plugin page. Select the `boxd` provider.

- `apiKey`: a boxd API key. Create one with
  `boxd auth keys create paperclip --org <org>`. Each key belongs to one org,
  and machines are created in that org. Paperclip saves a pasted key as a
  company secret. `BOXD_API_KEY` on the Paperclip host is an optional fallback
  when the environment has no key.
- `reuseLease`: default `false`. With `false`, the plugin deletes the machine
  when the run ends. With `true`, the plugin suspends the machine when the run
  ends, and the next run on the same issue resumes it. Disk, memory and running
  processes stay. The provider lease ID is the machine ID, so it stays the same
  across resumes.
- `snapshot`: optional snapshot name or ID. Each run restores this snapshot,
  for example a machine with your tools and repository already in place.
- `vcpu`: optional machine size for fresh machines: 1 vCPU/4 GB, 2/8 GB,
  4/16 GB or 8/32 GB. A blank value uses the org default. A snapshot keeps its
  own size.
- `org`: optional org name or ID. A blank value uses the API key's org.
- `namePrefix`: machine name prefix, `paperclip` by default.
- `timeoutMs`: default command timeout, 3600000 ms by default.

The default boxd image is Ubuntu 24.04 with Node 24, `tar`, `git`, Docker,
Claude Code, Codex and OpenCode on the PATH. It meets
[the sandbox runtime requirements](../SANDBOX-REQUIREMENTS.md) without a
setup step. Use a snapshot to add other agent CLIs.

The probe creates a machine, prepares the workspace and deletes the machine.
It uses real boxd resources. The probe machine also has a 15-minute boxd delete
timer, and a probe whose machine could not be deleted reports a failure.

## Implemented behavior

- Every machine is created with `isolated: true`. An isolated machine has no
  metadata endpoint, no in-VM `boxd` CLI and no boxd integrations, and other
  machines in the org cannot reach it over the private network. The API key
  stays in the plugin worker and never enters the machine.
- Machines carry the labels `paperclip-provider=boxd`,
  `paperclip-environment=<id>` and `paperclip-run=<id>`. Use
  `boxd machine list --label paperclip-provider=boxd` to find them.
- Commands run through `sh` in the workspace, with quoted arguments,
  per-command environment, staged stdin, and separate stdout and stderr. A
  command timeout ends the remote process group and returns `timedOut: true`.
- Stdin is staged with boxd's file API in a file only the machine user can
  read, and removed after the command. The workspace directory is created the
  same way. A machine whose boxd agent predates the file API, such as one
  restored from an older snapshot, falls back to the older upload and `mkdir`
  calls.
- A failed acquisition deletes its machine. If boxd cannot confirm the
  deletion, the plugin throws `PluginEnvironmentCreationCleanupError` with the
  machine ID, so the host records it and retries the teardown. The destroy hook
  checks that the machine's labels match before it deletes it.
- A command on a stopped machine starts the machine and runs the command one
  more time. A suspended or hibernated machine wakes on the command.
- Release deletes the machine and returns a receipt only after boxd no longer
  lists it. With `reuseLease`, release suspends the machine. A release that
  cancels active work stops the machine and keeps its disk.
- `onEnvironmentStopLease` stops the machine and keeps its disk.
  `onEnvironmentInspectLease` reads the machine state and does not change it.
- When the host requests a lease expiry, the plugin sets a boxd delete timer
  at or before that time and returns the expiry on the lease.
- The plugin keeps one SDK client for each API key, so commands do not
  exchange the key for a new session token each time.

## Capability boundaries

Interactive login PTYs, template capture, native file sync, persistent
sessions, incremental output, duplex channels and runner ingress are not
advertised. Workspace transfer uses the host's base64-over-exec fallback.
boxd has one region (EU), amd64 machines only, and no GPUs.

## Opt-in live tests

Default tests use a mocked SDK and do not contact boxd. To run against boxd,
export `BOXD_API_KEY` (and optionally `BOXD_ORG`), then run:

```sh
BOXD_LIVE_TEST=1 pnpm test
```

The live tests run every hook against boxd. They check:

- config validation, and a probe with a sized machine that deletes the machine
  afterwards (a bad API key returns a failed probe);
- the labels, the isolation and the org of an acquired machine;
- stdin, env, argument quoting, exit codes and stderr, and the removal of the
  staged stdin file;
- an empty stdin, and a staged stdin file that only the machine user can read;
- a 5 MiB round trip through the base64-over-exec path;
- that a command timeout returns `timedOut` and ends the remote processes;
- suspend and resume with a file and a running process kept, stop and resume
  with the file kept, and inspect in each state;
- a command on a stopped machine, which starts the machine and runs;
- resume and stop of a hibernated machine, stop of a suspended machine, and a
  release with `cancelActiveWork` or `stop_and_retain`;
- a release without reuse, which deletes the machine;
- a `requestedExpiresAt` that boxd enforces by deleting the machine;
- a run restored from a snapshot, and a fresh machine at the configured size;
- that resume after destroy reports an expired lease, and that no test
  machines are left.

Each test deletes its machines in `finally`. The tests print timings and no
credentials. A full run takes about two minutes.

## Optional managed-image inclusion

The bundled catalog key is `boxd`. Include the `boxd` directory in the Docker
`CLOUD_BUNDLED_PLUGINS` build argument, then include `boxd` in the managed
configuration's `plugins.autoInstall` list. The catalog entry does not
auto-install the plugin or change the default image.
