---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

For the comms-board provisioning variables below, all four values must be in the initial process
environment before the server or Paperclip CLI starts. The CLI deliberately skips these four variables
when loading its env file. A file-only configuration therefore remains visibly pending as
`provisioner_not_configured` and makes no provisioning HTTP request; it does not crash server startup.
Put the values in the launch environment and restart after changes. Values loaded by the server after
bootstrap are ignored for the snapshot. The two tokens are scrubbed, while captured URLs remain in the
live environment.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `PAPERCLIP_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | (unset) | Required when `PAPERCLIP_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `PAPERCLIP_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_REQUIRE_DATABASE_URL` | `false` | When `true`, refuses to start if `DATABASE_URL` (or a `database.connectionString` entry in the Paperclip config file -- either satisfies this guard, matching `config.databaseUrl`'s actual resolution) is missing, instead of silently falling back to embedded Postgres. This refusal uses a plain `Error`, not the Sentry-suppressible `StartupRefusalError` class, specifically for the authenticated+private case (e.g. Tailscale-only) that `PAPERCLIP_DEPLOYMENT_MODE`/`PAPERCLIP_DEPLOYMENT_EXPOSURE` don't otherwise guard -- those two flags only refuse the embedded-Postgres fallback for authenticated+public deployments, so an authenticated-but-private deployment would otherwise fall through with no refusal at all. For an authenticated+public deployment with this flag also set, the existing (Sentry-suppressible) authenticated-public guard fires first and this flag's always-paging guarantee does not apply -- that combination is already covered by the pre-existing guard, so set this flag unconditionally for the private case it targets, not as a universal override of the public guard's suppression behavior. Accepts `true`/`false` (case/whitespace-insensitive); unset, empty, or whitespace-only is treated as `false`; any other non-empty value fails startup loudly rather than silently disabling the guard. |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_REQUIRE_NONDUMPABLE` | `false` | When `true`, startup fails if a same-user child process can read this server's `/proc/<pid>/environ` (database URL, auth secret, provider keys). The production image starts the server from a root-owned exec-only node binary so that a same-user child should not be able to; an authenticated server logs the observed result either way (confirmed on Docker/Linux 6.12; not yet confirmed on Fargate, which is why the default is warn-only). Linux only. When truthy, an undeterminable result (non-Linux host, missing `head`, unclassifiable failure) also fails startup, because the requirement cannot be verified; when unset, an undeterminable result never fails startup. See `doc/HOSTED-AGENT-CONTAINMENT.md` in the repository. |
| `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` | `false` | Enables default MCP snapshots and setup for newly created agents. The current Comms Board and RH Google MCP entries remain OFF unless separately installed; changing this flag does not retroactively snapshot agents or revoke existing access. The capability flag is evaluated per call, but the boot-started OAuth discovery-seed sweep is scheduled only when the process starts with the flag enabled; restart the process after changing the deployment flag from off to on to activate that background sweep. |
| `PAPERCLIP_DEFAULT_AGENT_PROFILE_ROUTINE_ENABLED` | `false` | When exactly `true` (and `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` is on), the default-MCP sweep creates one daily "keep your Arcana one-pager up to date" routine for every eligible agent (ready comms-board identity and Arcana brain, not paused/terminated). Existing routines are untouched when unset. See `doc/connections/DEFAULT-MCP-SPEC.md`. |
| `PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL` | (unset) | Public RH Google MCP endpoint used to create the protected discovery-only seed. The seed is draft, disabled, non-installable, non-callable, and has no credential or grant; it does not make OAuth available until a signed-in active company member selects **Connect**. Must be an absolute HTTPS URL (loopback HTTP is allowed for local development); userinfo, query strings, and fragments are rejected. Example validated public endpoint: `https://rh-google-mcp.drum-mackarel.ts.net/mcp`. |
| `PAPERCLIP_DEFAULT_MCP_RH_MCP_URL` | (unset) | Public RH MCP endpoint used to create the protected discovery-only seed for the personal RH MCP entry. It has the same validation and consent behavior as the Google seed. Example validated public endpoint: `https://rh-mcp.drum-mackarel.ts.net/mcp`. |
| `PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS` | (unset) | Boot-time rollout scope for default-MCP template provisioning, OAuth seeds, and per-agent setup. Unset means all current and future active or paused companies; an empty value means none; a comma-separated UUID list means exactly that subset. Malformed values fail closed to no company. The captured value is immutable until restart. |
| `PAPERCLIP_HERMES_COMMAND_SCAN` | `required` | Parent-server command-scan policy for Hermes terminal command strings. The production image defaults to `required`; the value is read from the server process, not from agent or child-process environment. Operators may select only a value exposed by the deployed runtime's `getHermesCommandScanMode` contract (`"required"` or `"off"`, where unset defaults to `"off"`; any other value fails fast); this reference does not invent or imply additional values. A scanner `allow` may authorize the current command; scanner `block` and `warn` remain deny outcomes, even though schema-valid results can demonstrate scanner health for breaker reset handling. Consent, interactive approval, and pending-approval floors cannot override a scanner block or warning. Unsetting this variable does not disable the production requirement; change it only as an explicit, reviewed deployment delta with the full current variable set and a freshly saved plan. It is not an agent CLI override. |
| `PAPERCLIP_COMMS_BOARD_MCP_URL` | (unset) | Comms-board provisioning MCP endpoint. Provide it in the initial launch environment before server or CLI startup. HTTPS is required except for loopback HTTP during local development. Captured at first bootstrap and frozen until restart; later URL values are ignored for the snapshot but remain in the live environment. |
| `PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN` | (unset) | Control-plane bearer token for board registration. Provide it in the initial launch environment before server or CLI startup. It is captured once and removed from the live environment during bootstrap and after dotenv/config loading. Later values are ignored until restart. Never provide it to an agent. |
| `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL` | (unset) | Comms-board ownership API endpoint used to mint agent credentials. Provide it in the initial launch environment before server or CLI startup. Captured at first bootstrap and frozen until restart; later URL values are ignored for the snapshot but remain in the live environment. |
| `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN` | (unset) | Control-plane bearer token for ownership provisioning. Provide it in the initial launch environment before server or CLI startup. It is captured once and removed from the live environment during bootstrap and after dotenv/config loading. Later values are ignored until restart. Never provide it to an agent. |
| `TAILNET_HTTP_PROXY` | (unset) | Tailscale sidecar HTTP CONNECT listener, `http://<loopback host>:<port>`; anything else fails loudly. When set with `TAILNET_DOMAIN`, requests to `https://<name>.<TAILNET_DOMAIN>/` (port 443 only) from private-network deployments (`allowPrivateNetwork`) are tunnelled through it, and the sidecar resolves the name. `http://` and other ports fall through to the normal private-address guard. The proxy is shared by every such request, so any tailnet node the sidecar ACL allows on 443 is reachable by anyone who can configure an MCP URL in that deployment; restrict the ACL accordingly. |
| `TAILNET_DOMAIN` | (unset) | Our tailnet MagicDNS suffix, for example `drum-mackarel.ts.net`. Required when `TAILNET_HTTP_PROXY` is set, and the reverse. Must be a bare suffix ending in `.ts.net`: no scheme, port, or wildcard. Names under other `.ts.net` suffixes are never tunnelled. Both variables are read per request, not captured at bootstrap. |
| (rule) | | IP-literal URLs in `100.64.0.0/10` (the Tailscale CGNAT range, including IPv4-mapped IPv6 forms such as `[::ffff:100.64.0.1]`) or `fd7a:115c:a1e0::/48` (Tailscale IPv6, including 4via6 forms; NAT64 `64:ff9b::`, IPv4-compatible `::` and 6to4 `2002:` embeddings of the CGNAT range are also caught) are always rejected with `remote_http_tailnet_address_denied`, even with `allowPrivateNetwork`. Use the tailnet host name so the https:443 limit applies. A host name whose local DNS answer includes an address in either range is allowed only for `https://` on port 443 (explicit or default); any other scheme or port gets the same code. Names tunnelled through `TAILNET_HTTP_PROXY` are not resolved locally and are unaffected. Exception: an exact origin (scheme, host, port) listed by the operator in `PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST`, or a host listed in `PAPERCLIP_TOKEN_BROKER_ALLOWED_HOSTS`, skips this rule; user-supplied URLs never do. |
| `PAPERCLIP_ARCANA_URL` | (unset) | Arcana base URL (no path) for the `arcana-brain` default MCP's brain provisioning (`POST {url}/api/v1/brain/provision`). Provide it in the initial launch environment before server or CLI startup. HTTPS is required except for loopback HTTP during local development. Captured at first bootstrap and frozen until restart; never taken from a `.env` file. |
| `PAPERCLIP_ARCANA_PROVISION_KEY` | (unset) | Signing key (kid `paperclip-brain-provision`) for Arcana brain provisioning. Paperclip mints a fresh 60-second HS256 service JWT from it for each provision request, scope `arc:brain:provision` only (it can register brains, not read or mint anything). rh-auth tokens live at most 15 minutes, so a pre-minted token cannot be used here. Provide it in the initial launch environment before server or CLI startup. It is captured once and removed from the live environment during bootstrap and after dotenv/config loading, and is never taken from a `.env` file. Later values are ignored until restart. Never provide it to an agent. |
| `PAPERCLIP_ARCANA_BINDING_TOKEN` | (unset) | Bearer holding only the ACA `arcana:bind` scope, used to register each agent's Arcana brain in the ACA brain directory (`PUT {PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL}/brain-bindings/{boardSub}`). Unlike the provisioning key it is a pre-minted static service token (5-year, signed with the shared rh-auth secret and verified by ACA's registry, which is not subject to the 15-minute authority-token cap); rotate it by putting a new SecureString value and restarting; it can write directory rows and nothing else. Unset means binding is skipped (no call, setup unaffected). Provide it in the initial launch environment; it is captured once and removed from the live environment, never taken from a `.env` file, and never given to an agent. |
| `PAPERCLIP_ARCANA_MCP_URL` | (unset) | Arcana MCP endpoint URL (HTTPS, or loopback HTTP for development; no credentials, query or fragment) used to bootstrap the static `rh-arcana-brain` template connection (TECH-7253). Not a secret. Captured at first bootstrap and frozen until restart; never taken from a `.env` file. Unset or invalid means the template is not created, so new agents stay pending (`template_not_found`) until it is set and a template exists. |
| `PAPERCLIP_AGENT_MEMORY_ENABLED` | (unset) | Set to `true` to give NEW `hermes_local`, `claude_local` and `codex_local` agents a per-agent memory credential and the harness settings (the `agent-memory` default MCP entry: `MEM0_*` for Hermes, `RH_MEMORY_*` for Claude and Codex; a native-runner agent counts as Codex only when its config names Codex). Off unless `true` (case-insensitive), and it has no effect unless `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` is also `true`. Existing agents are never changed by this variable (see `PAPERCLIP_AGENT_MEMORY_BACKFILL_ENABLED`); their tokens are rotated before they expire. Read from the live process environment at each agent creation and setup run (not frozen at boot); not a secret. The token itself is minted through the comms-board ownership registry settings above. |
| `PAPERCLIP_AGENT_MEMORY_URL` | (unset) | Base URL of the external memory service, written to each new agent's `MEM0_HOST` (Hermes) or `RH_MEMORY_URL` (Claude and Codex). HTTPS, or loopback HTTP for development; no credentials, query or fragment. Unset or invalid: new agents get no memory entry at creation, and an entry created earlier waits (nothing is minted). Read live, not frozen. Not a secret. |
| `PAPERCLIP_AGENT_MEMORY_PROXY` | (unset) | Optional proxy URL written to each new agent's `MEM0_PROXY` or `RH_MEMORY_PROXY` (for example `http://127.0.0.1:1055`, the Tailscale sidecar). `http`, `https`, `socks5` or `socks5h` with a host and optional port, no credentials, path, query or fragment. Read live, not frozen at boot. Only the memory clients read it. Not a secret. |
| `PAPERCLIP_AGENT_MEMORY_CAPTURE` | (unset) | Set to `on` (case-insensitive) to retain legacy capture for new `claude_local`/`codex_local` agents; default is off (`RH_MEMORY_CAPTURE="off"` projected; recall-only). Operators can set `RH_MEMORY_CAPTURE` per agent in `adapterConfig.env` (`off`, `false`, `0`, `no` vs `on`); explicit agent settings are preserved across re-enrollment and backfill. Has no effect on `hermes_local` agents. |
| `PAPERCLIP_AGENT_MEMORY_BACKFILL_ENABLED` | (unset) | Set to `true` to let the operator-run missing-entry enrollment add the `agent-memory` entry (and, with `PAPERCLIP_AGENT_MEMORY_TOOLS_ENABLED=true`, the `agent-memory-tools` entry) to EXISTING agents of a profiled adapter that already hold a default-MCP state. It also needs `PAPERCLIP_AGENT_MEMORY_ENABLED=true`, a valid `PAPERCLIP_AGENT_MEMORY_URL` and `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED=true`; with any of them missing the job reports `nothing_missing` for every agent. Off unless `true` (case-insensitive). It enrolls nothing by itself: an operator runs `POST /api/companies/:companyId/default-mcp/missing-entry-enrollment` (dry run by default). Not a secret. |
| `PAPERCLIP_AGENT_MEMORY_TOOLS_ENABLED` | (unset) | Set to `true` to give `claude_local` and `codex_local` agents explicit memory tools (`memory_search`, `memory_add`, `memory_delete`) through Paperclip's tool gateway: the `agent-memory-tools` default MCP entry, a per-agent connection to `${PAPERCLIP_AGENT_MEMORY_URL}/mcp` that reuses the agent's own `agent-memory` token (no second secret). It also needs `PAPERCLIP_AGENT_MEMORY_ENABLED=true`, a valid `PAPERCLIP_AGENT_MEMORY_URL` and `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED=true`. New Claude and Codex agents get it at creation; existing agents need an operator-run missing-entry enrollment with `"keys": ["agent-memory-tools"]` (dry run first), which also requires `PAPERCLIP_AGENT_MEMORY_BACKFILL_ENABLED=true` and an `agent-memory` entry already present in the agent's metadata (its state is not checked at enrolment; setup waits until it is ready). Hermes agents never get it (they have the mem0 provider's own tools). The company template connection is created only while this is `true`. Turning it off stops new templates, provisioning, enrolment and setup, but does not remove tools from agents that are already ready (remove the agent's install to do that). Off unless `true` (case-insensitive). Not a secret. |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `PAPERCLIP_API_URL` | (auto-derived) | Paperclip API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |
| `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` | (board public origin) | Optional HTTPS origin for native chat provider webhooks when ingress and the board use different hosts. Must have no credentials, path, query, or fragment; invalid configuration refuses startup. Used only for provider callback URLs, not board links, authentication, trusted hosts, or identity confirmation. |
| `PAPERCLIP_RUNNER_PUBLIC_URL` | (unset) | Explicit `wss://` base URL used only when a remote `paperclip_runner` target dials Paperclip directly. Paperclip appends `/api/runner/v1/connect/<runId>`; the reverse proxy must forward WebSocket upgrades for that route. This value is never inferred from request headers. Daytona ignores it and uses provider ingress. |
| `PAPERCLIP_RUNNER_CA_BUNDLE_PATH` | (unset) | Optional PEM CA bundle for direct runner WSS. Platform roots remain enabled. There is no insecure TLS bypass. |
| `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH` | (host build) | Host-local path to a `paperclip-runnerd` artifact built for the remote target OS and architecture. Required when Paperclip and the remote sandbox do not share a compatible platform; build metadata and the required transport mode are verified before launch. |
| `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH` | (unset) | Optional host-local path to a Codex executable built for the remote target OS and architecture. For remote Codex-backed runners, Paperclip stages and verifies this executable beside `paperclip-runnerd`. |
| `PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC` | (unset) | Optional pinned npm package spec (for example, `@openai/codex@0.160.0`) installed inside each fresh remote lease when its Codex harness is not baked into the sandbox image. Mutually exclusive with `PAPERCLIP_RUNNER_REMOTE_CODEX_PATH`; Paperclip verifies the installed executable before starting `runnerd`. |
| `PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` | `/opt/paperclip-runner/provider-pack` in Docker; otherwise unset | Host-local path to the immutable provider pack built by `pnpm --filter @paperclipai/paperclip-runner build:provider-pack`. Stamped standard Docker images include the pack; downstream compositions and the `cloud` target inherit it. Unstamped local Docker builds skip pack generation. The pack includes its target-built Node 24.11+ runtime, locked production dependencies, OpenCode proxy/executable, and ACPX sidecar. Remote OpenCode and ACPX fail closed without it. A preinstalled pack is accepted only when its complete digested manifest matches this build-owned pack; otherwise Paperclip stages this pack into the sandbox. |
| `PAPERCLIP_HIDDEN_SETTINGS` | (unset) | Comma-separated settings surfaces to hide from the UI and floor at the API, for operators hosting Paperclip for others (managed cloud, internal shared server). See [Hiding settings surfaces](#hiding-settings-surfaces). |
| `PAPERCLIP_SETTING_DEFAULTS` | (unset) | JSON object replacing the schema default of selected instance settings, for hosting operators. See [Operator setting defaults](#operator-setting-defaults). |

### Shared skills

One GitHub repository folder can supply skills to every company library. The server downloads it on startup and every
10 minutes, and each company imports the latest snapshot on demand as `shared/<slug>` skills. No company, person or agent
receives the token. The feature is off unless both the token and the repository are set.

When it is on, a run also switches on the shared skills an agent's tools call for: a skill is added to the run when the
agent can use every tool the skill requires (the table is `SHARED_SKILL_DEFAULTS` in
`server/src/services/shared-skill-defaults.ts`). Nothing is saved into the agent's skill preferences, and there is no
per-agent opt-out. Unsetting the repository turns this off for everyone.

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_SHARED_SKILLS_GITHUB_TOKEN` | unset | Read-only GitHub token (fine-grained, Contents: read, limited to that one repository). Keep it in a secret store. |
| `PAPERCLIP_SHARED_SKILLS_REPOSITORY` | unset | `owner/name` of the repository. |
| `PAPERCLIP_SHARED_SKILLS_PATH` | `skills` | Folder in the repository whose subfolders (each with a `SKILL.md`) are the skills. |
| `PAPERCLIP_SHARED_SKILLS_REF` | `main` | Branch or ref to track. |

The token is read once at startup (from the real process environment, not a `.env` file) and removed from the process environment, so agent processes the server starts never inherit it. A token supplied only through a `.env` file is not used and is scrubbed. Rotating or unsetting the token takes effect on the next server restart.
Unsetting the repository, or restarting without the token, stops further imports; skills already in a library remain until removed.

### Default MCP OAuth endpoint readiness

The RH endpoint values above are public metadata endpoints, not secrets. Before enabling the
feature for a company, an operator must verify the configured URL in the deployment environment:

- Protected-resource metadata must return `401` without authentication and `200` with valid
  authentication. Authorization-server metadata must return `200` publicly and advertise dynamic
  client registration plus authorization-code and refresh grants with S256 PKCE. CIMD is
  intentionally disabled (TECH-1943), so Paperclip relies on dynamic client registration rather
  than a manually copied client secret.
- Human sign-in uses the Google provider through the Paperclip Okta-OIDC proxy. Machine OAuth is
  optional and must not be assumed from the human provider configuration.
- The current validated public examples are
  `https://rh-google-mcp.drum-mackarel.ts.net/mcp` and
  `https://rh-mcp.drum-mackarel.ts.net/mcp`. Do not substitute the direct
  `*.core.redesignhealth.com` aliases unless their TLS/SNI configuration has been separately
  corrected and validated.

Creating a seed is not an end-to-end readiness check: the first DCR POST, Paperclip redirect, and
human consent flow still require browser-visible deployment verification. In production, an
authenticated/private Paperclip deployment may use a reachable tailnet endpoint; public exposure
does not make a private tailnet target reachable. Keep that deployment guard in place rather than
using public exposure as a connectivity bypass. Current production Comms Board readiness does not
imply that these RH OAuth environment variables or the corresponding OAuth code path are deployed.

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

## Claude Code and Codex Memory Hook (agent env)

The production image includes `/etc/claude-code/managed-settings.json`, `/etc/codex/managed_config.toml` and `/usr/local/bin/rh-memory-hook`. The hook recalls memories before each prompt. End-of-turn capture is off by default for `claude_local` and `codex_local` agents enrolled from now on (`RH_MEMORY_CAPTURE=off` projected at enrollment; `PAPERCLIP_AGENT_MEMORY_CAPTURE=on` restores capture). Agents already enrolled keep capturing until an operator sets `RH_MEMORY_CAPTURE=off` in their `adapterConfig.env` (`adapterConfig.env` is replaced wholesale on `PATCH` so every other key must be resent). Recall always works, and these agents are recall-only because the service gives them no other write path. Runs only for `claude_local` and `codex_local` agents whose `adapterConfig.env` sets the token and URL below. Set these variables per agent, not on the server.

Claude Code's built-in auto memory is disabled in the image (`"autoMemoryEnabled": false` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `/etc/claude-code/managed-settings.json`, TECH-8749). Its notes under `$CLAUDE_CONFIG_DIR/projects/<project>/memory/` persisted on the shared volume and were reloaded every session, keyed by project path, so they competed with the memory hook. CLAUDE.md, rules, AGENTS.md and session resume are unaffected. Notes already written to the volume are not deleted by this change; they are simply no longer loaded or updated.

Codex loads `/etc/codex/managed_config.toml` for every run, so the `CODEX_HOME` that the adapter seeds does not matter. Codex hooks need no feature flag. Runs in remote sandboxes do not see the image files, so they do not use the hook.

| Variable | Default | Description |
|----------|---------|-------------|
| `RH_MEMORY_TOKEN` | (unset) | The agent's memory token, sent as `X-API-Key`. Use a `secret_ref`. If it is unset, the hook does nothing. |
| `RH_MEMORY_URL` | (unset) | Base URL of the memory service. It must use `https://`. |
| `RH_MEMORY_PROXY` | (unset) | Optional HTTP CONNECT proxy, used for the memory service only. |
| `RH_MEMORY_CAPTURE` | (unset) | Set `off`, `false`, `0`, `no` to disable capture (recall active); `on`/unset to enable. New agents get `"off"`. |
| `RH_MEMORY_TOP_K` | `5` | Number of memories to recall (1-20). |
| `RH_MEMORY_RECALL_TIMEOUT` | `3` | Seconds to wait for recall before the prompt continues. Capped at 8. |
| `RH_MEMORY_CAPTURE_TIMEOUT` | `15` | Seconds for the detached capture request. |
