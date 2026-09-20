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

Storybook's simulated controllers and page annotations do not run in the app.

## Compatibility and selection

The shared `AI_CONNECTION_CAPABILITIES` contract defines these combinations:

| Provider | Sign-in method | Existing harness |
| --- | --- | --- |
| Claude / Anthropic | Claude subscription token or Anthropic API key | Claude |
| OpenAI | ChatGPT/Codex subscription or OpenAI API key | Codex |
| OpenRouter | API key | OpenCode, with an `openrouter/` model |
| Grok / xAI | Grok subscription or xAI API key | Grok |

Native runner supports the corresponding existing Codex, OpenCode, and Claude
ACP profiles. Connections creation and reconnect mount `AgentProviderConnection`,
the same provider tiles, method controls, API entry, and `AdapterLoginPanel` used
by agent setup. Supported sandbox environments use onboarding's existing browser
sign-in controllers. Self-hosted installations use the shared terminal sign-in
instructions described below and require no sandbox. Environment selection does
not change agent execution settings.
API keys are validated against fixed provider endpoints; redirects
and caller-supplied validation URLs are rejected.

`runtimeConfig.aiConnection` contains `provider`, `mode`, and `method`. For responsible-user selections, `method` is a legacy wire hint retained for rolling upgrades; the resolver uses the selected account’s actual method:

- `responsible_user`: resolve the run's responsible user's personal provider default, using that account's subscription or API key. The `method` hint does not restrict the responsible user's account.
- `shared`: use the named `connectionId` and `grantId`, with audience and agent
  access checks.
- `delegated`: retained only to read legacy bindings. It cannot bypass human
  access; a personal credential remains available only for its owner's tasks.
  New configuration offers personal defaults or shared accounts.

“Which humans can use this credential?” is the sole permission for whose work
can use the account. “Just me” means the personal owner; shared accounts allow
selected company members or every company member. The separate agent-access
setting determines which agents can use it. There is no additional AI agent
authorization, and old delegation records do not override the human audience.

A connection choice never changes the harness, model, or provider routing.
Changing those separately may make a binding incompatible; saving then requires
a compatible choice. Agent configuration cannot grant access to another account.

Personal defaults are unique per company, user, and provider. A Claude bot can use one user’s subscription and another user’s API key without changing its harness or model. Explicit shared selections remain pinned to the selected account and method.
The first successful personal connection sets a default only when none exists.
The additive `ai_provider_defaults` table preserves the legacy per-method preferences. Migration selects each user’s most recently updated provider preference (including unavailable accounts), and rerunning it never overwrites a provider default. New writes maintain the legacy table for older servers. A database trigger propagates older servers’ explicit default updates to the provider default. Inserting an additional method default does not replace an existing provider default.

Revocation retains the unavailable default; connecting another account does not
silently replace it. Change it explicitly on the account detail page.

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
active-run attribution. Existing Connections operations handle naming, access,
and revocation. Mutation authorization is enforced server-side. OpenAPI documents the new board-only
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

## Runtime isolation

`prepareManagedAiRuntime` is shared by runs, environment tests, and adoption.
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
`useLocalAiLogin`. In local-trusted mode, Claude checks the operator’s existing
Claude Code login. Authenticated self-hosted users instead get a separate
`CLAUDE_CONFIG_DIR` for `claude auth login`; checking and saving only read that
attempt’s credential files, never the server operator’s account or Keychain.

Codex and Grok start a separate terminal sign-in for each connection or reconnect.
The shared component shows a server-generated command with a fresh `CODEX_HOME`
or `GROK_HOME`. Codex uses file credential storage in that home and `login --device-auth`, so
signing in from another computer does not depend on a localhost callback. The home is never
seeded with the operator's existing login: copying a rotating refresh token would
allow managed runs to invalidate credentials still used by legacy agents or the
operator's terminal. The user completes browser sign-in from that command, then
clicks Connect. This does not require a sandbox or change the host login.

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
Claude Keychain reads remain limited to the explicit local-trusted default-home import. A failed verification creates
no healthy connection. Preview-era Codex/Grok managed connections without the
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
In local-trusted mode, Claude checks the local operator’s Claude Code login.
Authenticated Claude users, plus all Codex and Grok users, check only their
connection-specific login home. The health response selects credential isolation,
not whether a self-hosted user may sign in.

Leaving and returning to a local sign-in screen resumes its active attempt. Navigation
does not delete a directory referenced by a copied command. **Start sign-in again**
explicitly cancels the old attempt; abandoned attempts expire after 30 minutes.
Commands create their directory if necessary, and completed/expired attempts are
cleaned up through the existing lifecycle.

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

Authenticated public deployments must configure a trusted runtime host (`PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` or `PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST`) before offering server-host subscription login, matching the local stdio runtime boundary. Health reports this capability so setup can offer a supported environment or API key instead of an unusable terminal command. Private authenticated self-hosted instances support isolated local login without that extra setting. Isolated Claude credential files must be private, owned by the server user, bounded, and free of symlinks.

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
inside the task. Connecting installs access for that agent and resumes the pending
work automatically. Explicit incompatible bindings and shared-account permission
denials still fail; hiring never expands a restricted shared account's audience.

Concurrent runs of one subscription do not wait for each other. No credential
lease exists to hold them, so a fresh task execution cannot enter a contention
wait. A run that already entered this wait keeps its scheduled retries. It does
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
