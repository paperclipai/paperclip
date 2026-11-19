# Default MCP spec

Every new agent can be offered a short list of MCP apps. The apps start OFF. This feature is off by default.

## Turn it on

Set `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED=true`. When the flag is not `true`, agent creation does not change.
Defaults are not applied retroactively to agents that already exist, *unless* an operator explicitly runs legacy enrollment (TECH-7339, below). Without that explicit step, legacy agents with an absent or null `defaultMcp` value remain unmanaged; existing managed or corrupted state is still enforced independently of the feature flag.

For the RH OAuth entries, also configure the public MCP endpoint variables described in
[Environment Variables](../../docs/deploy/environment-variables.md). The seed sweep only creates
discovery records for valid configured endpoints; it does not contact the endpoint, discover tools,
start OAuth, grant access, wake an agent, or create a credential.

## The spec

`server/src/services/default-mcp-spec.ts` holds the list. Each entry names an org connection (the template) and a `defaultEnabled` value.
To add an app, add one entry. Only an entry with special auth needs a `setupHook`.

- **Ordinary entry:** the agent toggles its eligible connection itself. OAuth consent is never started at create time. OAuth entries with `oauthSeed` first expose a protected discovery seed and require a human's personal connect flow.
- **Dedicated entry (comms board):** the org connection is a read-only template. Setup creates one connection per agent, named `<template>:<agentId>`. Only that connection can be installed or used by the agent. The org template and the connections of other agents are refused.

The current spec includes ReClaw Comms Board, Arcana Brain, RH Google MCP, and RH MCP. All but Arcana Brain have `defaultEnabled: false`, so none of those is installed by default, with one exception: ReClaw Comms Board sets `installByDefault: true`, so each agent's OWN dedicated connection is installed automatically (in the same transaction that creates it for new agents; once, by the install reconcile sweep, for existing agents, never the org template and never overriding a later removal by the owner). An agent with no board identity yet (owner_required, pending, error) has no dedicated connection, so nothing is exposed until setup is ready. Arcana Brain is `defaultEnabled: true` (see "Arcana brain entry"). Enabling the spec may still run the Comms Board's dedicated provisioning hook when its prerequisites are present; OAuth consent is never started by agent creation. No production authorization or new auth/IAM setup is implied.

### RH Google MCP

RH Google MCP is an OAuth, personal-only entry. When the feature is enabled and
`PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL` is valid, Paperclip creates one protected,
discovery-only seed per eligible company. The seed is a server-managed `draft` connection with
`enabled: false`; it is not installable or callable and has no grants, profile, credential, or
secret. It has no agent metadata, install row, catalog, or profile, and the seeder performs no
network request or agent wake. Its server marker and deterministic UID are implementation
identifiers; the displayed application/connection name is not a canonical identity. The seed is
immutable except for archive (`409 managed_seed_immutable`); its operation is idempotent under a
company/entry advisory lock, and an archived seed is an organization opt-out that is not recreated.
After the consenting owner first connects a personal Google instance, the tools named in
`RH_GOOGLE_MCP_INITIAL_ACTIVE_TOOLS` (`default-mcp-spec.ts`) are switched on and every other discovered
catalog entry remains quarantined until the owner reviews it. That list is hand-built: every read tool plus the
reviewed writes in `RH_GOOGLE_MCP_SAFE_WRITE_TOOLS` (drafts, Gmail label tagging, Docs, Sheets, Slides and Forms edits,
Drive file writes and comments). Only real danger stays quarantined: sending, deleting (including label-object, task and
contact management, which can delete through an `action` argument), sharing and publishing, calendar invites, Gmail
filters and Apps Script. An owner can enable those in Permissions. The Google server's own read-only flag is not used, because it marks tools
that change data (for example `manage_drive_access`, `modify_sheet_values`, `run_script_function`) as read-only. See
[TOOL-ENABLEMENT-RUNBOOK.md](./TOOL-ENABLEMENT-RUNBOOK.md). The instance is also installed,
through the owner-only per-agent install path, on the live agents that owner created (not terminated, not awaiting
approval). Agents other people created and agents created later start with it off; a reconnect preserves existing tool
choices and installs; if the profile has no tool entries at all, the first-consent starter set is applied again; installs
are never re-derived on reconnect. The result is recorded in a `personal_instance.install_on_existing_agents` audit event.

RH MCP uses the same protected seed and personal-connect lifecycle, but its new personal instance
auto-approves only the read tools listed below (see the current ceiling list for the exact count);
every other discovered tool remains quarantined. Reconnect preserves existing reviewed or denied
choices and does not restore the ceiling tools after they have been changed. Existing manually
created canonical Google or RH MCP connections, profiles, credentials, and installs are preserved
and are not adopted by a seed.

Widening the ceiling (adding a new raw tool name to the list) only auto-activates for a **brand-new**
personal instance's first-consent profile. For an **existing** personal instance whose profile
predates the widening: if that tool's catalog entry was already `active` (discovered and enabled
before the widening, just blocked by the ceiling), the existing profile already includes it, and
the widened ceiling alone makes it callable immediately — no reconnect or backfill needed. If the
tool is genuinely new to that connection's catalog (never discovered before), it is subject to the
connection's normal `quarantineNewEntries` review on its next catalog refresh like any other newly
discovered tool, ceiling or not; the owner must review and enable it via Permissions. Widening the
ceiling does not bypass that review for tools that haven't been discovered yet.
There is no silent OAuth, company-wide binding, or automatic agent grant; new agents remain OFF
until an explicit per-agent install.

The Apps UI's **Connect** action is the only normal path from the seed to a usable connection.
It requires a signed-in human who is an active member of the company and runs the existing OAuth
flow as that user. Paperclip creates or revives that user's personal instance, preserving its
existing grants and reviewed choices when reconnecting. The personal instance cannot be installed
company-wide; only its owner can add it to an agent, and an agent cannot receive two personal
instances for the same entry from different owners. Agent actors and borrowed/admin credentials
are not substitutes for the consenting user.

At runtime, the responsible user for an agent is selected by the existing trusted runtime context.
That user's active membership and personal grant are required; a grant belonging to another user
does not authorize the agent and requires user authorization instead. This is separate from the
agent's creator or owner identity.

The OAuth client, callback, PKCE, and refresh-token handling remain the existing trusted OAuth
path. The public endpoint must not be used to mutate credentials, callback URLs, or auth policy.
Dynamic client registration is the intended first-connect path when the endpoint advertises it;
Paperclip does not require an operator to copy a client secret manually. The configured public
RH endpoint contract exposes protected-resource metadata, authorization-server metadata, and
dynamic registration, with authorization-code and refresh support using S256 PKCE. The production
endpoint examples and first-connect browser flow still require deployment verification; this
spec does not claim that end-to-end OAuth has been exercised merely because the seed exists.

### RH MCP / Granola

The RH MCP entry is `rh-mcp`, displayed as **RH MCP**, and refers to the `rh-mcp-personal` connection. It is an ordinary OAuth entry: it has no setup hook, does not mint an upfront machine JWT or Comms token, and uses the existing per-user OAuth credential vault. A valid template must be an `mcp_remote` + `oauth` + `per_user` connection with `config.identityModel: "personal_only"` and `config.paperclipDefaultMcpEntry: "rh-mcp"`. Once valid, classification-breaking updates to its name, transport, auth kind, or credential policy are rejected before mutation. The protected `config.identityModel` and `config.paperclipDefaultMcpEntry` markers are pinned: attempts to change, clear, or omit them are silently ignored and the existing values are preserved. Benign enabled and URL updates remain allowed for manual canonical connections; the new server-managed seed and personal instance keep their endpoint configuration immutable. These rules preserve the existing classification and add no new security semantics. A missing, ambiguous, or invalid template is treated as unavailable: new agents remain OFF and receive no RH MCP binding or access. A same-named connection without these template properties remains an ordinary connection and is not capped by this entry.

Onboarding has three separate steps:

1. **Operator:** enable the feature and configure the RH MCP endpoint variable. Paperclip creates the protected `rh-mcp-personal` discovery seed when the company is eligible. This is endpoint configuration, not a Granola API-key setup; the upstream URL is not the Paperclip API base. A pre-existing manual canonical `rh-mcp-personal` profile or credential is preserved and is not adopted by the seeder.
2. **Human:** complete the one-time MDM Granola sync at <https://api.core.redesignhealth.com/granola/connect> by signing in with Google, entering a Granola API key on the authenticated key-only page, and selecting **Connect Granola**. Granola access covers `personal` and `public` categories, not workspace data. MDM stores the key encrypted for ingestion; it is not exposed to agents, chat, or prompts.
3. **User:** select **Connect your account** for RH MCP through the normal existing OAuth flow. Native personal OAuth issues access and refresh tokens into the existing vault and uses the user's personal grant; no custom setup or profile wizard is introduced.

For agent access, the effective permission surface is capped to these tools (read tools, `voice_apply` (60 s per-call timeout), plus the three Argus review verbs, of which `argus_start_review` and `argus_cancel_review` act on a review job): `mdm_granola_status`, `mdm_list_my_granola_notes`, `mdm_list_shared_granola_notes`, `mdm_get_granola_note`, `mdm_get_granola_transcript`, `argus_get_proxy_token`, `argus_start_review`, `argus_get_review`, `argus_cancel_review`, `zoom__get_transcript`, `zoom__get_meeting_transcript`, `zoom__get_meeting`, `zoom__list_my_meetings`, and `voice_apply`. The ceiling applies to effective agent access, not user sessions. Profile details may still show configured catalog entries; that does not mean every entry is effective or callable. For snapshot-managed agents, company installs, organization grants, and other agents' bindings do not authorize this personal template: access still requires the agent's explicit install and the responsible user's personal grant, membership, and vault-backed credential. Existing legacy rows and bindings are retained for compatibility rather than revoked; a legacy agent may continue to receive these capped reads only through its typed responsible user's personal grant, membership, and vault-backed credential, never through a shared-organization fallback. No new company-wide promotion is created after personal consent/callback/finalization. Note and transcript visibility are independent server-checked permissions; transcript access is read-only, and a privacy refusal has no fallback to another provider **within that same provider** — this rule is defined per-provider (e.g. a Granola transcript refusal does not fall back to another Granola source), not across providers. The ceiling now including both Granola and Zoom transcript tools means an agent could still request the same meeting's transcript from the other provider if that provider independently allows it; each provider's own access control is what governs that, not a cross-provider no-fallback guarantee. Existing user controls, custom connections, and legacy Group A entries remain unchanged.

`argus_get_proxy_token` is a deliberate exception inside this "read-only" ceiling: it does not read Granola, Zoom, or any RH business data, and is not itself a write/mutating action against any upstream system. It mints a short-lived (~30 minute), single-PR-scoped opaque bearer token used only to route the Argus code-review loop's own LLM/storage calls through rh-mcp's proxy; the token decrypts only server-side and never embeds a raw upstream secret. It is included in the ceiling, and therefore auto-activated like the other entries, specifically so the `argus-review-loop` skill can run unattended without a separate manual-approval step per agent. This was a considered trade-off, not an oversight: gating it behind a per-agent or per-skill opt-in was evaluated and rejected, because that friction would defeat the point of letting the skill run unattended, and the token's narrow scope (no business data access, short TTL, PR-scoped) was judged sufficient mitigation for keeping it in the default ceiling rather than behind an extra approval step.

Catalog/profile bindings and scoped fixture tests establish source behavior only; they do not prove that a seed is deployed, that a user has completed consent, that the provider's public endpoint is reachable, or that provider content access is qualified. In particular, direct `*.core.redesignhealth.com` aliases are not documented defaults unless their TLS/SNI configuration is independently validated; use the validated public endpoint values in the environment-variable reference.

## What OFF means

For snapshot-managed agents, an app is ON only with an explicit per-agent install row. A company-wide install, a company profile, or an organization grant does not turn it on. The gateway, token mint, effective profiles and the run projection use one rule. Legacy agents and pre-existing legacy bindings retain their compatibility behavior; this feature does not retroactively revoke them or grant them a shared-organization credential.
An agent whose row is missing or belongs to another company is caller-specific: gateway listing/search returns `404 agent_not_found`; the run projection is `null`. It is not silently treated as a legacy agent. A present but corrupted protected `defaultMcp` key fails closed: gateway dispatch and token mint return `403 installation_required`, and the effective installed set is empty. The same refusal is used by the heartbeat projection and effective-profile path.

An absent `defaultMcp` key, an empty metadata object, or `defaultMcp: null` is intentionally legacy/unmanaged behavior. The server never writes `null`; this compatibility distinction must not be described as the feature silently changing legacy agents. The refusal checks are independent of the feature flag: turning the feature off stops new snapshots and the sweep, but does not make an existing malformed state usable.

A managed per-agent connection cannot change its credential policy or arbitrary credential references. `credentialSecretRefs` are compared by canonical value, so equivalent key/reference ordering changes are accepted; values must remain unchanged. Non-header `credentialRefs` remain equal, while the single header reference may move only to the same secret and its path/key/prefix representation. The managed grant and connection bindings are updated atomically, without an outer duplicate sync.

Removing the install blocks the next session and the next call. It does not cancel a call that is already running, revoke a valid already-issued token, or remove installed access merely because the feature flag is later turned off. Per-agent disable controls runtime access; external token revocation remains a separate concern.

## Cached tool discovery and credential health

User- and agent-specific (`per_user` / `per_agent`) connections keep their active,
unquarantined cached tools discoverable when a company-level health probe records
`missing_secret` or another failure. Their credentials belong to grants, so the
shared health result alone cannot decide whether a particular caller can use them.
Agent visibility, explicit install requirements, tool policies and credential
resolution still apply. A missing, revoked or different agent's grant cannot use
an organization credential as a fallback. A deleted credential fails before a
provider request. A successful authorized call updates connection health normally;
discovery itself does not validate or repair credentials.

## Provisioning and identity checks

The setup hook provisions only after the agent row, company membership, template, and owner prerequisites have been checked. The stored `ownerUserId` is resolved to an active, verified human company member. Paperclip validates the ownership reply's `owner_email` after trimming and case-folding against that verified human email. A human actor becomes the owner at creation. An agent that creates another agent (hire or create route) passes its own id as the creator, and the new agent inherits the creating agent's frozen `comms-board` `ownerUserId` (`resolveCreatorOwnerUserId`), but only while that user is still an active member of the same company with a resolvable, verified email; the creator is read from its own company only. When the creator has no owner, its owner is no longer an active member, or the actor is a built-in or plugin, the owner stays null and setup waits for `owner_required` rather than provisioning as a human: no company-wide default and no guess are ever used. An approving human may still bind the owner at approval only where none exists. An entry that keeps waiting at `owner_required` for about a day (24 or more attempts, retries are roughly hourly) logs a warning once per 24 attempts (about daily), including whether an owner was ever assigned; state and retry cadence are unchanged.

New comms-board credentials use a fresh bare-per-bot signed-token subject, `paperclip-agent-<agent UUID>`, with `agentKey: null`; callers do not need to supply a per-call `agent_key`. Existing registered keyed bindings are left exactly as they are: setup does not re-register, rewrite, migrate, fork, or claim that a no-key runtime path works for those legacy keyed bindings.

The setup checkpoints the non-idempotent register and mint calls before making them. A missing response is therefore an unknown result (`board_unknown` or `mint_unknown`), not permission to retry or mint a replacement. Do not document an exact HTTP status for a missing mint result unless the current source explicitly establishes one.

For a dedicated entry, the org connection is a read-only template. Setup creates or reuses the deterministic per-agent connection, copies its catalog/access configuration, and grants only that agent access. A fresh dedicated clone has `mcpSessionRequired: true` for normal gateway use; the org template is not mutated. The template and other agents' dedicated connections remain forbidden even if an install row exists for them. A ready entry is trusted only when the persisted binding, one header reference, active agent grant, usable vault secret, and non-expired token agree.

The comms-board client performs the MCP session sequence before tool use: `initialize` negotiates the protocol version and receives any optional session id; `initialized` and `tools/call` then carry the protocol/session headers, followed by a best-effort `DELETE` for the session. Handshake failure occurs before the tool-call checkpoint and is safely retryable. Once the external register or mint request has been sent, a lost response remains an unknown result and is never retried. `registerAttemptedAt` is checkpointed after a successful handshake and before `tools/call`. Replies are bounded and must match the request id; SSE session notifications are handled as protocol messages. Plaintext `ToolError` handling maps only the narrow classified prefixes and never persists or exposes upstream error text.

The control-plane scopes are explicit: board registration requires `comms:write` plus `comms:admin`, while ownership provisioning uses an ownership token with `ownership:write`. An operator may use an existing profile that denies `comms_register` as a fork-hazard mitigation; this is operator guidance, not a claim that provisioning code enforces that profile.

Before first enablement, run a read-only pre-deploy audit for existing agent metadata containing the protected `defaultMcp` key. It should find zero rows before this rollout; once the feature has created snapshots, nonzero rows are expected. This audit is observational only and must not rewrite absent or null legacy metadata.

## Runtime enforcement and rollback

`loadAgentDefaultMcpState` and `agentInstallsRefused` are the shared enforcement seam used by heartbeat projection, token mint, effective profiles, and gateway access. Missing/foreign agents and malformed metadata are handled as described above; valid managed entries require an explicit agent install, while dedicated templates and other agents' dedicated connections remain forbidden. Runtime projection yields `null` for both missing/foreign agents and malformed metadata; the effective installed set is empty for a refused, valid agent row.

A runtime test call must exercise the managed OFF gate before policy evaluation, rate limiting, upstream invocation, or approval side effects. This route uses `runId: null` and does not create a heartbeat or require one. To prepare the canary, create an agent with `runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }`; agent creation forces it idle, and the operator should immediately pause that agent. The test call itself does not create a run or heartbeat. The test may use scoped instrumentation to show that no secret was decrypted; that evidence is distinct from a live `403 installation_required` and from audit records, and this spec does not promise zero-decrypt behavior based on logs alone.

Protocol request IDs and response IDs must match in both type and value; a numeric or string id is valid only when the response preserves that same type and value.

If an older image is rolled back, its code may no longer enforce the OFF gate. Revoke or clean up affected installs/tokens before rolling back the image; this is an operational warning, not a new lifecycle framework. Disabling the feature flag does not itself revoke a valid ready token or installed access.

## Comms board identity (operator prerequisites)

Setup calls two existing APIs. It needs these server settings:

- `PAPERCLIP_COMMS_BOARD_MCP_URL` and `PAPERCLIP_COMMS_BOARD_ADMIN_TOKEN` (board `comms_admin_register`).
- `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL` and `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_TOKEN` (ownership `POST /agents`).

All four must be in the initial process environment before the server or Paperclip CLI starts. The CLI deliberately skips these four variables when loading its env file, so a file-only value is not available to the first capture. If tokens are supplied in the environment but either endpoint is absent from that environment, setup remains visibly pending with `provisioner_not_configured` and makes no HTTP request; it does not crash server startup. Put the four values in the launch environment and restart after changing them. The first bootstrap capture is the only source of truth. The server freezes all four captured values, unconditionally deletes both token variables from the live environment during bootstrap, after each supported dotenv load, and after final config loading, and ignores later URL changes for the snapshot. Captured URLs remain in the live environment and may be inherited by default-environment children. The feature flag itself is still read live.

Each URL must be `https` (any host, so a private tailnet works). Plain `http` is allowed only for `127.0.0.1`, `localhost` or `[::1]`. A URL with a user name, a query or a fragment is refused, and the entry waits as `provisioner_config_invalid`. Redirects are never followed.
The ownership reply must name the same token base, be active, and be owned by the verified owner. Any other reply is an unknown result.

The admin and ownership tokens are control-plane credentials. They are never given to an agent.
The agent token has only `comms:read`, `comms:write` and `comms:proposals:write` (the last lets it use `proposals_submit`/`proposals_get`). It lives in the company secret store and is bound to the agent connection. Agents created before `comms:proposals:write` was added keep their old token (read and write only), so `proposals_submit` and `proposals_get` fail at the board for them until the token is rotated (`POST /agents/{sub}/rotate` on the ownership API). Minting is skipped when a binding already exists.
The company needs an active `api_key` template connection named `rh-comms-board` with one header credential. Paperclip provisions it automatically (see "Company template bootstrap"); an org-authored one with exactly that name and shape is trusted unchanged. Until a usable template exists, the entry stays `pending` (`template_not_found` or `template_provisioning`) and retries.

## Setup state

State is in `agents.metadata.defaultMcp`. Only the server writes it. Setup is durable: a 60-second sweep resumes pending work.
A lost register or mint response is an unknown result. It is never repeated and never rotated automatically.
Newly provisioned per-bot credentials request 365 days (TECH-7268); this default applies to newly issued tokens only, and existing token expirations are unchanged. Automatic rotation is not part of this feature. The existing backend rejects an expired token.

Security and revocation caveats:
- Uninstalling a connection, turning the feature flag OFF, or suspending an agent on the board does not fully revoke a signed JWT offline or invalidate in-flight Bearer tokens.
- Registry deactivation (by a human via Okta) blocks downstream token verification, but is subject to a positive caching window (~300s) and stale-on-outage fallback (up to 24h).
- Manually rotating a credential leaves the old JWT valid until its stored expiration, and reactivating a previously retired sub revives any unexpired tokens minted for that identity.

## Company template bootstrap (TECH-7271)

Per-agent comms identities are cloned from the company's read-only `rh-comms-board` template. Paperclip now provisions that template itself, for every non-archived company, so an operator no longer hand-authors it. This runs under the same `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` flag and needs no new route, table or migration. It reuses the same two server settings as the per-agent setup (`PAPERCLIP_COMMS_BOARD_MCP_URL` for the endpoint and `PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_*` for the mint); there is no per-bot or per-company SSM entry, and no board admin credential is used.

### What is created

- One application `rh-comms-board` and one connection with the fixed uid `rh-comms-board/default-mcp-template` (unique per company, unforgeable: client-created uids always carry a random id suffix), `mcp_remote`, `api_key`, `shared`, `mcpSessionRequired`, `quarantineNewEntries`. The endpoint is the frozen boot-time board URL.
- Server-owned markers on `config`: `defaultMcpManaged: "template"` and the durable claim `defaultMcpTemplate` (state `pending`/`in_progress`/`ready`/`error`, frozen owner, `mintAttemptedAt`, `secretId`, `tokenExpiresAt`, `allowlistVersion`, lease and attempt counters). Public create/update payloads have these keys stripped, so a client can never forge, adopt or remove them. The managed template cannot be edited (409 `managed_template_immutable`); archiving it is the one allowed change.
- A per-agent clone of it is marked `defaultMcpManaged: "dedicated"`, keeps `quarantineNewEntries`, and never inherits the claim. A client replacing a dedicated clone's config cannot remove either.

### The credential: 365 days, read-only, discovery only

The template token is minted through the existing ownership API `POST /agents` with the server's existing ownership token: scopes exactly `["comms:read"]`, `expires_in_days: 365`, subject `paperclip-company-template-<company uuid>` (63 characters, no `::`). The scopes come from a closed typed purpose table (`bot` = read+write+proposals:write, `template` = read); there is no caller-supplied scope list, so no code path can request `comms:admin` or `ownership:*`. The per-bot mint adds only `comms:proposals:write`. The token is stored only in the encrypted vault (deterministic key `default_mcp.comms_board.template`) and is never logged, written to activity, or placed in the claim or connection row. Only ids and closed reason codes are recorded.

The owner it is registered to is an ACTIVE `owner` membership of that company whose user is human with a verified, non-empty email: `defaultResponsibleUserId` when eligible, otherwise the earliest owner (ties by principal id). It is frozen before the first mint. Nobody is invented: with no eligible owner the company waits at `owner_required` and nothing external is called. If an eligible owner's verified-email data would block a real owner, that is reported as a source/read-only data gap; it is not relaxed here. A company's creator becomes its owner right after creation, so an ensure that wins that race waits and the durable sweep completes it.

### Reviewed allowlist (mandatory)

The board catalog lists every board tool regardless of the token's scope. So discovery runs once, then only an exact allowlist is made usable: version 2 is `comms_whoami`, `comms_list_agents`, `comms_lookup_agent_by_email`, `comms_list_conversations`, `comms_get_conversation`, `comms_inbox`, `comms_get_hold_status`, `comms_start_conversation`, `comms_post_message`, `comms_accept`, `comms_decline_invite`, `comms_invite`, `comms_rename_conversation`, `comms_leave`, `comms_extend_conversation`, `proposals_submit`, `proposals_get`. Those become ACTIVE with `reviewedAt`; every other discovered action is DISABLED. This deliberately excludes `comms_register` (identity fork hazard), the admin tools (`comms_admin_register`, `comms_deregister_agent`, `comms_set_agent_shared`), the other `proposals_*` tools (`proposals_list_pending`, `proposals_list_history`, `proposals_withdraw`), and permanent or privileged conversation operations (`comms_archive_conversation`, `comms_reopen_conversation`). The template's default-deny `app:<id>` profile includes the allowlisted actions only. If discovery finds none of them, the template waits as `catalog_unreviewed`. New tools found later are quarantined by the existing refresh; they are never enabled automatically.

### No company-wide access, ever

The template is provisioning-only and has no install rows and no profile bindings. Every company, agent and gallery install path refuses it with 409 `managed_template_not_installable`, and the runtime install check is false for it regardless of the agent's state, including legacy agents with no `defaultMcp` state, an explicit install row, a company profile binding or a default organization grant. The generic "enable everything for the whole company" profile sync never runs for a managed template or a dedicated clone, on any refresh path (the 15-minute cache, UI refresh, gallery refresh). An install row or binding that appears later is reported as `template_drift` and is NEVER deleted automatically (those are user grants). Existing legacy agents are not retrofitted: no snapshot, install or permission is added to any agent that already exists.

### Flow, collisions and failure policy

1. **Find / adopt / create** (one local transaction, advisory-locked per company). Exactly one valid user-managed `rh-comms-board` (active, `api_key`, `mcp_remote`, one header credential) is trusted unchanged (its token scope and tool review are not inspected here and should be audited separately), with no writes, secrets, profiles, bindings or install changes. More than one, or a malformed one, or a reserved uid without the marker, or a conflicting application, fails closed: nothing is inserted or minted. Our own template archived by an operator is `template_revoked` and is never recreated.
2. **Mint** (the only external write): the checkpoint (`mintAttemptedAt`) is written BEFORE the POST. A 409, any 5xx, a network failure or a contradictory reply is terminal (`ownership_conflict` / `mint_unknown`) and is never retried or rotated. Only a definitive 400/401/403/422 of a locally validated request cannot have created a row; it clears the checkpoint and retries with capped backoff (bounded to 8 attempts). A taken vault key refuses before minting. If the process dies after storing the token but before recording its id, a later claim adopts only the provably owned secret (this company, the fixed key, local-encrypted, our own description, created at or after the checkpoint); anything else is a terminal `mint_unknown`. A store failure after a successful mint is terminal `secret_store_failed`.
3. **Credential + discovery**: a header `Authorization: Bearer` reference to the latest secret version and its bindings (the connection is still a draft), then the existing catalog refresh outside any transaction.
4. **Review + activation** (one local transaction, claim re-checked): the allowlist is applied, the profile reconciled, drift checked, then the connection is activated and the claim is `ready`.

Every checkpoint is a path-scoped write guarded by a random `claimId` (10-minute lease). A stale or losing worker changes nothing, and a stale catalog refresh cannot write back the claim.

A ready template is trusted only while its token is unexpired, its single header credential, vault secret, active/enabled state, empty installs/bindings and the allowlist version agree. A newer allowlist version re-runs discovery and review only (no new mint).

### Expiry is honest, not automatic

The template token lives 365 days. Nothing re-issues it silently. When it expires, or when the template drifts, the claim becomes terminal (`template_expired` / `template_drift`) and NEW agents wait with `template_expired` / `template_failed` instead of cloning a bad template. Existing per-agent clones are unaffected because each has its own token. Re-issuing the template credential is an explicit operator action, and standing issuance infrastructure is a separate ticket (TECH-7269). The same holds for every terminal template state (`mint_unknown`, `ownership_conflict`, `secret_store_failed`, `secret_unavailable`, `template_drift`, `template_expired`, `template_revoked`): the sweep never retries them, archiving the template does not recreate it, and recovery is an explicit operator action outside this feature (an unknown mint may have left a live registry row, which is why it is never repeated). Agents waiting on a template that has just become ready (`template_not_found`, `template_provisioning`, `template_unsupported`, `template_ambiguous`) get a path-only `nextAttemptAt` nudge so the next sweep picks them up; no other agent metadata is touched.

### Scope and rollout

The sweep (25 companies per 60-second tick, running before the per-agent sweep under the same flag and the same running guard) plus a create hook and a reactivate hook (both scheduled after their commit, never inside a transaction, tracked until finished) cover every `active` or `paused` company. Archived companies are excluded until reactivated; paused companies are eligible. Outcomes with no durable state (no eligible owner, collisions) are re-tried with in-process spacing (30 seconds doubling to 10 minutes) so they can never starve the sweep.

`PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS` is the single rollout scope for the whole default-MCP provisioning feature (the name says "template" for historical reasons; there is no second knob). It bounds BOTH the company template provisioning AND every per-agent claim, register and mint. It is parsed from the deployment environment once at the first bootstrap import and frozen (the CLI `.env` preload reserves the key, like the provisioner settings): unset = every company; set to an empty string = no company; a comma-separated UUID list = exactly those companies; anything malformed (a wildcard, a non-UUID, an empty entry) = NO company. Malformed input never widens the scope. Before the bootstrap capture the scope is also none. The final state is to leave it unset (all companies); no pilot company ids are hardcoded.

The same frozen predicate is applied before the eager per-agent claim, the agent sweep query and every external register/mint call. A company outside the scope is left completely untouched: no claim, no register, no mint, no verify-ready repair, no activity, and no `nextAttemptAt` change, even when it already has a valid template. In particular an existing valid USER-managed `rh-comms-board` template outside the scope yields NO register and NO mint for any agent of that company, so an empty scope is true containment and not only a template-provisioning stop. Ready entries, installs and metadata outside the scope are preserved exactly as they are. Agent creation still takes the local default-OFF snapshot (nothing external), so an agent created while its company is out of scope simply stays `pending` until the scope includes it. Per-agent behavior inside the scope is unchanged. Test suites that exercise per-agent setup therefore freeze an "unset" scope (all companies) at the start of each test.

After the pre-production tests pass, the intended rollout is the global default ON for every non-archived existing and future company, with per-agent access still OFF until an explicit install. This feature never installs, wakes or creates agent rows.

### Review hardening details (TECH-7271)

- **Immutable profile and exact allowlist.** The managed template's `app:<id>` access profile refuses every service mutation with 409 `managed_template_immutable`: add/update/delete of entries, the new-tools "allow" review, `updateProfile` (including `defaultAction`, `entries` and a `profileKey` re-key that would otherwise silently disable the guard), `deleteProfile` (including `force`, and as a `reassignToProfileId` target) and `bindProfile`. Unmanaged profiles are unaffected. A ready template is also verified against the EXACT reviewed allowlist: an ACTIVE action outside it, a profile entry that is not an include of an allowlisted action of this connection, an empty allowlist or an empty profile are all `template_drift` (terminal, reported, never auto-repaired). The per-agent clone repeats the filter and fails closed: non-allowlisted actions are cloned disabled, only allowlisted includes are copied, an existing clone re-run is narrowed the same way, and a managed template with no reviewed allowlist in the spec clones nothing usable (`template_unsupported`).
- **Owned-secret recovery.** After a crash between storing the token and recording its id, only a secret that is provably ours is adopted: this company, the fixed key, `local_encrypted`, our description, created by the frozen owner, and created at or after the checkpoint minus a bounded 30-second tolerance for app/database clock skew. Minting is refused while any active secret holds the key, so a foreign or pre-existing secret can never fall inside that window.
- **Same-name ambiguity.** The fixed-uid template is not exempt: a second unarchived `rh-comms-board` connection is reported as `template_ambiguous` (nothing claimed, minted or changed), and per-agent setup waits with the same reason until the operator archives the stray connection.
- **Agent setup after the credential exists.** If the template becomes unusable after an agent's register/mint, only transient reasons (`template_not_found`, `template_provisioning`, `template_ambiguous`) wait without budget. For a Paperclip-managed template the terminal reasons (`template_failed`, `template_expired`, `template_unsupported`) are bounded by the retry budget and end in `error`. An org-authored (user-managed) template is never terminal in that sense: while it is temporarily disabled or edited the agent keeps waiting (for example `template_unsupported`), and it resumes when the template is restored. Neither case repeats register or mint, and the stored credential and binding are kept. The 8-attempt budget is the entry's single `attemptCount`, which every claim increments, including the uncapped waiting ones, and it is checked when a retry result is stored. So the budget is SHARED, not a fresh 8: an agent that waited 9 or more times before a managed terminal state gets `error` on its first terminal result. An unexpected local failure is retried as `binding_failed` and logged by error class only.
- A `waiting` or `error` state does not revoke the retained JWT: it remains until actual expiry or explicit issuer-side revocation. Local disable/install-OFF state, secret deletion, and board `isSuspended` status are not full offline-JWT revocation.
- **Claim format and compatibility.** The claim is `version: 1` with the full structure validated on read (non-empty `entryKey`, `principalSub`, `ownerUserId`, `ownerEmailNorm`, `updatedAt`; a non-negative integer `attemptCount`; a positive integer `allowlistVersion` when set; string-or-null elsewhere). A claim that fails validation is never trusted (`template_unsupported` / `template_failed`). This is the first build that writes any managed template claim: none was ever deployed before it, so no older claim format exists and no migration or backfill is provided. If an operator ever finds a malformed row, the supported action is to quarantine it (archive it), which is terminal and never recreated, and then repair manually.
- **Rollout implication.** With the scope unset (the final target: every non-archived company; any staged pilot list is only an intermediate step) each company gets exactly one 365-day, `comms:read`-only template credential, minted through the existing ownership API. Per-agent access stays OFF until an explicit install, and the template is never installable.

## Legacy agent enrollment (TECH-7339)

For a legacy personal agent that needs comms but no private Arcana brain, send
`agentId` to `POST /companies/:companyId/default-mcp/comms-only-enrollment`. Use `dryRun: true`
first. The company-scoped selector limits enrollment to that agent; ordinary
connector access is preserved. Other managed setup hooks, including the private
brain, are marked `not_required` / `operator_excluded` without creating a brain,
credential or connection. The setup sweep and later brain backfill preserve
that exclusion. Without a ready brain, the daily private-brain profile routine
is not created. This separate path returns 404 on older servers; a restrictive
option cannot be silently ignored on this separate path. The new path rejects
pagination. Updated servers also reject `agentId` on the legacy endpoint, but older
pods ignore it and can enroll the whole company. Never send a targeted request to
the legacy endpoint, including during a mixed-version rollout; use only the new
path for a single agent. Existing managed snapshots are returned as `already_enrolled`
and left unchanged; this operation does not remove an existing brain.
To add comms while leaving the private-brain choice undecided, explicitly send
`arcanaBrainPolicy: "preserve"` on the same targeted endpoint. This omits the
Arcana entry instead of recording an exclusion. No brain or memory routine is
created. A later, explicitly authorized brain backfill can still add it. Existing
managed snapshots, including existing brain bindings and exclusions, remain
unchanged in either mode. Omitting the option (or sending `"exclude"`) retains
the personal-agent exclusion behavior described above. Older servers reject
this unknown option rather than silently selecting a brain policy.

If no verified creator is recorded, the new path can initialize the unowned
comms entry and reports `ownerAssignmentRequired: true`. It does not choose a
company owner or mint a credential. The operator then uses the existing
`comms-owner-assignment` route to assign the authenticated, verified, active
human caller. Setup waits at `owner_required` until that step completes.

For full legacy enrollment, `server/src/services/default-mcp-legacy-enrollment.ts`
brings an older agent up to the default managed state of a newly created agent.
It reuses `snapshotDefaultMcpForNewAgent`/`scheduleDefaultMcpSetup`; comms-only
enrollment deliberately passes exclusions and does not have the full default state.
Neither mode uses a client metadata PATCH, direct SQL edit or one-off token script.

It is invoked per company via `POST /companies/:companyId/default-mcp/legacy-enrollment`
(`dryRun`, `limit`, `afterId` in the body), gated the same way agent creation is: the feature flag
must be on, and the company must be inside `PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS`. Only a
company connection manager (owner/admin membership, `tools:manage_connections`, or an instance admin)
may call it.

Only an agent whose `defaultMcp` key is absent or null is eligible; this is the same legacy/unmanaged
definition used everywhere else in this document. An agent whose key is present but fails validation
is reported as `corrupted_existing_state` and left untouched rather than silently replaced -- that
state already fails closed at runtime (see "What OFF means" above), and enrollment does not
second-guess it. An already-enrolled agent is a silent no-op on a repeat pass: no duplicate identity,
connection, binding or credential is created. A row lock around the read-classify-write step makes
two overlapping enrollment calls on the same agent resolve to exactly one enrollment.

The owner recorded on a newly enrolled agent's entries is `resolveLegacyResponsibleUser`'s result:
the earliest verified-human actor on that specific agent's own `agent.created`/`agent.hire_created`
activity, or (if it was created by an agent or built-in) its earliest `agent.approved` activity.
There is no company-wide fallback -- a known candidate who isn't an active, verified-email company
member is treated the same as no candidate at all (`owner_required`), never silently substituted
with the company's owner/admin. Comms-board credential issuance still goes through the existing
`commsBoardIdentityHook`, which independently re-resolves and verifies that owner against active
company membership before minting; enrollment does not shortcut that check.

This endpoint only ever sets `agents.metadata.defaultMcp` and schedules the existing setup hooks. For
a genuinely legacy agent it goes through the identical install/curated-profile logic
`snapshotDefaultMcpForNewAgent` already applies to new agents; it never touches an agent that already
has a `defaultMcp` snapshot, so existing per-agent install choices made through any other path are
never overwritten by this endpoint.

Becoming snapshot-managed changes which installs count for an ordinary (non-dedicated) entry: see
"What OFF means" above -- only an explicit per-agent install applies once an agent has `defaultMcp`
state, where before enrollment a company-wide install applied too. Left alone, enrollment would
silently revoke access a company-wide install was granting a legacy agent, with no row ever changing.
Before snapshotting, enrollment inspects each ordinary entry's existing agent-or-company install: an
existing install that maps unambiguously to one valid template is carried forward as an explicit
per-agent install (the entry comes up ON, through the same reviewed install path a default-ON entry
uses); an existing install that can't be safely attributed to one valid template (an ambiguous
same-name collision, or a connection that fails the entry's template requirements) is never guessed
at -- the whole agent is skipped and reported as `legacy_access_conflict` rather than partially
enrolled.

## Arcana brain entry (`arcana-brain`, TECH-7252)

A second `managed_token` entry gives each new agent a private Arcana brain, via the `arcana_brain` setup hook. It is
`defaultEnabled: true` (TECH-7253, explicitly requested; no backfill): every NEW agent in a rollout-scoped company gets a brain. Because it is a
dedicated (`setupHook`) entry, the hook provisions it, not the ordinary install helper, so the field is declarative. It only runs under the same
`PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` flag and company rollout scope, and is inert until the Arcana server settings below
are configured: an unconfigured deployment leaves the entry `pending` with no connection, secret or call, and agent creation is never blocked.
Existing agents are not touched by creation (the one-time backfill is separate and explicit). A NEW agent's own dedicated connection is installed in the same transaction that creates it, so `ready` means installed for that agent only (`installOnReady`, consumed once; an owner's later uninstall is never undone, and backfilled/legacy agents are never installed implicitly). A company-wide connection or install can never widen an agent: the org template and other
agents' connections are not installable for a dedicated entry, and each agent's own connection carries only the reviewed verbs.

- **Server settings:** `PAPERCLIP_ARCANA_URL` and `PAPERCLIP_ARCANA_PROVISION_KEY` (the provisioning signing key; Paperclip mints a 60-second
  scope-`arc:brain:provision` JWT from it per request for Arcana's `POST /api/v1/brain/provision`). Both are frozen at boot, the key is scrubbed from the live environment, and both are
  reserved so a workspace `.env` cannot supply them. Missing: `provisioner_not_configured`; invalid URL:
  `provisioner_config_invalid`; both wait without creating anything.
- **Template:** Paperclip bootstraps the company's `rh-arcana-brain` template itself with a static catalog (see
  "Static-catalog template bootstrap" below). Until it exists the entry stays `pending` (`template_not_found`) and is
  nudged as soon as the template is created. An org-authored same-named `api_key` `mcp_remote` connection with exactly
  one header credential is adopted unchanged.
- **Flow:** Paperclip generates the exchange key and stores it first as the vault secret `arcana_brain.<agentId>`, then sends
  Arcana only its sha256. Arcana's provision route is idempotent, so an unknown outcome is a plain retry with the same hash.
  The per-agent connection, agent grant and credential binding are the same local stage the comms entry uses (credential label
  "Arcana brain exchange key"). A deleted, disabled or otherwise non-active secret for the key is never revived or replaced
  (`secret_unavailable`). Arcana `409` is terminal `provision_conflict`; other 4xx is `provision_rejected`.
- **Identity:** the Arcana principal and runtime ids are deterministic version-5-style UUIDs derived from sha256 of
  `paperclip:arcana-brain:<principal|runtime>:<companyId>:<agentId>`; the brain id is `agent:<principal id>`.

### Static-catalog template bootstrap (TECH-7253)

The `arcana-brain` entry sets `templateBootstrap: "static"`. Unlike the comms-board bootstrap (`true`), it needs no
company-level Arcana credential: the template cannot discover tools, so the five reviewed verbs (`recall`,
`search_pages`, `read_page`, `coverage`, `open_source`; `ARCANA_BRAIN_REVIEWED_TOOLS` v1) are seeded directly as
active read-only catalog entries.

- **URL:** `PAPERCLIP_ARCANA_MCP_URL` (frozen boot snapshot, not scrubbed). Missing/invalid: nothing is written and the
  result is `waiting` (`mcp_url_not_configured` / `mcp_url_invalid`).
- **Template:** an active `mcp_remote`/`api_key`/`shared` connection named `rh-arcana-brain` with a single `Authorization`
  header pointing at a placeholder vault secret (`default_mcp.arcana_brain.template_placeholder`). The placeholder is
  never used for traffic; each agent's dedicated connection carries its own exchange key. Identified by the fixed uid
  `rh-arcana-brain/default-mcp-template`.
- **Drift:** any catalog entry outside the reviewed verbs is disabled and a disabled reviewed verb restored; the
  `app:<connectionId>` profile stays default-deny with only those entries and no bindings.
- **Never overrides operators:** a same-named non-ours connection is adopted unchanged; two same-named connections report
  `template_ambiguous`; an archived template is never recreated.
- Runs after the comms ensure on company creation and in the periodic sweep (`sweepCompanyTemplates`).
- **Static-catalog marker and live refresh:** the template, and every per-agent clone of it, carry the server-owned config
  marker `defaultMcpStaticCatalog: "arcana-brain"` (stripped from client payloads and pinned across client config
  replacements). A catalog refresh of a marked connection (health check or board refresh) only ever sees the five reviewed
  verbs: tools the live server reports beyond them are never added or activated, and a reviewed verb is accepted ACTIVE when
  its real descriptor differs from the seeded placeholder (hash drift is not a review trigger for a fixed read-only verb). A
  reviewed verb whose live descriptor stops classifying as a plain read, or an operator-`disabled` verb, is not accepted
  (quarantined / stays disabled). Without this, the first live `tools/list` quarantined all five verbs (`pending_review`),
  leaving the connection healthy but `tool_not_found` for every call.
- **Repair of already-quarantined connections:** `repairStaticCatalogConnections` runs in the same periodic sweep
  (`sweepCompanyTemplates`; gated by the feature flag and rollout scope; local database work only). On connections that are
  provably ours (the fixed-uid template, or a per-agent connection an agent's own `arcana-brain` state names as its dedicated
  connection) it stamps the marker where missing and re-activates only the five reviewed verbs found `quarantined` with
  reason `pending_review`. Other connections, other tools, and `disabled` entries are untouched. It logs one
  `tool_connection.static_catalog_repaired` activity event per repaired connection and a second pass changes nothing.

### Backfill for existing agents (TECH-7326)

`server/src/services/arcana-brain-backfill.ts` gives agents that already exist an EMPTY private Arcana brain. It adds no
information to any brain: nothing is loaded, only the brain, its per-agent exchange key and its dedicated connection are
created. It uses the same hook and runner as new-agent creation (`arcanaBrainHook` through `runDefaultMcpSetupForAgent`),
restricted to the `arcana-brain` entry, so there is no second provisioning path.

Invoked per company via `POST /companies/:companyId/default-mcp/arcana-brain-backfill` (a connection manager, like legacy
enrollment). Body: `dryRun` (default `true`), `confirm`, `limit` (1-25), `afterId` (UUID cursor from the previous page).

Per agent it:
- adds ONLY the `arcana-brain` entry (path-scoped; another entry, owner or MCP setting is never rewritten; an agent with no
  `defaultMcp` state gets a state holding just this entry, so its legacy access is unchanged);
- runs only the arcana hook (never the comms-board hook);
- when setup finishes `ready`, installs the agent's OWN dedicated connection for that agent only, logs
  `agent.default_mcp.arcana_backfill_enabled`, and records `backfillEnable: "done"` on the entry. This is the one deliberate,
  logged exception to "defaults never silently enable existing agents", and it applies to Arcana only.

Outcomes: `would_provision` (census only), `provisioned`, `pending` (template or config not ready yet; the durable sweep carries it on and the next run enables
it as `enable_only`), `failed` (with a reason; isolated, leaves no grant, install or usable connection), `skipped` with a reason
(`already_provisioned`, `lost_race` (a concurrent change), `setup_in_progress`, `agent_terminated`, `agent_pending_approval`,
`company_archived`, `company_out_of_scope`, `corrupted_existing_state`). A failed entry
is reset to pending with a fresh retry budget and re-run; the stored vault key and Arcana's idempotent provision route make
that retry safe (same hash, no orphan key). A vault secret that was revoked on purpose stays `secret_unavailable`.

Gates: the framework flag, the Arcana provisioner settings (`PAPERCLIP_ARCANA_URL`, `PAPERCLIP_ARCANA_PROVISION_KEY`) and the
frozen company rollout scope. While one is closed a real run does nothing and the report says why (`blocked`); a census still
lists what a real run would do. Agents are processed one at a time with a pause (default 250 ms) between Arcana calls.

Runbook (DEV first; production only on an explicit go):
1. Deploy an image containing this change; set `PAPERCLIP_ARCANA_URL`, `PAPERCLIP_ARCANA_PROVISION_KEY`,
   `PAPERCLIP_ARCANA_MCP_URL` and the framework flag; scope the
   company with `PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS`.
2. Let the company template bootstrap finish (the sweep creates `rh-arcana-brain`).
3. Census: `POST .../arcana-brain-backfill` with `{}` and review `would_provision` against the expected agents.
4. Real run, page by page: `{"dryRun": false, "confirm": "provision-empty-arcana-brains", "limit": 25}`, then pass `nextCursor`
   as `afterId` until it is null.
5. Agents reported `pending` finish through the sweep; run the backfill again to apply their install (`enable_only`).
6. Re-run the census: every agent is reported `skipped` with reason `already_provisioned` and `counts.would_provision` is 0
   (a second real run provisions nothing).

Interaction with legacy enrollment (TECH-7339). This job never enrolls an agent in the other default-MCP entries, and
legacy enrollment treats an agent that already holds any `defaultMcp` state (including one holding only the arcana entry) as
managed and leaves it alone. So if you want existing agents enrolled in the other entries too, do that BEFORE this backfill and
BEFORE deploying an image whose spec contains the `arcana-brain` entry: enrolling on such an image gives the agent a full
snapshot including a ready arcana entry, which this job deliberately reports as `already_provisioned` and does not install
(it cannot tell "never installed" from "installed, then removed by the agent's owner", and it never overrides that choice;
install it from the app instead). If the flag is not yet live on the running image, enrollment is a no-op, so in that case
skip it or do it later knowing the agent then keeps only the arcana entry from this job.

## Arcana backfill: entries stuck on an archived dedicated connection (`recreate_archived`)

An arcana entry that is `pending`/`error` (typically `binding_failed`) or `ready` (enabled, but with no working tools) whose stored `connectionId` resolves to an ARCHIVED connection
named exactly this agent's own dedicated name (`rh-arcana-brain:<agentId>`) can never finish: setup looks the connection up by the stored id
and does not clone a new one. The backfill plans `recreate_archived` for it (census: `would_provision` with `plan: "recreate_archived"`).
A real run (same `dryRun`/`confirm` rules) clears the entry `connectionId` and the binding `connectionId`/`grantId` (the vault secret
is kept, so no second key or brain), renames the archived connection's stale access profile (profile names are unique per company; it is
renamed, never deleted), resets setup to pending with a fresh retry budget plus the enable marker, writes
`agent.default_mcp.arcana_connection_recreate_requested`, then runs the normal setup, which clones a fresh connection by name and
the usual enable step installs it. Any other archived connection (an org template, a live one, another agent's) is never matched and
"revoked" stays terminal. A `ready` entry on a LIVE connection is still `already_provisioned`. For a `ready` entry the reset
sets the enable marker back to `pending`, so the enable step installs the NEW connection for that agent; afterwards the stored
`connectionId` points at the live clone, so a rerun does not match again.

## Comms-board credential rescope (existing agents)

Agents created before `comms:proposals:write` joined `COMMS_BOARD_TOKEN_SCOPES` hold a token with only `comms:read` and
`comms:write`, and minting is skipped once a binding exists. `server/src/services/comms-credential-rescope.ts` rotates those
credentials onto the current scope set. It runs only when an operator calls it.

`POST /companies/:companyId/default-mcp/comms-credential-rescope` (a connection manager: owner/admin, `tools:manage_connections`,
or instance admin; board only). Body: `dryRun` (default `true`), `confirm`, `limit` (1-25), `afterId` (UUID cursor).
A real run needs `dryRun: false` and `"confirm": "rotate-comms-board-credentials"`. The response is
`{ dryRun, targetScopeVersion, scanned, outcomes: [{ agentId, companyId, result }], counts, nextCursor }`: counts and agent ids
only, never a token, secret id, vault key, bearer or URL.

**The marker.** The scopes of an existing opaque token cannot be read back, so the entry records the scope-set version it was
minted or rotated with: `binding.commsScopeVersion` (constant `COMMS_BOARD_TOKEN_SCOPES_VERSION`, currently 2, next to
`COMMS_BOARD_TOKEN_SCOPES`). No marker or an older one means "needs rescoping". New mints record the current version. Bump the
constant whenever the scope set changes. Only the server writes it (the whole `defaultMcp` metadata key is reserved and stripped
from client updates).

**Per eligible agent** (not terminated, `comms-board` entry `ready`, dedicated, with a bound connection, grant and managed secret):
1. the local wiring is checked first; a broken one is `skipped_wiring_invalid` and nothing is rotated;
2. one ownership API `POST /agents/{sub}/rotate` with exactly the current scopes and `expires_in_days` (no retry);
3. the new token is written as a NEW VERSION of the existing managed secret (the connection already points at `latest`);
4. the wiring and that `latest` is the new token are verified;
5. only then the marker and the new expiry are recorded. Neither failure advances the marker, and the next run rotates again.
   - A secret write failure leaves the OLD version as `latest` (the new token is lost; the old one still works) and records a
     `binding.rescope` failure (`tokenMinted: true`).
   - A verify failure happens AFTER the write, so the NEW token is already `latest`; it records the same visible
     `binding.rescope` failure (`tokenMinted: true`).
   - `marker_write_failed` also happens after the write (the new token is `latest`), but records NO `binding.rescope` marker
     and logs nothing: the only signal is that outcome in the response, and the next run reports the agent as needing rescoping again.

Outcomes: `would_rescope` (census), `rescoped`, `already_current`, `skipped_*` (`terminated`, `company_archived`, `no_entry`,
`not_ready`, `not_dedicated`, `wiring_invalid`), `provisioner_not_configured` / `provisioner_config_invalid` (no HTTP call is
made), `rotate_unknown_sub` (404), `rotate_deactivated` (409), `rotate_rejected` (401/403), `rotate_failed`, `secret_write_failed`,
`verify_failed`, `marker_write_failed`, `rescope_error`. One agent failing never stops the batch.

**Operator notes.** Run the census first (`{}` scans only the first page; page it with `limit` and `afterId` = previous
`nextCursor` to see every agent). Then run the real pass as its own sequence: the first real request has NO `afterId`, and each
following one uses `afterId` = the previous real response's `nextCursor` until it is null. Never feed a census `nextCursor` into
the first real run, which would skip every agent on the pages before it. The OLD token stays valid until its own expiry (the registry rotates by re-minting, it does not revoke). Re-running is safe:
agents already at the current version are `already_current` and cause no call; failed ones are retried. Uses the server's
boot-captured ownership credential; no new environment variables.

## Comms-board catalog resync (existing agents)

A dedicated comms-board connection is a clone of the company template, and `cloneTemplateAccess` only ever narrows an
existing clone. Agents cloned while the reviewed allowlist was version 1 therefore keep `proposals_submit` and
`proposals_get` DISABLED and outside their `app:<connectionId>` profile, even though the template (and every new clone) has
them active. `server/src/services/comms-catalog-resync.ts` widens those clones onto the CURRENT allowlist, operator-triggered:

`POST /companies/:companyId/default-mcp/comms-catalog-resync` (connection manager, board only). Body: `dryRun` (default `true`),
`confirm`, `limit` (1-25), `afterId` (UUID cursor). A real run needs `dryRun: false` and `"confirm": "resync-comms-board-catalogs"`.
The response is `{ dryRun, scanned, outcomes: [{ agentId, companyId, result, tools? }], counts, nextCursor }`: counts, agent
ids and tool names only.

**Per eligible agent** (not terminated, company not archived, `comms-board` entry `ready`, dedicated, bound connection with
intact wiring), in ONE transaction under the same per-agent advisory lock as the setup stage:
1. the managed template is resolved against the current reviewed allowlist (only a verified-usable template is used);
2. `cloneTemplateAccess` runs with the allowlist: it inserts missing clone catalog rows and missing profile includes, and
   (as always) can only narrow anything outside the allowlist;
3. every allowlisted tool that is ACTIVE on the template and not active on the clone is set active with `reviewedAt`.

It never touches a tool outside the allowlist, never widens a tool the template itself has not made active (quarantined or
disabled on the template stays that way on the clone), never creates an install, and never changes credentials. A re-run
reports `already_current`. Outcomes: `would_widen` (census), `widened`, `already_current`, `skipped_terminated`,
`skipped_company_archived`, `skipped_no_entry`, `skipped_not_ready`, `skipped_not_dedicated`, `skipped_wiring_invalid`,
`skipped_template_unavailable`, `resync_error`. Activity event: `agent.default_mcp.comms_catalog_resynced` (key, connection id,
allowlist version and tool names only).

**Operator notes.** Run the census first and page it with `limit`/`afterId` as for the other routes; run the real pass as its
own sequence starting with no `afterId`. This does not rotate tokens: agents whose token predates `comms:proposals:write` still
need the credential rescope above before `proposals_submit` succeeds at the board.

## Company visibility backfill and comms-board `is_shared` sync (existing companies and agents)

Comms-board registration reads the owning company's `visibility` once and sends `is_shared` (`shared` => true; `private` or
unclassified NULL => false). The board freezes that value at first registration, and `companies.visibility` itself is set at
creation and rejected by the update route (TECH-7390). Companies created before the column existed carry NULL, so their agents
registered as private. Two operator routes correct this after the fact.

**Company classification.** `POST /companies/:companyId/visibility-backfill` (company owner or instance admin; board only).
Body: `visibility` (`private` | `shared`, required), `dryRun` (default `true`), `confirm`, `allowNarrowing`. A real run needs
`dryRun: false` and `"confirm": "set-company-visibility"`. A NULL company is set to the requested value (one guarded UPDATE, so it
is write-once); the same value is `already_current`; `shared` -> `private` happens only with `allowNarrowing: true`; `private` ->
`shared` is never done; an archived company is refused. Response: `{ dryRun, companyId, requested, before, after, result }` with
`result` one of `would_set`, `set`, `would_narrow`, `narrowed`, `already_current`, `refused_narrowing_requires_flag`,
`refused_private_to_shared`, `refused_company_archived`, `company_not_found`, `changed_concurrently`. Each change records a
`company.visibility_backfilled` activity event with `from`/`to`. A `private` company accepts no human invitations or member
additions, so narrowing is an explicit act.

**Agent sync.** `POST /companies/:companyId/default-mcp/comms-shared-sync` (connection manager, board only). Body: `dryRun`
(default `true`), `confirm`, `limit` (1-25), `afterId`. A real run needs `"confirm": "sync-comms-board-shared"`. For each ready,
dedicated comms-board agent with a board agent id and intact wiring (terminated agents and archived companies are skipped), the
target is `company.visibility === "shared"` (NULL targets private and the outcome carries `visibilityUnset: true`). If
`binding.commsSharedSynced` already equals the target the agent is `already_current`; otherwise a real run makes ONE board admin
`comms_set_agent_shared` call (same admin credential and MCP handshake as registration, no retry) and only then records the
marker. Setting a boolean is idempotent, so re-running is the retry. An agent with no marker (every agent before its first sync)
gets one call that matches what registration already sent. Outcomes: `would_sync`, `synced`, `already_current`, `skipped_*`,
`provisioner_not_configured` / `provisioner_config_invalid` (no call is made), `set_shared_unknown_agent`, `set_shared_rejected`,
`set_shared_failed`, `marker_write_failed` (the board value is correct; the next run repeats the call), `sync_error`. The report
carries counts, agent ids and the target value only. Run the classification first, then the sync.

## Arcana brain directory binding (TECH-7693)

ACA keeps a permanent, insert-only table mapping each comms board sub to its Arcana principal, runtime, company, brain id and
agent id. Paperclip is the only writer. Once an agent's `comms-board` and `arcana-brain` entries are BOTH ready, the default-MCP
sweep (every tick, as its last step) makes one `PUT {PAPERCLIP_COMMS_BOARD_OWNERSHIP_API_URL}/brain-bindings/{boardSub}` with
`PAPERCLIP_ARCANA_BINDING_TOKEN` (scope `arcana:bind` only). The call is idempotent (201 created, 200 identical replay). ACA
re-derives every id from the same recipe and refuses a sub that Paperclip's ownership credential did not register. The provisioning
hook now stores `arcanaRuntimeId`, `arcanaBrainId` and `arcanaRecipeVersion` on the arcana binding; the recipe stays a check on
writes (a stored id that disagrees is `identity_mismatch` and nothing is sent). Only a sub Paperclip minted is sent: the comms
entry's recorded `boardSub` must equal the recipe sub for its `identityGeneration` and carry no legacy agent key.

A settled answer is recorded on the arcana binding as `brainBinding {state, boardSub, generation, at}`: `bound` (201/200),
`conflict` (409) or `rejected` (403/422). A transient failure (ACA down, 401, 404, 429, 5xx, timeout) records nothing and the next
sweep retries. A marker for a different board sub (a reissued identity, which is a new generation) does not count, so the new sub is
bound; the old generation was never bound because reissue only applies to entries that never became ready. Paperclip cannot delete
(ACA's delete is human-Okta only), so nothing is retired.

**Operator route.** `POST /companies/:companyId/default-mcp/arcana-brain-binding` (connection manager, board only). Body: `dryRun`
(default `true`), `confirm` (`"bind-arcana-brains"`), `limit` (1-25), `afterId`, `retrySettled` (re-attempt a recorded conflict or
rejection). Outcomes: `would_bind`, `bound`, `already_current`, `conflict`, `rejected`, `identity_mismatch`, `skipped_*`,
`binding_not_configured` / `binding_config_invalid` (no call is made), `bind_failed`, `marker_write_failed`, `bind_error`. The
report carries counts and agent ids only. The sweep walks candidates in id order with a rotating cursor (10 per tick, ending the
tick after three transient failures in a row), so an agent that can never be bound cannot starve the others. Terminated agents and archived companies are skipped; `pending_approval` agents are excluded from the sweep and reported as `skipped_pending_approval` by the route.

## Assigning an owner to stuck comms-board entries (`owner_required`)

An entry's `ownerUserId` is frozen from the server-side actor when the agent is created. An agent created by another agent, a
built-in or a plugin has none, so comms-board setup waits at `pending` / `owner_required` and retries on its backoff
indefinitely. `server/src/services/comms-owner-assignment.ts` lets a human connection manager take responsibility for named agents:

`POST /companies/:companyId/default-mcp/comms-owner-assignment` (connection manager, board only). Body: `dryRun` (default `true`),
`confirm`, `agentIds` (REQUIRED, 1-25 agent UUIDs, never company-wide). A real run needs `dryRun: false` and
`"confirm": "assign-comms-board-owner"`. The response is `{ dryRun, scanned, outcomes: [{ agentId, result }], counts }`: counts and
agent ids only.

**The owner is always the authenticated caller**, never a body value, and must be an ACTIVE member of that company with a verified
email (instance admin is not a bypass). Otherwise every listed agent reports `owner_ineligible` and nothing changes. Registering an
agent on the comms board attributes it to its owner's ownership set, so only assign agents you are prepared to be responsible for.

**Per listed agent** (in the company, not terminated, company not archived): only when the `comms-board` entry exists, is
`pending` with reason `owner_required`, and has no owner, the entry's `ownerUserId` is set to the caller and its retry schedule is
reset (`nextAttemptAt` now, `attemptCount` 0). The UPDATE restates those preconditions in its own `WHERE`, so a concurrent setup run
or assignment makes it a no-op. Nothing else is written: no token is minted and no agent is registered here; the existing setup
sweep (every 60 seconds) performs the registration with the same checks as for any new agent, and reports its own failure reasons
(for example `board_conflict`) as usual. Outcomes: `would_assign` (census), `assigned`, `already_has_owner`,
`skipped_not_owner_required` (any other state or reason), `skipped_no_entry`, `skipped_terminated`, `skipped_company_archived`,
`agent_not_in_company` (also reported for an id from another company), `owner_ineligible`, `assign_error`. Activity event:
`agent.default_mcp.comms_owner_assigned` (entry key and owner user id only). A re-run reports `already_has_owner`.

## Following an owner reassignment (comms-owner-sync)

A human-approved reassignment (agent-comms-approvals `/ownership/reassign`, TECH-7389) changes the owner in the ownership registry and
on the board's agents row and leaves the credential unchanged, but the entry's frozen `ownerUserId` still names the old owner. It is
read when an agent hires another agent (the child inherits it while that user is an active member), when setup is re-run and when a
credential is rotated. `server/src/services/comms-owner-sync.ts` makes it follow the registry:

`POST /companies/:companyId/default-mcp/comms-owner-sync` (connection manager, board only). Body: `dryRun` (default `true`), `confirm`,
`limit` (1-25), `afterId`. A real run needs `dryRun: false` and `"confirm": "sync-comms-board-owner"`. The response is
`{ dryRun, scanned, outcomes: [{ agentId, companyId, result, registrySub }], counts, nextCursor }`: counts, agent ids and registry subs only.

**The new owner comes only from the registry** (`GET /ownership/{baseSub}`, which needs `ownership:read` on Paperclip's ownership
token), never from the request. Per ready, dedicated entry with a bound managed secret: an inactive or unknown sub, a rejected token or
a failed read changes nothing; an owner whose email already matches (case-insensitive) is `already_current`; otherwise the registry
email must resolve to exactly one user with a verified email and an ACTIVE membership of this company (`registry_owner_not_member`
or `registry_owner_ambiguous` change nothing). The write sets only `ownerUserId` and restates in its own `WHERE` that the entry is
still ready, still bound to the same managed secret and still holds the owner that was read (`lost_race` otherwise). A census makes
the same reads and writes nothing. With no provisioner configuration no call is made. Activity event:
`agent.default_mcp.comms_owner_synced` (entry key, `fromUserId`, `toUserId`; no email). The company template credential's recorded
owner is not touched here.

## Reissuing the comms-board identity after a `board_conflict`

Setup registers an agent on the board under `paperclip-agent-<agentId>` (display name `<name> (<first 8 of the agent id>)`) and never
upserts. When the board already holds that sub, that display name, or another identity under the same base sub, it answers
`already_registered`, `display_name_collision` or `identity_fork_detected`, and setup stops in the terminal `error` /
`board_conflict` state (an `error` state is never retried). The board and the ownership registry never reuse a registered sub, and the
existing registration may still be in use, so the fix is to register the agent under a NEW identity and leave the old one alone.
`server/src/services/comms-identity-reissue.ts` does that, operator-triggered:

`POST /companies/:companyId/default-mcp/comms-identity-reissue` (connection manager, board only). Body: `dryRun` (default `true`),
`confirm`, `agentIds` (REQUIRED, 1-25 agent UUIDs, never company-wide). A real run needs `dryRun: false` and
`"confirm": "reissue-comms-board-identity"`. The response is `{ dryRun, scanned, outcomes: [{ agentId, result, generation? }], counts }`:
counts, agent ids and the new generation only.

**Identity generation.** The comms-board entry carries a server-owned `identityGeneration` (absent or `0` is the original recipe).
Generation `N >= 1` uses the base sub `paperclip-agent-<agentId>-r<N>` and the display name `<name> (<id8>-r<N>)`. The new sub is a
different base sub (the board groups identities by the part before the first `::`), so the board's identity-fork guard does not tie it
to the old registration, and the suffixed display name cannot collide with the old one. Every later step reads the recorded
`binding.baseSub` / `binding.boardSub`, never the bare recipe: the credential mint (and the rescope rotation) uses the new base sub,
the connection wiring check uses the stored binding. Systems keyed by the board sub outside Paperclip (for example the Arcana pilot
principals list in agent-comms-approvals) must use the NEW sub for a reissued agent.

**Per listed agent** (in the company, not terminated, company not archived): only when the `comms-board` entry is in state `error`
with reason `board_conflict` and holds neither a board agent id nor a managed secret, the entry gets `identityGeneration + 1`, its
binding is cleared, and its setup becomes a fresh `pending` (reason cleared, `attemptCount` 0, `nextAttemptAt` now, no claim or lease,
the register and mint checkpoints cleared). The frozen `ownerUserId`, the connection and every other entry on the agent are kept. The
UPDATE restates all of those preconditions in its own `WHERE`, so a concurrent setup run or reissue makes it a no-op. Nothing is
registered, minted, installed or deleted here: the existing setup sweep (every 60 seconds) performs the registration with the same
checks as for any new agent, including the company's `is_shared` flag. Outcomes: `would_reissue` (census), `reissued`,
`skipped_not_board_conflict` (any other state or reason, including an entry already reissued and now pending or ready),
`skipped_has_credential` (a partial registration is never orphaned), `skipped_generation_limit`, `skipped_no_entry`,
`skipped_terminated`, `skipped_company_archived`, `agent_not_in_company` (also reported for an id from another company),
`reissue_error`. Activity event: `agent.default_mcp.comms_identity_reissued` (entry key and the from/to generation only).

## Adding missing managed entries to agents that already have a state

Legacy enrollment only touches agents with NO `defaultMcp` state. Agents that got a state holding only `arcana-brain` (from the
Arcana backfill) therefore never received a `comms-board` entry. `server/src/services/default-mcp-missing-entry-enrollment.ts`
closes that gap, operator-triggered:

`POST /companies/:companyId/default-mcp/missing-entry-enrollment` (connection manager, board only). Body: `dryRun` (default
`true`), `confirm`, `limit` (1-25), `afterId`, `responsibleUserId` (optional). A real run needs `dryRun: false` and `"confirm": "add-missing-default-mcp-entries"`.
Response: `{ dryRun, blocked, scanned, outcomes: [{ agentId, companyId, result, keys, responsibleSource | reason }], counts, nextCursor }`,
ids and entry keys only. `responsibleSource` (`audit_log` | `operator_override`) is on `would_add` and `added` outcomes.

Operator override for the responsible user: agents created by other agents have no user in the audit log, so they are
`owner_required` forever. `responsibleUserId` (a user id string, as in `auth_users.id`) is applied ONLY to agents whose audit log
resolves no owner and never replaces one that does. The user must pass the same check as an audit-log candidate (active `user`
membership in the company, verified email), else the whole request is a 400 and nothing is scanned. It works in dry runs (the
agent shows `would_add` with `responsibleSource: "operator_override"` instead of `owner_required`) and real runs; each agent
enrolled through it gets one `agent.default_mcp.responsible_user_override` activity entry (actor: the calling user; details:
`responsibleUserId` and the added keys). No audit rows are fabricated for the agent itself.

Which entries: every spec entry with a `setupHook` that the agent lacks, except `arcana-brain` (own backfill; never added, cleared
or rewritten here). Ordinary OAuth entries are never added. For each such agent (state present and valid, not terminated, company
not archived and in the rollout scope) it resolves the responsible owner exactly like legacy enrollment (`owner_required` in both
dry and real runs), honours `legacy_access_conflict`, builds the entry with `snapshotDefaultMcpForNewAgent` (the same initial
pending form), writes only the missing entry keys by path under a row lock, and schedules the same setup run restricted to the
added entries so the credential is minted (the 60s sweep is the backstop). Other skips: `corrupted_existing_state`,
`no_default_mcp_state` (use legacy enrollment), `nothing_missing`, `lost_race`. A re-run is a no-op for agents that have every
entry. Run the census first, then page real runs with `nextCursor`. Requires the framework flag; otherwise `blocked: feature_flag_off`.

## Standard daily job: keep the Arcana one-pager up to date (TECH-7713)

`server/src/services/default-agent-profile-routine.ts`. The auto-approval gate needs a source `agent-profile` (20..8000 chars, at
least 24h old) in the agent's own private brain; the agent writes it itself with `proposals_submit`. Every agent gets one ordinary
routine (daily schedule trigger, UTC, per-agent deterministic time 07:00-10:59, `skip_if_active`, assigned to the agent, visible
and pausable in the Routines UI) that runs `skills/paperclip/references/agent-profile-upkeep.md`.

Attachment: `sweepAgentProfileRoutines` runs in the 60s default-MCP sweep after the brain-binding sweep, for new AND existing
agents alike. An agent is eligible when it is not paused/terminated/pending approval, its company is not archived and is in the
rollout scope, and BOTH its `comms-board` and `arcana-brain` entries are `ready` (so `owner_required`, error and no-Arcana agents
get a routine only once they become ready). The routine is keyed `(origin_kind = default_agent_profile, origin_id = agent id)`:
a routine in any status, including one an owner archived, means settled, so the sweep never duplicates or revives it. A
terminated agent's routine is archived. The routines are not exported by company portability.

Flag: `PAPERCLIP_DEFAULT_AGENT_PROFILE_ROUTINE_ENABLED=true` (default off; also needs `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED`).
Unsetting it stops new routines; pause or archive existing ones to stop runs.

Behaviour of a run: no one-pager and no pending profile proposal: draft and propose `arcana_source_add` (held for one human; a new
brain has nothing to cite). One-pager exists, or a profile proposal is pending: do nothing. `arcana_source_revise` for the profile is
NOT used: the Arcana pilot backend has no revise route (`apply_source_revise` is determinately unsupported, TECH-7161), so an
approved revise would fail with `apply_failed`. Updating the reference doc is how revise gets enabled once Arcana supports it.

## Shared-org rh-mcp service token (`rh-mcp-service`, TECH-8066)

Personal orgs keep the OAuth `rh-mcp` seed. A company whose `visibility` is `shared` instead gets one bot-token
connection to rh-mcp named `rh-mcp-service`, so no agent depends on one person's OAuth session.

- **Off by default.** Set `PAPERCLIP_SHARED_ORG_RH_MCP_ENABLED=true` (also needs the default-MCP spec flag, the rh-mcp URL in
  `PAPERCLIP_DEFAULT_MCP_RH_MCP_URL`, and the comms ownership API credentials). Rollout follows the company template scope.
- **One token per org**, minted through the ownership API (`paperclip-rh-mcp-<companyId>`), never by Paperclip. Scopes are the
  closed allowlist in `RH_MCP_SERVICE_TOOLS_BY_SCOPE` (read scopes, plus the async comps run scope and decision grid scope): Argus review, MDM read, Opik read, Coresignal, Definitive Healthcare, the
  voice humanizer checklist, `voice_apply` (same `voice:read` scope; degrades to the universal checklist for a service token; 60 s timeout), the async comps verbs (`comps:run`: `comps__start`/`comps__get`/`comps__cancel`, TECH-8433), and decision grid (`decisions:run`: `decisions_run_grid`, 60 s timeout as the tool self-caps its own budget at 45 s and returns partial results rather than overrunning, TECH-9109). Never `supabase:*` (Ashby views are readable under `supabase:read`), writes, secrets or impersonation.
- **Offered tools equal the scopes.** The spec entry's reviewed allowlist is derived from the same map; identity-keyed tools
  (annotations, Granola status, voice guides) are left out because a service identity has no meaningful answer for them.
- **Lifecycle.** A periodic sweep (startup, then every 5 minutes) mints, connects, enables exactly the reviewed tools and installs
  live agents. New agents get it from `defaultEnabled`. The token is re-issued into a new vault version 60 days before expiry
  (expiry kept in `config.rhMcpServiceTokenExpiresAt`). When `RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION` advances, the sweep reconciles
  existing active connections (stored in `config.rhMcpServiceReviewedToolsVersion`) to re-apply the reviewed tools set without recreating the connection.
- **Scope changes do not reach existing orgs automatically.** The token's scopes are the keys of the map, and an issued token
  keeps its scopes until it is re-issued (60 days before expiry, or by hand with `POST /agents/{sub}/rotate` on the ownership
  API). After adding a scope such as `comps:run` or `decisions:run` (TECH-9109), rotate each org's token manually: `POST /agents/paperclip-rh-mcp-<companyId>/rotate` with a JSON body of
  `{"scopes": <every key of RH_MCP_SERVICE_TOKEN_SCOPES>, "expires_in_days": <days>}`, then store the returned `token` as a new version of the
  connection's vault secret (the API call alone does not update Paperclip; the old token keeps its old scopes until it expires). Bump `RH_MCP_SERVICE_REVIEWED_TOOLS_VERSION`
  whenever a scope or tool is added (a tool under an existing scope, like `voice_apply`, needs no rotation; adding a new scope like `decisions:run` requires a manual rotation of every shared org's token). The Argus and comps verbs get a 30 s per-call timeout (api-main cold starts); `decisions_run_grid` gets the 60 s gateway ceiling (the tool self-caps its own budget at 45 s and returns partial results rather than overrunning).
- **Opt-out:** archive the `rh-mcp-service` connection; it is not re-created.

## Credential health and OAuth callback failures

Failed OAuth callbacks record connection health (`error` status and message) on the `tool_connections` row only when establishing the connection's own credential:
- Organization identity (`!subjectUserId && !subjectAgentId`) under an allowlisted credential policy (`shared` or `per_user_with_fallback`).
- Strict personal default MCP instance where the consenting subject is the instance owner (`subjectUserId === createdByUserId`).

Per-user and per-agent OAuth callback failures never mutate the shared connection row. This ensures that an individual user's consent denial or upstream authorization error does not poison or disrupt the shared connection health for other users and agents across the organization.

## Agent memory entry (`agent-memory`, TECH-8409)

Not an MCP connection: it has no template, no install and no tools. It gives a NEW `hermes_local` or `claude_local` agent (including a native-runner agent whose harness is Claude) its own memory credential and harness settings, so recall and capture go through an external memory service instead of Paperclip's in-process runtime memory. Paperclip holds only generic config and the credential.

Enable it with `PAPERCLIP_AGENT_MEMORY_ENABLED=true` and `PAPERCLIP_AGENT_MEMORY_URL` (plus optional `PAPERCLIP_AGENT_MEMORY_PROXY`), on top of `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` and the comms-board provisioner settings (the ownership registry mints the token). It is off by default and applies only to agents created while it is on: the entry has `newAgentsOnly`, so legacy enrollment never adds it and missing-entry enrollment adds it only under the explicit backfill flag below.

Setup hook `agent_memory`, per new agent:

1. Waits (no external call) while the memory settings, the registry settings or the frozen owner are missing.
2. Writes a mint checkpoint, then mints `agent-memory-<agentId>` through the ownership registry: scopes `memory:read` and `memory:write` only, expiry 90 days (comms credentials stay at 365 days).
3. Stores the token as the company secret `agent_memory.<agentId>`. A checkpoint without a stored secret is an unknown outcome (`mint_unknown`): terminal, never re-minted. A disabled or deleted secret is never revived (`secret_unavailable`).
4. Writes the agent's `adapterConfig` through the agent lifecycle update (which records a revision and syncs secret bindings), merging the keys of the adapter's profile in `AGENT_MEMORY_ADAPTER_PROFILES` (`default-mcp-agent-memory.ts`). `hermes_local`: `env.MEM0_API_KEY` (secret reference), `env.MEM0_HOST`, `env.MEM0_PROXY` (when configured), `env.MEM0_USER_ID` (the agent id), `memoryProvider: "mem0"` and `runtimeMemory: false`. `claude_local` and `codex_local`: `env.RH_MEMORY_TOKEN` (secret reference), `env.RH_MEMORY_URL`, `env.RH_MEMORY_PROXY` (when configured), and `env.RH_MEMORY_CAPTURE` (default `"off"`; recall-only). A native-runner (`paperclip_runner`) agent is enrolled as Codex only when its config names Codex (`provider: "codex"`, or `provider: "acpx"` with `acpxAgent: "codex"`); the runner default with no provider is not enrolled. Other `env` keys are kept. Another harness is one more table entry. A failure here is a bounded retry; nothing external is repeated.

Claude and Codex agents are recall-only by default: end-of-turn capture is disabled by projecting `RH_MEMORY_CAPTURE="off"` into `adapterConfig.env` unless the server has `PAPERCLIP_AGENT_MEMORY_CAPTURE=on` (an explicit operator-configured `RH_MEMORY_CAPTURE` is preserved across re-enrollment and backfill). Recall continues to operate before each prompt. Agents already enrolled keep capturing until an operator sets `RH_MEMORY_CAPTURE=off` in their `adapterConfig.env` (since `adapterConfig.env` is replaced wholesale on `PATCH`, every other env key must be resent); recall always works, and these agents are recall-only because the service gives them no other write path.

The token is never logged and is not stored anywhere except the secret.

### Backfill for existing agents (agent memory)

Existing agents are enrolled by the operator-run missing-entry job (`POST /api/companies/:companyId/default-mcp/missing-entry-enrollment`), which reuses the same hook, so one mechanism serves new and existing agents. It adds `agent-memory` only while `PAPERCLIP_AGENT_MEMORY_BACKFILL_ENABLED=true` with a valid memory configuration, only for agents of a profiled adapter, and only for agents that already hold a default-MCP state (legacy agents with none are enrolled by legacy enrollment first). With the flag off, `keys: ["agent-memory"]` reports every agent as `nothing_missing`. Pass `"keys": ["agent-memory"]` to restrict the run to this entry; without it the job also adds any other missing managed entry, as before.

Run it per company, batch by batch:

1. Dry run (the default): `{ "keys": ["agent-memory"] }`. The report lists `would_add` agents and the reasons for skips (`owner_required` when the agent has no resolvable human owner). Nothing is written or minted.
2. Real run: `{ "keys": ["agent-memory"], "dryRun": false, "confirm": "add-missing-default-mcp-entries", "limit": 25 }`. Each added agent is set up by the normal hook (mint, secret, config). Pass the returned `nextCursor` as `afterId` to resume; a repeat run skips agents that already have the entry (`nothing_missing`).

The registry is insert-only per sub. An agent whose memory token was minted by hand (`agent-memory-<id>` already registered) ends at `ownership_conflict`; configure those agents manually, as before. Setup output never contains a token.

### `agent-memory-tools` (TECH-8832)

Explicit memory tools for Claude and Codex agents, beside the recall/capture hooks. It is a `templateBootstrap: "static"` dedicated entry (`setupHook: "agent_memory_tools"`, `newAgentsOnly`, `installByDefault`) whose template connection `rh-agent-memory-tools` points at `${PAPERCLIP_AGENT_MEMORY_URL}/mcp` and offers exactly `memory_search` (read), `memory_add` and `memory_delete` (reviewed writes; `memory_delete` removes only the caller's own rows, so it is seeded non-destructive and a live `destructiveHint` does not demote it). `memory_purge_agent` (admin) is never reviewed. The hook mints nothing: it waits (`memory_token_unavailable`) until the agent's own `agent-memory` entry is ready, then binds that same secret (`agent_memory.<agentId>`) to the agent's dedicated gateway connection, so rotation of that secret reaches the connection and the CLI only ever talks to Paperclip's gateway (no proxy or upstream token in the container). 

Flags and enrolment: it needs `PAPERCLIP_AGENT_MEMORY_TOOLS_ENABLED=true` on top of `PAPERCLIP_AGENT_MEMORY_ENABLED`, a valid `PAPERCLIP_AGENT_MEMORY_URL` and `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` (see the environment variable reference). New Claude and Codex agents get it at creation. Existing agents are enrolled with `"keys": ["agent-memory-tools"]`, which also needs `PAPERCLIP_AGENT_MEMORY_BACKFILL_ENABLED=true` and an `agent-memory` entry already present in the agent's metadata (its state is not checked at enrolment; setup waits until it is ready). Because the entry is `installByDefault` and a backfilled entry carries no `installOnReady` marker, the install-reconcile sweep installs the agent's own connection once the entry is ready.

The flag gates creating the template, new-agent provisioning, enrolment and setup. It is not a kill switch for agents that are already ready: their connection stays active, repair keeps healing it and `verifyReady` keeps passing. To take the tools away from an agent, remove its install (or archive its `rh-agent-memory-tools:<agentId>` connection).



### Rotation

Memory tokens last 90 days and the registry never revokes. The 60-second setup sweep rotates every ready `agent-memory` entry whose `binding.tokenExpiresAt` is within 14 days (`agent-memory-rotation.ts`), when agent memory is configured and `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED` is `true`: one registry rotate per agent (`POST {ownership API}/agents/agent-memory-<id>/rotate`, memory scopes, 90 days), then a new version of the agent's secret (the env reference is `version: "latest"`, so runs pick it up), then the new expiry is recorded. Any failure leaves `binding.rotation = { state: "failed", ... }` (codes and a timestamp only) and the old token keeps working; the agent is retried after one hour. A registry reply with no usable expiry is refused before anything is stored. A disabled or deleted secret is never rotated or revived. Each rotation writes an `agent.agent_memory.rotated` activity row with no secret data.
