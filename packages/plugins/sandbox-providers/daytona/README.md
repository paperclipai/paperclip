# `@paperclipai/plugin-daytona`

Published Daytona sandbox provider plugin for Paperclip.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. That lets operators install it from the Plugins page by package name without introducing root lockfile churn for Daytona's SDK dependencies.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-daytona
```

The host plugin installer runs `npm install` into the managed plugin directory, so transitive dependencies such as `@daytonaio/sdk` are pulled in during installation.

## Configuration

Configure Daytona from `Instance Settings -> Environments`, not from the plugin's plugin page.

- Put the Daytona API key on the sandbox environment itself.
- When you save an environment, Paperclip stores pasted API keys as company secrets.
- `DAYTONA_API_KEY` remains an optional host-level fallback when an environment omits the key.
- Optional `apiUrl` and `target` settings map directly to the Daytona SDK/client configuration. If `apiUrl` is omitted, the Daytona SDK uses its default endpoint.

Notes:

- The current published Daytona SDK package is `@daytonaio/sdk`.
- The driver supports both `snapshot`-based and `image`-based sandbox creation. If both are set, validation rejects the config as ambiguous.
- Optional `ttlMinutes` sets a positive whole-minute wall-clock lifetime in the creation request. It applies to image and snapshot sandboxes, including probes and interactive setup. The driver requires the provider to confirm the expiry before it returns the sandbox. It preserves an earlier creation expiry when a caller supplies a later deadline. Daytona destroys the sandbox and its files at expiry, even while active, stopped, paused, or archived. Omit this setting to keep existing lifetime behavior. This is separate from inactivity cleanup.
- Each cold create uses a unique provider name and ownership labels. If creation fails after Daytona has allocated a sandbox, the driver looks up that exact name, checks every ownership label, and waits for deletion. Failed, missing, or timed-out lookups and failed deletions report unconfirmed cleanup with the provider name; they never return a usable lease. A missing name lookup after an uncertain create is not proof that a delayed provider request cannot create a resource.
- For plugin-backed sandbox lease acquisition, unresolved creation cleanup crosses the worker RPC as a validated ownership envelope. The host records `pending_cleanup` before retrying deletion. If only a creation name is known, the provider first returns an ownership-verified sandbox ID without deleting it. The host saves that observation before authorizing deletion. Its existing cleanup sweep and durable spool preserve retries across controller restarts and environment deletion. A missing observed ID confirms cleanup after a lost deletion reply or database update; a name that has never been observed remains unresolved. Provider exceptions and resolved credentials are excluded from that envelope. This requires the matching host and plugin SDK update; probe and custom-image interactive-setup calls still report unconfirmed immediate cleanup without this lease-recovery path.
- Reusable leases map to Daytona stop/start semantics. Non-reusable leases are deleted on release. A provider-resolved `target` does not change the identity of an existing sandbox. Release closes the same scoped lease that a later sentinel-verified resume reopens.
- Idle sleep tracks pending hooks, underlying provider requests, open terminals, and sandbox allocations. A successful stop or delete clears only that sandbox's company, environment, and account scope. Every sandbox deletion waits for completed remote destruction within its existing timeout; acceptance alone cannot clear idle evidence. A timeout does not settle the underlying request. Cleanup that overlaps other work on the same sandbox needs a later quiet stop/delete receipt or read-only observation of the exact stopped or missing sandbox. Proof is captured before the provider observation. Other work that starts or finishes before its reply invalidates that proof, even after the other request has settled. An unobserved creation name is never absence proof. Active resources and uncertain cleanup continue to prevent idle sleep; verified cleanup no longer blocks sleep for the worker's entire lifetime.
- A command that has already exited returns its final separated log snapshot without opening a follow socket. The initial status check is bounded to 500ms and the caller's command deadline. Each follow connection also makes up to four early status reads, with 25/50/100/200ms delays and the same observation/deadline bounds. A confirmed exit still requires the final separated snapshot, but does not wait for the follow socket to close. Unconfirmed or unavailable status keeps streaming; the early reads stop after their bounded attempt window. The command is dispatched only once.
- A session log socket can close while its command still runs. The driver requires a recorded command exit before returning a completed execution. It reconnects the log stream once, then polls status and log snapshots at most once per second. Replayed output is removed by byte offset, new output continues to reach the host, and the command is never dispatched again. A socket that delivers no output for 15 seconds switches directly to polling, even if the socket stays open or its initial connection never completes. Late callbacks from that socket are ignored. This recovers pending permission requests and cancellation results from saved output without replaying the command. Healthy initial and reconnected streams retain their existing lifetime under the caller’s RPC/run guard. After a clean close or an idle socket, each status or snapshot read gets a fresh operation timeout; successful recovery polling does not impose a new command lifetime. When both stream attempts fail without a clean close, fallback retains its original timeout budget starting after the stream attempts.
- The SDK returns full log snapshots, so fallback bandwidth grows with retained output; it has no paged snapshot or stream cancellation API. A recovery-read timeout keeps partial output and explicitly reports whether command exit remains unconfirmed; it does not prove the remote command stopped. Provider/session teardown remains responsible for closing an outstanding socket. A final snapshot reconciles bytes missed by the stream before returning a recorded exit.
- A sandbox record can survive the loss of its underlying container. Resume treats it as expired only when a fresh provider read confirms the exact missing-container error for that sandbox and marks it unrecoverable. Unknown errors and failed confirmation reads preserve the lease. The host still requires a verified native-runner backup before replacement.
- Directory export normally builds a sandbox archive and downloads it. If archive creation exhausts disk space, quota, or the file-size limit, export streams the archive through a raw terminal instead. Each bounded chunk waits for a host write acknowledgement. Import still requires successful tar completion and the existing archive/path validation. The total archive cannot exceed the provider-reported sandbox disk allocation, and each host write must leave a 1 GiB free-space reserve. This fallback writes no sandbox archive or command log, preserves source files, and retains the configured transfer timeout. Terminal cleanup has a separate five-second limit and cannot hold the host archive open. It requires Bash and GNU `tar`, `dd`, and `base64` in the sandbox. It does not repair a provider session that already failed to save its state or increase the sandbox's disk allocation.

## Local development

```bash
cd packages/plugins/sandbox-providers/daytona
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```

These commands assume the repo root has already been installed once so the local `@paperclipai/plugin-sdk` workspace package is available to the compiler during development.

The capacity regression uses Python 3 for a real local PTY, Bash, and GNU core
utilities (`gtar`, `gdd`, and `gbase64` on macOS). It skips when those prerequisites
are unavailable or their version checks do not match. With `DAYTONA_API_KEY` set, run
`pnpm test src/file-sync-capacity.live.test.ts` to exercise an actual stopped and
resumed Daytona sandbox, a tar write to `/dev/full`, validated export, and a
second export after reconnect. The test creates and deletes one disposable
1 GiB Ubuntu sandbox; it does not fill a disk or modify existing sandboxes.

## Package layout

- `src/manifest.ts` declares the sandbox-provider driver metadata
- `src/plugin.ts` implements the environment lifecycle hooks
- `paperclipPlugin.manifest` and `paperclipPlugin.worker` point the host at the built plugin entrypoints in `dist/`
