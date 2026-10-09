# AI Connections

AI accounts use the existing Apps/Connections substrate. Manage them at
`/:company/apps`; select their use beside an agent's harness/model settings.
Onboarding, new-agent setup, account creation/reconnect, and inline task requests
reuse `AdapterLoginPanel`, its existing login controllers, and `AdapterLoginChrome`.
Onboarding and new-agent setup retain upstream's `SavedProviderKeySelect` and
`useSavedProviderKeys`, including saved-key references and account-specific Codex
homes. Managed default/shared accounts are additional choices in that same
selector. Selecting “Sign in to another account” survives background refreshes;
Claude authorization paste keeps upstream's immediate Connecting feedback.

New-agent Connect offers three persistent tiles: the provider's subscription,
the provider's API key, and Advanced. All three stay visible while the selected
mode's form is shown below. Advanced opens the existing compatible-connection
picker and provider setup. Execution environment selection lives in Configure.

Storybook's simulated controllers and page annotations do not run in the app.

## Compatibility and selection

The shared `AI_CONNECTION_CAPABILITIES` contract defines these combinations:

| Provider | Sign-in method | Existing harness |
| --- | --- | --- |
| Claude / Anthropic | Claude subscription token or Anthropic API key | Claude |
| OpenAI | ChatGPT/Codex subscription or OpenAI API key | Codex |
| OpenRouter (legacy, no routing metadata) | API key | OpenCode, with an `openrouter/` model |
| Google | API key | Gemini CLI |
| Grok / xAI | Grok subscription or xAI API key | Grok |

Native runner supports the corresponding existing Codex, OpenCode, and Claude
ACP profiles. Connections creation and reconnect mount `AgentProviderConnection`,
the same provider tiles, method controls, API entry, and `AdapterLoginPanel` used
by agent setup. Supported sandbox environments use onboarding's existing browser
sign-in controllers. Self-hosted Claude and Codex installations use the same
browser sign-in presentation with a local login runner and require no sandbox.
Environment selection does not change agent execution settings.
API keys are validated against fixed provider endpoints; redirects
and caller-supplied validation URLs are rejected.

`runtimeConfig.aiConnection` contains `provider`, `mode`, and `method`. For responsible-user selections, `method` is a legacy wire hint retained for rolling upgrades; the resolver uses the selected account’s actual method:

- `responsible_user`: resolve the run's responsible user's personal provider default, using that account's subscription or API key. The `method` hint does not restrict the responsible user's account.
- `shared`: use the named `connectionId` and `grantId`, with audience and agent
  access checks.
- `delegated`: an explicit personal account selection (the wire name is retained
  for compatibility). It cannot bypass human access; a personal credential
  remains available only for its owner’s tasks.

“Which humans can use this credential?” is the sole permission for whose work
can use the account. “Just me” means the personal owner; shared accounts allow
selected company members or every company member. The separate agent-access
setting determines which agents can use it. There is no additional AI agent
authorization, and old delegation records do not override the human audience.

A connection choice never changes the harness or model. For a routed connection,
the selected connection owns its provider routing.
Changing those separately may make a binding incompatible; saving then requires
a compatible choice. Agent configuration cannot grant access to another account.

Personal defaults are unique per company, user, and provider. A Claude bot can use one user’s subscription and another user’s API key without changing its harness or model. Explicit shared selections remain pinned to the selected account and method.
The first successful personal connection sets a default only when none exists.
The additive `ai_provider_defaults` table preserves the legacy per-method preferences. Migration selects each user’s most recently updated provider preference (including unavailable accounts), and rerunning it never overwrites a provider default. New writes maintain the legacy table for older servers. A database trigger propagates older servers’ explicit default updates to the provider default. Inserting an additional method default does not replace an existing provider default.

Revocation retains the unavailable default; connecting another account does not
silently replace it. Change it explicitly on the account detail page.

Agent settings offer **Reconnect account** when the current personal default
needs attention. This repairs the same connection and keeps its default and
agent access. **Connect another account** states that the new account will
become the user's provider default. It selects the returned grant before
adopting the binding and retains the actual sign-in method. A failed default
update stays visible and can be retried without another login. New account
setup shows an agent-access checkbox, enabled for all company agents by default
for connection managers. The owner can limit access to the current agent. This access applies only to
the owner's tasks. Reconnect never expands existing access.

## Storage and API

AI connections pair `connectionPurpose: ai` with `transport: runtime_auth`.
Database checks and the shared discriminator enforce the pair. These entries
cannot participate in tool discovery, MCP gateways, execution, or channels.
Anthropic offers Claude subscription and Claude API key; the unsupported duplicate REST API option is excluded. Catalog
validation also pairs AI metadata with runtime authentication and rejects unsupported
sign-in methods. Provider artwork and source provenance live in
`ui/public/brands/apps/manifest.json`; OpenRouter uses its official sign-in assets,
and OpenAI/Grok reuse the repository's pinned Lobe Icons source and license.

Provider/method metadata lives in `config.ai`. Credentials live on the existing
grant through encrypted vault secret references, with existing consumer bindings.
Safe provider-reported account identity is optional; secret references, tokens,
and authentication paths are never account labels.

Company-scoped `/api/companies/:companyId/ai-connections` operations provide list,
API-key creation/reconnect, personal defaults, completed login references, and
active-run attribution. The list includes `canManageConnections`, evaluated by
the same server permission check as creation, including custom
`tools:manage_connections` grants. Existing Connections operations handle naming,
access, and revocation. Mutation authorization is enforced server-side. OpenAPI documents the new board-only
operations. Agent-originated configuration and environment tests resolve the
authenticated request’s responsible user; an agent ID is never a personal-account
owner. A missing responsible identity blocks personal-default resolution.

Subscription login attempts retain their company, owner, method, access intent,
and reconnect target in the existing durable authentication session. Duplicate
completion returns the same connection/grant. Abandoned or expired attempts cannot
save a healthy connection. Reconnect preserves the connection ID, bindings,
customized name, and access settings. A completed connection remains even if
subsequent agent creation fails or is cancelled.

Account adoption during Save and the agent runtime test use the selected agent
environment, or the instance default when no override is set. An unavailable
remote environment blocks validation rather than probing the server host. The
runtime test accepts the form’s prospective adapter selection before it is saved.
For a saved-agent test, omitting `environmentId` uses the agent’s saved override.
Sending `environmentId: null` tests a change back to the instance default.

## On-demand usage limits

The AI account detail has **Check usage**. It reads the selected account only
when requested; opening the account, listing connections, and starting either
runner do not invoke this probe. There is no scheduling, provider selection,
quota enforcement, credit purchase, or automatic retry attached to it.

`aiConnectionService(db).probeUsage(companyId, userId, connectionId, grantId?)`
is the common server operation for legacy and native runner connections.
`GET /api/companies/:companyId/ai-connections/:connectionId/usage?grantId=...`
exposes it to board users. The UI client calls `aiConnectionsApi.probeUsage`.
The optional grant ID must belong to this connection; omit it only when exactly
one authorized grant exists. The company membership, personal owner/shared human
audience, connection lifecycle, and credential ownership checks run before any
provider request. Agent API keys cannot call this board endpoint. Internal
execution callers must also use the normal runner connection selection checks
for agent installation and responsible-user authority before using its result.

The returned `AiConnectionUsage` contains a timestamp and probe status (`ok`,
`unsupported`, `unavailable`, or `error`), provider/source, every reported limit
window, model/feature scope, exact window duration when known, reset time,
utilization/remaining percentage, absolute allowance when reported, and overage
settings/balance. The list summary advertises `usageProbeSupported`.
`limitReached` describes that window; `allowed` preserves explicit provider
admission for its limit group. A model-specific exhausted window must not be
treated as an account-wide denial. Codex workspace spend controls are also
returned when present. Percentages remain provider percentages: 0.5 means 0.5%,
99.99 stays below exhaustion, and values above 100 remain visible.

Capability means the provider has a probe implementation, not that every token
has permission to read it. Claude `setup-token` credentials characterized in
this repo request only `user:inference`; the provider can require `user:profile`
for [usage access](https://github.com/anthropics/claude-code/issues/13724).
A 403 returns `permission_denied` with no limits, distinct from expired
authentication or exhausted capacity. Minting another inference-only token
does not establish usage access. This probe cannot add scopes to a stored token.

| Connection | Read-only source | Observations |
| --- | --- | --- |
| Codex subscription | `GET https://chatgpt.com/backend-api/wham/usage` with stored access token and account ID | Primary/secondary windows, additional feature/model limits, provider admission, workspace spend control, credit balance |
| Claude subscription | `GET https://api.anthropic.com/api/oauth/usage`, with stored OAuth token and `anthropic-beta: oauth-2025-04-20` | Legacy and structured session/weekly/scoped windows, monthly extra usage, structured spend when legacy extra usage is absent |
| Grok subscription | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, with stored token and `x-xai-token-auth: xai-grok-cli` | Included-plan utilization/period when reported, separately reported on-demand allowance and prepaid balance in USD cents |
| OpenRouter API key | `GET https://openrouter.ai/api/v1/key` | Key credit cap, reset cadence, free-model daily request cap when returned |
| Other API-key methods | No supported single-key allowance endpoint | Explicit `unsupported`; no provider or secret read |

These subscription sources are provider-client endpoints, not a promise of a
stable public API. Codex's current endpoint/shape is grounded in the official
[backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)
and [response models](https://github.com/openai/codex/blob/main/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs).
Claude uses the same OAuth endpoint as the existing adapter probe; official
[usage documentation](https://code.claude.com/docs/en/costs) describes plan windows,
extra usage, and usage-check rate limiting. Grok's endpoint, optional fields, and
USD-cent units follow its official
[billing implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs).
It prefers `creditUsagePercent` and `currentPeriod`, with `used`/`monthlyLimit`
as the legacy included-allowance fallback. The official
[Grok commands](https://docs.x.ai/build/modes-and-commands) describe its usage screen.
OpenRouter documents its
[key limits endpoint](https://openrouter.ai/docs/api/reference/limits).

Unknown values are `null`, never assumed zero. A present Grok `Cent` message `{}`
means zero under its documented proto3 encoding; an absent message or omitted
included-usage percentage remains unknown. Claude's `is_active` dashboard flag
does not establish whether requests are allowed. Named Claude limit groups keep
their own identities and scopes, including `session` and `weekly_all` groups.
They do not replace the legacy account-wide windows. An enabled extra-usage switch or remaining
spend allowance does not establish a funded usable balance; overage `available`
stays unknown unless the provider confirms it or reports it disabled/exhausted.
An unlimited OpenRouter key does not establish account balance. A Grok reset
timestamp alone does not establish weekly/monthly cadence. API rate limiting
of the *probe* is an error, not an exhausted subscription. Malformed/empty
responses and network failures return no fresh limits. Responses are `no-store`,
bounded to 256 KiB and 15 seconds, use fixed endpoints with redirects disabled,
and contain neither credentials nor raw provider errors. Expired credentials
report `authentication_required`; the probe does not exchange refresh tokens
or change connection health.

The Costs dashboard uses the company quota endpoint. It reads each authorized
managed subscription separately, retaining the last successful observation on
transient errors. For managed Codex accounts, a 401 can trigger one persisted
OAuth refresh; it defers while potentially competing OpenAI work is active.
Refresh takes the company secret-mutation lock before database row locks and
requires those row locks immediately, before exchanging a single-use token.
Reconnect and runtime credential write-back follow the same lock order.
Credential resolution checks its version after any database wait and reloads a
rotated value before giving it to a new run. Unknown utilization has no progress
bar, but any provider-reported reset time remains visible.

Verification:

```sh
pnpm exec vitest run server/src/services/ai-connection-usage.test.ts server/src/__tests__/ai-connections.test.ts ui/src/components/ai-connections/AiConnectionUsagePanel.test.tsx server/src/__tests__/openapi-routes.test.ts
pnpm check:token-gates
```

Fixtures prove normalization, credential isolation and manual UI behavior. Live
provider/account entitlement qualification is separate; provider-side omissions
remain unknown and must not be used downstream as proof of available capacity.
On 2026-10-02, a real local Codex access token was saved to an encrypted,
disposable test connection. The actual connection usage HTTP route returned 200
with `status: ok`, a weekly window at 100% used, its reset time, denied included
usage, and available overage credits. The same stored connection passed selection
checks for both `codex_local` and `paperclip_runner` with the native Codex provider.
This verifies the connection API/vault/provider path and both selection paths;
it does not claim a live runner turn or browser acceptance test. The disposable
database and vault home were removed after verification.
After the operator signed in again on 2026-10-02, real Claude Keychain and Grok
file credentials were saved to encrypted disposable connections. Both the
provider requests and actual connection usage HTTP route returned 200 with
`status: ok`. Selection checks passed for `claude_local`, native Claude,
ACP Claude, `grok_local`, and ACP Grok through `paperclip_runner`.
Claude returned session and weekly usage at 0%, a scoped weekly window, and
enabled extra usage. Grok returned a weekly period and zero on-demand allowance
and prepaid balance, but omitted included-plan usage; it remains unknown rather
than being reported as 0% or available capacity. The live shapes prompted
regressions for Claude structured limits/spend and Grok legacy usage, monetary
units, absent percentages, and proto3 zero messages. The disposable database
and encrypted vault were removed. These checks started no provider turn and
exchanged no refresh tokens.

## Runtime isolation

Provider authentication failures, including `acpx_auth_required`, adapter login
requirements, and expired/invalidated refresh tokens, create an AI connection
card as the failed run is finalized. The card names the provider and uses the
same inline connection/reconnect controls as missing-account setup. Pending
cards are deduplicated. Creating a repair card persists a blocked run classification
that suppresses immediate and periodic generic retries until the responsible user
repairs the connection. Unsupported providers and failures that could not create
a card retain their existing recovery path. Tool permission errors and provider quota failures do not
request model authentication.

Pre-dispatch `configuration_incomplete` failures also show this card when every
missing binding is a personal `user_secret_ref` for the same compatible AI
provider. This includes a teammate who has no value for an onboarding
`ANTHROPIC_API_KEY` definition. The card asks that person to connect their own
account. It does not use another teammate's secret. Mixed gaps, company secrets,
and unrelated tool credentials keep the existing operator recovery path.
After explicit, validated adoption, the durable delivery reopens only the
blocked task whose latest failure and active configuration recovery still match
the card. A newer failure, reassignment, manual hold, or restricted external chat
does not resume through an old card.

An attributed managed credential is marked as needing reauthorization only if
its stored generation still matches the failed run. Late failures cannot
invalidate a refreshed or reconnected credential. Repair preserves the selected
account and its permissions when the same sign-in method is selected. The card
also lets the user switch between API key and subscription authentication for
providers that support both. Switching creates a separate account, then selects
it as the user's provider default or validates and updates the agent's explicit
account binding. The original account is retained. Accepting the card resumes with a fresh session
through the existing durable continuation delivery.

For compatible legacy agents, the card offers the responsible person's provider
connection without changing authentication automatically. After connecting,
**Use connection and continue** checks agent-update permissions and validates in
the agent's execution environment before committing the agent binding, connection
install, audit, and card completion in one transaction. A failed validation or
completion leaves the request pending and the old agent configuration and access
intact. Unsupported harness/provider routes are not guessed.

Codex ACP terminal failures with category `limit` and explicit usage-exhaustion
wording enter provider-quota recovery. A supported reset clock uses the existing
Codex parser; when none is available, recovery uses its existing quota backoff.
Context, turn, rate, storage-capacity and configured-budget limits retain their
existing handling. The adapter inspects bounded provider text only in memory
and retains recovery labels and a parsed timestamp, without copying the text to
run results or logs. A historical generic terminal-limit message alone does not
establish quota exhaustion.

`prepareManagedAiRuntime` is shared by runs, environment tests, and adoption.
Test and Save mark the tested account as needing attention when its provider
hello test rejects authentication or its API-key check returns 401 or 403.
Network, quota, runtime, and environment failures
do not change credential health. The same generation check protects a newer
reconnect from a late test result. Claude ACP's typed `access` failure is its
provider `auth_required` signal and enters the existing sign-in recovery path,
including when only the generic terminal-access fallback message is available.
Claude ACP validates working directories on the selected execution target. A
sandbox directory does not need to exist on the Paperclip server. When the agent
has no configured directory, the test uses the remote target's working directory.
It checks responsible identity, membership, compatibility, connection health,
human audience and agent installation before reading credentials.
Missing credentials produce an actionable configuration failure; responsible-user
task runs use the existing connection-request interaction, marked `purpose: ai`.
A runtime-auth request cannot satisfy, reuse, or supersede a tool request for
the same provider. AI-only methods are excluded from agent tool discovery.

Each invocation receives a private authentication home and only the selected
grant's credentials. Inherited credential variables are cleared. Conflicting
project authentication and provider-routing overrides are rejected. Managed
failure cannot reactivate host or legacy credentials.

A subscription invocation takes no lease. Two invocations of one grant, from
the same or a different provider account, run at the same time. At cleanup,
each invocation re-reads the credential stored at that moment under a row
lock on the grant, then compares it against its own refreshed copy using the
provider's own freshness field: Codex compares `last_refresh` and bounds it
against the host clock; Grok compares `expires_at`. The newer credential
persists; a tie or an unparseable freshness value keeps the stored
credential, so a spent single-use refresh token never overwrites a good one.
Refreshes are merged only into the originating active grant, with a
revocation check. Temporary homes are removed on normal completion or
failure.

A fresh task execution cannot enter subscription contention. The freshest-write
rule above resolves the conflict instead. A run that already entered this wait
keeps a durable scheduled retry, checked every 60–120 seconds. The task shows
“Waiting for AI subscription”. It does not request a reconnect, and it does not
consume its provider-failure retry allowance.
Each attempt rechecks task eligibility, ownership, budget, and current credential
access. Revocation and other configuration failures still require user action.
Authorized comment wakes that started as non-assignee runs can resume without
claiming the assignee’s execution lock. Admission records this authority while
holding the task and run locks. A reassignment during preflight cannot grant it.
Assignee retries must still own that lock.
Already-started native sessions retain their existing same-run recovery path;
they must not be replaced by a fresh execution with a pre-provider receipt.

Session reuse includes grant identity, responsible user, and credential
generation. A changed identity starts a fresh provider session. Native Codex
(`paperclip_runner`) honors the configured warm lifecycle. It copies refreshed
credentials back to the current invocation before deleting that invocation's
private home. The session-owned credential stays private until idle timeout or
explicit closure. Each follow-up rechecks current authorization and account
identity before reusing the session; changing identity retires the previous owner.
Other managed harnesses retain per-turn cleanup. A suspended native execution
whose credential identity changed must restart as a new execution.

After a verified provider resume, plain-text Slack follow-ups send the new
authorized message delta instead of repeating the full task framing. The saved
run and current message identities and bodies must match. Actual brief edits
still arrive; historical Slack task titles are not repeated as new directions.
Attachments, omitted input, questions, approvals, and recovery retain their full
framing. A fresh provider session always receives the complete bootstrap.
Retained sandbox runner binaries are reused only after an exact SHA-256 match
with the controller artifact and the normal capability checks. Run-scoped
credential changes still require provider process rotation.


Warm sandbox execution requires both `reuseLease: true` and
`runnerLifecycleMode: "warm"` on the environment. `runnerIdleTimeoutMs` bounds
idle process retention. Chat tasks without a project reuse a sandbox only within
the same company, environment, task, agent, and runtime configuration. They do
not need an artificial project workspace. Other tasks, other agents, and ad-hoc
connection tests cannot claim that retained sandbox. Daytona verifies a matching
workspace sentinel before accepting either a workspace-scoped or task-scoped lease.

Revocation blocks new invocations and refresh persistence. A running provider
process may already hold credentials. The revoke confirmation lists attributed
active runs and exposes the existing Stop action; it does not promise immediate
provider-side revocation.

### Stop during sandbox preparation

ACPX startup registers cancellation while it materializes the remote auth home
and stages files. Stop requests termination of that run's sandbox. Daytona closes
admission and stops the sandbox before waiting for outstanding setup commands.
The host requires a receipt for the exact company, run, and provider lease before
abandoning the blocked setup RPC. Normal completion still drains work gracefully.

Late setup responses cannot launch the agent. A cancelled sandbox cannot resume
while its old provider requests are still settling; a retry receives an explicit
error instead. If termination cannot be verified, the adapter keeps ownership
until the outstanding operation settles, and Stop is not acknowledged as complete.
Local execution and cancellation of an already-running agent turn are unchanged.

## Legacy adoption

Migration `0273` indexes only explicitly owned personal secrets with a recognized
provider/method and matching agent configuration. It keeps original secret
references and leaves every agent's legacy authentication unchanged. Reconnecting
an indexed account creates a private grant credential instead of rotating the
legacy secret. Subsequent reconnects rotate that private credential. Unknown
ownership and filesystem-only subscriptions remain unresolved. The migration is
repeatable and does not classify unknown credentials as company-shared.

Imported accounts initially need validation. Agent settings show “Existing
authentication — not managed by Connections” until adoption. The adoption
confirmation names the binding and affected agent. Saving runs a provider hello
test in that agent's environment before replacing authentication. After adoption,
the server preserves the managed binding and will not restore legacy fallback.

## Local subscription sign-in

Local installations do not need a sandbox to connect a subscription. Connections,
onboarding, and agent setup share `LocalProviderLoginInstructions` and
`useLocalAiLogin`. Claude and Codex start a local provider process behind the
browser sign-in card. Claude accepts the authorization code in that card; Codex
displays its device code there. The user does not run a shell command. Each
local runner requires Python 3 for its pseudo-terminal (included in the Docker
image) and the corresponding provider CLI on the Paperclip host. Each
attempt retains a private credential home. The home is never seeded with the
operator's existing login: copying a rotating refresh token would
allow managed runs to invalidate credentials still used by legacy agents or the
operator's terminal. The user completes browser sign-in, then clicks Connect.
Grok retains its terminal sign-in flow until it has a local browser login runner.

Attempts reuse `adapter_auth_sessions`, binding company, owner, provider, access
intent, reconnect target, and a 30-minute expiry. Validation and completion are
serialized; duplicate completion returns the saved connection. Restart retains
the attempt. Cancellation and expiry remove the attempt home, and the startup/
periodic cleanup sweep retries expired directories. Successful completion persists
credentials to the encrypted grant and removes the temporary login home. Refreshes
subsequently update only that grant. Reconnect preserves IDs and access settings.

Starting an isolated attempt requires normal company-scoped AI-connection creation
permission. Checks, completion, cancellation, and resumption are owner-bound.
Authenticated users cannot import host credentials or use another user’s attempt.
A failed verification creates no healthy connection. Preview-era Codex/Grok managed connections without the
isolated-subscription marker require reconnect before another managed execution;
unmanaged legacy agents retain their existing authentication paths.

## Verification

`server/src/__tests__/ai-connections.test.ts` exercises storage, isolation,
defaults, human audiences, agent access, reconnect races, refresh ownership,
concurrent subscription write-backs, migration replay, and redacted API
failures against a real embedded database. Existing login, adapter, tool, and channel suites cover their
shared integration paths. The onboarding tests cover managed reuse and keeping a
successfully connected account after failed agent creation.

The [Storybook review index](http://localhost:6116/?path=/story/ai-connections-review--review-index)
retains deterministic authentication states and interaction checks. Run
`pnpm build-storybook`, then
`pnpm exec playwright test --config tests/ai-connections-review/playwright.config.ts`.
Also run token gates, repository typecheck, tests, and build before handoff.
Live connect → reuse → run → reconnect verification still requires valid provider
credentials and a supported login/runtime environment; fixtures do not prove it.

For an isolated running test drive, also run:

```sh
AI_CONNECTIONS_TEST_COMPANY_ID=<company-id> pnpm exec playwright test --config tests/ai-connections-app/playwright.config.ts
```

Set `AI_CONNECTIONS_TEST_URL` when the test drive uses a port other than 3100.

These browser checks exercise the production list/detail pages, rejected API-key
validation, cancellation, focus restoration, and adoption without saving agent
changes. They submit an explicitly invalid fixture key and do not prove successful
authentication with a live account.

### Local sign-in checks

Local subscription screens share the same credential check on entry and when the
window regains focus. Waiting screens also poll until sign-in verifies. A successful
check shows the account is signed in; only **Connect** creates or reconnects the grant.
Claude, Codex, and Grok check only their connection-specific login home. The
health response selects whether a self-hosted user may sign in.

Leaving and returning to a local sign-in screen resumes its active attempt. Navigation
does not delete its credential home. **Start sign-in again**
explicitly cancels the old attempt; abandoned attempts expire after 30 minutes.
Completed and expired attempts are cleaned up through the existing lifecycle.

### Disposable live inline-repair test

The normal app test configuration excludes `*.live.spec.ts`. To run the destructive
inline-repair scenario, set `AI_REPAIR_TEST_ALLOW_DESTRUCTIVE=1` and use a separate
loopback `local_trusted` instance. Set `AI_REPAIR_TEST_DISPOSABLE_MARKER` to a fresh
32-character lowercase hexadecimal value. The company, single Codex agent, single
personal OpenAI API connection, and issue must all be named `AI Repair QA <marker>`
(the issue uses that title). Supply their IDs with `AI_CONNECTIONS_TEST_COMPANY_ID`,
`AI_REPAIR_TEST_CONNECTION_ID`, and `AI_REPAIR_TEST_ISSUE_ID`, and the disposable
provider key with `AI_REPAIR_TEST_KEY`. The test verifies these boundaries before
revoking credentials or submitting work. Delete the disposable instance and revoke
its provider key after the test; failed tests may leave a paused task for inspection.

Authenticated public deployments must configure a trusted runtime host (`PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` or `PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST`) before offering server-host subscription login, matching the local stdio runtime boundary. Health reports this capability so setup can offer a supported environment or API key when local sign-in is unavailable. Private authenticated self-hosted instances support isolated local login without that extra setting. Isolated Claude credential files must be private, owned by the server user, bounded, and free of symlinks.

### Hiring and delegated work

When a managed agent creates or hires another agent without an explicit AI binding
or adapter auth setting, the server inherits its compatible managed connection choice.
Explicit credentials, blank overrides, credential directories, and provider routing
settings for the child provider take precedence. Unrelated provider keys do not
suppress the default. Unmanaged parents keep their existing authentication path. The new agent resolves
the responsible user's account at execution time; it never copies the parent's
credentials or identity. Same-provider hires preserve subscription/API-key choice.
A different provider selects the responsible user's default for that provider.
Native Codex and ACPX/Claude provider selections follow the same compatibility rules.

Hiring may succeed before that personal account exists or while it needs repair,
including hires awaiting board approval. The first assigned task then shows an AI
connection card. First-time setup presents the provider's subscription/API controls
inside the task. The inline form omits the connection name field and names new
accounts from the user's display name, provider, and selected authentication
method (for example, `dotta's Claude API account`). Reconnecting preserves the
existing account name. Connecting installs access for that agent and resumes the pending
work automatically. Explicit incompatible bindings and shared-account permission
denials still fail; hiring never expands a restricted shared account's audience.

Concurrent runs of one subscription do not hold a credential lease. A fresh
task can briefly wait when a credential rotation holds the company file lock or
a grant/secret database row lock. Lock timeouts become `ai_connection_busy`,
keeping the task on its automatic pre-provider scheduled retry path. It does
not request new credentials, and it does not consume the provider-failure retry
allowance. Each retry revalidates the account, and existing run-dispatch rules
still suppress cancelled, reassigned, or otherwise ineligible work. An assignee
retry must still keep execution-lock ownership at scheduling, promotion, and
dispatch.

`server/src/__tests__/agent-hire-ai-connections.test.ts` covers both creation routes,
both providers and methods, approval gates, native provider mapping, shared access
boundaries, and concurrent runs of one subscription for both providers. The opt-in
[`tests/hiring-ai-connections/README.md`](../../tests/hiring-ai-connections/README.md)
describes real browser hiring, subtask, connection, and automatic-resume checks on
local and Daytona environments, plus the production component Storybook checks.

### Managed session compatibility

Resume checks compare the selected account identity with the server-owned
metadata in the saved task session. Read this metadata before decoding the
adapter session: adapter codecs intentionally discard unknown fields. A missing
identity, a different grant or responsible user, or a changed credential generation
requires a fresh session. The metadata is removed before passing session params
to an adapter. Temporary authentication-home paths do not change the configuration
fingerprint. These checks do not relax current connection authorization.

Quota polling has a 20-second response deadline. Once a managed OAuth refresh
starts, it has its own 60-second request lifetime so the replacement token body
can still be read and committed after the dashboard stops waiting. A successful
refreshed observation uses the saved grant/secret revision as its cache identity.
A reconnect during credential resolution defers the poll instead of associating
one account's quota with another revision. Both Costs surfaces retain matching
successful observations on transient failures and clear them on authentication
failure or credential rotation.

Managed runtime token write-back retries a company-lock timeout twice (three
30-second acquisition attempts), so a slow quota exchange does not discard a
different account's replacement tokens. Any remaining write-back error preserves
the private runtime home for retry; cleanup deletes it only after a successful
transaction or an intentional freshness/authorization discard. These retained
homes are recovery evidence, not a background replay queue; persistent database
or lock failures still require operator intervention.

Quota OAuth replacement tokens are encrypted with the instance secrets master
key and fsynced under `<instance-root>/quota-credential-recovery/<company-id>/`
before vault, grant, or activity writes. Storage and encryption are checked before
exchanging a single-use refresh token. Failed saves retry without another OAuth
exchange; persistent failures keep the encrypted record for the next quota poll,
including after a restart. New OpenAI subscription runtimes serialize credential
reads with quota exchanges and recover a matching pending replacement before
materializing an auth home. Authentication-failure handling also recovers a
matching replacement before marking the grant invalid. A failed recovery save
defers these actions and leaves both the active grant and journal intact.
The journal is removed only after database commit (or
when an authorized newer credential makes it obsolete). Replay checks the grant,
connection, secret, and original credential fingerprint and cannot reactivate a
revoked grant or overwrite a reconnect. Back up this directory and the instance
secrets key with the instance data. Loss of durable storage while receiving a
provider token can still require reconnecting the account.

## Advanced provider routing (2026-10-02)

Use the regular rows on **Connectors** to add OpenRouter, Amazon Bedrock,
Google Gemini, a Responses API, Messages API, Chat Completions API, or local
endpoint connection. Each row has its own Connect action and saved accounts.
The catalog tags these entries `model-provider`; no category UI is shown.
Responses-compatible gateways such as Emissary use the Responses API row.
The native subscription/API-key onboarding remains the default. Provider choices
show the existing local brand artwork and reuse the existing access step. Custom
URLs, protocol, AWS region, and credential fields appear only after choosing the
corresponding connector. New connections default to everyone in the organization
and all agents when the actor has permission; the existing Advanced disclosure
contains the controls to narrow access, without a separate Access step. New-agent setup also offers the connection picker in its persistent
**Advanced / Custom Gateway** tile.

At **Agents → [agent] → Harness / Runtime**, **Connection** is a dropdown of
compatible saved connections, including explicit personal accounts. The existing
model picker uses that connection’s optional model IDs and accepts manual IDs.
Changing connections preserves the model for explicit review. URLs and
credentials belong to the connection; the model belongs to the agent.

| Harness | Implemented managed routes |
| --- | --- |
| Codex legacy and Codex New Runner (app-server) | OpenRouter; custom/local OpenAI Responses endpoints |
| Claude legacy and Claude New Runner (ACPX) | OpenRouter; custom/local Anthropic Messages; Bedrock API key |
| OpenCode legacy and New Runner | OpenRouter; custom/local Chat Completions |
| Hermes local | OpenRouter; custom/local Chat Completions |
| Gemini CLI, Grok | Their native API connections; custom routes are not advertised |

Migration `0306` adds Google to both account-default provider constraints. Local
Gemini connections seed the API-key auth choice in their disposable home before
environment probes and task execution. The settings file contains no credential.

OpenClaw Gateway, Hermes Gateway, Claude Managed, AWS AgentCore, Process, HTTP,
and legacy `acpx_local` are excluded: external agents retain their own model
configuration, and `acpx_local` is retired. Cursor/Pi/Copilot custom routing,
Vertex, ambient AWS identity, arbitrary authentication headers, and automatic
catalog discovery for custom gateways are not part of this implementation.

OpenRouter connections without an explicit model list automatically load its public
[model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
ordered with `sort=most-popular`. New-agent setup and agent settings share this
discovery path, preserve the provider's ordering, and adapt model IDs to the selected
harness. Explicit connection model lists take precedence. Catalog discovery sends
no credentials; a failed request offers refresh and manual model entry.

`config.ai.routing` stores only kind, protocol, URL, auth method, region, and
optional model IDs/labels. The vault stores provider API keys, including Bedrock API keys.
Fixed bindings contain only connection/grant identity. The server checks actual
connection metadata, company, owner/audience, installation, status, and protocol
before resolving secrets. Advanced connections cannot silently become native
personal defaults. Reconnect replaces credentials and preserves destination;
changing destination requires a separate connection. Credentials are never
submitted to a new URL as part of reconnect.

Native OpenCode custom gateways keep the reusable key in the runner process.
The harness configuration contains a session-scoped loopback capability, limited
to the configured model's Chat Completions endpoint. Streaming and provider error
status are preserved; redirects are rejected. Closing or failing the harness
revokes the capability and aborts outstanding requests. Upstream requests use
session-local Node HTTP/HTTPS agents with the runtime's HTTP_PROXY, HTTPS_PROXY,
ALL_PROXY fallback, NO_PROXY bypasses, and SSL_CERT_FILE/SSL_CERT_DIR trust. The
harness bypasses outgoing proxies for loopback broker/MCP calls. This bounds key exposure
from shell tools reading the configuration; it is not an OS isolation boundary
against a process debugger running as the runner user.

Only fixed official provider endpoints receive control-plane key checks. Custom
endpoints and Bedrock are exercised by the selected harness in the selected
execution environment, through **Run test**. Saving a custom connection records
configuration; it is not proof that the model can respond. HTTPS is required for
remote URLs; loopback endpoints may use HTTP. Localhost refers to the agent’s
execution environment, including when it is a sandbox. URLs cannot contain user
credentials, query parameters, or fragments.

Managed Grok uses a disposable runtime home. Paperclip does not retain or restore
Grok transcript files into host temporary directories: private file modes do not
isolate agents running as the same OS user. Archives from earlier development
builds are ignored. Provider session metadata still saves normally. If the selected
session has no history in its current execution environment, Grok starts a fresh
session with the Paperclip task handoff rather than attempting remote subscription
recovery. Transcript continuation requires an isolated provider history solution
and is not qualified by this change.

Runtime projection clears alternate provider credentials and routing overrides,
uses disposable homes, and never falls back to host authentication. Codex probes
retain the selected provider home. The new runner copies only the validated
Paperclip provider stanza into its isolated Codex home, preserves its own tool
and sandbox policy, and disables shell snapshots. TypeScript and Rust launch
boundaries explicitly allow only the corresponding provider credential and
routing fields. Keys remain outside model-issued command environments on the
new Codex runner. Hermes custom endpoints use an isolated `config.yaml` with an
environment reference for the key.

Primary configuration references consulted:
[Codex custom providers](https://developers.openai.com/codex/config-advanced/),
[OpenRouter Codex](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli),
[OpenRouter Claude](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration),
[Claude gateways](https://code.claude.com/docs/en/llm-gateway),
[Claude Bedrock](https://code.claude.com/docs/en/amazon-bedrock),
[OpenCode providers](https://opencode.ai/docs/providers/), and
[Hermes providers](https://hermes-agent.nousresearch.com/docs/integrations/providers).

Validation includes negative company/owner/revocation/protocol checks, no-auth
vault behavior, immutable reconnect destinations, credential projection, Codex
probe isolation, and new-runner home/environment boundaries. The isolated local
test-drive exercised live OpenRouter requests using the Codex and Claude CLI
probes, then completed real tasks using Codex, Claude, and OpenCode New Runner.
The app walkthrough verified connection selection, saving, and completed tasks.
A follow-up Codex/OpenRouter acceptance test ran a shell calculation, completed
the task, then resumed from a new user message and completed a second shell
calculation with the prior context. Reconnect coverage round-trips routing
through PostgreSQL JSONB and verifies that credential rotation retains identity
and agent access.
General AWS access keys are not accepted or forwarded to Claude; use a Bedrock
API key. Support for AWS roles requires a credential broker before it can ship.
The initial OpenCode tool-use check was denied terminal access. The native driver
now includes the assigned workspace and its canonical path in the allowed
directories while preserving the configured tool policy. Subsequent local
qualification verified tool use and follow-up on the affected OpenCode route.
Live Bedrock verification subsequently passed with a short-lived Bedrock API key,
region `us-east-1`, and `us.anthropic.claude-sonnet-4-6`. The saved connection
passed **Run test**. Claude legacy and Claude New Runner each ran a terminal
calculation, completed the task, and ran a context-dependent follow-up. Actual
tool output was verified for all four successful runs. Private gateways still
have deterministic mapping and validation coverage but need live verification
in the target deployment. Short-lived Bedrock keys must be rotated before expiry.

The repeatable provider connection campaign is documented in
[`tests/runner-e2e/PROVIDER-CONNECTIONS.md`](../../tests/runner-e2e/PROVIDER-CONNECTIONS.md).
It preserves actual tool outputs, downloaded artifacts, completion and follow-up
receipts, source provenance, cleanup, and provider failures. The retained local
qualification has 43 passing API/gateway cells out of 46; staging and all
subscription combinations remain unqualified. Gemini CLI 0.58.0 has an upstream
ACP new-file error conversion defect. The provider-free filesystem probe exposes
that defect without modifying the installed CLI. Provider overloads and one
follow-up timeout also remain live qualification limits.

### Gateway completion compatibility

Provider-facing `paperclip_finish` accepts an omitted or `null` continuation for
`done`, `completed`, and `needs_review`. This supports gateways that require all
declared tool properties to be present. Normalization removes only `null`;
non-yielding tool calls still reject a continuation object, and `yielded` still
requires a complete `response_wake` object.

Task-card account repair uses the provider reconnect form for routed accounts,
retaining the saved endpoint, protocol, model aliases, and connection identity.

## Subscription cost reporting

The Costs page shows metered API spend beside the **current monthly subscription
commitment**. API dollars and both token totals follow the selected date range;
monthly subscription fees do not. Tokens measure Paperclip work only, while a
subscription fee covers the entire provider account, including other usage.
Recorded subscription overages remain separate from the recurring fee.

Agent, user, project, and model cost rows use a right-aligned amount with any
estimate badge underneath. Each badge reflects that row's own ledger events in
the selected date range.

Discovery uses the managed AI connection actually selected for a run, or the
connected accounts visible to the user viewing Costs. An administrator cannot
probe another user's private credentials. OpenAI identity combines workspace and
seat claims from the exact bearer token accepted by its usage endpoint, with
the selected workspace checked against those claims. An editable ID token cannot
establish identity or grant price-edit access. Claude's OAuth profile combines
organization and account identity when the token allows profile access. Identity
keys are company-scoped hashes; reporting never exposes tokens, raw provider IDs,
or credential hashes. Multiple agents and connections sharing a known paid seat
count once. Distinct seats remain separate even in the same workspace. Before
provider verification, each connection grant has its own unconfirmed record;
local claims alone cannot combine another user's account or billing editors.

Supported exact plan identifiers with a stable account identity map to dated, USD, before-tax web list prices
in `packages/shared/src/subscriptions.ts`. The UI labels these **Estimated** (or
**Partially estimated** when combined with user-supplied prices). A generic
OpenAI Pro, Claude Max, team, or enterprise entitlement does not reliably
identify the price: it stays **Price unknown** until its owner enters an amount.
Annual prices are divided by 12 using exact decimal arithmetic. Supported
currencies are totaled separately; Paperclip does not estimate exchange rates.

Use **Subscriptions → View details → Edit price** to record the amount paid,
billing cadence, and tracking status. Personal prices are editable by their
owner; shared prices require AI-connection management permission. When the same
seat is connected both personally and shared, both its personal owners and
company connection managers can edit the single fee, regardless of discovery
order. These billing permissions survive disconnecting a connection; they do
not grant access to its credentials. Viewers cannot
edit. Updates append an immutable price revision and reject stale concurrent
edits. Ending or excluding tracking does not cancel the provider subscription.
Disconnecting a connection also does not prove that billing stopped, so the fee
continues until explicitly ended or excluded.

Claude setup tokens can lack profile permission. Grok plan observations currently
do not supply a verified billing identity. Such connections retain an unconfirmed
identity and may need manual linking after a credential change. An unconfirmed
identity requires a user-supplied price before contributing a monthly fee, so
credential rotations cannot multiply automatic list-price estimates. **Link accounts**
combines usage and keeps the selected account's price; it is restricted to accounts
the caller can edit and should only join the same subscription or paid seat.
Provider observations never overwrite a user-supplied price. Conflicting manual
prices prevent automatic linking rather than silently choosing one.

Monthly totals and account details include only accounts the viewer may see:
personal billing owners, company managers of shared fees, and the authorized
audience of active shared grants. Revoking a grant removes its audience's access
to the fee. Cost-read permission alone does not reveal
another member's personal plan, price, owner, or account-linked activity. Billing
editors retain visibility after disconnection so they can end tracking. Aggregate
API and subscription run-token totals remain company-wide, as in existing cost
reports; hidden private accounts are not mislabeled as missing attribution.

Provider lookups run in the background, with a six-hour attempt cache shared by
server replicas, at most four active provider lookups per process, a 15-second
request deadline, and a 256 KiB response limit. Failed checks preserve the last
observed plan and price. The report reads the database only and loads just the
current price for each account; earlier revisions remain stored for auditing.
Failed background UI reloads retain the last loaded values and show a short
status message. Failed discovery offers **Retry account check**.

Each new managed subscription run snapshots its subscription ID. Its cost receipt
inherits that server-derived ID, outside the immutable monetary receipt hash.
Switching accounts cannot move an earlier run to the new subscription. Linking
duplicates resolves historical IDs in reports without rewriting receipts.
Legacy and unmanaged subscription usage still contributes to the subscription
token total but is not retroactively assigned to a guessed account. Subscription
estimates never create finance events, change the inference ledger's dollar
amounts, or consume agent budgets.

The company-scoped API is documented in OpenAPI:

- `GET /api/companies/:companyId/costs/subscriptions`: current fees and usage for
  `from`/`to` (inclusive, matching existing cost reports), or `period=all`.
- `POST /api/companies/:companyId/costs/subscriptions/refresh`: request background
  discovery for the caller's authorized connections; returns `202` immediately.
- `PATCH /api/companies/:companyId/costs/subscriptions/:subscriptionId`: save a
  price with `expectedRevision`, plan, nullable `amountCents`, currency, cadence,
  and tracking status.
- `POST /api/companies/:companyId/costs/subscriptions/:subscriptionId/link`: link
  a duplicate using `targetId`, `expectedRevision`, and `targetRevision`.

Storybook **Costs / Subscriptions** renders the production Costs page with
interactive fixtures for normal estimates, unknown prices, provider failures,
and mobile layouts. Its edits affect fixture data only. Focused verification:

```sh
pnpm exec vitest run server/src/__tests__/subscriptions.test.ts \
  server/src/__tests__/subscription-routes.test.ts \
  ui/src/components/SubscriptionCostCard.test.tsx ui/src/pages/Costs.test.tsx
pnpm check:token-gates
pnpm storybook
```

These tests include real PostgreSQL persistence, migration replay, concurrent
updates, account changes, duplicate identity resolution, ownership, monetary
receipt replay, unknown prices, and failed provider observations. Provider payloads
are fixtures; live provider access still depends on the deployment's credentials
and scopes.
