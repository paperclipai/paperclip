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
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |
| `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` | (board public origin) | Optional HTTPS origin for native chat provider webhooks when ingress and the board use different hosts. Must have no credentials, path, query, or fragment; invalid configuration refuses startup. Used only for provider callback URLs, not board links, authentication, trusted hosts, or identity confirmation. |
| `PAPERCLIP_RUNNER_PUBLIC_URL` | (unset) | Explicit `wss://` base URL used only when a remote `paperclip_runner` target dials Paperclip directly. Paperclip appends `/api/runner/v1/connect/<runId>`; the reverse proxy must forward WebSocket upgrades for that route. This value is never inferred from request headers. Daytona ignores it and uses provider ingress. |
| `PAPERCLIP_RUNNER_CA_BUNDLE_PATH` | (unset) | Optional PEM CA bundle for direct runner WSS. Platform roots remain enabled. There is no insecure TLS bypass. |
| `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` | (host build) | Host-local path to a `paperclip-runnerd` artifact built for the remote target OS and architecture. Required when Paperclip and the remote sandbox do not share a compatible platform; build metadata and the required transport mode are verified before launch. |
| `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH` | (unset) | Optional host-local path to a Codex executable built for the remote target OS and architecture. For remote Codex-backed runners, Paperclip stages and verifies this executable beside `paperclip-runnerd`. |
| `PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC` | (unset) | Optional pinned npm package spec (for example, `@openai/codex@0.160.0`) installed inside each fresh remote lease when its Codex harness is not baked into the sandbox image. Mutually exclusive with `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH`; Paperclip verifies the installed executable before starting `runnerd`. |
| `PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` | `/opt/paperclip-runner/provider-pack` in Docker; otherwise unset | Host-local path to the immutable provider pack built by `pnpm --filter @paperclipai/paperclip-runner build:provider-pack`. Stamped standard Docker images include the pack; downstream compositions and the `cloud` target inherit it. Unstamped local Docker builds skip pack generation. The pack includes its target-built Node 24.11+ runtime, locked production dependencies, OpenCode proxy/executable, and ACPX sidecar. Remote OpenCode and ACPX fail closed without it. A preinstalled pack is accepted only when its complete digested manifest matches this build-owned pack; otherwise Paperclip stages this pack into the sandbox. |
| `PAPERCLIP_MCP_GATEWAY_TOOL_TIMEOUT_MS` | `10000` | Gateway default time budget in milliseconds for ordinary tool execution through the MCP gateway when the caller supplies no timeout. Some calls keep a budget of their own. See [MCP gateway tool timeouts](#mcp-gateway-tool-timeouts). |
| `PAPERCLIP_MCP_GATEWAY_TOOL_TIMEOUT_MAX_MS` | `60000` | Upper limit in milliseconds for a caller-supplied tool call timeout. Raised to the default budget when set lower. See [MCP gateway tool timeouts](#mcp-gateway-tool-timeouts). |
| `PAPERCLIP_HIDDEN_SETTINGS` | (unset) | Comma-separated settings surfaces to hide from the UI and floor at the API, for operators hosting Paperclip for others (managed cloud, internal shared server). See [Hiding settings surfaces](#hiding-settings-surfaces). |
| `PAPERCLIP_SETTING_DEFAULTS` | (unset) | JSON object replacing the schema default of selected instance settings, for hosting operators. See [Operator setting defaults](#operator-setting-defaults). |

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

### MCP gateway tool timeouts

`PAPERCLIP_MCP_GATEWAY_TOOL_TIMEOUT_MS` (default `10000`) sets the gateway's
default time budget for ordinary tool execution: the gateway applies it when
it runs a tool and the caller supplied no timeout. The MCP `tools/call` route
passes no per-call timeout, so a tool that an agent runs that way starts from
this default. Raise it when a remote tool legitimately takes longer than 10
seconds.

The variable does not change a budget that is set somewhere else. Known cases:

- Railway `run-command`, called without a timeout, gets the command's
  `timeoutSeconds` (default 30) plus 10 seconds, at most 60 seconds.
- Cognee Cloud tools, called without a timeout, get 60 seconds.
- Browser Use tools are not timed by the gateway. Each request to the Browser
  Use API has a 25 second limit instead.
- Plugin tools run in a plugin worker, and the worker gives each call 30
  seconds. A plugin tool that runs through the gateway gets the shorter of
  that limit and the gateway budget, so raising this variable above 30 seconds
  does not give a plugin tool more time. `POST /api/plugins/tools/execute`
  applies the worker limit only.
- The resource and prompt helper tools (`paperclip_list_resources`,
  `paperclip_read_resource`, `paperclip_list_prompts` and
  `paperclip_get_prompt`) are not ordinary tool execution, even though an agent
  reaches them through `tools/call`, and this variable does not govern them.
  Each local stdio connection they query gets a fixed 10 seconds, and a remote
  connection is bound by the remote HTTP transport's own limits. The MCP
  `resources/list`, `resources/read`, `prompts/list` and `prompts/get` methods
  behave the same way.

`PAPERCLIP_MCP_GATEWAY_TOOL_TIMEOUT_MAX_MS` (default `60000`) caps a timeout
that a caller does supply. The cap never drops below the default budget: if it
is set lower, the default budget is used as the cap.

Both values are whole positive numbers of milliseconds. Anything else (empty,
`0`, a negative or fractional number, exponent notation such as `1e5`, or
trailing text such as `120000ms`) is ignored and the built-in value is used.
Values above `2147483647` (the largest delay a Node.js timer accepts) are
reduced to that bound.

For a tool call that needed approval, the budget depends on what runs the call
once it is approved:

- When Paperclip runs the call itself as part of accepting the approval (the
  usual path for an agent's ask-first call), the call keeps a fixed 60 second
  budget. Neither variable changes it.
- When a later gateway call carries out the approved request by passing
  `approvedActionRequestId`, it is timed like any other call: the timeout that
  call supplies, up to the cap, or the default above when it supplies none.
- When an ask-first call made from a connection's Test tab is approved, it
  runs with no caller timeout, so it gets the default above.

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
