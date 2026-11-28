---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DB_BACKUP_DIR` | (instance config `database.backup.dir`) | Output directory for automated database backups. Home-aware (`~/...` expands). Commonly paired with `PAPERCLIP_DB_BACKUP_REQUIRE_MOUNTED=true` when the directory lives on a dedicated backup volume. |
| `PAPERCLIP_DB_BACKUP_REQUIRE_MOUNTED` | `false` | When `true`, each database backup refuses to run unless `PAPERCLIP_DB_BACKUP_DIR` (or the configured backup dir) is a mount point — its device differs from its parent's. Prevents a lost backup volume from being silently recreated on the root filesystem by the recursive backup `mkdir`, which would refill the primary disk. Pair with a systemd `ExecStartPre=/usr/bin/mountpoint -q <dir>` service guard for start-time enforcement. |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |
| `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` | (board public origin) | Optional HTTPS origin for native chat provider webhooks when ingress and the board use different hosts. Must have no credentials, path, query, or fragment; invalid configuration refuses startup. Used only for provider callback URLs, not board links, authentication, trusted hosts, or identity confirmation. In `authenticated` mode with `private` exposure, also add the ingress hostname to `PAPERCLIP_ALLOWED_HOSTNAMES`. Otherwise the private-hostname guard rejects provider callbacks with 403 before they reach the webhook route. The guard reads `X-Forwarded-Host` before `Host`, so a reverse proxy that rewrites `Host` but forwards the original `X-Forwarded-Host` still gets 403. |
| `PAPERCLIP_RUNNER_PUBLIC_URL` | (unset) | Explicit `wss://` base URL used only when a remote `paperclip_runner` target dials Paperclip directly. Paperclip appends `/api/runner/v1/connect/<runId>`; the reverse proxy must forward WebSocket upgrades for that route. This value is never inferred from request headers. Daytona ignores it and uses provider ingress. |
| `PAPERCLIP_RUNNER_CA_BUNDLE_PATH` | (unset) | Optional PEM CA bundle for direct runner WSS. Platform roots remain enabled. There is no insecure TLS bypass. |
| `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` | (host build) | Host-local path to a `paperclip-runnerd` artifact built for the remote target OS and architecture. Required when Paperclip and the remote sandbox do not share a compatible platform; build metadata and the required transport mode are verified before launch. When the sandbox image already has a `paperclip-runnerd` with the same SHA-256, Paperclip uses that copy and does not upload this file. |
| `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH` | (unset) | Optional host-local path to a Codex executable built for the remote target OS and architecture. For remote Codex-backed runners, Paperclip stages and verifies this executable beside `paperclip-runnerd`. |
| `PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC` | (unset) | Optional pinned npm package spec (for example, `@openai/codex@0.170.0`) installed inside each fresh remote lease when its Codex harness is not baked into the sandbox image. Mutually exclusive with `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH`; Paperclip verifies the installed executable before starting `runnerd`. |
| `PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` | `/opt/paperclip-runner/provider-pack` in Docker; otherwise unset | Host-local path to the immutable provider pack built by `pnpm --filter @paperclipai/paperclip-runner build:provider-pack`. Stamped standard Docker images include the pack; downstream compositions and the `cloud` target inherit it. Unstamped local Docker builds skip pack generation. The pack includes its target-built Node 24.11+ runtime, locked production dependencies, OpenCode proxy/executable, and ACPX sidecar. Remote OpenCode and ACPX fail closed without it. A preinstalled pack is accepted only when its complete digested manifest matches this build-owned pack; otherwise Paperclip stages this pack into the sandbox. |
| `PAPERCLIP_HIDDEN_SETTINGS` | (unset) | Comma-separated settings surfaces to hide from the UI and floor at the API, for operators hosting Paperclip for others (managed cloud, internal shared server). See [Hiding settings surfaces](#hiding-settings-surfaces). |
| `PAPERCLIP_SETTING_DEFAULTS` | (unset) | JSON object replacing the schema default of selected instance settings, for hosting operators. See [Operator setting defaults](#operator-setting-defaults). |
| `PAPERCLIP_DEBUG_WORK_SIGNALS` | (unset) | Diagnostic only. Comma-separated allowlist of work-signal topics, each optionally followed by `:N` (for example `stranded-assignments:10,run-dispatch`). For each listed topic the server writes JSON lines to stderr: every work signal (topic and hint), with the caller stack on one signal in N (default 20); remote and reconnect notifications; direct settled publishes; and the recovery queues' loads, checks and direct wakes (direct wakes always carry the caller stack). Logged values are internal ids only (company, issue, run), never secrets or user identifiers. Stack frames keep their raw file and line positions, so bundled builds map them offline with that build's source map. Each topic and event pair is capped at 10 lines per second; a `suppressed` line names the dropped event and its count. The value is read once at startup, so enabling or changing it requires a restart. Unset or empty disables it completely. |
| `PAPERCLIP_MANAGED_CONFIG` | (unset) | Trusted deployment configuration for managed features, plugins and environments. See [Managed sandbox reconciliation](#managed-sandbox-reconciliation). |

Daytona connectivity for `paperclip_runner` uses authenticated provider
WebSocket ingress and follows the instance experimental setting
`enableNativeRunner` (default `false`). There is no separate ingress opt-in.
Disabling Paperclip Runner blocks fresh native starts while persisted native
runs retain their recovery path. The deprecated `enableRunnerPreviewIngress`
key remains accepted in stored and managed configuration for version-skew
compatibility, but it has no runtime effect. The setting has no effect on
legacy adapters or callback bridges.

### Webhook-only chat ingress

Keep `PAPERCLIP_PUBLIC_URL` (or the explicit authentication public URL) pointed
at the actual board. If the board is private, set
`PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL=https://chat-ingress.example.com` and forward
only `POST /api/chat-webhooks/*` from that host. Provider signatures still gate
ingress; this variable does not expose routes or grant provider access.
Never forward the private `local_trusted` board through a public tunnel.

In Paperclip Cloud, chat callback URLs and account-linking URLs follow the
instance's signed canonical origin after a warm instance is claimed, without
requiring a restart. An explicit `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` still takes
precedence for provider callbacks only; board links follow the claimed origin.
Existing provider-side callback settings must be updated if they were created
with an old URL.

Task links in external messages require an externally safe HTTPS board URL.
Local/private board URLs are omitted with instructions to open the task in
Paperclip; the public webhook host is never substituted for the board. Identity
confirmation stays on the board and requires the user to be able to reach it.

### Preinstalled remote runner images

Remote sandbox images may preinstall `paperclip-runnerd`, `codex`, and the
provider pack at `/opt/paperclip-runner/provider-pack` instead of
paying the upload and npm-install cost on every fresh lease. Put both executable
names on the sandbox user's `PATH`; `$HOME/.local/bin` is checked explicitly
before `PATH`. Paperclip verifies runner build metadata, the selected PRP
transport capability, Codex startup, the provider-pack digest, exact harness
pins, Node compatibility, and packaged bridge digests before linking artifacts
into the run-specific runtime directory. A missing or incompatible executable falls back
to `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` and
`PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC` (or
`PAPERCLIP_RUNNER_REMOTE_CODEX_PATH`) without changing the selected transport.
OpenCode and ACPX instead fall back only to
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`; they never start a provider
process on the Paperclip host for a remote target.
The Daytona environment editor's **Configure image** action can create this
image without a separate container registry: install the executables in its
setup sandbox, finish setup, and Paperclip captures and promotes the resulting
Daytona snapshot for future leases.

### Hiding settings surfaces

`PAPERCLIP_HIDDEN_SETTINGS` takes keys from the registry in
`packages/shared/src/settings-visibility.ts`:

- Any instance settings page: `instance.profile`, `instance.environments`,
  `instance.access`, `instance.experimental`,
  `instance.plugins`, `instance.adapters` — removed from navigation and
  routing (the General page is the settings root and stays visible). Hiding
  `instance.access`, `instance.plugins`, or `instance.adapters` also floors
  their management endpoints with `403 settings_operator_managed`; hiding
  `instance.experimental` floors every experimental toggle write.
- Any Instance → General section: `instance.general.censorUsernameInLogs`,
  `instance.general.backupRetention`,
  `instance.general.feedbackDataSharingPreference` (each also rejects
  value-changing writes via `PATCH /api/instance/settings/general`), plus the
  UI-only `instance.general.deploymentStatus` and `instance.general.signOut`.
- Any experimental toggle: `instance.experimental.<flagKey>` (e.g.
  `instance.experimental.enableSmokeLab`) — the card disappears and
  value-changing writes are rejected.
- All current and future experimental toggles: `instance.experimental.*`.
  Add `!instance.experimental.<flagKey>` entries to leave specific controls
  available. The server expands this policy against its own feature catalog,
  so new toggles stay hidden without an environment change. The Experimental
  page remains available. Exceptions only apply to the wildcard; an explicit
  hidden toggle or `instance.experimental` page restriction always wins,
  regardless of entry order. Unknown exceptions are logged and ignored.
- Any top-level company settings page: `company.members`, `company.invites`,
  `company.secrets`, `company.export`, `company.import` — removed from the
  settings sidebar, tab bar, and routing (the company General page is the
  settings root and stays visible). These are UI-visibility keys: the
  membership, invite, secret, and export APIs stay live for agents and
  integrations. `company.import` is the exception — hiding it also floors
  every company-import route with `403 settings_operator_managed`. On
  cloud-managed instances import is floored unconditionally with
  `403 cloud_managed`, independent of this variable.
- A single tab of the Secrets page: `company.secrets.vaults` (Provider
  vaults) and `company.secrets.proposals` (Proposals) — the tab disappears
  while the rest of the page stays up. UI-visibility only; the secret
  provider-config and proposal APIs stay live for agents and integrations.

- `workspaces.isolation` hides project execution-workspace policy, task and
  routine workspace selectors, pipeline workspace overrides, isolated re-issue
  actions, and the execution-workspace Configuration tab (including direct
  links). Workspace navigation, files, status, and runtime access stay available.
  This key only controls UI visibility: it does not disable isolation, change
  saved policies, or block APIs used by agents. New tasks and routine runs omit
  hidden draft overrides so the server applies the existing defaults. Tasks
  launched from a workspace or parent task keep that explicit context. Hide the two
  experimental isolation toggles separately when the operator manages them.

Unknown keys are logged and ignored, so one list can be rolled across a fleet
of mixed app versions, and retired keys (like `instance.heartbeats`, whose
page was removed) can stay in an operator list without breaking older or
newer releases. With the variable unset nothing is hidden and behavior
is identical to earlier releases. Hiding a toggle does not change its value;
pair hiding with the desired default where it matters (for general settings,
see [Operator setting defaults](#operator-setting-defaults)).

For example, this allows only the Environments control and keeps the Plugins
settings page hidden:

```sh
PAPERCLIP_HIDDEN_SETTINGS='instance.plugins,instance.experimental.*,!instance.experimental.enableEnvironments'
```

`GET /api/health` returns the expanded concrete keys in `hiddenSettings`.
The UI and settings API use the same restrictions. Reads and same-value
echoes remain allowed; changing a hidden value returns
`403 settings_operator_managed`.

Older images that predate wildcard support ignore the wildcard and exceptions.
Keep their explicit hidden-toggle entries during an upgrade, or upgrade all
images before replacing an explicit list. Once every image supports this
syntax, the wildcard and its exceptions are sufficient. A recognized exception
without a wildcard has no effect.

### Operator setting defaults

`PAPERCLIP_SETTING_DEFAULTS` takes a JSON object whose fields come from the
registry in `packages/shared/src/setting-defaults.ts` (currently
`feedbackDataSharingPreference`). The operator value substitutes for the
schema default at read time: any field whose effective value is still the
schema default resolves to the operator value, while an explicit non-default
user choice always wins. The overlay is never persisted, so unsetting the
variable restores stock behavior wherever a user has not chosen otherwise.
A client that writes back the full settings object it read does not persist
the operator value either: writing the operator value over a still-unchosen
field is treated as an echo of the overlay and the field stays unchosen.

Example: `PAPERCLIP_SETTING_DEFAULTS='{"feedbackDataSharingPreference":"allowed"}'`
defaults AI feedback sharing to allowed; pairing it with
`instance.general.feedbackDataSharingPreference` in `PAPERCLIP_HIDDEN_SETTINGS`
also hides the control and floors value-changing writes.

Unknown field names are logged and ignored (mixed-version fleet safe).
Malformed JSON or an invalid value for a known field refuses startup — policy
configuration fails closed.

### Managed sandbox reconciliation

Managed-config sandbox declarations reconcile the instance's Paperclip-marked
environment after its provider plugin becomes ready. Platform-owned stock can
advance before the first company exists; company-scoped stock bindings are
initialized when companies appear. This includes legacy marked rows that have
no stock baseline. Ordinary self-hosted reconciliation continues to preserve
operator modifications.

The internal `platformFullyManaged` assertion is reserved for deployment callers
that prevent operator edits. Other callers of `ensureManagedSandboxEnvironment`
leave it unset. Platform reconciliation requires the row's existing
`managedByPaperclip` ownership marker even when company bindings exist: a
tracking binding recorded for a skipped tenant-created row never authorizes
adopting it. Archived rows require a matching stock binding that records both
the archive status and Paperclip's archive token before automatic reactivation.
A token on the environment row alone is insufficient. An operator save removes
that token when reaffirming an archive. An archived row without a corroborating
binding stays preserved for individual operator review, including when it was
archived before the first company existed. Later tracking-only bindings do not
authorize its reactivation.

Re-running reconciliation with the desired declaration repairs stale managed
stock in place and is idempotent. It preserves environment identity, tenant
environment variables and unrelated metadata, and does not replace running
provider leases. Existing workspaces can therefore receive a separately
scheduled reconciliation rather than deleting their environments or leases.
An unmarked environment holding the declared name remains untouched. A
deliberately archived row remains archived; only Paperclip's own availability
archive can reactivate automatically.

Inspect the reconciliation's `action`, `stockStatus` and `updateAvailable`
outcomes when verifying an update. Writing the desired configuration or seeing
healthy HTTP responses alone does not prove that a database environment row
converged. Entry failures and skipped stock updates are logged while startup
continues degraded. Validate repeated empty-instance boots and the actual row
in deployment qualification; do not turn a performance check into a startup gate.

### Qualify a sandbox runtime before deployment

The image includes `/app/server/dist/qualify-sandbox-runtime.js`. Deployment
systems can run it without a database, network access or provider credentials:

```sh
node /app/server/dist/qualify-sandbox-runtime.js \
  --manifest /opt/paperclip-runner/provider-pack/provider-pack.json \
  --runner /app/packages/paperclip-runner/dist/bin/paperclip-runnerd < installed.json
```

The input has `installed` (`manifest`, hexadecimal `runnerSha256`, and `immutable`)
and an optional nonempty `providers` list (`{ "kind": "opencode" }` or
`{ "kind": "acpx", "agent": "claude" }`, for example). The deployment system
chooses its provider list. Omit the list to check OpenCode and every packaged
provider profile. The report records `allPackProviders: true` for that scope.
Core contains no hosting-provider policy.

The caller must collect the installed manifest and runner hash from the exact
sandbox snapshot under qualification, verify its files against that manifest,
and establish that the installation is protected against runtime writes before
asserting `immutable: true`. This command does not make those remote observations
itself. Its result is deployment evidence, not a signed grant or a replacement
for file-integrity verification.

The command uses the same compatibility check as task startup. Different pack
hashes remain compatible when their interface contract and selected provider
profiles agree. A different daemon binary, missing protected installation,
changed contract, or changed provider profile refuses qualification. Exit code
0 means compatible, 2 means incompatible, and 1 means invalid input or an
unavailable qualification. The JSON result records the manifests, daemon hash
and provider scope. Qualify the candidate before publishing or deploying it;
a refusal should leave the current deployment serving.

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL (inherits the server-level value; see Server Configuration above) |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Code adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex adapter) |
