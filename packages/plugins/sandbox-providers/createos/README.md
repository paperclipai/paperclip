# `@paperclipai/plugin-createos`

CreateOS sandbox provider for Paperclip. This package lives alongside Daytona
and E2B, outside the root pnpm workspace, and uses CreateOS's public HTTP API.
No CreateOS SDK dependency is required; the `tar` library handles local archives. The package has not been published as
part of this change; use a local-path install for development.

## Build and install locally

Requires Node 24.11+, pnpm, and an installed Paperclip checkout.

```sh
cd packages/plugins/sandbox-providers/createos
pnpm install --ignore-workspace --no-lockfile
pnpm typecheck
pnpm test
pnpm build
```

From the Paperclip checkout, with your instance running:

```sh
pnpm paperclipai plugin install /absolute/path/to/paperclip/packages/plugins/sandbox-providers/createos
pnpm paperclipai plugin list
pnpm paperclipai plugin inspect paperclip.createos-sandbox-provider
```

Rebuild after source changes; local plugin output watching reloads the worker.
If the running worker still uses the previous build, explicitly reload it when
no sandbox commands are active:

```sh
pnpm paperclipai plugin disable paperclip.createos-sandbox-provider
pnpm paperclipai plugin enable paperclip.createos-sandbox-provider
```

The plugin uses the same package entrypoints and publish manifest helper as
other sandbox providers. Plugin workers are trusted code on the Paperclip host.

## Configure an environment

Configure the provider under **Instance Settings → Environments**. The plugin
has no custom UI. Required fields:

- `apiUrl`: defaults to `https://api.sb.createos.sh`. A trailing `/v1`
  is accepted and normalized. HTTPS is required except on loopback for testing.
- `shape`: choose from the dropdown of published CreateOS shapes. The bundled
  choices match `https://api.sb.createos.sh/v1/shapes` as of 2026-09-08.
- `apiKey`: your CreateOS key. Paperclip saves pasted keys as company secrets;
  a resolved environment key takes precedence over the optional host fallback
  `CREATEOS_API_KEY`.

Optional fields:

- `rootfs`: a rootfs catalog entry or a ready template ID/name; omission uses
  the provider default. The image must include `/bin/bash`, ordinary Unix
  utilities including `tar`, `base64`, and GNU `realpath` (`-m` support), and the selected adapter's runtime
  dependencies (such as Node and Git). The generic runtime provisions/stages
  agent assets; this plugin does not build an agent image.
- `region`: must match the API endpoint. Omission uses the provider default.
- `timeoutMs`: operation/default command deadline, 300000 ms by default. This
  is **not** a sandbox TTL.
- `reuseLease`: default false. False deletes on release; true waits for pause
  completion and later resumes the same sandbox, preserving workspace data.

The probe creates a sandbox, prepares its workspace, executes a managed
command, and deletes the sandbox. It therefore uses real provider resources.

## Implemented behavior

- Company/environment-bound lease metadata and a random workspace marker
  checked before a resumed lease is trusted. API keys are not lease metadata.
- State-aware pause/resume with bounded polling. Transient errors are surfaced;
  only missing/terminal sandboxes or a mismatched workspace expire a resume.
- Managed pipe processes with explicit working directory, quoted arguments,
  per-command environment, staged stdin, and separate stdout/stderr.
  Per-command variables are applied by the command wrapper; CreateOS's API-level
  environment overrides only accept keys declared at sandbox creation.
- Incremental output via replayable NDJSON, bounded reconnect attempts, UTF-8
  decoding across frame boundaries, and explicit errors for missing output.
  Returned stdout/stderr each retain at most 4 Mi characters of tail output;
  `metadata.outputTruncated` reports truncation. Live log chunks are still
  delivered as they arrive.
- API requests to each endpoint are spaced by at least 300 ms across this
  worker's leases, keeping callback polling below the provider's 300/minute
  IP limit. Other workers or applications sharing the same IP can still
  exhaust that shared limit.
- Command timeout and active lease-release/shutdown cancellation explicitly
  terminate the process tree. Disconnecting the stream alone is not cancellation.
  Unknown process-creation outcomes and failed process cleanup prevent reuse
  in the current worker; the operator/host must destroy the affected lease.
  No automatic retry of process creation or command execution occurs.
- Workspace realization at `/paperclip-workspace` and native binary file sync,
  including directory archives, file modes, exclusions, symlink containment,
  atomic file downloads, and ordered post-upload commands. This keeps bulk data
  out of CreateOS's 1 MiB managed-process output journal. Ordinary command
  output still uses that journal and fails explicitly if unread data is evicted.
  Outbound archives are validated before extraction and limited to 10 GiB of
  declared file data; absolute/traversing paths and escaping links are rejected.

## Capability boundaries

Interactive login PTYs, temporary login leases, snapshot capture,
duplex channels, and provider WebSocket ingress are not advertised.
CreateOS idle auto-pause is not a guaranteed absolute expiry, so acquisition
with `requestedExpiresAt` fails before provisioning a resource.

The host has an outbound-WSS native runner path for providers without ingress.
Using it additionally requires a reachable Paperclip runner endpoint and the
host's qualified runner/provider artifacts. This plugin's local tests do not
constitute an end-to-end native runner qualification.

Sandbox create has no idempotency key in the inspected API. If its response is
lost before an ID arrives, the plugin cannot identify that resource for cleanup;
inspect the provider account before retrying an ambiguous creation. A plugin
crash also loses its in-memory command tracking; durable lease recovery remains
host-owned. This version does not claim a provider-side expiration guarantee.

## Opt-in live smoke

Default tests use mocked HTTP responses and do not contact CreateOS. To test a
chosen endpoint, export `CREATEOS_API_URL`, `CREATEOS_API_KEY`, `CREATEOS_SHAPE`,
and optionally `CREATEOS_ROOTFS`, then run:

```sh
CREATEOS_LIVE_TEST=1 pnpm test
```

The live test creates a sandbox, round-trips a 5 MiB binary file through native
sync, checks stdin/env/output, writes a file, pauses
and resumes the sandbox, verifies the file, and deletes it in `finally`.
It does not print credentials. Cleanup errors fail the test.

## Optional managed-image inclusion

The bundled catalog key is `createos`. Include the `createos` directory in the
Docker `CLOUD_BUNDLED_PLUGINS` build argument, then include `createos` in the
managed configuration's `plugins.autoInstall` list. Adding the catalog entry
does not auto-install the plugin or change the default image contents.
